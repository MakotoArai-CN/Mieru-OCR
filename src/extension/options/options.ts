import { showConfirm } from '../ui/modal';

interface CalculateRule {
  pattern: string;
  matchType: 'wildcard' | 'regex';
  outputMode: 'result' | 'equation';
  enabled: boolean;
}

interface SiteRule {
  selector: string;
  inputSelector?: string;
  submitSelector?: string;
  agreementSelectors?: string[];
  fullUrl?: string;
  urlPattern?: string;
  hostname?: string;
  enabled: boolean;
  createdAt?: number;
  updatedAt?: number;
}

const elements: Record<string, HTMLElement | NodeListOf<HTMLElement> | null> = {};
let currentEditRuleKey: string | null = null;

async function init(): Promise<void> {
  cacheElements();
  bindEvents();
  await applyTheme();
  await loadSettings();
  await loadRules();
  await loadStats();
  displayVersion();
}

function cacheElements(): void {
  elements.navItems = document.querySelectorAll('.nav-item');
  elements.sections = document.querySelectorAll('.section');
  elements.theme = document.getElementById('theme');
  elements.autoFill = document.getElementById('autoFill');
  elements.typewriterEffect = document.getElementById('typewriterEffect');
  elements.autoSolveOnRule = document.getElementById('autoSolveOnRule');
  elements.autoSubmit = document.getElementById('autoSubmit');
  elements.autoCheckAgreement = document.getElementById('autoCheckAgreement');
  elements.captchaSelector = document.getElementById('captchaSelector');
  elements.inputSelector = document.getElementById('inputSelector');
  elements.submitSelector = document.getElementById('submitSelector');
  elements.agreementSelectors = document.getElementById('agreementSelectors');
  elements.newAgreementSelector = document.getElementById('newAgreementSelector');
  elements.autoCalculate = document.getElementById('autoCalculate');
  elements.calculateOutputMode = document.getElementById('calculateOutputMode');
  elements.calculateOptionsGroup = document.getElementById('calculateOptionsGroup');
  elements.calculateRulesCard = document.getElementById('calculateRulesCard');
  elements.calculateRulesList = document.getElementById('calculate-rules-list');
  elements.timeout = document.getElementById('timeout');
  elements.retryCount = document.getElementById('retryCount');
  elements.debugMode = document.getElementById('debugMode');
  elements.rulesList = document.getElementById('rules-list');
  elements.bulkRules = document.getElementById('bulk-rules');
  elements.toast = document.getElementById('toast');
  elements.toastMessage = document.getElementById('toast-message');
  elements.fileImport = document.getElementById('file-import');
  elements.customIncludeKeywords = document.getElementById('customIncludeKeywords');
  elements.customExcludePatterns = document.getElementById('customExcludePatterns');
  elements.siteBlacklist = document.getElementById('siteBlacklist');
  elements.editRuleKey = document.getElementById('edit-rule-key');
  elements.editRuleOriginalKey = document.getElementById('edit-rule-original-key');
  elements.editRuleSelector = document.getElementById('edit-rule-selector');
  elements.editRuleInput = document.getElementById('edit-rule-input');
  elements.editRuleUrl = document.getElementById('edit-rule-url');
  elements.statsTotal = document.getElementById('stats-total');
  elements.statsSitesCount = document.getElementById('stats-sites-count');
  elements.statsAvgTime = document.getElementById('stats-avg-time');
  elements.statsUpdated = document.getElementById('stats-updated');
  elements.statsList = document.getElementById('stats-list');
}

