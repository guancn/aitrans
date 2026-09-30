// background.js

// 协议适配层（buildRequest / readStream / extractText）
importScripts('providers.js');

// 默认系统提示词 — 融合宝玉翻译理念：意译优先、表达地道、保留专名
// ⚠️ 修改此处时请同步更新 popup.js 中的 DEFAULT_PROMPT
const DEFAULT_SYSTEM_PROMPT =
  'You are a professional {{targetLang}} translator. ' +
  'Translate naturally by meaning, not word-for-word. ' +
  'Adapt idioms and cultural references to sound native. ' +
  'Preserve proper nouns, code, numbers, URLs and formatting as-is. ' +
  'If the text is already in {{targetLang}}, return it unchanged. ' +
  'Be concise — match the source length and tone. ' +
  'Output ONLY JSON (no markdown fences): {"source_lang":"<detected>","translated_text":"<translation>"}';

// 内置 DeepSeek 预设：旧配置迁移与新装用户的初始模型
// temperature:0 + 关闭思考 = v1.3.0 及以前的翻译行为
const DEEPSEEK_PRESET = {
  name: 'DeepSeek Flash', protocol: 'openai', baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash', thinking: 'off', extraParams: '{"temperature":0}'
};

// 配置默认值；onChanged 中键被 remove 时回退到这里
const CONFIG_DEFAULTS = {
  targetLang: 'zh-CN', translationService: 'deepseek', systemPrompt: DEFAULT_SYSTEM_PROMPT,
  activeMode: 'selection', fp_targetLang: 'zh-CN', fp_translationService: 'google',
  fp_systemPrompt: DEFAULT_SYSTEM_PROMPT, models: []
};

// 缓存用户配置，避免每次翻译时查询 storage 产生延迟
let userConfig = { ...CONFIG_DEFAULTS };

const LANG_NAMES = {
  'zh-CN': 'Simplified Chinese',
  'en': 'English',
  'ja': 'Japanese',
  'ko': 'Korean',
  'fr': 'French',
  'de': 'German',
  'es': 'Spanish',
  'ru': 'Russian'
};

// 旧版单引擎配置（apiKey / fp_apiKey）→ 模型列表；仅在 models 键不存在时调用
function migrateLegacyConfig(items) {
  const key = items.apiKey || '';
  const fpKey = items.fp_apiKey || '';
  const models = [{ id: 'deepseek', ...DEEPSEEK_PRESET, apiKey: key || fpKey }];
  // 两种模式曾配置不同的 Key：拆成两个条目，各自沿用原 Key
  const splitFp = !!(key && fpKey && key !== fpKey);
  if (splitFp) {
    models.push({ id: 'deepseek_fp', ...DEEPSEEK_PRESET, name: 'DeepSeek Flash（全页）', apiKey: fpKey });
  }
  const fpService = items.fp_translationService || 'google';
  return {
    set: {
      models,
      translationService: items.translationService || 'deepseek',
      fp_translationService: splitFp && fpService === 'deepseek' ? 'deepseek_fp' : fpService
    },
    remove: ['apiKey', 'fp_apiKey']
  };
}

// 配置加载 promise 化：SW 冷启动时消息可能先于 storage 回调到达，
// 消息处理前必须 await configReady，否则会用硬编码默认值路由（引擎/语言错乱）
let configReady = Promise.resolve();

try {
  configReady = new Promise((resolve) => {
    chrome.storage.sync.get(null, (items) => {
      if (chrome.runtime.lastError || !items) { resolve(); return; }
      const apply = () => {
        for (const k of Object.keys(CONFIG_DEFAULTS)) {
          if (items[k]) userConfig[k] = items[k];
        }
        resolve();
      };
      if (Array.isArray(items.models)) { apply(); return; }

      const { set, remove } = migrateLegacyConfig(items);
      Object.assign(items, set);
      // 写入完成后才 resolve：ensureConfig 的调用方（popup / 选项页）随后直接读 storage
      chrome.storage.sync.set(set, () => {
        if (!chrome.runtime.lastError) chrome.storage.sync.remove(remove);
        apply();
      });
    });
  });

  // 键被 remove 时 newValue 为 undefined，用 ?? 回退默认值防止配置被污染
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, c] of Object.entries(changes)) {
      if (k in CONFIG_DEFAULTS) userConfig[k] = c.newValue ?? CONFIG_DEFAULTS[k];
    }
  });
} catch (e) {
  // Service Worker 上下文失效时静默处理
}

