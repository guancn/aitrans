// providers.js — 模型协议适配层（OpenAI 兼容 / Anthropic 原生）
// 纯函数：background.js 以 importScripts 加载；tests/ 以 vm 加载

const THINKING_EFFORTS = ['low', 'medium', 'high'];
// 思考开启时 max_tokens 需容纳思考内容，否则译文会被截断
const THINKING_MAX_TOKENS = 16000;

// 深度合并：对象递归合并，其余值覆盖，null 表示删除该键
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    // JSON.parse 会产生自有的 __proto__ 键，递归写入会污染 Object.prototype
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
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

// 单个 SSE 事件 → 文本增量；anthropic 的 error 事件直接抛出
function streamDeltaText(evt, protocol) {
  if (protocol === 'anthropic') {
    if (evt.type === 'error') throw new Error((evt.error && evt.error.message) || 'Anthropic 流式响应错误');
    // 只取正文增量，thinking_delta 等事件丢弃
    return evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta' ? evt.delta.text : '';
  }
  return evt.choices?.[0]?.delta?.content || '';
}

// 读取 SSE 流，返回拼接后的完整文本；每批新内容到达时以累积文本回调
async function readStream(response, protocol, onChunk) {
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
      // 跳过空行、event: 行与 ": keep-alive" 注释行
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch (_) { continue; }
      const delta = streamDeltaText(evt, protocol);
      if (delta) { content += delta; changed = true; }
    }
    if (changed && onChunk) onChunk(content);
  }
  return content;
}

// 非流式响应 → 文本
function extractText(json, protocol) {
  if (protocol === 'anthropic') {
    return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  return json.choices?.[0]?.message?.content || '';
}
