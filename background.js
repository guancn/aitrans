// background.js

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

// 缓存用户配置，避免每次翻译时查询 storage 产生延迟
let userConfig = { targetLang: 'zh-CN', translationService: 'deepseek', apiKey: '', systemPrompt: DEFAULT_SYSTEM_PROMPT, activeMode: 'selection', fp_targetLang: 'zh-CN', fp_translationService: 'google', fp_apiKey: '', fp_systemPrompt: DEFAULT_SYSTEM_PROMPT };

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

try {
  chrome.storage.sync.get(['targetLang', 'translationService', 'apiKey', 'systemPrompt', 'activeMode', 'fp_targetLang', 'fp_translationService', 'fp_apiKey', 'fp_systemPrompt'], (items) => {
    if (!chrome.runtime.lastError && items) {
      if (items.targetLang) userConfig.targetLang = items.targetLang;
      if (items.translationService) userConfig.translationService = items.translationService;
      if (items.apiKey) userConfig.apiKey = items.apiKey;
      if (items.systemPrompt) userConfig.systemPrompt = items.systemPrompt;
      if (items.activeMode) userConfig.activeMode = items.activeMode;
      if (items.fp_targetLang) userConfig.fp_targetLang = items.fp_targetLang;
      if (items.fp_translationService) userConfig.fp_translationService = items.fp_translationService;
      if (items.fp_apiKey) userConfig.fp_apiKey = items.fp_apiKey;
      if (items.fp_systemPrompt) userConfig.fp_systemPrompt = items.fp_systemPrompt;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      if (changes.targetLang) userConfig.targetLang = changes.targetLang.newValue;
      if (changes.translationService) userConfig.translationService = changes.translationService.newValue;
      if (changes.apiKey) userConfig.apiKey = changes.apiKey.newValue;
      if (changes.systemPrompt) userConfig.systemPrompt = changes.systemPrompt.newValue;
      if (changes.activeMode) userConfig.activeMode = changes.activeMode.newValue;
      if (changes.fp_targetLang) userConfig.fp_targetLang = changes.fp_targetLang.newValue;
      if (changes.fp_translationService) userConfig.fp_translationService = changes.fp_translationService.newValue;
      if (changes.fp_apiKey) userConfig.fp_apiKey = changes.fp_apiKey.newValue;
      if (changes.fp_systemPrompt) userConfig.fp_systemPrompt = changes.fp_systemPrompt.newValue;
    }
  });
} catch (e) {
  // Service Worker 上下文失效时静默处理
}

async function translateText(text, targetLang, apiKey, systemPrompt, maxRetries = 2) {
  const targetLangName = LANG_NAMES[targetLang] || targetLang;
  // 全局替换：默认提示词中 {{targetLang}} 出现多次，单次 replace 会漏掉后面的
  const finalPrompt = systemPrompt.replace(/\{\{targetLang\}\}/g, targetLangName);

  const url = 'https://api.deepseek.com/v1/chat/completions';

  // maxRetries 不含首次尝试，总计最多 (maxRetries + 1) 次请求
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          messages: [
            { role: 'system', content: finalPrompt },
            { role: 'user', content: text }
          ],
          temperature: 0,
          max_tokens: 2048,
          thinking: { type: 'disabled' }
        })
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
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

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';

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
      if (attempt === maxRetries) {
        return {
          success: false,
          error: error.message || '翻译请求失败，请检查网络连接'
        };
      }
      await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
      clearTimeout(timeoutId);
    }
  }
}

// Google 翻译（免费，无需 API Key）
// 使用 translate.googleapis.com 的非官方端点，dj=1 获得结构化 JSON 响应
async function translateWithGoogle(text, targetLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&dj=1`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
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
    return {
      success: false,
      error: error.message || 'Google 翻译请求失败，请检查网络连接'
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
          model: 'deepseek-v4-flash',
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
        // 429 退避重试；其余（含 401/403）直接回退逐条，让上层拿到明确错误
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
    if (batched) {
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

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'translate') {
    const service = userConfig.translationService || 'deepseek';

    // Google 翻译路径：免费，无需 API Key
    if (service === 'google') {
      translateWithGoogle(request.text, userConfig.targetLang)
        .then(sendResponse)
        .catch(() => {});
      return true;
    }

    if (userConfig.apiKey) {
      translateText(request.text, userConfig.targetLang, userConfig.apiKey, userConfig.systemPrompt)
        .then(sendResponse)
        .catch(() => {});
    } else {
      chrome.storage.sync.get({
        targetLang: 'zh-CN',
        apiKey: '',
        systemPrompt: DEFAULT_SYSTEM_PROMPT
      }, (items) => {
        if (!items.apiKey) {
          sendResponse({ success: false, error: '请先在扩展设置中填写 DeepSeek API Key' });
          return;
        }
        translateText(request.text, items.targetLang, items.apiKey, items.systemPrompt)
          .then(sendResponse)
          .catch(() => {});
      });
    }
    return true;
  }

  if (request.action === 'translateBatch') {
    const service = userConfig.fp_translationService || 'google';

    if (service === 'google') {
      translateBatch(request.texts, userConfig.fp_targetLang, '', '', 'google', 5)
        .then(sendResponse)
        .catch(() => {});
      return true;
    }

    if (userConfig.fp_apiKey) {
      translateBatch(request.texts, userConfig.fp_targetLang, userConfig.fp_apiKey, userConfig.fp_systemPrompt, 'deepseek', 3)
        .then(sendResponse)
        .catch(() => {});
    } else {
      chrome.storage.sync.get({
        fp_targetLang: 'zh-CN',
        fp_apiKey: '',
        fp_systemPrompt: DEFAULT_SYSTEM_PROMPT
      }, (items) => {
        if (!items.fp_apiKey) {
          sendResponse(request.texts.map(() => ({ success: false, error: '请先在扩展设置中填写 DeepSeek API Key' })));
          return;
        }
        translateBatch(request.texts, items.fp_targetLang, items.fp_apiKey, items.fp_systemPrompt, 'deepseek', 3)
          .then(sendResponse)
          .catch(() => {});
      });
    }
    return true;
  }
});