function bindEvents(): void {
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
  document.getElementById('btn-add-calc-rule')?.addEventListener('click', addCalculateRule);
  document.getElementById('btn-add-agreement')?.addEventListener('click', addAgreementSelector);
  document.getElementById('btn-clear-stats')?.addEventListener('click', clearStats);
  document.getElementById('btn-save-edit-rule')?.addEventListener('click', saveEditRule);
  document.getElementById('btn-cancel-edit-rule')?.addEventListener('click', cancelEditRule);

  (elements.fileImport as HTMLInputElement)?.addEventListener('change', handleFileImport);

  (elements.theme as HTMLSelectElement)?.addEventListener('change', async () => {
    const settings = await getSettings();
    settings.theme = (elements.theme as HTMLSelectElement).value;
    await saveSettings(settings);
    await applyTheme();
  });

  (elements.autoCalculate as HTMLInputElement)?.addEventListener('change', () => {
    const show = (elements.autoCalculate as HTMLInputElement).checked;
    (elements.calculateOptionsGroup as HTMLElement).style.display = show ? 'block' : 'none';
    (elements.calculateRulesCard as HTMLElement).style.display = show ? 'block' : 'none';
  });
}

function switchSection(sectionId: string): void {
  (elements.navItems as NodeListOf<HTMLElement>).forEach(item => {
    item.classList.toggle('active', item.dataset.section === sectionId);
  });
  (elements.sections as NodeListOf<HTMLElement>).forEach(section => {
    section.classList.toggle('active', section.id === sectionId);
  });
}

async function applyTheme(): Promise<void> {
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

function getDefaultSettings(): any {
  return {
    theme: 'auto',
    autoFill: true,
    typewriterEffect: true,
    autoSolveOnRule: false,
    autoSubmit: false,
    autoCheckAgreement: true,
    captchaSelector: '',
    inputSelector: '',
    submitSelector: '',
    agreementSelectors: [],
    autoCalculate: false,
    calculateOutputMode: 'result',
    calculateRules: [],
    timeout: 30000,
    retryCount: 3,
    debugMode: false,
  };
}

async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  (elements.theme as HTMLSelectElement).value = settings.theme || 'auto';
  (elements.autoFill as HTMLInputElement).checked = settings.autoFill !== false;
  (elements.typewriterEffect as HTMLInputElement).checked = settings.typewriterEffect !== false;
  (elements.autoSolveOnRule as HTMLInputElement).checked = settings.autoSolveOnRule || false;
  (elements.autoSubmit as HTMLInputElement).checked = settings.autoSubmit || false;
  (elements.autoCheckAgreement as HTMLInputElement).checked = settings.autoCheckAgreement !== false;
  (elements.captchaSelector as HTMLInputElement).value = settings.captchaSelector || '';
  (elements.inputSelector as HTMLInputElement).value = settings.inputSelector || '';
  (elements.submitSelector as HTMLInputElement).value = settings.submitSelector || '';
  renderAgreementSelectors(settings.agreementSelectors || []);
  (elements.autoCalculate as HTMLInputElement).checked = settings.autoCalculate || false;
  (elements.calculateOutputMode as HTMLSelectElement).value = settings.calculateOutputMode || 'result';
  if (settings.autoCalculate) {
    (elements.calculateOptionsGroup as HTMLElement).style.display = 'block';
    (elements.calculateRulesCard as HTMLElement).style.display = 'block';
  }
  renderCalculateRules(settings.calculateRules || []);
  (elements.timeout as HTMLInputElement).value = String((settings.timeout || 30000) / 1000);
  (elements.retryCount as HTMLInputElement).value = String(settings.retryCount || 3);
  (elements.debugMode as HTMLInputElement).checked = settings.debugMode || false;
  (elements.customIncludeKeywords as HTMLTextAreaElement).value = (settings.customIncludeKeywords || []).join('\n');
  (elements.customExcludePatterns as HTMLTextAreaElement).value = (settings.customExcludePatterns || []).join('\n');
  (elements.siteBlacklist as HTMLTextAreaElement).value = (settings.siteBlacklist || []).join('\n');
}

function renderAgreementSelectors(selectors: string[]): void {
  const container = elements.agreementSelectors as HTMLElement;
  if (!container) return;
  if (!selectors || selectors.length === 0) {
    container.innerHTML = '<div class="empty-hint">暂无协议选择器</div>';
    return;
  }
  container.innerHTML = selectors.map((selector, index) => `
<div class="selector-item" data-index="${index}">
<code>${escapeHtml(selector)}</code>
<button class="btn btn-danger btn-sm btn-delete-agreement" data-index="${index}">删除</button>
</div>
`).join('');
  container.querySelectorAll('.btn-delete-agreement').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const index = parseInt((e.target as HTMLElement).dataset.index || '0');
      await deleteAgreementSelector(index);
    });
  });
}