// 单次请求超时；DeepSeek 含重试的总时长受 TRANSLATE_DEADLINE_MS 约束
// ⚠️ content.js 的 TRANSLATE_TIMEOUT_MS 是 SW 无响应兜底，必须大于 TRANSLATE_DEADLINE_MS
const REQUEST_TIMEOUT_MS = 20000;
const TRANSLATE_DEADLINE_MS = 25000;

// ─── 划词翻译内存 LRU 缓存 ───────────────────────────────
// SW 存活期间避免重复 API 调用（反复查同一个词很常见）；SW 终止即清空，零持久化成本
const CACHE_MAX = 100;
const translateCache = new Map();

function cacheGet(key) {
  const v = translateCache.get(key);
  if (v !== undefined) {
    // LRU：命中后移到末尾（Map 保持插入序）
    translateCache.delete(key);
    translateCache.set(key, v);
  }
  return v;
}

function cacheSet(key, value) {
  if (translateCache.has(key)) translateCache.delete(key);
  translateCache.set(key, value);
  if (translateCache.size > CACHE_MAX) {
    translateCache.delete(translateCache.keys().next().value);
  }
}

// 从（可能未接收完的）JSON 文本中增量提取字符串字段；字段未闭合时返回已到达的部分
function extractJsonStringField(buf, field) {
  const m = new RegExp(`"${field}"\\s*:\\s*"`).exec(buf);
  if (!m) return null;
  let out = '';
  for (let i = m.index + m[0].length; i < buf.length; i++) {
    const ch = buf[i];
    if (ch === '"') return { value: out, complete: true };
    if (ch !== '\\') { out += ch; continue; }
    // 转义序列被分块截断时停在此处，等下一块到达
    if (i + 1 >= buf.length) break;
    const esc = buf[++i];
    if (esc === 'u') {
      if (i + 4 >= buf.length) break;
      out += String.fromCharCode(parseInt(buf.slice(i + 1, i + 5), 16));
      i += 4;
    } else {
      out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[esc] ?? esc;
    }
  }
  return { value: out, complete: false };
}

// 读取 OpenAI 兼容 SSE 流，返回拼接后的完整 content；每批新内容到达时以累积文本回调
async function readChatStream(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    let changed = false;
    for (const line of lines) {
      const s = line.trim();
      // 跳过空行与 ": keep-alive" 注释行
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) { content += delta; changed = true; }
      } catch (_) { /* 忽略无法解析的行 */ }
    }
    if (changed) onChunk(content);
  }
  return content;
}

// onDelta 传入时走流式：每收到新内容回调 (已到达的译文, 已识别的源语言)
async function translateText(text, targetLang, apiKey, systemPrompt, maxRetries = 2, onDelta = null) {
  const targetLangName = LANG_NAMES[targetLang] || targetLang;
  // 全局替换：默认提示词中 {{targetLang}} 出现多次，单次 replace 会漏掉后面的
  const finalPrompt = systemPrompt.replace(/\{\{targetLang\}\}/g, targetLangName);

  const url = 'https://api.deepseek.com/v1/chat/completions';

  // maxRetries 不含首次尝试，总计最多 (maxRetries + 1) 次请求，且整体不超过截止时间
  const deadline = Date.now() + TRANSLATE_DEADLINE_MS;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { success: false, error: '请求超时，请重试' };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remaining));
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'deepseek-flash',
          messages: [
            { role: 'system', content: finalPrompt },
            { role: 'user', content: text }
          ],
          temperature: 0,
          max_tokens: 2048,
          thinking: { type: 'disabled' },
          stream: !!onDelta
        })
      });

      if (!response.ok) {
        clearTimeout(timeoutId);
        if (response.status === 401 || response.status === 403) {
          let msg = 'API Key 无效，请检查设置';
          if (response.status === 403) msg = 'API Key 无权限或余额不足';
          return { success: false, error: msg };
        }
        if (response.status === 429) {
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          return { success: false, error: '请求过于频繁，请稍后再试' };
        }
        const errText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      // 读取响应体也在超时计时内（流式时 body 持续数秒）
      let content;
      if (onDelta) {
        content = await readChatStream(response, (acc) => {
          const t = extractJsonStringField(acc, 'translated_text');
          if (t && t.value) {
            const lang = extractJsonStringField(acc, 'source_lang');
            onDelta(t.value, lang && lang.complete ? lang.value : '');
          }
        });
      } else {
        const data = await response.json();
        content = data.choices?.[0]?.message?.content || '';
      }
      clearTimeout(timeoutId);

      // 两层 JSON 提取：先正则清理，再大括号定位
      let parsed = null;
      let extracted = content
        .replace(/```(?:json)?\s*/gi, '')  // 移除所有开启围栏 (```json, ```)
        .replace(/```/g, '')               // 移除残留闭合围栏
        .trim();

      try {
        parsed = JSON.parse(extracted);
      } catch (_) {
        // 正则清理失败，尝试大括号提取
        const start = extracted.indexOf('{');
        const end = extracted.lastIndexOf('}');
        if (start !== -1 && end > start) {
          try {
            parsed = JSON.parse(extracted.slice(start, end + 1));
          } catch (__) { /* 最终回退 */ }
        }
      }

      if (parsed && parsed.translated_text) {
        return {
          success: true,
          originalText: text,
          translatedText: parsed.translated_text,
          sourceLang: parsed.source_lang || 'auto',
          service: 'deepseek'
        };
      }

      // 全部解析失败则返回错误，决不把原始 JSON 当译文展示
      return {
        success: false,
        error: '翻译结果解析失败，请重试'
      };

    } catch (error) {
      clearTimeout(timeoutId);
      if (attempt === maxRetries) {
        return {
          success: false,
          error: (error && error.name === 'AbortError')
            ? '请求超时，请重试'
            : (error.message || '翻译请求失败，请检查网络连接')
        };
      }
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
}

