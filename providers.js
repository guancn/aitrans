// providers.js — 模型协议适配层（OpenAI 兼容 / Anthropic 原生）
// 纯函数：background.js 以 importScripts 加载；tests/ 以 vm 加载

const THINKING_EFFORTS = ['low', 'medium', 'high'];
// 思考开启时 max_tokens 需容纳思考内容，否则译文会被截断
const THINKING_MAX_TOKENS = 16000;

// 深度合并：对象递归合并，其余值覆盖，null 表示删除该键
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete target[k];
    } else if (v && typeof v === 'object' && !Array.isArray(v) &&
               target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

// 高级参数 JSON 字符串 → 对象；非法或非对象时视为空（选项页已在保存时校验）
function parseExtraParams(str) {
  if (!str || !str.trim()) return {};
  try {
    const p = JSON.parse(str);
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch (_) {
    return {};
  }
}

// 构造请求：model 为模型列表条目；返回 { url, headers, body(对象) }
// base_url 约定与各家 SDK 一致：openai 自带版本段，anthropic 不带
function buildRequest(model, { system, user, stream, maxTokens }) {
  const base = (model.baseUrl || '').trim().replace(/\/+$/, '');
  const effortOn = THINKING_EFFORTS.includes(model.thinking);
  const max_tokens = effortOn ? THINKING_MAX_TOKENS : maxTokens;
  let url, headers, body;

  if (model.protocol === 'anthropic') {
    url = base + '/v1/messages';
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': model.apiKey,
      'anthropic-version': '2023-06-01',
      // 扩展 SW 直连 Anthropic 必需，否则被 CORS 拒绝
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    body = { model: model.model, max_tokens, system, messages: [{ role: 'user', content: user }], stream };
    if (model.thinking === 'off') {
      body.thinking = { type: 'disabled' };
    } else if (effortOn) {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort: model.thinking };
    }
  } else {
    url = base + '/chat/completions';
    headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${model.apiKey}` };
    body = {
      model: model.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens,
      stream
    };
    if (model.thinking === 'off') {
      // DeepSeek / 智谱约定；其他厂商的关闭写法用高级参数覆盖
      body.thinking = { type: 'disabled' };
    } else if (effortOn) {
      body.reasoning_effort = model.thinking;
    }
  }

  deepMerge(body, parseExtraParams(model.extraParams));
  return { url, headers, body };
}