async function addAgreementSelector(): Promise<void> {
  const input = elements.newAgreementSelector as HTMLInputElement;
  const selector = input.value.trim();
  if (!selector) {
    showToast('请输入选择器', 'error');
    return;
  }
  const settings = await getSettings();
  const selectors = settings.agreementSelectors || [];
  if (selectors.includes(selector)) {
    showToast('选择器已存在', 'error');
    return;
  }
  selectors.push(selector);
  settings.agreementSelectors = selectors;
  await saveSettings(settings);
  renderAgreementSelectors(selectors);
  input.value = '';
  showToast('选择器已添加', 'success');
}

async function deleteAgreementSelector(index: number): Promise<void> {
  const settings = await getSettings();
  const selectors = settings.agreementSelectors || [];
  selectors.splice(index, 1);
  settings.agreementSelectors = selectors;
  await saveSettings(settings);
  renderAgreementSelectors(selectors);
  showToast('选择器已删除', 'success');
}

function renderCalculateRules(rules: CalculateRule[]): void {
  const container = elements.calculateRulesList as HTMLElement;
  if (!container) return;
  if (!rules || rules.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>暂无规则，将使用默认输出格式</p></div>';
    return;
  }
  container.innerHTML = rules.map((rule, index) => `
<div class="calc-rule-item" data-index="${index}">
<div class="calc-rule-info">
<div class="calc-rule-pattern">${escapeHtml(rule.pattern)}</div>
<div class="calc-rule-meta">
<span class="calc-rule-badge">${rule.matchType === 'regex' ? '正则' : '通配符'}</span>
<span class="calc-rule-badge ${rule.outputMode === 'result' ? 'output-result' : 'output-equation'}">
${rule.outputMode === 'result' ? '仅结果' : '完整等式'}
</span>
</div>
</div>
<div class="calc-rule-actions">
<button class="btn btn-danger btn-sm btn-delete-calc-rule" data-index="${index}">删除</button>
</div>
</div>
`).join('');
  container.querySelectorAll('.btn-delete-calc-rule').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const index = parseInt((e.target as HTMLElement).dataset.index || '0');
      await deleteCalculateRule(index);
    });
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function addCalculateRule(): Promise<void> {
  const patternInput = document.getElementById('newCalcRulePattern') as HTMLInputElement;
  const matchTypeSelect = document.getElementById('newCalcRuleMatchType') as HTMLSelectElement;
  const outputModeSelect = document.getElementById('newCalcRuleOutputMode') as HTMLSelectElement;
  const pattern = patternInput.value.trim();
  if (!pattern) {
    showToast('请输入站点匹配规则', 'error');
    return;
  }
  const settings = await getSettings();
  const rules: CalculateRule[] = settings.calculateRules || [];
  rules.push({
    pattern,
    matchType: matchTypeSelect.value as 'wildcard' | 'regex',
    outputMode: outputModeSelect.value as 'result' | 'equation',
    enabled: true,
  });
  settings.calculateRules = rules;
  await saveSettings(settings);
  renderCalculateRules(rules);
  patternInput.value = '';
  showToast('规则已添加', 'success');
}

async function deleteCalculateRule(index: number): Promise<void> {
  const settings = await getSettings();
  const rules: CalculateRule[] = settings.calculateRules || [];
  rules.splice(index, 1);
  settings.calculateRules = rules;
  await saveSettings(settings);
  renderCalculateRules(rules);
  showToast('规则已删除', 'success');
}