// Google 翻译（免费，无需 API Key）
// 使用 translate.googleapis.com 的非官方端点，dj=1 获得结构化 JSON 响应
async function translateWithGoogle(text, targetLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&dj=1`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `q=${encodeURIComponent(text)}`
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Google 翻译请求失败 (HTTP ${response.status})`);
    }

    const data = await response.json();

    // dj=1 响应格式: { sentences: [{ trans: "...", orig: "..." }], src: "en", ... }
    const translatedText = data.sentences?.map(s => s.trans).join('') || '';
    const sourceLang = data.src || 'auto';

    if (!translatedText) {
      throw new Error('Google 翻译返回空结果');
    }

    return {
      success: true,
      originalText: text,
      translatedText,
      sourceLang,
      service: 'google'
    };
  } catch (error) {
    clearTimeout(timeoutId);
    return {
      success: false,
      error: (error && error.name === 'AbortError')
        ? '请求超时，请重试'
        : (error.message || 'Google 翻译请求失败，请检查网络连接')
    };
  }
}

// 全页批量翻译专用提示词：一次请求翻译整个数组，请求数降到 1/N
// 注意：全页批量走此固定提示词（不使用用户自定义 fp_systemPrompt），以换取吞吐量
const BATCH_SYSTEM_PROMPT =
  'You are a professional {{targetLang}} translator. ' +
  'You will receive a JSON array of text segments. ' +
  'Translate EACH segment into {{targetLang}}, naturally by meaning, not word-for-word. ' +
  'Adapt idioms to sound native; preserve proper nouns, code, numbers, URLs and formatting as-is. ' +
  'If a segment is already in {{targetLang}}, return it unchanged. ' +
  'Output ONLY a JSON array of translated strings — same length and order as the input, ' +
  'no markdown fences, no extra keys, no commentary.';

// 从模型输出中提取字符串数组（容错：围栏清理 → 方括号定位 → 对象内首个数组）
function parseJsonArray(content) {
  const toStrArray = (p) => Array.isArray(p) ? p.map(x => (typeof x === 'string' ? x : String(x))) : null;

  const extracted = content
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    const p = JSON.parse(extracted);
    const arr = toStrArray(p);
    if (arr) return arr;
    // 模型可能包了一层对象，如 {"translations":[...]}
    if (p && typeof p === 'object') {
      for (const v of Object.values(p)) {
        const inner = toStrArray(v);
        if (inner) return inner;
      }
    }
  } catch (_) { /* 继续尝试方括号定位 */ }

  const start = extracted.indexOf('[');
  const end = extracted.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      return toStrArray(JSON.parse(extracted.slice(start, end + 1)));
    } catch (_) { /* 放弃 */ }
  }
  return null;
}

// DeepSeek 数组批量：一次请求翻译整批，成功返回 string[]，失败返回 null（由上层逐条回退）
async function translateBatchDeepSeek(texts, targetLang, apiKey, maxRetries = 2) {
  const targetLangName = LANG_NAMES[targetLang] || targetLang;
  const finalPrompt = BATCH_SYSTEM_PROMPT.replace(/\{\{targetLang\}\}/g, targetLangName);
  const url = 'https://api.deepseek.com/v1/chat/completions';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'deepseek-flash',
          messages: [
            { role: 'system', content: finalPrompt },
            { role: 'user', content: JSON.stringify(texts) }
          ],
          temperature: 0,
          max_tokens: 4096,
          thinking: { type: 'disabled' }
        })
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // 401/403 返回哨兵短路：回退逐条只会再打 N 个注定失败的请求，纯浪费
        if (response.status === 401 || response.status === 403) {
          return {
            authError: true,
            error: response.status === 403 ? 'API Key 无权限或余额不足' : 'API Key 无效，请检查设置'
          };
        }
        // 429 退避重试；其余错误回退逐条（由上层工作池处理）
        if (response.status === 429 && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        return null;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';
      const arr = parseJsonArray(content);
      // 数量必须与输入严格一致，否则无法对齐 → 回退逐条保证正确性
      if (arr && arr.length === texts.length) return arr;
      return null;
    } catch (error) {
      clearTimeout(timeoutId);
      if (attempt === maxRetries) return null;
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  return null;
}

