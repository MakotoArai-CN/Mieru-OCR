declare const browser: any;

import { CONSTANTS, DEFAULT_EXTENSION_SETTINGS } from '@core/config';
import { initLocale, setLocale, t, translatePage } from '@core/i18n';
import type { Locale } from '@core/i18n';

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

type ChipFieldKey = 'customIncludeKeywords' | 'customExcludePatterns' | 'customAgreementKeywords' | 'customInputExcludeKeywords';
type DisabledChipKey = 'disabledCaptchaKeywords' | 'disabledExcludePatterns' | 'disabledAgreementKeywords' | 'disabledInputExcludeKeywords';
type ThemeMode = 'auto' | 'light' | 'dark';

const ARRAY_SETTING_KEYS = [
  'agreementSelectors',
  'calculateRules',
  'whitelist',
  'customIncludeKeywords',
  'customExcludePatterns',
  'customAgreementKeywords',
  'customInputExcludeKeywords',
  'disabledCaptchaKeywords',
  'disabledExcludePatterns',
  'disabledAgreementKeywords',
  'disabledInputExcludeKeywords',
  'siteBlacklist',
] as const;

function createDefaultRecognitionStats(): { sites: Record<string, any>; total: number; updated: number } {
  return { sites: {}, total: 0, updated: Date.now() };
}

const CHIP_META: Record<ChipFieldKey, {
  builtin: string[];
  disabledKey: DisabledChipKey;
}> = {
  customIncludeKeywords: {
    builtin: [...CONSTANTS.CAPTCHA_KEYWORDS],
    disabledKey: 'disabledCaptchaKeywords',
  },
  customExcludePatterns: {
    builtin: [...CONSTANTS.EXCLUDE_PATTERNS],
    disabledKey: 'disabledExcludePatterns',
  },
  customAgreementKeywords: {
    builtin: [...CONSTANTS.AGREEMENT_KEYWORDS],
    disabledKey: 'disabledAgreementKeywords',
  },
  customInputExcludeKeywords: {
    builtin: [...CONSTANTS.INPUT_EXCLUDE_KEYWORDS],
    disabledKey: 'disabledInputExcludeKeywords',
  },
};

const elements: Record<string, HTMLElement | NodeListOf<HTMLElement> | null> = {};
let currentEditRuleKey: string | null = null;
let importMode = '';

async function init(): Promise<void> {
  cacheElements();
  // Set locale before rendering dynamic content so t() returns correct translations
  {
    const s = await getSettings();
    initLocale((s.language || 'auto') as any);
  }
  renderKeywordChipGroups();
  bindEvents();
  await loadSettings();
  translatePage();
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
  elements.siteBlacklist = document.getElementById('siteBlacklist');
  elements.language = document.getElementById('language');
  elements.editRuleKey = document.getElementById('edit-rule-key');
  elements.editRuleOriginalKey = document.getElementById('edit-rule-original-key');
  elements.editRuleSelector = document.getElementById('edit-rule-selector');
  elements.editRuleInput = document.getElementById('edit-rule-input');
  elements.editRuleUrl = document.getElementById('edit-rule-url');
  elements.statsList = document.getElementById('stats-list');
}

function bindEvents(): void {
  (elements.navItems as NodeListOf<HTMLElement>).forEach((item) => {
    item.addEventListener('click', (event) => {
      event.preventDefault();
      switchSection(item.dataset.section || 'general');
    });
  });

  document.getElementById('btn-save-general')?.addEventListener('click', () => { void saveGeneralSettings(); });
  document.getElementById('btn-save-advanced')?.addEventListener('click', () => { void saveAdvancedSettings(); });

  document.getElementById('btn-export-rules')?.addEventListener('click', () => { void exportRules(); });
  document.getElementById('btn-import-rules')?.addEventListener('click', () => triggerImport('rules'));
  document.getElementById('btn-add-bulk-rules')?.addEventListener('click', () => { void addBulkRules(); });
  document.getElementById('btn-export-config')?.addEventListener('click', () => { void exportConfig(); });
  document.getElementById('btn-import-config')?.addEventListener('click', () => triggerImport('config'));
  document.getElementById('btn-reset-all')?.addEventListener('click', () => { void resetAll(); });
  document.getElementById('btn-add-calc-rule')?.addEventListener('click', () => { void addCalculateRule(); });
  document.getElementById('btn-add-agreement')?.addEventListener('click', () => { void addAgreementSelector(); });
  document.getElementById('btn-clear-stats')?.addEventListener('click', () => { void clearStats(); });
  document.getElementById('btn-save-edit-rule')?.addEventListener('click', () => { void saveEditRule(); });
  document.getElementById('btn-cancel-edit-rule')?.addEventListener('click', cancelEditRule);

  (elements.fileImport as HTMLInputElement | null)?.addEventListener('change', (event) => { void handleFileImport(event); });

  bindThemeSwitcher();
  bindLanguageSwitcher();
  bindKeywordChipGroups();

  (elements.autoCalculate as HTMLInputElement | null)?.addEventListener('change', () => {
    const enabled = (elements.autoCalculate as HTMLInputElement).checked;
    toggleCalculateOptions(enabled);
  });
}

