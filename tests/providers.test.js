const test = require('node:test');
const assert = require('node:assert/strict');
const { loadProviders, plain } = require('./helpers/load');

const P = loadProviders();
const base = { id: 'x', name: 'X', apiKey: 'KEY', model: 'mdl', thinking: 'default', extraParams: '' };
const req = (m, o = {}) => plain(P.buildRequest({ ...base, ...m }, { system: 'SYS', user: 'U', stream: true, maxTokens: 2048, ...o }));

test('openai：URL 去尾斜杠后拼 /chat/completions，Bearer 鉴权，不发 temperature', () => {
  const r = req({ protocol: 'openai', baseUrl: 'https://api.deepseek.com/' });
  assert.equal(r.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(r.headers.Authorization, 'Bearer KEY');
  assert.equal(r.headers['Content-Type'], 'application/json');
  assert.deepEqual(r.body, {
    model: 'mdl',
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'U' }],
    max_tokens: 2048,
    stream: true
  });
});

test('openai：带版本段的 base_url 只拼 /chat/completions', () => {
  assert.equal(req({ protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }).url,
    'https://open.bigmodel.cn/api/paas/v4/chat/completions');
});

test('anthropic：拼 /v1/messages，三个必需头，system 在顶层', () => {
  const r = req({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' });
  assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(r.headers['x-api-key'], 'KEY');
  assert.equal(r.headers['anthropic-version'], '2023-06-01');
  assert.equal(r.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal('Authorization' in r.headers, false);
  assert.deepEqual(r.body, {
    model: 'mdl', max_tokens: 2048, system: 'SYS',
    messages: [{ role: 'user', content: 'U' }], stream: true
  });
});

test('思考档位映射', () => {
  const cases = [
    ['openai', 'default', {}],
    ['openai', 'off', { thinking: { type: 'disabled' } }],
    ['openai', 'low', { reasoning_effort: 'low' }],
    ['openai', 'medium', { reasoning_effort: 'medium' }],
    ['openai', 'high', { reasoning_effort: 'high' }],
    ['anthropic', 'default', {}],
    ['anthropic', 'off', { thinking: { type: 'disabled' } }],
    ['anthropic', 'low', { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } }],
    ['anthropic', 'high', { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }]
  ];
  for (const [protocol, thinking, expected] of cases) {
    const b = req({ protocol, baseUrl: 'https://h', thinking }).body;
    const picked = {};
    for (const k of ['thinking', 'reasoning_effort', 'output_config']) if (k in b) picked[k] = b[k];
    assert.deepEqual(picked, expected, `${protocol}/${thinking}`);
  }
});

test('思考开启（低/中/高）时 max_tokens 提到 16000，否则用调用方的值', () => {
  assert.equal(req({ protocol: 'openai', baseUrl: 'https://h', thinking: 'low' }).body.max_tokens, 16000);
  assert.equal(req({ protocol: 'anthropic', baseUrl: 'https://h', thinking: 'high' }).body.max_tokens, 16000);
  assert.equal(req({ protocol: 'anthropic', baseUrl: 'https://h', thinking: 'off' }, { maxTokens: 4096 }).body.max_tokens, 4096);
});

test('高级参数：档位之后深度合并，覆盖值，null 删除键', () => {
  const b = req({
    protocol: 'anthropic', baseUrl: 'https://h', thinking: 'high',
    extraParams: '{"temperature":0,"output_config":{"effort":"low"},"thinking":null}'
  }).body;
  assert.equal(b.temperature, 0);
  assert.deepEqual(b.output_config, { effort: 'low' });
  assert.equal('thinking' in b, false);

  const b2 = req({ protocol: 'openai', baseUrl: 'https://h', extraParams: '{"max_tokens":null,"max_completion_tokens":16000}' }).body;
  assert.equal('max_tokens' in b2, false);
  assert.equal(b2.max_completion_tokens, 16000);
});

test('高级参数：非法 JSON / 非对象被忽略', () => {
  assert.equal(req({ protocol: 'openai', baseUrl: 'https://h', extraParams: '{bad' }).body.max_tokens, 2048);
  assert.equal(req({ protocol: 'openai', baseUrl: 'https://h', extraParams: '[1,2]' }).body.max_tokens, 2048);
});

test('高级参数深度合并保留兄弟键', () => {
  const b = req({
    protocol: 'anthropic', baseUrl: 'https://h', thinking: 'high',
    extraParams: '{"output_config":{"foo":1}}'
  }).body;
  // 深度合并应保留原有的 effort，并加入新的 foo
  assert.deepEqual(b.output_config, { effort: 'high', foo: 1 });
});
