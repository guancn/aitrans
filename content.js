let popupContainer = null;
let iconContainer = null;
let isContextInvalidated = false;
let activeRequestId = 0;

// 缓存用户配置，避免高频划词时产生多余的异步 IPC 开销
let userConfig = { triggerMode: 'icon', activeMode: 'selection' };
try {
  if (chrome.runtime && chrome.runtime.id) {
    chrome.storage.sync.get(['triggerMode', 'activeMode'], (items) => {
      if (!chrome.runtime.lastError && items) {
        if (items.triggerMode) userConfig.triggerMode = items.triggerMode;
        if (items.activeMode) userConfig.activeMode = items.activeMode;
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      // 键被 remove 时 newValue 为 undefined，用 ?? 回退默认值防止配置被污染
      if (area === 'sync' && changes.triggerMode) {
        userConfig.triggerMode = changes.triggerMode.newValue ?? 'icon';
      }
      if (area === 'sync' && changes.activeMode) {
        userConfig.activeMode = changes.activeMode.newValue ?? 'selection';
      }
    });
  }
} catch (e) {
  // Service Worker 上下文失效或 storage API 不可用时静默降级
  console.debug('划词翻译: 配置初始化失败', e);
}

// 检查插件上下文是否仍然有效
function isExtensionAlive() {
  if (isContextInvalidated) return false;
  if (!chrome.runtime || !chrome.runtime.id) {
    markInvalidated();
    return false;
  }
  return true;
}

function markInvalidated() {
  if (isContextInvalidated) return;
  isContextInvalidated = true;
  console.warn('极简划词翻译：插件已更新或重新加载，当前页面的插件上下文已失效。请刷新页面后继续使用。');
  cleanup();
  document.removeEventListener('mousedown', onMouseDown);
  document.removeEventListener('mouseup', debouncedMouseUp);
}

// Remove any existing UI
function cleanup() {
  if (popupContainer) {
    popupContainer.remove();
    popupContainer = null;
  }
  if (iconContainer) {
    iconContainer.remove();
    iconContainer = null;
  }
}

function onMouseDown(e) {
  if (!isExtensionAlive()) return;
  // If clicking inside the popup or icon, ignore (don't close immediately)
  if (popupContainer && popupContainer.contains(e.target)) return;
  if (iconContainer && iconContainer.contains(e.target)) return;
  
  // Clean up if we click anywhere outside
  cleanup();
}

function onMouseUp(e) {
  if (!isExtensionAlive()) return;
  if (popupContainer && popupContainer.contains(e.target)) return;
  if (iconContainer && iconContainer.contains(e.target)) return;

  // 全页翻译模式下禁用划词翻译
  if (userConfig.activeMode === 'fullpage') return;

  const selection = window.getSelection();
  const text = selection.toString().trim();

  if (text.length > 0) {
    const x = e.clientX;
    const y = e.clientY;
    
    // 捕获源文本的样式
    let sourceStyleInfo = {
      fontSize: 14,
      fontWeight: 'normal',
      fontStyle: 'normal'
    };
    
    try {
      const anchorNode = selection.anchorNode;
      const elementNode = anchorNode.nodeType === 3 ? anchorNode.parentElement : anchorNode;
      if (elementNode) {
        const computedStyle = window.getComputedStyle(elementNode);
        
        // 提取 font-size 并进行安全截断 (12px 到 24px)
        const parsedSize = parseFloat(computedStyle.fontSize);
        if (!isNaN(parsedSize)) {
          sourceStyleInfo.fontSize = Math.max(12, Math.min(parsedSize, 24));
        }
        sourceStyleInfo.fontWeight = computedStyle.fontWeight || 'normal';
        sourceStyleInfo.fontStyle = computedStyle.fontStyle || 'normal';
      }
    } catch (err) {
      console.debug('划词翻译: 源文本样式提取失败', err);
    }
    
    // 直接读取内存中的配置，消除异步 I/O 的延迟
    if (userConfig.triggerMode === 'icon') {
      showIcon(text, x, y, sourceStyleInfo);
    } else {
      showTranslationDirectly(text, x, y, sourceStyleInfo);
    }
  }
}

const debouncedMouseUp = debounce(onMouseUp, 200);

document.addEventListener('mousedown', onMouseDown, { passive: true });
document.addEventListener('mouseup', debouncedMouseUp, { passive: true });

function debounce(func, wait) {
  let timeout;
  return function(...args) {
    const later = () => {
      clearTimeout(timeout);
      if (isExtensionAlive()) {
        func(...args);
      }
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function showIcon(text, x, y, sourceStyleInfo) {
  cleanup();
  
  iconContainer = document.createElement('div');
  iconContainer.id = 'chrome-ext-translate-icon';
  // SF Symbols 风格线性译文字形（currentColor 上色，描边样式见 content.css）
  iconContainer.innerHTML = `
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <path d="m5 8 6 6"/>
      <path d="m4 14 6-6 2-3"/>
      <path d="M2 5h12"/>
      <path d="M7 2h1"/>
      <path d="m22 22-5-10-5 10"/>
      <path d="M14 18h6"/>
    </svg>
  `;
  
  // Position adjustments to prevent out of bounds
  let leftPos = x + window.scrollX + 10;
  if (x + 40 > window.innerWidth) leftPos = x + window.scrollX - 40;
  
  iconContainer.style.left = `${leftPos}px`;
  iconContainer.style.top = `${y + window.scrollY + 10}px`;
  
  let hoverTimeout;
  let translated = false; // Flag to check if we already requested translation
  
  iconContainer.addEventListener('mouseenter', () => {
    if (translated) return; // Prevent multiple requests when hovering repeatedly
    hoverTimeout = setTimeout(() => {
       translated = true;
       createAndShowPopup(text, x, y, iconContainer, sourceStyleInfo);
    }, 150); // slight delay
  });
  
  iconContainer.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimeout);
  });
  
  document.body.appendChild(iconContainer);
  setTimeout(() => {
      if(iconContainer) iconContainer.classList.add('show');
  }, 10);
}

function showTranslationDirectly(text, x, y, sourceStyleInfo) {
  cleanup();
  createAndShowPopup(text, x, y, null, sourceStyleInfo);
}

function createAndShowPopup(text, x, y, replaceIcon = null, sourceStyleInfo = null) {
  if (!isExtensionAlive()) {
    cleanup();
    return;
  }

  const requestId = ++activeRequestId;

  const container = document.createElement('div');
  container.id = 'chrome-ext-translate-popup';
  
  // Adjust position to prevent overflow
  const maxPopupWidth = 600; 
  let popX = x + window.scrollX + 10;
  let popY = y + window.scrollY + 15;
  
  if (x + maxPopupWidth > window.innerWidth) {
    popX = x + window.scrollX - maxPopupWidth;
    if (popX < 0) popX = 10; // keep in bounds
  }
  
  container.style.left = `${popX}px`;
  container.style.top = `${popY}px`;
  
  container.innerHTML = `
    <div class="translate-ext-loading">
        <div class="translate-ext-spinner"></div>
    </div>
  `;
  
  document.body.appendChild(container);
  popupContainer = container;
  
  if (replaceIcon && replaceIcon.parentNode) {
    replaceIcon.remove();
    iconContainer = null;
  }
  
  setTimeout(() => {
    if(container) container.classList.add('show');
  }, 10);
  
  // 15 秒超时保护，防止 Service Worker 无响应导致 loading spinner 永久卡死
  const TRANSLATE_TIMEOUT_MS = 15000;
  const timeoutId = setTimeout(() => {
    // 必须校验 requestId：旧请求的定时器不能覆盖用户新发起的翻译弹窗
    if (requestId === activeRequestId && popupContainer) {
      popupContainer.innerHTML = `<div class="translate-ext-error">翻译超时，请重试</div>`;
    }
  }, TRANSLATE_TIMEOUT_MS);
  
  try {
    chrome.runtime.sendMessage({ action: 'translate', text: text }, (response) => {
      clearTimeout(timeoutId);

      if (requestId !== activeRequestId) return;

      if (chrome.runtime.lastError) {
        if (chrome.runtime.lastError.message && chrome.runtime.lastError.message.includes('Extension context invalidated')) {
           markInvalidated();
        }
        // 非上下文失效错误（如 "Could not establish connection"）也需提示用户
        else if (popupContainer) {
          popupContainer.innerHTML = `<div class="translate-ext-error">连接失败，请刷新页面后重试</div>`;
        }
        return;
      }

      // If container was closed by user
      if (!popupContainer) return; 
      
      if (response && response.success) {
        popupContainer.innerHTML = `
          <div class="translate-ext-header">
             <span class="translate-ext-lang">${escapeHtml(response.sourceLang).toUpperCase()}</span>
             <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
             <span class="translate-ext-logo">${response.service === 'google' ? 'Google 翻译' : 'DeepSeek AI'}</span>
             <div class="translate-ext-close">
               <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
             </div>
          </div>
          <div class="translate-ext-result">${escapeHtml(response.translatedText)}</div>
        `;
        
        // Bind close button
        const closeBtn = popupContainer.querySelector('.translate-ext-close');
        if (closeBtn) {
          closeBtn.addEventListener('click', cleanup);
        }

        if (sourceStyleInfo) {
          const resultEl = popupContainer.querySelector('.translate-ext-result');
          if (resultEl) {
            resultEl.style.fontSize = `${sourceStyleInfo.fontSize}px`;
            resultEl.style.fontWeight = sourceStyleInfo.fontWeight;
            resultEl.style.fontStyle = sourceStyleInfo.fontStyle;
          }
        }
      } else {
        popupContainer.innerHTML = `
          <div class="translate-ext-error">${escapeHtml(response ? response.error : '未知错误')}</div>
        `;
      }
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.message && e.message.includes('Extension context invalidated')) {
      markInvalidated();
    }
  }
}

function escapeHtml(unsafe) {
    return (unsafe || '').toString()
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

// ─── 全页翻译 ────────────────────────────────────────────

// 跳过标签：这些元素内的文本不翻译
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'CANVAS',
  'SVG', 'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'BUTTON', 'SELECT',
  'OPTION', 'OPTGROUP'
]);

// 用 TreeWalker 收集页面所有可翻译文本节点
function* walkTextNodes(root = document.body) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node || !node.parentElement) return NodeFilter.FILTER_REJECT;

      // 廉价文本检查前置：先淘汰空白和纯数字/符号节点，再做较贵的 DOM 遍历
      const txt = (node.nodeValue || '').trim();
      if (txt.length < 1) return NodeFilter.FILTER_REJECT;
      // 无字母/CJK 不必翻译（"123"、"•"、"→"、"$"），省请求省 token
      if (!/[\p{L}]/u.test(txt)) return NodeFilter.FILTER_REJECT;

      // 沿祖先链单次遍历：跳过 SKIP_TAGS（含嵌套，如 <pre><span>高亮代码</span></pre>）、
      // 插件自身 UI、以及显式标记不翻译的元素（translate="no" / .notranslate 通用约定）
      let el = node.parentElement;
      while (el) {
        if (SKIP_TAGS.has(el.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
        if ((el.id || '').startsWith('chrome-ext-translate-')) return NodeFilter.FILTER_REJECT;
        if (el.getAttribute('translate') === 'no' || el.classList.contains('notranslate')) return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }

      // 跳过不可见文本（display:none 的菜单/折叠面板/隐藏 modal，常占页面文本 30%+ 的 token）
      // checkVisibility 为 Chrome 105+，旧版本安全降级为不过滤
      const parent = node.parentElement;
      if (parent.checkVisibility && !parent.checkVisibility()) return NodeFilter.FILTER_REJECT;

      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let cur;
  while ((cur = walker.nextNode())) {
    yield cur;
  }
}

// 存储原文，用于恢复
const originalTexts = new WeakMap();
let pageTranslationInProgress = false;

// 全页翻译主流程
async function startPageTranslation() {
  if (pageTranslationInProgress) return;
  if (!isExtensionAlive()) return;
  pageTranslationInProgress = true;

  try {
    // 先恢复之前的翻译（如果存在）
    restorePageTexts();

    const nodes = Array.from(walkTextNodes());
    if (nodes.length === 0) return;

    showProgress('正在收集文本...', 0);

    // 拆出每个节点的前后空白，只翻译中间实体部分（回填时补回空白，避免行内文本粘连）
    const items = [];
    for (const node of nodes) {
      if (!originalTexts.has(node)) {
        originalTexts.set(node, node.nodeValue);
      }
      const m = (node.nodeValue || '').match(/^(\s*)([\s\S]*?)(\s*)$/);
      const core = m[2];
      if (!core) continue;
      items.push({ node, lead: m[1], core, trail: m[3] });
    }
    if (items.length === 0) { hideProgress(); return; }

    // 去重：整页大量重复文本（导航、页脚、重复标签）只翻一次
    const uniqueTexts = [...new Set(items.map(it => it.core))];
    const translations = new Map();

    // 按字符预算切批：固定条数遇长段落易超 max_tokens=4096 → 输出 JSON 截断 →
    // 长度对不上 → 整批回退逐条（N 个请求 + N 份 system prompt），token 反而爆炸。
    // 字符预算让短文本一批塞更多、长文本自动少塞，截断率大幅下降。
    const BATCH_CHAR_BUDGET = 1800;
    const BATCH_MAX_ITEMS = 30;
    const batches = [];
    let batch = [];
    let batchChars = 0;
    for (const t of uniqueTexts) {
      if (batch.length > 0 && (batchChars + t.length > BATCH_CHAR_BUDGET || batch.length >= BATCH_MAX_ITEMS)) {
        batches.push(batch);
        batch = [];
        batchChars = 0;
      }
      batch.push(t);
      batchChars += t.length;
    }
    if (batch.length > 0) batches.push(batch);

    const total = batches.length;
    let completed = 0;
    const MAX_CONCURRENT = 3;

    showProgress('正在翻译...', 0);

    // 并发批量调度：每次最多 MAX_CONCURRENT 批并行
    for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
      const chunk = batches.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.all(chunk.map(batchTexts =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { action: 'translateBatch', texts: batchTexts },
            (response) => {
              resolve(chrome.runtime.lastError ? null : response);
            }
          );
        })
      ));

      // 收集译文到 map（按唯一文本对齐）
      for (let j = 0; j < chunk.length; j++) {
        const batchTexts = chunk[j];
        const result = results[j];
        if (result && Array.isArray(result)) {
          for (let k = 0; k < result.length; k++) {
            const r = result[k];
            if (r && r.success && r.translatedText) {
              translations.set(batchTexts[k], r.translatedText);
            }
          }
        }
        completed++;
      }

      const pct = Math.round((completed / total) * 100);
      showProgress(`正在翻译... ${pct}%`, pct);
    }

    // 回填：保留原节点前后空白
    for (const it of items) {
      const t = translations.get(it.core);
      if (t) it.node.nodeValue = it.lead + t + it.trail;
    }

    showProgress('翻译完成', 100);
    setTimeout(hideProgress, 2000);
  } catch (e) {
    console.debug('划词翻译: 全页翻译异常', e);
    showProgress('翻译出错，请刷新页面后重试', 0);
    setTimeout(hideProgress, 3000);
  } finally {
    pageTranslationInProgress = false;
  }
}

