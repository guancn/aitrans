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
  const modelWarning = document.getElementById('modelWarning');
  const systemPromptInput = document.getElementById('systemPrompt');
  const resetBtn = document.getElementById('resetPrompt');
  const promptSection = document.getElementById('promptSection');
  // 全页翻译模式
  const fpTargetLangSelect = document.getElementById('fpTargetLang');
  const fpTranslationServiceSelect = document.getElementById('fpTranslationService');
  const fpModelWarning = document.getElementById('fpModelWarning');
  const fpSystemPromptInput = document.getElementById('fpSystemPrompt');
  const fpResetBtn = document.getElementById('fpResetPrompt');
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
  let models = [];

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

  // ─── 翻译服务下拉：Google + 模型列表 ─────────
  function renderServiceOptions(select, value) {
    select.textContent = '';
    const add = (v, label) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      select.appendChild(o);
    };
    add('google', 'Google 翻译 (免费)');
    for (const m of models) add(m.id, m.name);
    select.value = value === 'google' || models.some(m => m.id === value) ? value : 'google';
  }

  // 所选模型缺 Key / 未授权时提示，点击跳转模型管理
  function updateModelWarning(select, warnEl) {
    warnEl.hidden = true;
    const m = models.find(x => x.id === select.value);
    if (!m) return;
    if (!m.apiKey) {
      warnEl.textContent = '该模型未填写 API Key，点此前往模型管理';
      warnEl.hidden = false;
      return;
    }
    let origin;
    try { origin = new URL(m.baseUrl).origin + '/*'; } catch (_) { return; }
    chrome.permissions.contains({ origins: [origin] }).then((ok) => {
      if (!ok && select.value === m.id) {
        warnEl.textContent = '未授权访问该模型地址，点此前往模型管理';
        warnEl.hidden = false;
      }
    }).catch(() => {});
  }

  // ─── 选 Google 时隐藏提示词区与模型警告 ─────────────
  function toggleModelSections() {
    promptSection.style.display = translationServiceSelect.value === 'google' ? 'none' : '';
    updateModelWarning(translationServiceSelect, modelWarning);
    fpPromptSection.style.display = fpTranslationServiceSelect.value === 'google' ? 'none' : '';
    updateModelWarning(fpTranslationServiceSelect, fpModelWarning);
  }

  // ─── 各模式独立的保存函数 ───────────────────────
  function saveSelectionSettings() {
    chrome.storage.sync.set({
      targetLang: targetLangSelect.value,
      triggerMode: triggerModeSelect.value,
      translationService: translationServiceSelect.value,
      systemPrompt: systemPromptInput.value.trim() || DEFAULT_PROMPT
    }, saveCallback);
  }

  function saveFullpageSettings() {
    chrome.storage.sync.set({
      fp_targetLang: fpTargetLangSelect.value,
      fp_translationService: fpTranslationServiceSelect.value,
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
    chrome.storage.sync.set({ activeMode: 'selection' });
  });

  segFullpage.addEventListener('click', () => {
    if (currentMode === 'fullpage') return;
    renderActiveMode('fullpage');
    chrome.storage.sync.set({ activeMode: 'fullpage' });
  });

  // ─── 模型管理入口 ─────────────────────────
  document.querySelectorAll('.manage-models, .model-warning').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
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
  function loadAll() {
    chrome.storage.sync.get({
      // 划词翻译默认值
      targetLang: 'zh-CN',
      triggerMode: 'icon',
      translationService: 'deepseek',
      systemPrompt: DEFAULT_PROMPT,
      // 全页翻译默认值
      fp_targetLang: 'zh-CN',
      fp_translationService: 'google',
      fp_systemPrompt: DEFAULT_PROMPT,
      // 全局
      activeMode: 'selection',
      models: [],
      // 迁移键
      fullPageTranslate: undefined
    }, (items) => {
      models = Array.isArray(items.models) ? items.models : [];
      const migrated = migrateFromOldConfig(items);

      targetLangSelect.value = items.targetLang;
      triggerModeSelect.value = items.triggerMode;
      renderServiceOptions(translationServiceSelect, items.translationService);
      systemPromptInput.value = items.systemPrompt || DEFAULT_PROMPT;

      fpTargetLangSelect.value = items.fp_targetLang;
      renderServiceOptions(fpTranslationServiceSelect, items.fp_translationService);
      fpSystemPromptInput.value = items.fp_systemPrompt || DEFAULT_PROMPT;

      renderActiveMode(migrated ? 'fullpage' : (items.activeMode || 'selection'));
      toggleModelSections();
    });
  }

  // 先让 background 完成旧 apiKey → 模型列表的迁移（同时唤醒 SW），再读取存储
  chrome.runtime.sendMessage({ action: 'ensureConfig' }, () => {
    void chrome.runtime.lastError;
    loadAll();
  });

  // 选项页增删模型时实时刷新下拉
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.models) return;
    models = changes.models.newValue || [];
    renderServiceOptions(translationServiceSelect, translationServiceSelect.value);
    renderServiceOptions(fpTranslationServiceSelect, fpTranslationServiceSelect.value);
    toggleModelSections();
  });

  // ─── 划词翻译模式事件监听 ────────────────
  targetLangSelect.addEventListener('change', saveSelectionSettings);
  triggerModeSelect.addEventListener('change', saveSelectionSettings);
  translationServiceSelect.addEventListener('change', () => { toggleModelSections(); saveSelectionSettings(); });
  systemPromptInput.addEventListener('blur', saveSelectionSettings);

  resetBtn.addEventListener('click', () => {
    systemPromptInput.value = DEFAULT_PROMPT;
    saveSelectionSettings();
  });

  // ─── 全页翻译模式事件监听 ─────────────────
  fpTargetLangSelect.addEventListener('change', saveFullpageSettings);
  fpTranslationServiceSelect.addEventListener('change', () => { toggleModelSections(); saveFullpageSettings(); });
  fpSystemPromptInput.addEventListener('blur', saveFullpageSettings);

  fpResetBtn.addEventListener('click', () => {
    fpSystemPromptInput.value = DEFAULT_PROMPT;
    saveFullpageSettings();
  });
});
