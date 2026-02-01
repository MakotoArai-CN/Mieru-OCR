let currentCaptcha: any = null;
let recognizedText: string | null = null;
let currentHostname: string | null = null;
let currentSiteRule: any = null;
let hasCustomInput = false;
let hasCustomCaptcha = false;
let statusTimer: number | null = null;
let isReady = false;

const elements: Record<string, HTMLElement | null> = {};

async function init(): Promise<void> {
  cacheElements();
  bindEvents();
  await applyTheme();
  await loadStatus();
  startStatusPolling();
}

function cacheElements(): void {
  elements.statusIndicator = document.getElementById('status-indicator');
  elements.statusText = document.getElementById('status-text');
  elements.captchaCount = document.getElementById('captcha-count');
  elements.captchaSection = document.getElementById('captcha-section');
  elements.captchaType = document.getElementById('captcha-type');
  elements.ocrStatus = document.getElementById('ocr-status');
  elements.resultSection = document.getElementById('result-section');
  elements.resultText = document.getElementById('result-text');
  elements.resultTime = document.getElementById('result-time');
  elements.ruleSection = document.getElementById('rule-section');
  elements.ruleText = document.getElementById('rule-text');
  elements.inputSection = document.getElementById('input-section');
  elements.inputText = document.getElementById('input-text');
  elements.btnTheme = document.getElementById('btn-theme');
  elements.btnSettings = document.getElementById('btn-settings');
  elements.btnCaptcha = document.getElementById('btn-captcha');
  elements.btnInput = document.getElementById('btn-input');
  elements.btnCopy = document.getElementById('btn-copy');
  elements.btnPreview = document.getElementById('btn-preview');
  elements.btnDeleteRule = document.getElementById('btn-delete-rule');
  elements.btnClearInput = document.getElementById('btn-clear-input');
  elements.toast = document.getElementById('toast');
  elements.toastIcon = document.getElementById('toast-icon');
  elements.toastMessage = document.getElementById('toast-message');
}

function bindEvents(): void {
  elements.btnTheme?.addEventListener('click', toggleTheme);
  elements.btnSettings?.addEventListener('click', () => chrome.runtime.openOptionsPage());
  elements.btnCaptcha?.addEventListener('click', selectCaptcha);
  elements.btnInput?.addEventListener('click', selectInput);
  elements.btnCopy?.addEventListener('click', copyResult);
  elements.btnPreview?.addEventListener('click', previewCaptcha);
  elements.btnDeleteRule?.addEventListener('click', deleteSiteRule);
  elements.btnClearInput?.addEventListener('click', clearCustomInput);
}

async function applyTheme(): Promise<void> {
  const result = await chrome.storage.local.get('settings');
  const theme = result.settings?.theme || 'auto';
  let effectiveTheme = theme;
  if (theme === 'auto') {
    effectiveTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.body.setAttribute('data-theme', effectiveTheme);
}

async function toggleTheme(): Promise<void> {
  const result = await chrome.storage.local.get('settings');
  const settings = result.settings || {};
  const themes = ['light', 'dark', 'auto'];
  const currentIndex = themes.indexOf(settings.theme || 'auto');
  settings.theme = themes[(currentIndex + 1) % themes.length];
  await chrome.storage.local.set({ settings });
  await applyTheme();
  showToast(`主题: ${settings.theme === 'auto' ? '自动' : settings.theme === 'dark' ? '深色' : '浅色'}`, 'success');
}

function isInjectableUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

async function ensureContentScript(tabId: number, tabUrl: string): Promise<boolean> {
  if (!isInjectableUrl(tabUrl)) return false;

  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return true;
  } catch (e) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (e) {
    return false;
  }

  await new Promise(resolve => setTimeout(resolve, 150));

  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return true;
  } catch (e) {
    return false;
  }
}

async function safeSendMessage(tabId: number, tabUrl: string, message: any): Promise<any> {
  const ok = await ensureContentScript(tabId, tabUrl);
  if (!ok) {
    throw new Error('无法连接内容脚本');
  }
  return await chrome.tabs.sendMessage(tabId, message);
}

