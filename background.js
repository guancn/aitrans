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
let userConfig = { targetLang: 'zh-CN', translationService: 'deepseek', apiKey: '', systemPrompt: DEFAULT_SYSTEM_PROMPT };

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
  chrome.storage.sync.get(['targetLang', 'translationService', 'apiKey', 'systemPrompt'], (items) => {
    if (!chrome.runtime.lastError && items) {
      if (items.targetLang) userConfig.targetLang = items.targetLang;
      if (items.translationService) userConfig.translationService = items.translationService;
      if (items.apiKey) userConfig.apiKey = items.apiKey;
      if (items.systemPrompt) userConfig.systemPrompt = items.systemPrompt;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      if (changes.targetLang) userConfig.targetLang = changes.targetLang.newValue;
      if (changes.translationService) userConfig.translationService = changes.translationService.newValue;
      if (changes.apiKey) userConfig.apiKey = changes.apiKey.newValue;
      if (changes.systemPrompt) userConfig.systemPrompt = changes.systemPrompt.newValue;
    }
  });
} catch (e) {
  // Service Worker 上下文失效时静默处理
}

async function translateText(text, targetLang, apiKey, systemPrompt, maxRetries = 2) {
  const targetLangName = LANG_NAMES[targetLang] || targetLang;
  const finalPrompt = systemPrompt.replace('{{targetLang}}', targetLangName);

  const url = 'https://api.deepseek.com/v1/chat/completions';

  // maxRetries 不含首次尝试，总计最多 (maxRetries + 1) 次请求
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
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
          max_tokens: 1024,
          thinking: { type: 'disabled' }
        })
      });

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
          sourceLang: parsed.source_lang || 'auto'
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
    }
  }
}

// Google 翻译（免费，无需 API Key）
// 使用 translate.googleapis.com 的非官方端点，dj=1 获得结构化 JSON 响应
async function translateWithGoogle(text, targetLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&dj=1`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `q=${encodeURIComponent(text)}`
    });

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
      sourceLang
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Google 翻译请求失败，请检查网络连接'
    };
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'translate') {
    const service = userConfig.translationService || 'deepseek';

    // Google 翻译路径：免费，无需 API Key
    if (service === 'google') {
      translateWithGoogle(request.text, userConfig.targetLang)
        .then(sendResponse);
      return true;
    }

    // DeepSeek 翻译路径：需 API Key
    if (userConfig.apiKey) {
      translateText(request.text, userConfig.targetLang, userConfig.apiKey, userConfig.systemPrompt)
        .then(sendResponse);
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
          .then(sendResponse);
      });
    }
    return true;
  }
});
