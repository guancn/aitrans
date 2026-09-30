const test = require('node:test');
const assert = require('node:assert/strict');
const { plain, evalIn, loadBackground, callMessage, mkPort, until } = require('./helpers/load');
const { sseText, streamResponse, jsonResponse } = require('./helpers/sse');

const PRESET = {
  name: 'DeepSeek Flash', protocol: 'openai', baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash', thinking: 'off', extraParams: '{"temperature":0}'
};

test('migrateLegacyConfig：新装用户得到空 Key 的内置条目', () => {
  const { ctx } = loadBackground();
  const r = plain(ctx.migrateLegacyConfig({}));
  assert.deepEqual(r.set.models, [{ id: 'deepseek', ...PRESET, apiKey: '' }]);
  assert.equal(r.set.translationService, 'deepseek');
  assert.equal(r.set.fp_translationService, 'google');
  assert.deepEqual(r.remove, ['apiKey', 'fp_apiKey']);
});

test('migrateLegacyConfig：只有 apiKey', () => {
  const { ctx } = loadBackground();
  const r = plain(ctx.migrateLegacyConfig({ apiKey: 'k1', translationService: 'google', fp_translationService: 'deepseek' }));
  assert.deepEqual(r.set.models, [{ id: 'deepseek', ...PRESET, apiKey: 'k1' }]);
  assert.equal(r.set.translationService, 'google');
  assert.equal(r.set.fp_translationService, 'deepseek');
});

test('migrateLegacyConfig：只有 fp_apiKey 时内置条目沿用它', () => {
  const { ctx } = loadBackground();
  const r = plain(ctx.migrateLegacyConfig({ fp_apiKey: 'k2' }));
  assert.equal(r.set.models.length, 1);
  assert.equal(r.set.models[0].apiKey, 'k2');
});

test('migrateLegacyConfig：两个 Key 不同时拆成两个条目，全页指向 deepseek_fp', () => {
  const { ctx } = loadBackground();
  const r = plain(ctx.migrateLegacyConfig({ apiKey: 'k1', fp_apiKey: 'k2', translationService: 'deepseek', fp_translationService: 'deepseek' }));
  assert.deepEqual(r.set.models.map(m => [m.id, m.apiKey, m.name]), [
    ['deepseek', 'k1', 'DeepSeek Flash'],
    ['deepseek_fp', 'k2', 'DeepSeek Flash（全页）']
  ]);
  assert.equal(r.set.translationService, 'deepseek');
  assert.equal(r.set.fp_translationService, 'deepseek_fp');
});

test('configReady：无 models 键时迁移并删除旧键，内存配置同步更新', async () => {
  const { ctx, store } = loadBackground({ storage: { apiKey: 'k1', translationService: 'deepseek', targetLang: 'ja' } });
  await evalIn(ctx, 'configReady');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(store.models.length, 1);
  assert.equal(store.models[0].apiKey, 'k1');
  assert.equal('apiKey' in store, false);
  const cfg = plain(evalIn(ctx, 'userConfig'));
  assert.equal(cfg.models.length, 1);
  assert.equal(cfg.targetLang, 'ja');
  assert.equal(cfg.translationService, 'deepseek');
});

test('configReady：已有 models 时不做任何写入（幂等）', async () => {
  const models = [{ id: 'deepseek', ...PRESET, apiKey: 'k' }];
  const { ctx, writes } = loadBackground({ storage: { models, translationService: 'deepseek' } });
  await evalIn(ctx, 'configReady');
  assert.deepEqual(writes, []);
});

test('onChanged：键被删除时回退默认值', async () => {
  const { ctx, listeners } = loadBackground({ storage: { models: [], translationService: 'm_1' } });
  await evalIn(ctx, 'configReady');
  listeners.changed.forEach(f => f({ translationService: { oldValue: 'm_1' } }, 'sync'));
  assert.equal(evalIn(ctx, 'userConfig.translationService'), 'deepseek');
});

test('ensureConfig：等待迁移写入完成后响应', async () => {
  const { store, listeners } = loadBackground({ storage: { apiKey: 'k1' } });
  const r = await callMessage(listeners, { action: 'ensureConfig' });
  assert.deepEqual(plain(r), { ok: true });
  assert.ok(Array.isArray(store.models));
});

const OPENAI_M = { id: 'm_o', name: 'My GPT', protocol: 'openai', baseUrl: 'https://api.example.com/v1', model: 'gpt-x', apiKey: 'ko', thinking: 'default', extraParams: '' };
const ANTH_M = { id: 'm_a', name: 'Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5', apiKey: 'ka', thinking: 'default', extraParams: '' };
const RESULT_JSON = '{"source_lang":"en","translated_text":"你好\\n\\"世界\\" \\u4e2d😀"}';
const RESULT_TEXT = JSON.parse(RESULT_JSON).translated_text;

async function runPort(bg, text) {
  const p = mkPort();
  bg.listeners.connect(p);
  p.msgL({ text });
  await until(() => p.sent.some(m => m.type === 'done'));
  return p;
}

