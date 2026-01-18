let currentCaptcha: any = null;
let recognizedText: string | null = null;
let currentHostname: string | null = null;
let currentSiteRule: any = null;
let hasCustomInput = false;
let statusTimer: number | null = null;

const elements: Record<string, HTMLElement | null> = {};

async function init() {
  cacheElements();
  bindEvents();
  await applyTheme();
  await loadStatus();
  startStatusPolling();
}

function cacheElements() {
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

function bindEvents() {
  elements.btnTheme?.addEventListener('click', toggleTheme);
  elements.btnSettings?.addEventListener('click', () => chrome.runtime.openOptionsPage());
  elements.btnCaptcha?.addEventListener('click', selectCaptcha);
  elements.btnInput?.addEventListener('click', selectInput);
  elements.btnCopy?.addEventListener('click', copyResult);
  elements.btnPreview?.addEventListener('click', previewCaptcha);
  elements.btnDeleteRule?.addEventListener('click', deleteSiteRule);
  elements.btnClearInput?.addEventListener('click', clearCustomInput);
}

async function applyTheme() {
  const result = await chrome.storage.local.get('settings');
  const theme = result.settings?.theme || 'auto';
  let effectiveTheme = theme;
  if (theme === 'auto') {
    effectiveTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.body.setAttribute('data-theme', effectiveTheme);
}

async function toggleTheme() {
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
    throw new Error('无法连接内容脚本（页面不可注入或未加载完成）');
  }
  return await chrome.tabs.sendMessage(tabId, message);
}

async function loadStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) return;

    const url = new URL(tab.url);
    currentHostname = url.hostname;

    const rulesResponse = await chrome.runtime.sendMessage({ action: 'getSiteRules' });
    const rules = rulesResponse.success ? rulesResponse.rules : {};
    const rule = rules[currentHostname];
    if (rule && rule.enabled !== false) {
      currentSiteRule = rule;
      showRuleSection(rule);
    }

    const statusResponse = await safeSendMessage(tab.id, tab.url, { action: 'getStatus' });
    if (statusResponse.success) {
      hasCustomInput = statusResponse.hasCustomInput || false;
      if (hasCustomInput) {
        showInputSection();
      }
    }

    const scanResponse = await safeSendMessage(tab.id, tab.url, { action: 'scan' });
    if (scanResponse.success) {
      elements.captchaCount!.textContent = `${scanResponse.captchas.length} 个验证码`;
      if (scanResponse.captchas.length > 0) {
        currentCaptcha = scanResponse.bestCaptcha;
        updateCaptchaInfo(scanResponse.bestCaptcha);
      } else {
        updateCaptchaInfo(null);
      }
    }
  } catch (error) {
    console.error('加载状态失败', error);
    showToast((error as Error).message || '加载状态失败', 'error');
  }
}

function showRuleSection(rule: any) {
  elements.ruleSection?.classList.remove('hidden');
  const selector = rule.selector.length > 25 ? rule.selector.substring(0, 25) + '...' : rule.selector;
  elements.ruleText!.textContent = `已记住: ${selector}`;
}

function showInputSection() {
  elements.inputSection?.classList.remove('hidden');
}

function updateCaptchaInfo(captcha: any) {
  if (!captcha) {
    elements.captchaSection?.classList.add('hidden');
    return;
  }
  elements.captchaSection?.classList.remove('hidden');
  elements.captchaType!.textContent = captcha.type.toUpperCase();
}

function updateOcrStatusView(status: string, message?: string) {
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

function startStatusPolling() {
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

async function selectCaptcha() {
  setStatus('processing', '选择验证码...');
  (elements.btnCaptcha as HTMLButtonElement).disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) throw new Error('无法获取当前标签页');
    const response = await safeSendMessage(tab.id, tab.url, { action: 'startPicker' });
    if (response.success) {
      await chrome.runtime.sendMessage({
        action: 'saveSiteRule',
        hostname: response.hostname,
        rule: { selector: response.selector, info: response.info, enabled: true }
      });
      showToast('已保存验证码规则', 'success');
    }
    window.close();
  } catch (error) {
    showToast((error as Error).message, 'error');
    setStatus('idle', '自动识别中');
    (elements.btnCaptcha as HTMLButtonElement).disabled = false;
  }
}

async function selectInput() {
  setStatus('processing', '选择输入框...');
  (elements.btnInput as HTMLButtonElement).disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) throw new Error('无法获取当前标签页');
    const response = await safeSendMessage(tab.id, tab.url, { action: 'startInputPicker' });
    if (response.success) {
      showToast('已选择输入框', 'success');
      hasCustomInput = true;
    }
    window.close();
  } catch (error) {
    showToast((error as Error).message, 'error');
    setStatus('idle', '自动识别中');
    (elements.btnInput as HTMLButtonElement).disabled = false;
  }
}

async function clearCustomInput() {
  elements.inputSection?.classList.add('hidden');
  hasCustomInput = false;
  showToast('已清除输入框选择', 'success');
}

async function copyResult() {
  if (!recognizedText) return;
  try {
    await navigator.clipboard.writeText(recognizedText);
    showToast('已复制', 'success');
  } catch {
    showToast('复制失败', 'error');
  }
}

async function previewCaptcha() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) throw new Error('无法获取当前标签页');
    await safeSendMessage(tab.id, tab.url, { action: 'previewCaptcha', captchaId: currentCaptcha?.id });
    showToast('预览窗口已在页面中打开', 'success');
  } catch (error) {
    showToast((error as Error).message, 'error');
  }
}

async function deleteSiteRule() {
  if (!currentHostname) return;
  try {
    await chrome.runtime.sendMessage({ action: 'deleteSiteRule', hostname: currentHostname });
    elements.ruleSection?.classList.add('hidden');
    currentSiteRule = null;
    showToast('已删除网站规则', 'success');
  } catch {
    showToast('删除失败', 'error');
  }
}

function setStatus(status: string, text: string) {
  elements.statusIndicator!.className = `status-indicator status-${status}`;
  elements.statusText!.textContent = text;
}

function showToast(message: string, type: 'success' | 'error') {
  elements.toast!.className = `toast ${type}`;
  elements.toastIcon!.textContent = type === 'success' ? '✓' : '✕';
  elements.toastMessage!.textContent = message;
  elements.toast!.classList.remove('hidden');
  setTimeout(() => elements.toast!.classList.add('hidden'), 2500);
}

document.addEventListener('DOMContentLoaded', init);
export {};