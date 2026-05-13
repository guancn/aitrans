// 默认提示词，与 background.js 保持同步
// ⚠️ 修改此处时请同步更新 background.js 中的 DEFAULT_SYSTEM_PROMPT
const DEFAULT_PROMPT =
  'You are a professional {{targetLang}} translator. ' +
  'Translate naturally by meaning, not word-for-word. ' +
  'Adapt idioms and cultural references to sound native. ' +
  'Preserve proper nouns, code, numbers, URLs and formatting as-is. ' +
  'If the text is already in {{targetLang}}, return it unchanged. ' +
  'Be concise — match the source length and tone. ' +
  'Output ONLY JSON (no markdown fences): {"source_lang":"<detected>","translated_text":"<translation>"}';

document.addEventListener('DOMContentLoaded', () => {
  // ─── 元素引用 ────────────────────────────
  // 划词翻译模式
  const targetLangSelect = document.getElementById('targetLang');
  const triggerModeSelect = document.getElementById('triggerMode');
  const translationServiceSelect = document.getElementById('translationService');
  const apiKeyInput = document.getElementById('apiKey');
  const toggleBtn = document.getElementById('toggleApiKey');
  const systemPromptInput = document.getElementById('systemPrompt');
  const resetBtn = document.getElementById('resetPrompt');
  const apiKeySection = document.getElementById('apiKeySection');
  const promptSection = document.getElementById('promptSection');
  // 全页翻译模式
  const fpTargetLangSelect = document.getElementById('fpTargetLang');
  const fpTranslationServiceSelect = document.getElementById('fpTranslationService');
  const fpApiKeyInput = document.getElementById('fpApiKey');
  const fpToggleBtn = document.getElementById('fpToggleApiKey');
  const fpSystemPromptInput = document.getElementById('fpSystemPrompt');
  const fpResetBtn = document.getElementById('fpResetPrompt');
  const fpApiKeySection = document.getElementById('fpApiKeySection');
  const fpPromptSection = document.getElementById('fpPromptSection');
  const translatePageBtn = document.getElementById('translatePageBtn');
  const pageTranslateStatus = document.getElementById('pageTranslateStatus');
  // 分段控件
  const segSelection = document.getElementById('segSelection');
  const segFullpage = document.getElementById('segFullpage');
  const selectionModeSettings = document.getElementById('selectionModeSettings');
  const fullpageModeSettings = document.getElementById('fullpageModeSettings');
  // 共享
  const saveStatus = document.getElementById('saveStatus');

  let currentMode = 'selection';

  // ─── 从旧 fullPageTranslate 迁移 ──────────
  function migrateFromOldConfig(allItems) {
    if (allItems.fullPageTranslate === true && allItems.activeMode === undefined) {
      currentMode = 'fullpage';
      chrome.storage.sync.set({ activeMode: 'fullpage' }, () => {
        if (!chrome.runtime.lastError) {
          chrome.storage.sync.remove('fullPageTranslate');
        }
      });
      return true;
    }
    return false;
  }

  // ─── 渲染当前模式 ────────────────────────────
  function renderActiveMode(mode) {
    currentMode = mode;
    if (mode === 'fullpage') {
      segSelection.classList.remove('active');
      segFullpage.classList.add('active');
      selectionModeSettings.style.display = 'none';
      fullpageModeSettings.style.display = '';
    } else {
      segFullpage.classList.remove('active');
      segSelection.classList.add('active');
      selectionModeSettings.style.display = '';
      fullpageModeSettings.style.display = 'none';
    }
  }

  // ─── 按模式切换 DeepSeek 设置可见性 ─────────────
  function toggleDeepSeekSections() {
    if (currentMode === 'selection') {
      const isDeepSeek = translationServiceSelect.value === 'deepseek';
      apiKeySection.style.display = isDeepSeek ? '' : 'none';
      promptSection.style.display = isDeepSeek ? '' : 'none';
    } else {
      const isDeepSeek = fpTranslationServiceSelect.value === 'deepseek';
      fpApiKeySection.style.display = isDeepSeek ? '' : 'none';
      fpPromptSection.style.display = isDeepSeek ? '' : 'none';
    }
  }

  // ─── 各模式独立的保存函数 ───────────────────────
  function saveSelectionSettings() {
    chrome.storage.sync.set({
      targetLang: targetLangSelect.value,
      triggerMode: triggerModeSelect.value,
      translationService: translationServiceSelect.value,
      apiKey: apiKeyInput.value.trim(),
      systemPrompt: systemPromptInput.value.trim() || DEFAULT_PROMPT
    }, saveCallback);
  }

  function saveFullpageSettings() {
    chrome.storage.sync.set({
      fp_targetLang: fpTargetLangSelect.value,
      fp_translationService: fpTranslationServiceSelect.value,
      fp_apiKey: fpApiKeyInput.value.trim(),
      fp_systemPrompt: fpSystemPromptInput.value.trim() || DEFAULT_PROMPT
    }, saveCallback);
  }

  function saveCallback() {
    if (chrome.runtime.lastError) {
      saveStatus.textContent = '保存失败，请重试';
      saveStatus.classList.add('show');
      saveStatus.style.color = '#d93025';
      setTimeout(() => { saveStatus.classList.remove('show'); saveStatus.style.color = ''; }, 3000);
      return;
    }
    saveStatus.textContent = '已保存！';
    saveStatus.classList.add('show');
    setTimeout(() => saveStatus.classList.remove('show'), 2000);
  }

  // ─── 分段控件事件 ────────────────────
  segSelection.addEventListener('click', () => {
    if (currentMode === 'selection') return;
    renderActiveMode('selection');
    toggleDeepSeekSections();
    chrome.storage.sync.set({ activeMode: 'selection' });
  });

  segFullpage.addEventListener('click', () => {
    if (currentMode === 'fullpage') return;
    renderActiveMode('fullpage');
    toggleDeepSeekSections();
    chrome.storage.sync.set({ activeMode: 'fullpage' });
  });

  // ─── 翻译当前网页按钮 ─────────────────────────
  translatePageBtn.addEventListener('click', () => {
    const btnTimeout = setTimeout(() => {
      if (pageTranslateStatus) {
        pageTranslateStatus.textContent = '请求超时，请重试';
        pageTranslateStatus.style.color = '#d93025';
      }
    }, 30000);

    pageTranslateStatus.style.display = 'block';
    pageTranslateStatus.textContent = '正在发送翻译请求...';
    pageTranslateStatus.style.color = '#5f6368';

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) {
        clearTimeout(btnTimeout);
        pageTranslateStatus.textContent = '无法获取当前页面';
        pageTranslateStatus.style.color = '#d93025';
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, { action: 'translatePage' }, (response) => {
        clearTimeout(btnTimeout);
        if (chrome.runtime.lastError) {
          pageTranslateStatus.textContent = '发送失败，请刷新页面后重试';
          pageTranslateStatus.style.color = '#d93025';
          return;
        }
        if (response && response.received) {
          pageTranslateStatus.textContent = '翻译已开始，请查看页面';
          pageTranslateStatus.style.color = '#1e8e3e';
          setTimeout(() => { pageTranslateStatus.style.display = 'none'; }, 3000);
        } else {
          pageTranslateStatus.textContent = '翻译请求被拒绝';
          pageTranslateStatus.style.color = '#d93025';
        }
      });
    });
  });

  // ─── 初始化：加载所有配置 ─────────────────────────
  chrome.storage.sync.get({
    // 划词翻译默认值
    targetLang: 'zh-CN',
    triggerMode: 'icon',
    translationService: 'deepseek',
    apiKey: '',
    systemPrompt: DEFAULT_PROMPT,
    // 全页翻译默认值
    fp_targetLang: 'zh-CN',
    fp_translationService: 'google',
    fp_apiKey: '',
    fp_systemPrompt: DEFAULT_PROMPT,
    // 全局
    activeMode: 'selection',
    // 迁移键
    fullPageTranslate: undefined
  }, (items) => {
    // 迁移检查
    const migrated = migrateFromOldConfig(items);

    // 设置划词翻译模式值
    targetLangSelect.value = items.targetLang;
    triggerModeSelect.value = items.triggerMode;
    translationServiceSelect.value = items.translationService;
    apiKeyInput.value = items.apiKey;
    systemPromptInput.value = items.systemPrompt || DEFAULT_PROMPT;

    // 设置全页翻译模式值
    fpTargetLangSelect.value = items.fp_targetLang;
    fpTranslationServiceSelect.value = items.fp_translationService;
    fpApiKeyInput.value = items.fp_apiKey;
    fpSystemPromptInput.value = items.fp_systemPrompt || DEFAULT_PROMPT;

    // 设置当前模式
    renderActiveMode(migrated ? 'fullpage' : (items.activeMode || 'selection'));
    toggleDeepSeekSections();
  });

  // ─── 划词翻译模式事件监听 ────────────────
  targetLangSelect.addEventListener('change', saveSelectionSettings);
  triggerModeSelect.addEventListener('change', saveSelectionSettings);
  translationServiceSelect.addEventListener('change', () => { toggleDeepSeekSections(); saveSelectionSettings(); });
  apiKeyInput.addEventListener('blur', saveSelectionSettings);
  apiKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') apiKeyInput.blur(); });
  systemPromptInput.addEventListener('blur', saveSelectionSettings);

  toggleBtn.addEventListener('click', () => {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  });

  resetBtn.addEventListener('click', () => {
    systemPromptInput.value = DEFAULT_PROMPT;
    saveSelectionSettings();
  });

  // ─── 全页翻译模式事件监听 ─────────────────
  fpTargetLangSelect.addEventListener('change', saveFullpageSettings);
  fpTranslationServiceSelect.addEventListener('change', () => { toggleDeepSeekSections(); saveFullpageSettings(); });
  fpApiKeyInput.addEventListener('blur', saveFullpageSettings);
  fpApiKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fpApiKeyInput.blur(); });
  fpSystemPromptInput.addEventListener('blur', saveFullpageSettings);

  fpToggleBtn.addEventListener('click', () => {
    fpApiKeyInput.type = fpApiKeyInput.type === 'password' ? 'text' : 'password';
  });

  fpResetBtn.addEventListener('click', () => {
    fpSystemPromptInput.value = DEFAULT_PROMPT;
    saveFullpageSettings();
  });
});
