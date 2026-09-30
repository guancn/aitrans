// 模型管理页：维护 chrome.storage.sync 的 models 列表；保存 / 测试时按 Base URL 域名申请主机权限
const MAX_MODELS = 10;
const BASE_URL_HINTS = {
  openai: '需含版本段，自动拼接 /chat/completions。例：https://api.openai.com/v1、https://api.deepseek.com',
  anthropic: '自动拼接 /v1/messages。例：https://api.anthropic.com'
};
const EMPTY_MODEL = { name: '', protocol: 'openai', baseUrl: '', model: '', apiKey: '', thinking: 'default', extraParams: '' };

const $ = (id) => document.getElementById(id);
let models = [];
let selectedId = null;
let renderToken = 0;

function newId() {
  return 'm_' + Math.random().toString(36).slice(2, 10);
}

function originPattern(baseUrl) {
  return new URL(baseUrl).origin + '/*';
}

function hasPermission(baseUrl) {
  try {
    return chrome.permissions.contains({ origins: [originPattern(baseUrl)] }).catch(() => false);
  } catch (_) {
    return Promise.resolve(false);
  }
}

function readForm() {
  return {
    id: selectedId,
    name: $('f_name').value.trim(),
    protocol: $('f_protocol').value,
    baseUrl: $('f_baseUrl').value.trim().replace(/\/+$/, ''),
    model: $('f_model').value.trim(),
    apiKey: $('f_apiKey').value.trim(),
    thinking: $('f_thinking').value,
    extraParams: $('f_extra').value.trim()
  };
}

// 同步校验，返回错误文案或空串（之后要申请权限，此处不得 await，否则丢失用户手势）
function validate(m) {
  if (!m.name || !m.baseUrl || !m.model) return '名称、Base URL、模型名均为必填';
  let u;
  try { u = new URL(m.baseUrl); } catch (_) { return 'Base URL 格式不正确'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Base URL 必须以 http:// 或 https:// 开头';
  if (m.extraParams) {
    try {
      const p = JSON.parse(m.extraParams);
      if (!p || typeof p !== 'object' || Array.isArray(p)) return '高级参数必须是 JSON 对象';
    } catch (_) {
      return '高级参数不是合法 JSON';
    }
  }
  return '';
}

function showStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function updateBaseUrlHint() {
  const p = $('f_protocol').value;
  $('baseUrlHint').textContent = BASE_URL_HINTS[p];
  $('f_baseUrl').placeholder = p === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
}

function fillForm(m) {
  $('f_name').value = m.name;
  $('f_protocol').value = m.protocol;
  $('f_baseUrl').value = m.baseUrl;
  $('f_model').value = m.model;
  $('f_apiKey').value = m.apiKey;
  $('f_apiKey').type = 'password';
  $('toggleKey').textContent = '显示';
  $('f_thinking').value = m.thinking;
  $('f_extra').value = m.extraParams;
  updateBaseUrlHint();
  showStatus('', '');
}

// 权限查询是异步的：先并行查完再同步重建列表，避免多次渲染交错
async function renderList() {
  const token = ++renderToken;
  const granted = await Promise.all(models.map(m => hasPermission(m.baseUrl)));
  if (token !== renderToken) return;

  const ul = $('modelList');
  ul.textContent = '';
  models.forEach((m, i) => {
    const li = document.createElement('li');
    li.dataset.id = m.id;
    if (m.id === selectedId) li.classList.add('active');
    const name = document.createElement('span');
    name.textContent = m.name;
    li.appendChild(name);
    const badges = [];
    if (!m.apiKey) badges.push('未填 Key');
    if (!granted[i]) badges.push('未授权');
    for (const b of badges) {
      const s = document.createElement('span');
      s.className = 'badge';
      s.textContent = b;
      li.appendChild(s);
    }
    li.addEventListener('click', () => select(m.id));
    ul.appendChild(li);
  });
  $('addModel').disabled = models.length >= MAX_MODELS;
  $('limitHint').hidden = models.length < MAX_MODELS;
}

function select(id) {
  selectedId = id;
  fillForm(models.find(m => m.id === id));
  renderList();
}

// 新增：只生成草稿，保存后才进入列表
function startDraft() {
  selectedId = newId();
  fillForm(EMPTY_MODEL);
  renderList();
}

function selectFirst() {
  if (models.length) select(models[0].id);
  else startDraft();
}

function persist(m) {
  const exists = models.some(x => x.id === m.id);
  if (!exists && models.length >= MAX_MODELS) return Promise.reject(new Error(`最多 ${MAX_MODELS} 个模型`));
  const next = exists ? models.map(x => (x.id === m.id ? m : x)) : [...models, m];
  return chrome.storage.sync.set({ models: next }).then(() => {
    models = next;
    selectedId = m.id;
    renderList();
  });
}

// ─── 事件 ────────────────────────────────

$('f_protocol').addEventListener('change', updateBaseUrlHint);

$('toggleKey').addEventListener('click', () => {
  const show = $('f_apiKey').type === 'password';
  $('f_apiKey').type = show ? 'text' : 'password';
  $('toggleKey').textContent = show ? '隐藏' : '显示';
});

$('addModel').addEventListener('click', startDraft);

// 非本机、非内网的 http 地址：API Key 会明文经过公网
function isInsecureRemote(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch (_) { return false; }
  if (u.protocol !== 'http:') return false;
  const h = u.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return false;
  return !(/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h));
}

