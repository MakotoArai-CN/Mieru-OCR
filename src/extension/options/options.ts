const elements: Record<string, HTMLElement | NodeListOf<HTMLElement> | null> = {};

async function init() {
  cacheElements();
  bindEvents();
  await applyTheme();
  await loadSettings();
  await loadRules();
  displayVersion();
}

function cacheElements() {
  elements.navItems = document.querySelectorAll('.nav-item');
  elements.sections = document.querySelectorAll('.section');
  elements.theme = document.getElementById('theme');
  elements.autoFill = document.getElementById('autoFill');
  elements.autoSolveOnRule = document.getElementById('autoSolveOnRule');
  elements.autoSubmit = document.getElementById('autoSubmit');
  elements.captchaSelector = document.getElementById('captchaSelector');
  elements.inputSelector = document.getElementById('inputSelector');
  elements.submitSelector = document.getElementById('submitSelector');
  elements.agreementSelector = document.getElementById('agreementSelector');
  elements.timeout = document.getElementById('timeout');
  elements.retryCount = document.getElementById('retryCount');
  elements.debugMode = document.getElementById('debugMode');
  elements.rulesList = document.getElementById('rules-list');
  elements.bulkRules = document.getElementById('bulk-rules');
  elements.toast = document.getElementById('toast');
  elements.toastMessage = document.getElementById('toast-message');
  elements.fileImport = document.getElementById('file-import');
}

function bindEvents() {
  (elements.navItems as NodeListOf<HTMLElement>).forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      switchSection(item.dataset.section!);
    });
  });

  document.getElementById('btn-save-general')?.addEventListener('click', saveGeneralSettings);
  document.getElementById('btn-save-advanced')?.addEventListener('click', saveAdvancedSettings);
  document.getElementById('btn-export-rules')?.addEventListener('click', exportRules);
  document.getElementById('btn-import-rules')?.addEventListener('click', () => triggerImport('rules'));
  document.getElementById('btn-add-bulk-rules')?.addEventListener('click', addBulkRules);
  document.getElementById('btn-export-config')?.addEventListener('click', exportConfig);
  document.getElementById('btn-import-config')?.addEventListener('click', () => triggerImport('config'));
  document.getElementById('btn-reset-all')?.addEventListener('click', resetAll);

  (elements.fileImport as HTMLInputElement)?.addEventListener('change', handleFileImport);

  (elements.theme as HTMLSelectElement)?.addEventListener('change', async () => {
    const settings = await getSettings();
    settings.theme = (elements.theme as HTMLSelectElement).value;
    await saveSettings(settings);
    await applyTheme();
  });
}

function switchSection(sectionId: string) {
  (elements.navItems as NodeListOf<HTMLElement>).forEach(item => {
    item.classList.toggle('active', item.dataset.section === sectionId);
  });
  (elements.sections as NodeListOf<HTMLElement>).forEach(section => {
    section.classList.toggle('active', section.id === sectionId);
  });
}

async function applyTheme() {
  const settings = await getSettings();
  const theme = settings.theme || 'auto';
  let effectiveTheme = theme;
  if (theme === 'auto') {
    effectiveTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.body.setAttribute('data-theme', effectiveTheme);
}

async function getSettings(): Promise<any> {
  const result = await chrome.storage.local.get('settings');
  return result.settings || getDefaultSettings();
}

async function saveSettings(settings: any): Promise<void> {
  await chrome.storage.local.set({ settings });
}

function getDefaultSettings() {
  return {
    theme: 'auto',
    autoFill: true,
    autoSolveOnRule: false,
    autoSubmit: false,
    captchaSelector: '',
    inputSelector: '',
    submitSelector: '',
    agreementSelector: '',
    timeout: 30000,
    retryCount: 3,
    debugMode: false,
  };
}

async function loadSettings() {
  const settings = await getSettings();
  (elements.theme as HTMLSelectElement).value = settings.theme || 'auto';
  (elements.autoFill as HTMLInputElement).checked = settings.autoFill !== false;
  (elements.autoSolveOnRule as HTMLInputElement).checked = settings.autoSolveOnRule || false;
  (elements.autoSubmit as HTMLInputElement).checked = settings.autoSubmit || false;
  (elements.captchaSelector as HTMLInputElement).value = settings.captchaSelector || '';
  (elements.inputSelector as HTMLInputElement).value = settings.inputSelector || '';
  (elements.submitSelector as HTMLInputElement).value = settings.submitSelector || '';
  (elements.agreementSelector as HTMLInputElement).value = settings.agreementSelector || '';
  (elements.timeout as HTMLInputElement).value = String((settings.timeout || 30000) / 1000);
  (elements.retryCount as HTMLInputElement).value = String(settings.retryCount || 3);
  (elements.debugMode as HTMLInputElement).checked = settings.debugMode || false;
}

async function saveGeneralSettings() {
  const settings = await getSettings();
  settings.theme = (elements.theme as HTMLSelectElement).value;
  settings.autoFill = (elements.autoFill as HTMLInputElement).checked;
  settings.autoSolveOnRule = (elements.autoSolveOnRule as HTMLInputElement).checked;
  settings.autoSubmit = (elements.autoSubmit as HTMLInputElement).checked;
  settings.captchaSelector = (elements.captchaSelector as HTMLInputElement).value.trim();
  settings.inputSelector = (elements.inputSelector as HTMLInputElement).value.trim();
  settings.submitSelector = (elements.submitSelector as HTMLInputElement).value.trim();
  settings.agreementSelector = (elements.agreementSelector as HTMLInputElement).value.trim();
  await saveSettings(settings);
  showToast('设置已保存', 'success');
}

async function saveAdvancedSettings() {
  const settings = await getSettings();
  settings.timeout = parseInt((elements.timeout as HTMLInputElement).value) * 1000;
  settings.retryCount = parseInt((elements.retryCount as HTMLInputElement).value);
  settings.debugMode = (elements.debugMode as HTMLInputElement).checked;
  await saveSettings(settings);
  showToast('设置已保存', 'success');
}

async function loadRules() {
  const result = await chrome.storage.local.get('siteRules');
  const rules = result.siteRules || {};
  const rulesList = elements.rulesList as HTMLElement;

  if (Object.keys(rules).length === 0) {
    rulesList.innerHTML = '<div class="empty-state"><p>暂无保存的规则</p><span>使用弹窗中的"选择元素"功能添加规则</span></div>';
    return;
  }

  rulesList.innerHTML = Object.entries(rules).map(([hostname, rule]: [string, any]) => `
    <div class="rule-item" data-hostname="${hostname}">
      <div class="rule-info">
        <div class="rule-hostname">${hostname}</div>
        <div class="rule-selector">${rule.selector}</div>
      </div>
      <div class="rule-actions">
        <button class="btn btn-secondary btn-sm btn-edit-rule">编辑</button>
        <button class="btn btn-danger btn-sm btn-delete-rule">删除</button>
      </div>
    </div>
  `).join('');

  rulesList.querySelectorAll('.btn-delete-rule').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const item = (e.target as HTMLElement).closest('.rule-item') as HTMLElement;
      const hostname = item.dataset.hostname;
      await chrome.runtime.sendMessage({ action: 'deleteSiteRule', hostname });
      await loadRules();
      showToast('规则已删除', 'success');
    });
  });
}

