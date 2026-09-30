// 构造接口响应替身：SSE 流（可按任意字节切块）与普通 JSON
function sseText(protocol, content) {
  const pieces = content.match(/.{1,3}/gsu) || [];
  let s = ': keep-alive\n\n';
  if (protocol === 'anthropic') {
    s += 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n';
    s += 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n';
    s += 'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'SECRET' } }) + '\n\n';
    for (const p of pieces) {
      s += 'event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: p } }) + '\n\n';
    }
    s += 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  } else {
    for (const p of pieces) s += 'data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n';
    s += 'data: [DONE]\n\n';
  }
  return s;
}

function streamResponse(text, chunk = 7, status = 200) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    body: new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
        c.close();
      }
    })
  };
}

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

module.exports = { sseText, streamResponse, jsonResponse };
