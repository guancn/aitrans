const test = require('node:test');
const assert = require('node:assert/strict');
const { CHROME, runHarness } = require('./helpers/headless');

const skip = !CHROME && '未找到 Chrome（可设置 CHROME_PATH）';

const DEEPSEEK = {
  id: 'deepseek', name: 'DeepSeek Flash', protocol: 'openai', baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash', apiKey: 'sk-1', thinking: 'off', extraParams: '{"temperature":0}'
};

test('选项页：增改删、手势内申请权限、测试连接', { skip }, () => {
  const scenario = async () => {
    const failures = [];
    const check = (cond, msg) => { if (!cond) failures.push(msg); };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const el = (id) => document.getElementById(id);
    const gesture = (node) => { window.__inClick = true; node.click(); window.__inClick = false; };
    const fill = (m) => { for (const [k, v] of Object.entries(m)) el(k).value = v; };

    await sleep(100);
    check(document.querySelectorAll('#modelList li').length === 1, '初始应渲染 1 个模型');
    check(el('f_name').value === 'DeepSeek Flash', '初始应选中第一个模型');
    check(el('f_extra').value === '{"temperature":0}', '应回填高级参数');

    el('addModel').click(); await sleep(50);
    check(el('f_name').value === '', '新增后表单应清空');
    fill({ f_name: 'Claude', f_protocol: 'anthropic', f_baseUrl: 'https://api.anthropic.com/', f_model: 'claude-haiku-4-5', f_apiKey: 'sk-ant', f_thinking: 'low', f_extra: '{bad' });
    gesture(el('saveBtn')); await sleep(50);
    check(window.__calls.permissionsRequest.length === 0, '校验失败时不应申请权限');
    check(el('status').className.includes('error'), '非法 JSON 应报错');

    el('f_extra').value = '{"max_tokens":1000}';
    gesture(el('saveBtn')); await sleep(100);
    const req = window.__calls.permissionsRequest[0];
    check(req && req.origins[0] === 'https://api.anthropic.com/*', '应按域名申请权限');
    check(req && req.inGesture, '权限申请必须在点击的同步调用链内');
    check(window.__store.models.length === 2, '应保存为第 2 个模型');
    const saved = window.__store.models[1] || {};
    check(saved.baseUrl === 'https://api.anthropic.com' && saved.protocol === 'anthropic' && saved.thinking === 'low' && saved.extraParams === '{"max_tokens":1000}', '保存字段应正确且去掉尾部斜杠');
    check(el('status').className.includes('warn'), '未授权时应显示警告');
    check([...document.querySelectorAll('#modelList li')].some(li => li.textContent.includes('未授权')), '列表应标记未授权');

    gesture(el('testBtn')); await sleep(100);
    check(window.__calls.permissionsRequest[1] && window.__calls.permissionsRequest[1].inGesture, '测试连接也应在手势内申请权限');
    const tm = window.__calls.sendMessage.find(m => m.action === 'testModel');
    check(tm && tm.model.model === 'claude-haiku-4-5', '应发送 testModel');
    check(el('status').textContent.includes('成功'), '测试成功应显示结果');

    document.querySelector('#modelList li').click(); await sleep(50);
    check(el('f_name').value === 'DeepSeek Flash', '点击列表应切换编辑对象');
    el('deleteBtn').click(); await sleep(100);
    check(window.__store.models.length === 1 && window.__store.models[0].name === 'Claude', '应删除 DeepSeek');
    check(window.__store.translationService === 'google', '被删模型所在模式应回退 Google');
    check(window.__calls.sendMessage[0] && window.__calls.sendMessage[0].action === 'ensureConfig', '初始化应先请求 ensureConfig');

    el('addModel').click(); await sleep(50);
    fill({ f_name: 'Remote', f_protocol: 'openai', f_baseUrl: 'http://api.example.com/v1', f_model: 'm', f_apiKey: 'k' });
    gesture(el('saveBtn')); await sleep(100);
    check(el('status').textContent.includes('明文 HTTP'), '远端 http 应提示明文 HTTP');
    el('f_baseUrl').value = 'http://localhost:11434/v1';
    gesture(el('saveBtn')); await sleep(100);
    check(!el('status').textContent.includes('明文 HTTP'), '本机 http 不应提示明文 HTTP');
    return failures;
  };
  const r = runHarness('options', { models: [DEEPSEEK], translationService: 'deepseek', fp_translationService: 'google' }, scenario.toString());
  assert.deepEqual(r.failures, []);
});

test('popup：动态模型下拉、无 Key 输入、缺 Key 提示、管理模型入口', { skip }, () => {
  const scenario = async () => {
    const failures = [];
    const check = (cond, msg) => { if (!cond) failures.push(msg); };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const el = (id) => document.getElementById(id);

    await sleep(100);
    check(window.__calls.sendMessage.some(m => m.action === 'ensureConfig'), '应先请求 ensureConfig');
    const opts = [...el('translationService').options].map(o => o.value);
    check(JSON.stringify(opts) === '["google","deepseek","m_x"]', '划词下拉应为 Google + 模型列表：' + opts);
    check(el('translationService').options[2].textContent === 'Claude', '选项文本应为模型名');
    check(el('translationService').value === 'deepseek', '应选中已保存的模型');
    check(el('fpTranslationService').value === 'm_x', '全页应选中 m_x');
    check(!el('apiKey') && !el('fpApiKey'), '弹窗不应再有 API Key 输入框');
    check(!el('modelWarning').hidden && el('modelWarning').textContent.includes('API Key'), '所选模型缺 Key 应提示');
    check(el('promptSection').style.display !== 'none', '选模型时应显示提示词');

    el('translationService').value = 'google';
    el('translationService').dispatchEvent(new Event('change'));
    await sleep(50);
    check(window.__store.translationService === 'google', '切换服务应保存');
    check(el('promptSection').style.display === 'none' && el('modelWarning').hidden, '选 Google 应隐藏提示词与警告');

    document.querySelector('.manage-models').click();
    check(window.__calls.openOptionsPage === 1, '「管理模型」应打开选项页');
    return failures;
  };
  const store = {
    models: [
      { id: 'deepseek', name: 'DeepSeek Flash', protocol: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: '', thinking: 'off', extraParams: '' },
      { id: 'm_x', name: 'Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5', apiKey: 'k', thinking: 'default', extraParams: '' }
    ],
    translationService: 'deepseek', fp_translationService: 'm_x', activeMode: 'selection'
  };
  const r = runHarness('popup', store, scenario.toString());
  assert.deepEqual(r.failures, []);
});