$('modelForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const m = readForm();
  const err = validate(m);
  if (err) { showStatus(err, 'error'); return; }
  // 权限申请必须是本次点击中的第一个异步调用；已授权时直接 resolve true 不弹窗
  chrome.permissions.request({ origins: [originPattern(m.baseUrl)] })
    .catch(() => false)
    .then((granted) => persist(m).then(() => {
      if (isInsecureRemote(m.baseUrl)) {
        showStatus('已保存，但该地址使用明文 HTTP，API Key 可能被窃听' + (granted ? '' : '；且未授权访问该地址'), 'warn');
      } else if (granted) showStatus('已保存', 'ok');
      else showStatus('已保存，但未授权访问该地址，翻译将失败。再次点击保存可重新授权', 'warn');
    }))
    .catch((err2) => showStatus('保存失败：' + err2.message, 'error'));
});

$('testBtn').addEventListener('click', () => {
  const m = readForm();
  const err = validate(m);
  if (err) { showStatus(err, 'error'); return; }
  showStatus('测试中…', 'info');
  chrome.permissions.request({ origins: [originPattern(m.baseUrl)] })
    .catch(() => false)
    .then(() => chrome.runtime.sendMessage({ action: 'testModel', model: m }))
    .then((r) => {
      if (r && r.success) showStatus(`成功（${r.ms}ms）：${r.translatedText}`, 'ok');
      else showStatus('失败：' + (r ? r.error : '后台无响应'), 'error');
    })
    .catch((err2) => showStatus('失败：' + err2.message, 'error'));
});

$('deleteBtn').addEventListener('click', async () => {
  if (!models.some(x => x.id === selectedId)) { selectFirst(); return; }
  const cfg = await chrome.storage.sync.get(['translationService', 'fp_translationService']);
  const inUse = cfg.translationService === selectedId || cfg.fp_translationService === selectedId;
  const msg = inUse ? '该模型正在被使用，删除后对应模式将改用 Google 翻译。确定删除？' : '确定删除该模型？';
  if (!confirm(msg)) return;

  const next = models.filter(x => x.id !== selectedId);
  const patch = { models: next };
  if (cfg.translationService === selectedId) patch.translationService = 'google';
  if (cfg.fp_translationService === selectedId) patch.fp_translationService = 'google';
  await chrome.storage.sync.set(patch);
  models = next;
  selectFirst();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.models) {
    models = changes.models.newValue || [];
    renderList();
  }
});

// 先让 background 完成旧配置迁移（同时唤醒 SW），再读取模型列表
chrome.runtime.sendMessage({ action: 'ensureConfig' })
  .catch(() => {})
  .then(() => chrome.storage.sync.get('models'))
  .then(({ models: stored }) => {
    models = Array.isArray(stored) ? stored : [];
    selectFirst();
  });
