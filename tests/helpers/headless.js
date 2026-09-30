// 在本机 headless Chrome 中运行页面 harness：注入 chrome mock + 场景脚本，读取 <pre id="__result">
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { ROOT } = require('./load');

const CHROME = process.env.CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].find(p => fs.existsSync(p));

// 与 chrome.* 行为对齐的最小 mock：storage 回调异步、未传回调时返回 Promise；
// __inClick 由场景在点击前后置位，用于断言权限申请发生在用户手势的同步调用链内
function chromeMock(initialStore) {
  return `
window.__store = ${JSON.stringify(initialStore)};
window.__calls = { permissionsRequest: [], sendMessage: [], openOptionsPage: 0 };
window.__inClick = false;
const __changed = [];
const __clone = (x) => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
const __reply = (value, cb) => { if (cb) { setTimeout(() => cb(value), 0); return; } return Promise.resolve(value); };
window.chrome = {
  runtime: {
    id: 'test', lastError: undefined,
    sendMessage(msg, cb) {
      __calls.sendMessage.push(__clone(msg));
      const r = msg.action === 'testModel' ? { success: true, translatedText: '你好，世界。', ms: 42 } : { ok: true };
      return __reply(r, cb);
    },
    openOptionsPage() { __calls.openOptionsPage++; }
  },
  permissions: {
    request(p) { __calls.permissionsRequest.push({ origins: p.origins, inGesture: __inClick }); return Promise.resolve(false); },
    contains(p) { return Promise.resolve(p.origins[0].startsWith('https://api.deepseek.com')); }
  },
  storage: {
    sync: {
      get(keys, cb) {
        let r;
        if (keys == null) r = __clone(__store);
        else if (typeof keys === 'string') r = { [keys]: __clone(__store[keys]) };
        else if (Array.isArray(keys)) { r = {}; keys.forEach(k => { if (k in __store) r[k] = __clone(__store[k]); }); }
        else { r = __clone(keys); for (const k in keys) if (k in __store) r[k] = __clone(__store[k]); }
        return __reply(r, cb);
      },
      set(obj, cb) {
        Object.assign(__store, __clone(obj));
        const changes = {};
        for (const k in obj) changes[k] = { newValue: __clone(obj[k]) };
        setTimeout(() => __changed.forEach(f => f(changes, 'sync')), 0);
        return __reply(undefined, cb);
      },
      remove(keys, cb) { [].concat(keys).forEach(k => delete __store[k]); return __reply(undefined, cb); }
    },
    onChanged: { addListener(f) { __changed.push(f); } }
  },
  tabs: { query(q, cb) { cb([]); }, sendMessage() {} }
};
window.confirm = () => true;
`;
}

// page：'options' | 'popup'；scenario：返回 failures 数组的 async 函数源码
function runHarness(page, initialStore, scenario) {
  const abs = (f) => pathToFileURL(path.join(ROOT, f)).href;
  let html = fs.readFileSync(path.join(ROOT, `${page}.html`), 'utf8');
  const cssTag = `href="${page}.css"`;
  const jsTag = `<script src="${page}.js"></script>`;
  if (!html.includes(cssTag) || !html.includes(jsTag)) throw new Error(`${page}.html 缺少预期的 css/js 引用`);
  html = html
    .replace(cssTag, `href="${abs(page + '.css')}"`)
    .replace(jsTag,
      `<script>${chromeMock(initialStore)}</script>` +
      `<script src="${abs(page + '.js')}"></script>` +
      `<script>(${scenario})().then((failures) => {
         const pre = document.createElement('pre'); pre.id = '__result';
         pre.textContent = JSON.stringify({ failures }); document.body.appendChild(pre);
       });</script>`);
  const file = path.join(os.tmpdir(), `aitrans-${page}-harness.html`);
  fs.writeFileSync(file, html);
  const out = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--allow-file-access-from-files',
    '--virtual-time-budget=10000', '--dump-dom', pathToFileURL(file).href
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
  const m = out.match(/<pre id="__result">([\s\S]*?)<\/pre>/);
  if (!m) throw new Error('harness 未输出结果（页面脚本可能报错）');
  const txt = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return JSON.parse(txt);
}

module.exports = { CHROME, runHarness };