function switchSection(sectionId: string): void {
  (elements.navItems as NodeListOf<HTMLElement>).forEach((item) => {
    item.classList.toggle('active', item.dataset.section === sectionId);
  });
  (elements.sections as NodeListOf<HTMLElement>).forEach((section) => {
    section.classList.toggle('active', section.id === sectionId);
  });
}

function renderKeywordChipGroups(): void {
  const container = document.getElementById('keyword-chip-groups');
  if (!container) return;

  const i18nKeys: Record<ChipFieldKey, { titleKey: string; placeholderKey: string; hintKey: string }> = {
    customIncludeKeywords: { titleKey: 'settings.keywords.triggerTitle', placeholderKey: 'settings.keywords.triggerPlaceholder', hintKey: 'settings.keywords.triggerHint' },
    customExcludePatterns: { titleKey: 'settings.keywords.excludeTitle', placeholderKey: 'settings.keywords.excludePlaceholder', hintKey: 'settings.keywords.excludeHint' },
    customAgreementKeywords: { titleKey: 'settings.keywords.agreementTitle', placeholderKey: 'settings.keywords.agreementPlaceholder', hintKey: 'settings.keywords.agreementHint' },
    customInputExcludeKeywords: { titleKey: 'settings.keywords.inputExcludeTitle', placeholderKey: 'settings.keywords.inputExcludePlaceholder', hintKey: 'settings.keywords.inputExcludeHint' },
  };

  container.innerHTML = (Object.keys(CHIP_META) as ChipFieldKey[]).map((field) => {
    const keys = i18nKeys[field];
    return `
      <div class="form-group keyword-group" data-chip-field="${field}">
        <div class="keyword-header">
          <label>${t(keys.titleKey)}</label>
          <div class="keyword-actions">
            <span class="keyword-subtitle">${t('settings.keywords.builtinDeletable')}</span>
            <button type="button" class="btn btn-secondary btn-sm chip-reset" data-chip-field="${field}">${t('settings.keywords.resetDefault')}</button>
          </div>
        </div>
        <div class="chip-list" id="${field}-list"></div>
        <div class="chip-input-row">
          <input type="text" class="chip-input" id="${field}-input" placeholder="${t(keys.placeholderKey)}">
        </div>
        <span class="hint">${t(keys.hintKey)}</span>
      </div>
    `;
  }).join('');
}

function bindThemeSwitcher(): void {
  document.querySelectorAll<HTMLElement>('.theme-option').forEach((button) => {
    button.addEventListener('click', async () => {
      const theme = (button.dataset.themeValue || 'auto') as ThemeMode;
      const settings = await getSettings();
      settings.theme = theme;
      await saveSettings(settings);
      setThemeOption(theme);
      await applyTheme();
    });
  });

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handleAutoTheme = async () => {
    const settings = await getSettings();
    if ((settings.theme || 'auto') === 'auto') {
      await applyTheme();
    }
  };

  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', () => { void handleAutoTheme(); });
  } else if (typeof media.addListener === 'function') {
    media.addListener(() => { void handleAutoTheme(); });
  }
}

