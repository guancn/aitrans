let popupContainer = null;
let iconContainer = null;
let isContextInvalidated = false;

// 缓存用户配置，避免高频划词时产生多余的异步 IPC 开销
let userConfig = { triggerMode: 'icon' };
try {
  if (chrome.runtime && chrome.runtime.id) {
    chrome.storage.sync.get(['triggerMode'], (items) => {
      if (!chrome.runtime.lastError && items && items.triggerMode) {
        userConfig.triggerMode = items.triggerMode;
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes.triggerMode) {
        userConfig.triggerMode = changes.triggerMode.newValue;
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
             <span class="translate-ext-lang">${response.sourceLang.toUpperCase()}</span>
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