async function loadStatus(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return;

    const url = new URL(tab.url);
    currentHostname = url.hostname;

    const rulesResponse = await chrome.runtime.sendMessage({ action: 'getSiteRules' });
    const rules = rulesResponse.success ? rulesResponse.rules : {};

    let matchedRule = null;
    const currentUrl = tab.url;
    
    for (const key of Object.keys(rules)) {
      const rule = rules[key];
      if (!rule.enabled) continue;
      
      if (rule.fullUrl && currentUrl === rule.fullUrl) {
        matchedRule = { key, rule };
        break;
      }
      
      if (rule.urlPattern && currentUrl.startsWith(rule.urlPattern)) {
        matchedRule = { key, rule };
        break;
      }
      
      if (rule.hostname === currentHostname && !rule.fullUrl && !rule.urlPattern) {
        matchedRule = { key, rule };
      }
    }

    if (matchedRule) {
      currentSiteRule = matchedRule.rule;
      showRuleSection(matchedRule.rule);
    }

    const statusResponse = await safeSendMessage(tab.id, tab.url, { action: 'getStatus' });
    if (statusResponse.success) {
      hasCustomInput = statusResponse.hasCustomInput || false;
      hasCustomCaptcha = statusResponse.hasCustomCaptcha || false;
      isReady = statusResponse.isReady || false;

      if (hasCustomInput) {
        showInputSection();
      }

      updateReadyStatus();
    }

    const scanResponse = await safeSendMessage(tab.id, tab.url, { action: 'scan' });
    if (scanResponse.success) {
      elements.captchaCount!.textContent = `${scanResponse.captchas.length} 个验证码`;

      if (scanResponse.captchas.length > 0 || hasCustomCaptcha) {
        currentCaptcha = scanResponse.bestCaptcha;
        updateCaptchaInfo(scanResponse.bestCaptcha || { type: 'custom', confidence: 100 });
      } else {
        updateCaptchaInfo(null);
      }
    }
  } catch (error) {
    console.error('加载状态失败', error);
    showToast((error as Error).message || '加载状态失败', 'error');
  }
}

function updateReadyStatus(): void {
  if (isReady) {
    setStatus('idle', '等待识别');
  } else if (hasCustomCaptcha || hasCustomInput) {
    setStatus('idle', '请选择缺少的元素');
  } else {
    setStatus('idle', '自动检测中');
  }
}

function showRuleSection(rule: any): void {
  elements.ruleSection?.classList.remove('hidden');
  const selector = rule.selector.length > 25 ? rule.selector.substring(0, 25) + '...' : rule.selector;
  elements.ruleText!.textContent = `已记住: ${selector}`;
}

function showInputSection(): void {
  elements.inputSection?.classList.remove('hidden');
}

function updateCaptchaInfo(captcha: any): void {
  if (!captcha) {
    elements.captchaSection?.classList.add('hidden');
    return;
  }

  elements.captchaSection?.classList.remove('hidden');
  elements.captchaType!.textContent = (captcha.type || 'unknown').toUpperCase();
}

function updateOcrStatusView(status: string, message?: string): void {
  if (!elements.ocrStatus) return;

  if (status === 'ready') {
    elements.ocrStatus.textContent = '就绪';
    elements.ocrStatus.className = 'value status-ready';
    return;
  }

  if (status === 'fault') {
    elements.ocrStatus.textContent = '故障';
    elements.ocrStatus.className = 'value status-fault';
    elements.ocrStatus.title = message || '';
    return;
  }

  elements.ocrStatus.textContent = '初始化';
  elements.ocrStatus.className = 'value status-initializing';
  elements.ocrStatus.title = message || '';
}

function startStatusPolling(): void {
  const poll = async () => {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'getOcrStatus' });
      if (resp?.success && resp.ocrStatus) {
        updateOcrStatusView(resp.ocrStatus.status, resp.ocrStatus.message);
      }
    } catch {}
  };

  poll();

  if (statusTimer) window.clearInterval(statusTimer);
  statusTimer = window.setInterval(poll, 800);
}

