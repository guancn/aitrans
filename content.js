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
      if (area === 'sync' && changes.triggerMode) {
        userConfig.triggerMode = changes.triggerMode.newValue;
      }
      if (area === 'sync' && changes.activeMode) {
        userConfig.activeMode = changes.activeMode.newValue;
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
  // Built-in lightweight SVG Translate Icon
  iconContainer.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z" fill="#ffffff"/>
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
       iconContainer.classList.add('loading');
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
    if (popupContainer) {
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
             <span class="translate-ext-logo">智能翻译</span>
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
      const tag = node.parentElement.tagName;
      if (SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;

      // 跳过插件自己的 UI 元素
      let el = node.parentElement;
      while (el) {
        const id = el.id || '';
        if (id.startsWith('chrome-ext-translate-')) return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }

      // 跳过空白或太短的文本
      const txt = (node.nodeValue || '').trim();
      if (txt.length < 1) return NodeFilter.FILTER_REJECT;

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

    // 保存原文
    for (const node of nodes) {
      if (!originalTexts.has(node)) {
        originalTexts.set(node, node.nodeValue);
      }
    }

    showProgress('正在收集文本...', 0);

    // 提取纯文本数组
    const texts = nodes.map(n => (n.nodeValue || '').trim());

    // 分批发送（每批最多 20 条）
    const BATCH_SIZE = 20;
    const batches = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      batches.push({
        index: i,
        texts: texts.slice(i, i + BATCH_SIZE),
        nodes: nodes.slice(i, i + BATCH_SIZE)
      });
    }

    const total = batches.length;
    let completed = 0;
    const MAX_CONCURRENT = 3;

    showProgress('正在翻译...', 0);

    // 并发批量调度：每次最多 MAX_CONCURRENT 批并行
    for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
      const chunk = batches.slice(i, i + MAX_CONCURRENT);
      const results = await Promise.all(chunk.map(batch =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { action: 'translateBatch', texts: batch.texts },
            (response) => {
              resolve(chrome.runtime.lastError ? null : response);
            }
          );
        })
      ));

      // 处理结果
      for (let j = 0; j < chunk.length; j++) {
        const batch = chunk[j];
        const result = results[j];
        if (result && Array.isArray(result)) {
          for (let k = 0; k < result.length; k++) {
            const node = batch.nodes[k];
            const r = result[k];
            if (r && r.success && r.translatedText && node) {
              node.nodeValue = r.translatedText;
            }
          }
        }
        completed++;
      }

      const pct = Math.round((completed / total) * 100);
      showProgress(`正在翻译... ${completed}/${total} 段 (${pct}%)`, pct);
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
}

// 滚动时更新进度条位置
function handleProgressScroll() {
  if (progressBar) {
    progressBar.style.top = `${window.scrollY}px`;
    if (progressText) progressText.style.top = `${window.scrollY + 8}px`;
  }
}
document.addEventListener('scroll', handleProgressScroll, { passive: true });

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