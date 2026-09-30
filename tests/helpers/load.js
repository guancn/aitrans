// 测试辅助：用 vm 加载扩展脚本（无打包、无依赖），并提供 chrome / port mock
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// vm 内对象的原型属于另一 realm，deepStrictEqual 前先转成普通对象
const plain = (x) => JSON.parse(JSON.stringify(x));

// 读取 vm 上下文中 let/const 声明的顶层绑定（它们不是 global 属性）
const evalIn = (ctx, expr) => vm.runInContext(expr, ctx);

function loadProviders() {
  const ctx = vm.createContext({ TextDecoder, TextEncoder });
  vm.runInContext(read('providers.js'), ctx, { filename: 'providers.js' });
  return ctx;
}

// storage：chrome.storage.sync 初始内容；fetchImpl：(url, init) => Promise<Response 替身>；
// patch：对 background.js 源码的 [查找, 替换] 列表（用于缩短超时常量）
function loadBackground({ storage = {}, fetchImpl, patch = [] } = {}) {
  const store = JSON.parse(JSON.stringify(storage));
  const writes = [];
  const listeners = { connect: null, message: null, changed: [] };
  const fetchCalls = [];

  const chrome = {
    runtime: {
      lastError: undefined,
      onConnect: { addListener: (f) => { listeners.connect = f; } },
      onMessage: { addListener: (f) => { listeners.message = f; } },
      onInstalled: { addListener() {} }
    },
    storage: {
      sync: {
        get(keys, cb) {
          const all = JSON.parse(JSON.stringify(store));
          let r = all;
          if (typeof keys === 'string') r = { [keys]: all[keys] };
          else if (Array.isArray(keys)) r = Object.fromEntries(keys.filter(k => k in all).map(k => [k, all[k]]));
          setTimeout(() => cb(r), 0);
        },
        set(obj, cb) {
          writes.push(['set', JSON.parse(JSON.stringify(obj))]);
          Object.assign(store, JSON.parse(JSON.stringify(obj)));
          if (cb) setTimeout(cb, 0);
        },
        remove(keys, cb) {
          writes.push(['remove', [].concat(keys)]);
          for (const k of [].concat(keys)) delete store[k];
          if (cb) setTimeout(cb, 0);
        }
      },
      onChanged: { addListener: (f) => listeners.changed.push(f) }
    }
  };

  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, AbortController, TextDecoder, TextEncoder, ReadableStream,
    chrome,
    fetch: (url, init) => {
      fetchCalls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
      return (fetchImpl || (() => Promise.reject(new Error('fetch 未 mock'))))(url, init);
    }
  });
  ctx.importScripts = (...files) => files.forEach(f => vm.runInContext(read(f), ctx, { filename: f }));

  let src = read('background.js');
  for (const [from, to] of patch) {
    if (!src.includes(from)) throw new Error(`patch 未命中：${from}`);
    src = src.replace(from, to);
  }
  vm.runInContext(src, ctx, { filename: 'background.js' });
  return { ctx, store, writes, listeners, fetchCalls };
}

// 模拟 content 端的 port；dead 后 postMessage 抛错（与 Chrome 行为一致）
function mkPort() {
  const p = {
    name: 'translate', sent: [], dead: false, msgL: null, discL: null,
    postMessage(m) {
      if (p.dead) throw new Error('Attempting to use a disconnected port object');
      p.sent.push(JSON.parse(JSON.stringify(m)));
    },
    onMessage: { addListener: (f) => { p.msgL = f; } },
    onDisconnect: { addListener: (f) => { p.discL = f; } }
  };
  return p;
}

// 轮询直到条件成立（最长 2s）
async function until(fn) {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise(r => setTimeout(r, 5));
  if (!fn()) throw new Error('等待超时');
}

// 以 onMessage 方式调用 background，返回 sendResponse 的值
function callMessage(listeners, request) {
  return new Promise((resolve) => listeners.message(request, {}, resolve));
}

module.exports = { ROOT, read, plain, evalIn, loadProviders, loadBackground, mkPort, until, callMessage };
