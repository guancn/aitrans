const test = require('node:test');
const assert = require('node:assert/strict');
const { plain, evalIn, loadBackground, callMessage } = require('./helpers/load');

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