// 恢复页面原文
function restorePageTexts() {
  const nodes = Array.from(walkTextNodes());
  for (const node of nodes) {
    const orig = originalTexts.get(node);
    if (orig !== undefined && node.nodeValue !== orig) {
      node.nodeValue = orig;
    }
  }
  // 不清理 originalTexts，保留以便再次恢复
}

// ─── 进度条 ──────────────────────────────────────────────

let progressBar = null;
let progressFill = null;
let progressText = null;

function showProgress(msg, pct) {
  if (!progressBar) {
    progressBar = document.createElement('div');
    progressBar.id = 'chrome-ext-translate-progress';
    progressBar.style.top = `${window.scrollY}px`;
    progressBar.innerHTML = '<div class="translate-ext-progress-fill"></div>';
    document.body.appendChild(progressBar);

    progressFill = progressBar.querySelector('.translate-ext-progress-fill');

    progressText = document.createElement('div');
    progressText.className = 'translate-ext-progress-text';
    progressText.style.top = `${window.scrollY + 8}px`;
    document.body.appendChild(progressText);

    // 懒注册：仅进度条存在期间监听滚动，避免在每个页面常驻高频回调
    document.addEventListener('scroll', handleProgressScroll, { passive: true });
  }

  // 滚动时更新位置
  progressBar.style.top = `${window.scrollY}px`;
  progressText.style.top = `${window.scrollY + 8}px`;

  if (progressFill) progressFill.style.width = `${pct}%`;
  if (progressText) progressText.textContent = msg;
}

function hideProgress() {
  if (progressBar) { progressBar.remove(); progressBar = null; progressFill = null; }
  if (progressText) { progressText.remove(); progressText = null; }
  document.removeEventListener('scroll', handleProgressScroll);
}

// 滚动时更新进度条位置（仅在进度条存在期间挂载，见 showProgress/hideProgress）
function handleProgressScroll() {
  if (progressBar) {
    progressBar.style.top = `${window.scrollY}px`;
    if (progressText) progressText.style.top = `${window.scrollY + 8}px`;
  }
}

// ─── 消息监听 ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'translatePage') {
    if (isExtensionAlive()) {
      startPageTranslation();
      sendResponse({ received: true });
    } else {
      sendResponse({ received: false, error: '插件上下文已失效' });
    }
  }
});