async function saveGeneralSettings(): Promise<void> {
  const settings = await getSettings();
  settings.theme = (elements.theme as HTMLSelectElement).value;
  settings.autoFill = (elements.autoFill as HTMLInputElement).checked;
  settings.typewriterEffect = (elements.typewriterEffect as HTMLInputElement).checked;
  settings.autoSolveOnRule = (elements.autoSolveOnRule as HTMLInputElement).checked;
  settings.autoSubmit = (elements.autoSubmit as HTMLInputElement).checked;
  settings.autoCheckAgreement = (elements.autoCheckAgreement as HTMLInputElement).checked;
  settings.captchaSelector = (elements.captchaSelector as HTMLInputElement).value.trim();
  settings.inputSelector = (elements.inputSelector as HTMLInputElement).value.trim();
  settings.submitSelector = (elements.submitSelector as HTMLInputElement).value.trim();
  await saveSettings(settings);
  showToast('设置已保存', 'success');
}

async function saveAdvancedSettings(): Promise<void> {
  const settings = await getSettings();
  settings.autoCalculate = (elements.autoCalculate as HTMLInputElement).checked;
  settings.calculateOutputMode = (elements.calculateOutputMode as HTMLSelectElement).value;
  settings.timeout = parseInt((elements.timeout as HTMLInputElement).value) * 1000;
  settings.retryCount = parseInt((elements.retryCount as HTMLInputElement).value);
  settings.debugMode = (elements.debugMode as HTMLInputElement).checked;
  settings.customIncludeKeywords = (elements.customIncludeKeywords as HTMLTextAreaElement).value
    .split('\n').map((s: string) => s.trim()).filter(Boolean);
  settings.customExcludePatterns = (elements.customExcludePatterns as HTMLTextAreaElement).value
    .split('\n').map((s: string) => s.trim()).filter(Boolean);
  settings.siteBlacklist = (elements.siteBlacklist as HTMLTextAreaElement).value
    .split('\n').map((s: string) => s.trim()).filter(Boolean);
  await saveSettings(settings);
  showToast('设置已保存', 'success');
}

async function loadRules(): Promise<void> {
  const result = await chrome.storage.local.get('siteRules');
  const rules = result.siteRules || {};
  const rulesList = elements.rulesList as HTMLElement;
  if (Object.keys(rules).length === 0) {
    rulesList.innerHTML = '<div class="empty-state"><p>暂无保存的规则</p><span>使用弹窗中的"选择元素"功能添加规则</span></div>';
    return;
  }
  rulesList.innerHTML = Object.entries(rules).map(([key, rule]: [string, any]) => {
    const displayKey = key.length > 40 ? key.substring(0, 40) + '...' : key;
    const selectorDisplay = rule.selector.length > 30 ? rule.selector.substring(0, 30) + '...' : rule.selector;
    return `
<div class="rule-item" data-key="${escapeHtml(key)}">
<div class="rule-info">
<div class="rule-hostname">${escapeHtml(displayKey)}</div>
<div class="rule-selector">${escapeHtml(selectorDisplay)}</div>
${rule.fullUrl ? '<div class="rule-badge">完整URL匹配</div>' : ''}
</div>
<div class="rule-actions">
<button class="btn btn-secondary btn-sm btn-edit-rule" data-key="${escapeHtml(key)}">编辑</button>
<button class="btn btn-danger btn-sm btn-delete-rule" data-key="${escapeHtml(key)}">删除</button>
</div>
</div>
`;
  }).join('');
  rulesList.querySelectorAll('.btn-delete-rule').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const key = (e.target as HTMLElement).dataset.key;
      if (key) {
        await chrome.runtime.sendMessage({ action: 'deleteSiteRule', ruleKey: key });
        await loadRules();
        showToast('规则已删除', 'success');
      }
    });
  });
  rulesList.querySelectorAll('.btn-edit-rule').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const key = (e.target as HTMLElement).dataset.key;
      if (key) {
        await editRule(key);
      }
    });
  });
}