// 批量翻译：DeepSeek 优先走单请求数组批量，失败/Google 回退并发工作池
async function translateBatch(texts, targetLang, apiKey, systemPrompt, service, maxConcurrency) {
  if (texts.length === 0) return [];

  // DeepSeek 快路径：整批一次请求
  if (service === 'deepseek') {
    const batched = await translateBatchDeepSeek(texts, targetLang, apiKey);
    // 鉴权失败：短路整批，绝不回退逐条（会打出 N 个注定 401 的请求）
    if (batched && batched.authError) {
      return texts.map(() => ({ success: false, error: batched.error }));
    }
    if (Array.isArray(batched)) {
      return batched.map((t, i) => ({
        success: true,
        originalText: texts[i],
        translatedText: t,
        sourceLang: 'auto',
        service: 'deepseek'
      }));
    }
    // 批量失败 → 落到下方逐条工作池（保留质量与错误信息）
  }

  const results = new Array(texts.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < texts.length) {
      const i = nextIndex++;
      try {
        if (service === 'google') {
          results[i] = await translateWithGoogle(texts[i], targetLang);
        } else {
          results[i] = await translateText(texts[i], targetLang, apiKey, systemPrompt);
        }
      } catch (e) {
        results[i] = { success: false, error: e.message || '批量翻译失败' };
      }
    }
  }

  const pool = [];
  for (let j = 0; j < maxConcurrency; j++) {
    pool.push(worker());
  }
  await Promise.all(pool);
  return results;
}

// 划词翻译走长连接（port）：DeepSeek 流式推送 {type:'delta'}，结束推送 {type:'done', result}；
// Google 与缓存命中只推送 done
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translate') return;
  let disconnected = false;
  port.onDisconnect.addListener(() => { disconnected = true; });
  // 用户关闭弹窗后 content 端会断开，向已断开的 port 发消息会抛错
  const post = (msg) => {
    if (disconnected) return;
    try { port.postMessage(msg); } catch (_) { disconnected = true; }
  };

  port.onMessage.addListener(({ text }) => {
    (async () => {
      // 冷启动竞态防护：等配置加载完成再路由，否则可能用错引擎/语言
      await configReady;

      const service = userConfig.translationService || 'deepseek';
      const cacheKey = `${service}|${userConfig.targetLang}|${text}`;
      const cached = cacheGet(cacheKey);
      if (cached) {
        post({ type: 'done', result: cached });
        return;
      }

      let result;
      if (service === 'google') {
        result = await translateWithGoogle(text, userConfig.targetLang);
      } else {
        if (!userConfig.apiKey) {
          post({ type: 'done', result: { success: false, error: '请先在扩展设置中填写 DeepSeek API Key' } });
          return;
        }
        result = await translateText(text, userConfig.targetLang, userConfig.apiKey, userConfig.systemPrompt, 2,
          (partial, sourceLang) => post({ type: 'delta', translatedText: partial, sourceLang, service: 'deepseek' }));
      }

      if (result && result.success) cacheSet(cacheKey, result);
      post({ type: 'done', result });
    })().catch(() => post({ type: 'done', result: { success: false, error: '翻译请求失败' } }));
  });
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  // popup / 选项页打开时调用：唤醒 SW 并等待旧配置迁移完成
  if (request.action === 'ensureConfig') {
    configReady.then(() => sendResponse({ ok: true }));
    return true;
  }
  if (request.action === 'translateBatch') {
    (async () => {
      await configReady;

      const service = userConfig.fp_translationService || 'google';
      if (service === 'google') {
        sendResponse(await translateBatch(request.texts, userConfig.fp_targetLang, '', '', 'google', 5));
        return;
      }

      if (!userConfig.fp_apiKey) {
        sendResponse(request.texts.map(() => ({ success: false, error: '请先在扩展设置中填写 DeepSeek API Key' })));
        return;
      }
      sendResponse(await translateBatch(request.texts, userConfig.fp_targetLang, userConfig.fp_apiKey, userConfig.fp_systemPrompt, 'deepseek', 3));
    })().catch(() => {});
    return true;
  }
});