async function addBulkRules() {
  const text = (elements.bulkRules as HTMLTextAreaElement).value.trim();
  if (!text) {
    showToast('请输入规则', 'error');
    return;
  }

  try {
    const rules = JSON.parse(text);
    if (!Array.isArray(rules)) throw new Error('格式错误');

    for (const rule of rules) {
      if (!rule.hostname || !rule.selector) continue;
      await chrome.runtime.sendMessage({
        action: 'saveSiteRule',
        hostname: rule.hostname,
        rule: { selector: rule.selector, inputSelector: rule.inputSelector, enabled: true }
      });
    }

    (elements.bulkRules as HTMLTextAreaElement).value = '';
    await loadRules();
    showToast(`已添加 ${rules.length} 条规则`, 'success');
  } catch {
    showToast('JSON格式错误', 'error');
  }
}

async function exportRules() {
  const result = await chrome.storage.local.get('siteRules');
  const rules = result.siteRules || {};
  const exportData = Object.entries(rules).map(([hostname, rule]: [string, any]) => ({
    hostname,
    selector: rule.selector,
    inputSelector: rule.inputSelector,
  }));
  downloadJson(exportData, 'ddddocr-rules.json');
}

async function exportConfig() {
  const result = await chrome.storage.local.get(['settings', 'siteRules']);
  downloadJson(result, 'ddddocr-config.json');
}

function downloadJson(data: any, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

let importMode = '';

function triggerImport(mode: string) {
  importMode = mode;
  (elements.fileImport as HTMLInputElement).click();
}

async function handleFileImport(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (importMode === 'rules') {
      if (!Array.isArray(data)) throw new Error('格式错误');
      for (const rule of data) {
        if (!rule.hostname || !rule.selector) continue;
        await chrome.runtime.sendMessage({
          action: 'saveSiteRule',
          hostname: rule.hostname,
          rule: { selector: rule.selector, inputSelector: rule.inputSelector, enabled: true }
        });
      }
      await loadRules();
      showToast('规则已导入', 'success');
    } else if (importMode === 'config') {
      await chrome.storage.local.set(data);
      await loadSettings();
      await loadRules();
      showToast('配置已导入', 'success');
    }
  } catch {
    showToast('导入失败，请检查文件格式', 'error');
  }

  (elements.fileImport as HTMLInputElement).value = '';
}

async function resetAll() {
  if (!confirm('确定要重置所有设置吗？此操作不可恢复。')) return;
  await chrome.storage.local.clear();
  await loadSettings();
  await loadRules();
  showToast('已重置所有设置', 'success');
}

function showToast(message: string, type: 'success' | 'error') {
  (elements.toast as HTMLElement).className = `toast ${type}`;
  (elements.toastMessage as HTMLElement).textContent = message;
  (elements.toast as HTMLElement).classList.remove('hidden');
  setTimeout(() => (elements.toast as HTMLElement).classList.add('hidden'), 3000);
}

document.addEventListener('DOMContentLoaded', init);

function displayVersion() {
  const manifest = chrome.runtime.getManifest();
  const versionEl = document.getElementById('app-version');
  if (versionEl) {
    versionEl.textContent = manifest.version;
  }
}

export {};