async function editRule(key: string): Promise<void> {
  const result = await chrome.storage.local.get('siteRules');
  const rules = result.siteRules || {};
  const rule = rules[key];
  if (!rule) {
    showToast('规则不存在', 'error');
    return;
  }
  currentEditRuleKey = key;
  (elements.editRuleKey as HTMLInputElement).value = key;
  (elements.editRuleOriginalKey as HTMLInputElement).value = key;
  (elements.editRuleSelector as HTMLInputElement).value = rule.selector || '';
  (elements.editRuleInput as HTMLInputElement).value = rule.inputSelector || '';
  (elements.editRuleUrl as HTMLInputElement).value = rule.fullUrl || '';
  switchSection('rules');

  const editKeyEl = elements.editRuleKey as HTMLInputElement | null;
  const editCard = editKeyEl ? editKeyEl.closest('.card') : null;
  if (editCard) {
    editCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  showToast('已加载规则到编辑区', 'success');
}

async function saveEditRule(): Promise<void> {
  const originalKey = (elements.editRuleOriginalKey as HTMLInputElement).value;
  const selector = (elements.editRuleSelector as HTMLInputElement).value.trim();
  const inputSelector = (elements.editRuleInput as HTMLInputElement).value.trim();
  const fullUrl = (elements.editRuleUrl as HTMLInputElement).value.trim();
  if (!selector) {
    showToast('验证码选择器不能为空', 'error');
    return;
  }
  const result = await chrome.storage.local.get('siteRules');
  const rules = result.siteRules || {};
  const oldRule = rules[originalKey] || {};
  const newRule: SiteRule = {
    ...oldRule,
    selector,
    inputSelector: inputSelector || undefined,
    fullUrl: fullUrl || undefined,
    enabled: true,
    updatedAt: Date.now(),
  };
  await chrome.runtime.sendMessage({
    action: 'updateSiteRule',
    oldKey: originalKey,
    newRule,
  });
  cancelEditRule();
  await loadRules();
  showToast('规则已更新', 'success');
}

function cancelEditRule(): void {
  currentEditRuleKey = null;
  (elements.editRuleKey as HTMLInputElement).value = '';
  (elements.editRuleOriginalKey as HTMLInputElement).value = '';
  (elements.editRuleSelector as HTMLInputElement).value = '';
  (elements.editRuleInput as HTMLInputElement).value = '';
  (elements.editRuleUrl as HTMLInputElement).value = '';
}

async function addBulkRules(): Promise<void> {
  const text = (elements.bulkRules as HTMLTextAreaElement).value.trim();
  if (!text) {
    showToast('请输入规则', 'error');
    return;
  }
  try {
    const rules = JSON.parse(text);
    if (!Array.isArray(rules)) throw new Error('格式错误');
    let count = 0;
    for (const rule of rules) {
      if (!rule.hostname || !rule.selector) continue;
      await chrome.runtime.sendMessage({
        action: 'saveSiteRule',
        hostname: rule.hostname,
        rule: {
          selector: rule.selector,
          inputSelector: rule.inputSelector,
          fullUrl: rule.fullUrl,
          enabled: true,
        },
      });
      count++;
    }
    (elements.bulkRules as HTMLTextAreaElement).value = '';
    await loadRules();
    showToast(`已添加 ${count} 条规则`, 'success');
  } catch {
    showToast('JSON格式错误', 'error');
  }
}

async function exportRules(): Promise<void> {
  const result = await chrome.storage.local.get('siteRules');
  const rules = result.siteRules || {};
  const exportData = Object.entries(rules).map(([key, rule]: [string, any]) => ({
    hostname: rule.hostname || key,
    selector: rule.selector,
    inputSelector: rule.inputSelector,
    fullUrl: rule.fullUrl,
    urlPattern: rule.urlPattern,
  }));
  downloadJson(exportData, 'ddddocr-rules.json');
}

async function exportConfig(): Promise<void> {
  const result = await chrome.storage.local.get(['settings', 'siteRules']);
  downloadJson(result, 'ddddocr-config.json');
}

function downloadJson(data: any, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

let importMode = '';

function triggerImport(mode: string): void {
  importMode = mode;
  (elements.fileImport as HTMLInputElement).click();
}

async function loadStats(): Promise<void> {
  const response = await chrome.runtime.sendMessage({ action: 'getStats' });
  if (!response.success) return;
  const stats = response.stats;
  const sites = Object.entries(stats.sites || {}) as [string, { count: number; lastTime: number; totalTime: number }][];
  const totalTime = sites.reduce((sum, [, s]) => sum + s.totalTime, 0);
  const avgTime = stats.total > 0 ? Math.round(totalTime / stats.total) : 0;
  const lastUpdate = stats.updated ? new Date(stats.updated).toLocaleString() : '-';
  const statsGrid = document.getElementById('stats-grid');
  if (statsGrid) {
    statsGrid.innerHTML = `
<div class="stat-card">
<div class="stat-label">总识别次数</div>
<div class="stat-value">${stats.total}<span class="stat-unit">次</span></div>
</div>
<div class="stat-card accent">
<div class="stat-label">统计站点数</div>
<div class="stat-value">${sites.length}<span class="stat-unit">个</span></div>
</div>
<div class="stat-card success">
<div class="stat-label">平均识别耗时</div>
<div class="stat-value">${avgTime}<span class="stat-unit">ms</span></div>
</div>
<div class="stat-card warning">
<div class="stat-label">最后更新</div>
<div class="stat-value" style="font-size: 16px;">${lastUpdate}</div>
</div>
`;
  }
  const statsList = elements.statsList as HTMLElement;
  if (sites.length === 0) {
    statsList.innerHTML = '<div class="empty-state"><p>暂无统计数据</p><span>开始使用后将自动记录</span></div>';
    return;
  }
  sites.sort((a, b) => b[1].count - a[1].count);
  const topSites = sites.slice(0, 20);
  const maxCount = topSites.length > 0 ? topSites[0][1].count : 1;
  statsList.innerHTML = topSites.map(([hostname, siteStats], index) => {
    const siteAvgTime = siteStats.count > 0 ? Math.round(siteStats.totalTime / siteStats.count) : 0;
    const lastTime = new Date(siteStats.lastTime).toLocaleDateString();
    const progressWidth = Math.round((siteStats.count / maxCount) * 100);
    return `
<div class="rank-item">
<div class="rank-num">${index + 1}</div>
<div class="rank-info">
<div class="rank-host">${escapeHtml(hostname)}</div>
<div class="rank-meta">
<span>平均 ${siteAvgTime}ms</span>
<span>最后: ${lastTime}</span>
</div>
<div class="progress-bar">
<div class="progress-fill" style="width: ${progressWidth}%"></div>
</div>
</div>
<div class="rank-count">${siteStats.count}</div>
</div>
`;
  }).join('');
}

async function clearStats(): Promise<void> {
  const ok = await showConfirm({
    title: '清除统计',
    message: '确定要清除所有统计数据吗？',
    confirmText: '确定清除',
    cancelText: '取消',
  });
  if (!ok) return;
  await chrome.runtime.sendMessage({ action: 'clearStats' });
  await loadStats();
  showToast('统计数据已清除', 'success');
}

async function handleFileImport(e: Event): Promise<void> {
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
          rule: {
            selector: rule.selector,
            inputSelector: rule.inputSelector,
            fullUrl: rule.fullUrl,
            enabled: true,
          },
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

async function resetAll(): Promise<void> {
  const ok = await showConfirm({
    title: '重置所有设置',
    message: '确定要重置所有设置吗？此操作不可恢复。',
    confirmText: '确定重置',
    cancelText: '取消',
  });
  if (!ok) return;
  await chrome.storage.local.clear();
  await loadSettings();
  await loadRules();
  showToast('已重置所有设置', 'success');
}

function showToast(message: string, type: 'success' | 'error'): void {
  (elements.toast as HTMLElement).className = `toast ${type}`;
  (elements.toastMessage as HTMLElement).textContent = message;
  (elements.toast as HTMLElement).classList.remove('hidden');
  setTimeout(() => (elements.toast as HTMLElement).classList.add('hidden'), 3000);
}

function displayVersion(): void {
  const manifest = chrome.runtime.getManifest();
  const versionEl = document.querySelectorAll('.version');
  if (versionEl) {
    versionEl.forEach(el => {
      el.textContent = manifest.version;
    });
  }
}

document.addEventListener('DOMContentLoaded', init);
export { };