async function selectCaptcha(): Promise<void> {
  setStatus('processing', '选择验证码...');
  (elements.btnCaptcha as HTMLButtonElement).disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) throw new Error('无法获取当前标签页');

    const response = await safeSendMessage(tab.id, tab.url, { action: 'startPicker' });

    if (response.success) {
      hasCustomCaptcha = true;
      
      await chrome.runtime.sendMessage({
        action: 'saveSiteRule',
        hostname: response.hostname,
        rule: {
          selector: response.selector,
          info: response.info,
          fullUrl: response.fullUrl,
          urlPattern: response.urlPattern,
          enabled: true,
        },
      });

      showToast('已保存验证码规则', 'success');
      updateReadyStatus();
    }

    window.close();
  } catch (error) {
    showToast((error as Error).message, 'error');
    setStatus('idle', '自动识别中');
    (elements.btnCaptcha as HTMLButtonElement).disabled = false;
  }
}

async function selectInput(): Promise<void> {
  setStatus('processing', '选择输入框...');
  (elements.btnInput as HTMLButtonElement).disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) throw new Error('无法获取当前标签页');

    const response = await safeSendMessage(tab.id, tab.url, { action: 'startInputPicker' });

    if (response.success) {
      hasCustomInput = true;
      showToast('已选择输入框', 'success');
      updateReadyStatus();
    }

    window.close();
  } catch (error) {
    showToast((error as Error).message, 'error');
    setStatus('idle', '自动识别中');
    (elements.btnInput as HTMLButtonElement).disabled = false;
  }
}

async function clearCustomInput(): Promise<void> {
  elements.inputSection?.classList.add('hidden');
  hasCustomInput = false;
  showToast('已清除输入框选择', 'success');
  updateReadyStatus();
}

async function copyResult(): Promise<void> {
  if (!recognizedText) return;

  try {
    await navigator.clipboard.writeText(recognizedText);
    showToast('已复制', 'success');
  } catch {
    showToast('复制失败', 'error');
  }
}

async function previewCaptcha(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) throw new Error('无法获取当前标签页');

    await safeSendMessage(tab.id, tab.url, {
      action: 'previewCaptcha',
      captchaId: currentCaptcha?.id,
    });

    showToast('预览窗口已在页面中打开', 'success');
  } catch (error) {
    showToast((error as Error).message, 'error');
  }
}

async function deleteSiteRule(): Promise<void> {
  if (!currentHostname) return;

  try {
    const rulesResponse = await chrome.runtime.sendMessage({ action: 'getSiteRules' });
    const rules = rulesResponse.success ? rulesResponse.rules : {};
    
    let keyToDelete: string | null = null;
    
    for (const key of Object.keys(rules)) {
      const rule = rules[key];
      if (rule.hostname === currentHostname) {
        keyToDelete = key;
        break;
      }
    }

    if (keyToDelete) {
      await chrome.runtime.sendMessage({
        action: 'deleteSiteRule',
        ruleKey: keyToDelete,
        hostname: currentHostname,
      });
    }

    elements.ruleSection?.classList.add('hidden');
    currentSiteRule = null;
    showToast('已删除网站规则', 'success');
  } catch {
    showToast('删除失败', 'error');
  }
}

function setStatus(status: string, text: string): void {
  elements.statusIndicator!.className = `status-indicator status-${status}`;
  elements.statusText!.textContent = text;
}

function showToast(message: string, type: 'success' | 'error'): void {
  elements.toast!.className = `toast ${type}`;
  elements.toastIcon!.textContent = type === 'success' ? '✓' : '✕';
  elements.toastMessage!.textContent = message;
  elements.toast!.classList.remove('hidden');

  setTimeout(() => elements.toast!.classList.add('hidden'), 2500);
}

document.addEventListener('DOMContentLoaded', init);

export {};