for (const model of [OPENAI_M, ANTH_M]) {
  test(`划词 port：${model.protocol} 流式推送 delta 与 done`, async () => {
    const bg = loadBackground({
      storage: { models: [model], translationService: model.id },
      fetchImpl: async () => streamResponse(sseText(model.protocol, RESULT_JSON), 5)
    });
    const p = await runPort(bg, 'hello');
    const deltas = p.sent.filter(m => m.type === 'delta');
    assert.ok(deltas.length >= 2);
    assert.ok(deltas.every(d => RESULT_TEXT.startsWith(d.translatedText) && d.service === 'model' && d.modelName === model.name));
    const done = p.sent.at(-1);
    assert.equal(done.result.success, true);
    assert.equal(done.result.translatedText, RESULT_TEXT);
    assert.equal(done.result.modelName, model.name);
    const call = bg.fetchCalls[0];
    assert.equal(call.body.stream, true);
    assert.equal(call.body.model, model.model);
    assert.equal(call.url, model.protocol === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.example.com/v1/chat/completions');
  });
}

test('划词 port：缓存按模型区分，命中时只发 done', async () => {
  const bg = loadBackground({
    storage: { models: [OPENAI_M], translationService: 'm_o' },
    fetchImpl: async () => streamResponse(sseText('openai', RESULT_JSON))
  });
  await runPort(bg, 'hello');
  const p2 = await runPort(bg, 'hello');
  assert.deepEqual(p2.sent.map(m => m.type), ['done']);
  assert.equal(bg.fetchCalls.length, 1);
});

test('划词 port：模型已删除 / 未填 Key 的报错', async () => {
  let bg = loadBackground({ storage: { models: [], translationService: 'm_gone' } });
  let p = await runPort(bg, 'x');
  assert.equal(p.sent.at(-1).result.error, '模型已删除，请重新选择');

  bg = loadBackground({ storage: { models: [{ ...OPENAI_M, apiKey: '' }], translationService: 'm_o' } });
  p = await runPort(bg, 'x');
  assert.equal(p.sent.at(-1).result.error, '请先在模型管理中填写 API Key');
  assert.equal(bg.fetchCalls.length, 0);
});

test('划词：fetch 抛 TypeError（无权限 / 网络）给出授权提示', async () => {
  const bg = loadBackground({
    storage: { models: [OPENAI_M], translationService: 'm_o' },
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); }
  });
  const p = await runPort(bg, 'x');
  assert.equal(p.sent.at(-1).result.error, '无法访问该地址：请在模型管理中保存以授权，或检查网络');
});

test('全页批量：模型单请求数组批量，结果带 modelName', async () => {
  const bg = loadBackground({
    storage: { models: [ANTH_M], fp_translationService: 'm_a' },
    fetchImpl: async () => jsonResponse({ content: [{ type: 'text', text: '["甲","乙"]' }] })
  });
  const r = plain(await callMessage(bg.listeners, { action: 'translateBatch', texts: ['a', 'b'] }));
  assert.deepEqual(r.map(x => x.translatedText), ['甲', '乙']);
  assert.ok(r.every(x => x.service === 'model' && x.modelName === 'Claude'));
  assert.equal(bg.fetchCalls[0].body.stream, false);
  assert.equal(bg.fetchCalls[0].body.max_tokens, 4096);
});

test('全页批量：401 整批短路，不逐条回退', async () => {
  const bg = loadBackground({
    storage: { models: [OPENAI_M], fp_translationService: 'm_o' },
    fetchImpl: async () => jsonResponse({}, 401)
  });
  const r = plain(await callMessage(bg.listeners, { action: 'translateBatch', texts: ['a', 'b', 'c'] }));
  assert.ok(r.every(x => x.error === 'API Key 无效，请检查设置'));
  assert.equal(bg.fetchCalls.length, 1);
});

test('testModel：用未保存的模型对象翻译并返回耗时', async () => {
  const bg = loadBackground({
    storage: { models: [] },
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: RESULT_JSON } }] })
  });
  const r = plain(await callMessage(bg.listeners, { action: 'testModel', model: OPENAI_M }));
  assert.equal(r.success, true);
  assert.equal(r.translatedText, RESULT_TEXT);
  assert.equal(typeof r.ms, 'number');
  assert.equal(bg.fetchCalls[0].body.stream, false);
  assert.equal(bg.fetchCalls[0].body.messages[1].content, 'Hello, world.');
});

test('testModel：4xx 不重试，返回状态码与响应原文', async () => {
  const bg = loadBackground({
    storage: { models: [] },
    fetchImpl: async () => jsonResponse({ error: { message: 'thinking.type disabled not supported' } }, 400)
  });
  const r = plain(await callMessage(bg.listeners, { action: 'testModel', model: ANTH_M }));
  assert.equal(r.success, false);
  assert.match(r.error, /^HTTP 400: .*thinking\.type disabled not supported/);
  assert.equal(bg.fetchCalls.length, 1);
});

test('划词：请求挂起时总耗时受截止时间约束', async () => {
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => {
    const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
  }));
  const bg = loadBackground({
    storage: { models: [OPENAI_M], translationService: 'm_o' },
    fetchImpl: hang,
    patch: [['REQUEST_TIMEOUT_MS = 20000', 'REQUEST_TIMEOUT_MS = 200'], ['TRANSLATE_DEADLINE_MS = 25000', 'TRANSLATE_DEADLINE_MS = 250']]
  });
  const t = Date.now();
  const p = await runPort(bg, 'x');
  assert.equal(p.sent.at(-1).result.error, '请求超时，请重试');
  // 上限 = 截止时间 + 最长一次网络错误退避（300ms，未缩放）
  assert.ok(Date.now() - t < 250 + 300 + 100);
});

test('extractJsonStringField：任意前缀都是最终值的前缀', () => {
  const { ctx } = loadBackground();
  const full = RESULT_JSON;
  for (let i = 0; i <= full.length; i++) {
    const r = ctx.extractJsonStringField(full.slice(0, i), 'translated_text');
    if (r) assert.ok(RESULT_TEXT.startsWith(r.value), `前缀 ${i}`);
  }
  assert.deepEqual(plain(ctx.extractJsonStringField(full, 'translated_text')), { value: RESULT_TEXT, complete: true });
});