function setThemeOption(theme: ThemeMode): void {
  (elements.theme as HTMLInputElement).value = theme;
  document.querySelectorAll<HTMLElement>('.theme-option').forEach((button) => {
    const active = button.dataset.themeValue === theme;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}

function bindLanguageSwitcher(): void {
  document.querySelectorAll<HTMLElement>('[data-lang-value]').forEach((button) => {
    button.addEventListener('click', async () => {
      const lang = (button.dataset.langValue || 'auto') as 'auto' | 'zh' | 'ja' | 'en';
      const settings = await getSettings();
      settings.language = lang;
      await saveSettings(settings);
      setLanguageOption(lang);
      if (lang === 'auto') {
        initLocale('auto');
      } else {
        setLocale(lang as Locale);
      }
      translatePage();
      // Re-render all dynamically generated content
      renderKeywordChipGroups();
      bindKeywordChipGroups();
      await refreshAllChipLists();
      await loadRules();
      await loadStats();
      const s = await getSettings();
      renderAgreementSelectors(s.agreementSelectors || []);
      renderCalculateRules(s.calculateRules || []);
    });
  });
}

function setLanguageOption(lang: string): void {
  (elements.language as HTMLInputElement).value = lang;
  document.querySelectorAll<HTMLElement>('[data-lang-value]').forEach((button) => {
    const active = button.dataset.langValue === lang;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  });
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRecognitionStats(stats: unknown): { sites: Record<string, any>; total: number; updated: number } {
  if (!isPlainObject(stats)) {
    return createDefaultRecognitionStats();
  }

  return {
    sites: isPlainObject(stats.sites) ? stats.sites : {},
    total: typeof stats.total === 'number' ? stats.total : 0,
    updated: typeof stats.updated === 'number' ? stats.updated : Date.now(),
  };
}

function normalizeConfigData(data: unknown): {
  settings: Record<string, any>;
  siteRules: Record<string, any>;
  recognitionStats: { sites: Record<string, any>; total: number; updated: number };
} {
  const normalized = isPlainObject(data) ? data : {};
  return {
    settings: getEnhancedSettings(isPlainObject(normalized.settings) ? normalized.settings : {}),
    siteRules: isPlainObject(normalized.siteRules) ? normalized.siteRules : {},
    recognitionStats: normalizeRecognitionStats(normalized.recognitionStats),
  };
}

function getEnhancedSettings(settings: Record<string, any>): Record<string, any> {
  const merged: Record<string, any> = {
    ...DEFAULT_EXTENSION_SETTINGS,
    ...settings,
  };

  ARRAY_SETTING_KEYS.forEach((key) => {
    merged[key] = Array.isArray(merged[key]) ? merged[key] : [];
  });

  return merged;
}

function getEnabledBuiltinKeywords(field: ChipFieldKey, settings: Record<string, any>): string[] {
  const meta = CHIP_META[field];
  const disabled = new Set((settings[meta.disabledKey] || []).map((item: string) => item.toLowerCase()));
  return meta.builtin.filter((item) => !disabled.has(item.toLowerCase()));
}

function renderChipList(field: ChipFieldKey, settings: Record<string, any>): void {
  const list = document.getElementById(`${field}-list`);
  if (!list) return;

  const builtinItems = getEnabledBuiltinKeywords(field, settings).map((value) => ({ value, kind: 'builtin' as const }));
  const customItems = (settings[field] || []).map((value: string) => ({ value, kind: 'custom' as const }));
  const items = [...builtinItems, ...customItems];

  if (items.length === 0) {
    list.innerHTML = `<div class="empty-hint">${t('settings.keywords.empty')}</div>`;
    return;
  }

  list.innerHTML = items.map((item) => `
    <span class="chip-item ${item.kind}">
      <span class="chip-text">${escapeHtml(item.value)}</span>
      <span class="chip-meta">${item.kind === 'builtin' ? t('settings.keywords.builtin') : t('settings.keywords.custom')}</span>
      <button type="button" class="chip-remove" data-chip-field="${field}" data-chip-kind="${item.kind}" data-chip-value="${escapeHtml(item.value)}">×</button>
    </span>
  `).join('');
}

async function refreshAllChipLists(): Promise<void> {
  const settings = await getSettings();
  (Object.keys(CHIP_META) as ChipFieldKey[]).forEach((field) => renderChipList(field, settings));
}

function bindKeywordChipGroups(): void {
  (Object.keys(CHIP_META) as ChipFieldKey[]).forEach((field) => {
    const input = document.getElementById(`${field}-input`) as HTMLInputElement | null;
    input?.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();

      const value = input.value.trim();
      if (!value) return;

      const settings = await getSettings();
      const existing = new Set([
        ...(settings[field] || []).map((item: string) => item.toLowerCase()),
        ...CHIP_META[field].builtin.map((item) => item.toLowerCase()),
      ]);

      if (existing.has(value.toLowerCase())) {
        showToast(t('settings.keywords.exists'), 'error');
        return;
      }

      settings[field] = [...(settings[field] || []), value];
      await saveSettings(settings);
      input.value = '';
      await refreshAllChipLists();
    });
  });

  document.getElementById('keyword-chip-groups')?.addEventListener('click', (event) => {
    void handleKeywordGroupClick(event);
  });
}

async function handleKeywordGroupClick(event: Event): Promise<void> {
  const target = event.target as HTMLElement;
  const removeBtn = target.closest('.chip-remove') as HTMLElement | null;
  if (removeBtn) {
    const field = removeBtn.dataset.chipField as ChipFieldKey;
    const kind = removeBtn.dataset.chipKind as 'builtin' | 'custom';
    const value = removeBtn.dataset.chipValue || '';
    const settings = await getSettings();

    if (kind === 'builtin') {
      const disabledKey = CHIP_META[field].disabledKey;
      settings[disabledKey] = Array.from(new Set([...(settings[disabledKey] || []), value]));
    } else {
      settings[field] = (settings[field] || []).filter((item: string) => item.toLowerCase() !== value.toLowerCase());
    }

    await saveSettings(settings);
    await refreshAllChipLists();
    return;
  }

  const resetBtn = target.closest('.chip-reset') as HTMLElement | null;
  if (resetBtn) {
    const field = resetBtn.dataset.chipField as ChipFieldKey;
    const settings = await getSettings();
    settings[field] = [];
    settings[CHIP_META[field].disabledKey] = [];
    await saveSettings(settings);
    await refreshAllChipLists();
    showToast(t('settings.keywords.resetDone'), 'success');
  }
}

async function applyTheme(): Promise<void> {
  const settings = await getSettings();
  const theme = (settings.theme || 'auto') as ThemeMode;
  setThemeOption(theme);

  let effectiveTheme = theme;
  if (theme === 'auto') {
    effectiveTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  document.body.setAttribute('data-theme', effectiveTheme);
}

async function getSettings(): Promise<Record<string, any>> {
  try {
    const result = await browser.storage.local.get('settings');
    return getEnhancedSettings(result?.settings || {});
  } catch {
    return getEnhancedSettings({});
  }
}

async function saveSettings(settings: Record<string, any>): Promise<void> {
  await browser.storage.local.set({ settings: getEnhancedSettings(settings) });
}

async function loadSettings(): Promise<void> {
  const settings = await getSettings();

  setThemeOption((settings.theme || 'auto') as ThemeMode);
  setLanguageOption(settings.language || 'auto');
  (elements.autoFill as HTMLInputElement).checked = settings.autoFill !== false;
  (elements.typewriterEffect as HTMLInputElement).checked = settings.typewriterEffect !== false;
  (elements.autoSolveOnRule as HTMLInputElement).checked = Boolean(settings.autoSolveOnRule);
  (elements.autoSubmit as HTMLInputElement).checked = Boolean(settings.autoSubmit);
  (elements.autoCheckAgreement as HTMLInputElement).checked = settings.autoCheckAgreement !== false;
  (elements.captchaSelector as HTMLInputElement).value = settings.captchaSelector || '';
  (elements.inputSelector as HTMLInputElement).value = settings.inputSelector || '';
  (elements.submitSelector as HTMLInputElement).value = settings.submitSelector || '';
  renderAgreementSelectors(settings.agreementSelectors || []);

  (elements.autoCalculate as HTMLInputElement).checked = Boolean(settings.autoCalculate);
  (elements.calculateOutputMode as HTMLSelectElement).value = settings.calculateOutputMode || 'result';
  toggleCalculateOptions(Boolean(settings.autoCalculate));
  renderCalculateRules(settings.calculateRules || []);

  (elements.timeout as HTMLInputElement).value = String((settings.timeout || 30000) / 1000);
  (elements.retryCount as HTMLInputElement).value = String(settings.retryCount || 3);
  (elements.debugMode as HTMLInputElement).checked = Boolean(settings.debugMode);
  (elements.siteBlacklist as HTMLTextAreaElement).value = (settings.siteBlacklist || []).join('\n');

  await refreshAllChipLists();
  await applyTheme();
}

function toggleCalculateOptions(show: boolean): void {
  (elements.calculateOptionsGroup as HTMLElement).style.display = show ? 'block' : 'none';
  (elements.calculateRulesCard as HTMLElement).style.display = show ? 'block' : 'none';
}

function renderAgreementSelectors(selectors: string[]): void {
  const container = elements.agreementSelectors as HTMLElement;
  if (!container) return;

  if (!selectors.length) {
    container.innerHTML = `<div class="empty-hint">${t('settings.agreementSelector.empty')}</div>`;
    return;
  }

  container.innerHTML = selectors.map((selector, index) => `
    <div class="selector-item" data-index="${index}">
      <code>${escapeHtml(selector)}</code>
      <button class="btn btn-danger btn-sm btn-delete-agreement" data-index="${index}">${t('common.delete')}</button>
    </div>
  `).join('');

  container.querySelectorAll('.btn-delete-agreement').forEach((button) => {
    button.addEventListener('click', (event) => {
      const index = parseInt((event.currentTarget as HTMLElement).dataset.index || '0', 10);
      void deleteAgreementSelector(index);
    });
  });
}

async function addAgreementSelector(): Promise<void> {
  const input = elements.newAgreementSelector as HTMLInputElement;
  const selector = input.value.trim();
  if (!selector) {
    showToast(t('settings.agreementSelector.enterSelector'), 'error');
    return;
  }

  const settings = await getSettings();
  const selectors = settings.agreementSelectors || [];
  if (selectors.includes(selector)) {
    showToast(t('settings.agreementSelector.exists'), 'error');
    return;
  }

  settings.agreementSelectors = [...selectors, selector];
  await saveSettings(settings);
  renderAgreementSelectors(settings.agreementSelectors);
  input.value = '';
  showToast(t('settings.agreementSelector.add'), 'success');
}

async function deleteAgreementSelector(index: number): Promise<void> {
  const settings = await getSettings();
  const selectors = [...(settings.agreementSelectors || [])];
  selectors.splice(index, 1);
  settings.agreementSelectors = selectors;
  await saveSettings(settings);
  renderAgreementSelectors(selectors);
  showToast(t('settings.agreementSelector.deleted'), 'success');
}

function renderCalculateRules(rules: CalculateRule[]): void {
  const container = elements.calculateRulesList as HTMLElement;
  if (!container) return;

  if (!rules.length) {
    container.innerHTML = `<div class="empty-state"><p>${t('calc.noRules')}</p></div>`;
    return;
  }

  container.innerHTML = rules.map((rule, index) => `
    <div class="calc-rule-item" data-index="${index}">
      <div class="calc-rule-info">
        <div class="calc-rule-pattern">${escapeHtml(rule.pattern)}</div>
        <div class="calc-rule-meta">
          <span class="calc-rule-badge">${rule.matchType === 'regex' ? t('calc.regex') : t('calc.wildcard')}</span>
          <span class="calc-rule-badge ${rule.outputMode === 'result' ? 'output-result' : 'output-equation'}">
            ${rule.outputMode === 'result' ? t('calc.outputResult') : t('calc.outputEquation')}
          </span>
        </div>
      </div>
      <div class="calc-rule-actions">
        <button class="btn btn-danger btn-sm btn-delete-calc-rule" data-index="${index}">${t('common.delete')}</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.btn-delete-calc-rule').forEach((button) => {
    button.addEventListener('click', (event) => {
      const index = parseInt((event.currentTarget as HTMLElement).dataset.index || '0', 10);
      void deleteCalculateRule(index);
    });
  });
}

async function addCalculateRule(): Promise<void> {
  const patternInput = document.getElementById('newCalcRulePattern') as HTMLInputElement;
  const matchTypeSelect = document.getElementById('newCalcRuleMatchType') as HTMLSelectElement;
  const outputModeSelect = document.getElementById('newCalcRuleOutputMode') as HTMLSelectElement;
  const pattern = patternInput.value.trim();

  if (!pattern) {
    showToast(t('calc.enterPattern'), 'error');
    return;
  }

  const settings = await getSettings();
  const rules: CalculateRule[] = [...(settings.calculateRules || [])];
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
  showToast(t('calc.ruleAdded'), 'success');
}

async function deleteCalculateRule(index: number): Promise<void> {
  const settings = await getSettings();
  const rules: CalculateRule[] = [...(settings.calculateRules || [])];
  rules.splice(index, 1);
  settings.calculateRules = rules;
  await saveSettings(settings);
  renderCalculateRules(rules);
  showToast(t('calc.ruleDeleted'), 'success');
}

async function saveGeneralSettings(): Promise<void> {
  const settings = await getSettings();
  settings.theme = (elements.theme as HTMLInputElement).value || 'auto';
  settings.language = (elements.language as HTMLInputElement).value as 'auto' | 'zh' | 'ja' | 'en';
  settings.autoFill = (elements.autoFill as HTMLInputElement).checked;
  settings.typewriterEffect = (elements.typewriterEffect as HTMLInputElement).checked;
  settings.autoSolveOnRule = (elements.autoSolveOnRule as HTMLInputElement).checked;
  settings.autoSubmit = (elements.autoSubmit as HTMLInputElement).checked;
  settings.autoCheckAgreement = (elements.autoCheckAgreement as HTMLInputElement).checked;
  settings.captchaSelector = (elements.captchaSelector as HTMLInputElement).value.trim();
  settings.inputSelector = (elements.inputSelector as HTMLInputElement).value.trim();
  settings.submitSelector = (elements.submitSelector as HTMLInputElement).value.trim();
  await saveSettings(settings);
  showToast(t('settings.saved'), 'success');
}

async function saveAdvancedSettings(): Promise<void> {
  const settings = await getSettings();
  settings.autoCalculate = (elements.autoCalculate as HTMLInputElement).checked;
  settings.calculateOutputMode = (elements.calculateOutputMode as HTMLSelectElement).value;
  settings.timeout = parseInt((elements.timeout as HTMLInputElement).value, 10) * 1000;
  settings.retryCount = parseInt((elements.retryCount as HTMLInputElement).value, 10);
  settings.debugMode = (elements.debugMode as HTMLInputElement).checked;
  settings.siteBlacklist = (elements.siteBlacklist as HTMLTextAreaElement).value
    .split('\n')
    .map((item: string) => item.trim())
    .filter(Boolean);
  await saveSettings(settings);
  showToast(t('settings.saved'), 'success');
}

async function loadRules(): Promise<void> {
  let rules: Record<string, any> = {};
  try {
    const result = await browser.storage.local.get('siteRules');
    rules = result?.siteRules || {};
  } catch {
    rules = {};
  }

  const rulesList = elements.rulesList as HTMLElement;
  if (Object.keys(rules).length === 0) {
    rulesList.innerHTML = `<div class="empty-state"><p>${t('rules.empty')}</p><span>${t('rules.emptyHint')}</span></div>`;
    return;
  }

  rulesList.innerHTML = Object.entries(rules).map(([key, rule]: [string, any]) => {
    const displayKey = key.length > 40 ? `${key.substring(0, 40)}...` : key;
    const selectorDisplay = rule.selector.length > 30 ? `${rule.selector.substring(0, 30)}...` : rule.selector;
    return `
      <div class="rule-item" data-key="${escapeHtml(key)}">
        <div class="rule-info">
          <div class="rule-hostname">${escapeHtml(displayKey)}</div>
          <div class="rule-selector">${escapeHtml(selectorDisplay)}</div>
          ${rule.fullUrl ? `<div class="rule-badge">${t('rules.fullUrlMatch')}</div>` : ''}
        </div>
        <div class="rule-actions">
          <button class="btn btn-secondary btn-sm btn-edit-rule" data-key="${escapeHtml(key)}">${t('common.edit')}</button>
          <button class="btn btn-danger btn-sm btn-delete-rule" data-key="${escapeHtml(key)}">${t('common.delete')}</button>
        </div>
      </div>
    `;
  }).join('');

  rulesList.querySelectorAll('.btn-delete-rule').forEach((button) => {
    button.addEventListener('click', async (event) => {
      const key = (event.currentTarget as HTMLElement).dataset.key;
      if (!key) return;
      await browser.runtime.sendMessage({ action: 'deleteSiteRule', ruleKey: key });
      await loadRules();
      showToast(t('rules.deleted'), 'success');
    });
  });

  rulesList.querySelectorAll('.btn-edit-rule').forEach((button) => {
    button.addEventListener('click', (event) => {
      const key = (event.currentTarget as HTMLElement).dataset.key;
      if (!key) return;
      void editRule(key);
    });
  });
}

async function editRule(key: string): Promise<void> {
  let rules: Record<string, any> = {};
  try {
    const result = await browser.storage.local.get('siteRules');
    rules = result?.siteRules || {};
  } catch {
    rules = {};
  }

  const rule = rules[key];
  if (!rule) {
    showToast(t('rules.notFound'), 'error');
    return;
  }

  currentEditRuleKey = key;
  (elements.editRuleKey as HTMLInputElement).value = key;
  (elements.editRuleOriginalKey as HTMLInputElement).value = key;
  (elements.editRuleSelector as HTMLInputElement).value = rule.selector || '';
  (elements.editRuleInput as HTMLInputElement).value = rule.inputSelector || '';
  (elements.editRuleUrl as HTMLInputElement).value = rule.fullUrl || '';

  switchSection('rules');
  const editCard = (elements.editRuleKey as HTMLInputElement | null)?.closest('.card');
  editCard?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  showToast(t('rules.editLoaded'), 'success');
}

async function saveEditRule(): Promise<void> {
  const originalKey = (elements.editRuleOriginalKey as HTMLInputElement).value;
  const selector = (elements.editRuleSelector as HTMLInputElement).value.trim();
  const inputSelector = (elements.editRuleInput as HTMLInputElement).value.trim();
  const fullUrl = (elements.editRuleUrl as HTMLInputElement).value.trim();

  if (!selector) {
    showToast(t('rules.selectorRequired'), 'error');
    return;
  }

  let rules: Record<string, any> = {};
  try {
    const result = await browser.storage.local.get('siteRules');
    rules = result?.siteRules || {};
  } catch {
    rules = {};
  }
  const oldRule = rules[originalKey] || {};

  const newRule: SiteRule = {
    ...oldRule,
    selector,
    inputSelector: inputSelector || undefined,
    fullUrl: fullUrl || undefined,
    enabled: true,
    updatedAt: Date.now(),
  };

  await browser.runtime.sendMessage({
    action: 'updateSiteRule',
    oldKey: originalKey,
    newRule,
  });

  cancelEditRule();
  await loadRules();
  showToast(t('rules.updated'), 'success');
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
    showToast(t('rules.bulkEmpty'), 'error');
    return;
  }

  try {
    const rules = JSON.parse(text);
    if (!Array.isArray(rules)) throw new Error(t('rules.formatError'));

    let count = 0;
    for (const rule of rules) {
      if (!rule.hostname || !rule.selector) continue;
      await browser.runtime.sendMessage({
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
    showToast(t('rules.bulkAdded', count), 'success');
  } catch {
    showToast(t('rules.jsonError'), 'error');
  }
}

async function exportRules(): Promise<void> {
  let rules: Record<string, any> = {};
  try {
    const result = await browser.storage.local.get('siteRules');
    rules = result?.siteRules || {};
  } catch {
    rules = {};
  }

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
  try {
    const result = await browser.storage.local.get(['settings', 'siteRules', 'recognitionStats']);
    downloadJson(normalizeConfigData(result), 'ddddocr-config.json');
  } catch {
    showToast(t('config.exportFailed'), 'error');
  }
}

function downloadJson(data: any, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function triggerImport(mode: string): void {
  importMode = mode;
  (elements.fileImport as HTMLInputElement).click();
}

async function loadStats(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({ action: 'getStats' });
    if (!response?.success) return;

    const stats = response.stats;
    const sites = Object.entries(stats.sites || {}) as [string, { count: number; lastTime: number; totalTime: number }][];
    const totalTime = sites.reduce((sum, [, value]) => sum + value.totalTime, 0);
    const avgTime = stats.total > 0 ? Math.round(totalTime / stats.total) : 0;
    const lastUpdate = stats.updated ? new Date(stats.updated).toLocaleString() : '-';
    const statsGrid = document.getElementById('stats-grid');

    if (statsGrid) {
      statsGrid.innerHTML = `
        <div class="stat-card">
          <div class="stat-label">${t('stats.totalCount')}</div>
          <div class="stat-value">${stats.total}<span class="stat-unit">${t('stats.unit.times')}</span></div>
        </div>
        <div class="stat-card accent">
          <div class="stat-label">${t('stats.siteCount')}</div>
          <div class="stat-value">${sites.length}<span class="stat-unit">${t('stats.unit.sites')}</span></div>
        </div>
        <div class="stat-card success">
          <div class="stat-label">${t('stats.avgTime')}</div>
          <div class="stat-value">${avgTime}<span class="stat-unit">ms</span></div>
        </div>
        <div class="stat-card warning">
          <div class="stat-label">${t('stats.lastUpdate')}</div>
          <div class="stat-value" style="font-size: 16px;">${lastUpdate}</div>
        </div>
      `;
    }

    const statsList = elements.statsList as HTMLElement;
    if (sites.length === 0) {
      statsList.innerHTML = `<div class="empty-state"><p>${t('stats.empty')}</p><span>${t('stats.emptyHint')}</span></div>`;
      return;
    }

    sites.sort((a, b) => b[1].count - a[1].count);
    const topSites = sites.slice(0, 20);
    const maxCount = topSites.length ? topSites[0][1].count : 1;

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
              <span>${t('stats.avg', siteAvgTime)}</span>
              <span>${t('stats.last', lastTime)}</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${progressWidth}%"></div>
            </div>
          </div>
          <div class="rank-count">${siteStats.count}</div>
        </div>
      `;
    }).join('');
  } catch {
    showToast(t('stats.loadFailed'), 'error');
  }
}

