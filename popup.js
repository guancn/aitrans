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
  const targetLangSelect = document.getElementById('targetLang');
  const triggerModeSelect = document.getElementById('triggerMode');
  const apiKeyInput = document.getElementById('apiKey');
  const systemPromptInput = document.getElementById('systemPrompt');
  const toggleBtn = document.getElementById('toggleApiKey');
  const resetBtn = document.getElementById('resetPrompt');
  const saveStatus = document.getElementById('saveStatus');
  const translationServiceSelect = document.getElementById('translationService');
  const apiKeySection = document.getElementById('apiKeySection');
  const promptSection = document.getElementById('promptSection');

  chrome.storage.sync.get({
    targetLang: 'zh-CN',
    triggerMode: 'icon',
    translationService: 'deepseek',
    apiKey: '',
    systemPrompt: DEFAULT_PROMPT
  }, (items) => {
    targetLangSelect.value = items.targetLang;
    triggerModeSelect.value = items.triggerMode;
    translationServiceSelect.value = items.translationService || 'deepseek';
    apiKeyInput.value = items.apiKey;
    systemPromptInput.value = items.systemPrompt || DEFAULT_PROMPT;
    toggleDeepSeekSections();
  });

  // 根据所选翻译服务显示/隐藏 DeepSeek 专属设置（API Key、提示词）
  function toggleDeepSeekSections() {
    const isDeepSeek = translationServiceSelect.value === 'deepseek';
    apiKeySection.style.display = isDeepSeek ? '' : 'none';
    promptSection.style.display = isDeepSeek ? '' : 'none';
  }

  function saveSettings() {
    chrome.storage.sync.set({
      targetLang: targetLangSelect.value,
      triggerMode: triggerModeSelect.value,
      translationService: translationServiceSelect.value,
      apiKey: apiKeyInput.value.trim(),
      systemPrompt: systemPromptInput.value.trim() || DEFAULT_PROMPT
    }, () => {
      saveStatus.textContent = '已保存！';
      saveStatus.classList.add('show');
      setTimeout(() => saveStatus.classList.remove('show'), 2000);
    });
  }

  targetLangSelect.addEventListener('change', saveSettings);
  triggerModeSelect.addEventListener('change', saveSettings);
  translationServiceSelect.addEventListener('change', () => {
    toggleDeepSeekSections();
    saveSettings();
  });
  apiKeyInput.addEventListener('blur', saveSettings);
  systemPromptInput.addEventListener('blur', saveSettings);
  apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      apiKeyInput.blur();
    }
  });

  toggleBtn.addEventListener('click', () => {
    const isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
  });

  resetBtn.addEventListener('click', () => {
    systemPromptInput.value = DEFAULT_PROMPT;
    saveSettings();
  });
});