async function clearStats(): Promise<void> {
  if (!confirm(t('stats.clearConfirm'))) return;
  try {
    await browser.runtime.sendMessage({ action: 'clearStats' });
    await loadStats();
    showToast(t('stats.cleared'), 'success');
  } catch {
    showToast(t('stats.clearFailed'), 'error');
  }
}

async function handleFileImport(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (importMode === 'rules') {
      if (!Array.isArray(data)) throw new Error(t('rules.formatError'));
      for (const rule of data) {
        if (!rule.hostname || !rule.selector) continue;
        await browser.runtime.sendMessage({
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
      showToast(t('rules.imported'), 'success');
    } else if (importMode === 'config') {
      await browser.storage.local.clear();
      await browser.storage.local.set(normalizeConfigData(data));
      await loadSettings();
      await loadRules();
      await loadStats();
      showToast(t('config.imported'), 'success');
    }
  } catch {
    showToast(t('config.importFailed'), 'error');
  }

  (elements.fileImport as HTMLInputElement).value = '';
}

async function resetAll(): Promise<void> {
  if (!confirm(t('config.resetConfirm'))) return;
  try {
    await browser.storage.local.clear();
    await browser.storage.local.set(normalizeConfigData({}));
    await loadSettings();
    await loadRules();
    await loadStats();
    showToast(t('config.resetDone'), 'success');
  } catch {
    showToast(t('config.resetFailed'), 'error');
  }
}

function showToast(message: string, type: 'success' | 'error'): void {
  (elements.toast as HTMLElement).className = `toast ${type}`;
  (elements.toastMessage as HTMLElement).textContent = message;
  (elements.toast as HTMLElement).classList.remove('hidden');
  setTimeout(() => (elements.toast as HTMLElement).classList.add('hidden'), 3000);
}

function displayVersion(): void {
  try {
    const manifest = browser.runtime.getManifest();
    document.querySelectorAll('.version').forEach((element) => {
      element.textContent = manifest.version;
    });
  } catch {
    // noop
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

document.addEventListener('DOMContentLoaded', () => {
  void init();
});

export { };
