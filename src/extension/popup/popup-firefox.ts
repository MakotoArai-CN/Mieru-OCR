import { showConfirm } from '../ui/modal';

declare const browser: any;

let currentCaptcha: any = null;
let recognizedText: string | null = null;
let currentHostname: string | null = null;
let currentSiteRuleKey: string | null = null;
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
elements.btnSettings?.addEventListener('click', () => browser.runtime.openOptionsPage());
elements.btnCaptcha?.addEventListener('click', selectCaptcha);
elements.btnInput?.addEventListener('click', selectInput);
elements.btnCopy?.addEventListener('click', copyResult);
elements.btnPreview?.addEventListener('click', previewCaptcha);
elements.btnDeleteRule?.addEventListener('click', deleteSiteRule);
elements.btnClearInput?.addEventListener('click', clearCustomInput);
}

async function applyTheme(): Promise<void> {
try {
const result = await browser.storage.local.get('settings');
const theme = result?.settings?.theme || 'auto';
let effectiveTheme = theme;
if (theme === 'auto') {
effectiveTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
document.body.setAttribute('data-theme', effectiveTheme);
} catch {
document.body.setAttribute('data-theme', 'dark');
}
}

async function toggleTheme(): Promise<void> {
try {
const result = await browser.storage.local.get('settings');
const settings = result?.settings || {};
const themes = ['light', 'dark', 'auto'];
const currentIndex = themes.indexOf(settings.theme || 'auto');
settings.theme = themes[(currentIndex + 1) % themes.length];
await browser.storage.local.set({ settings });
await applyTheme();
showToast(`主题: ${settings.theme === 'auto' ? '自动' : settings.theme === 'dark' ? '深色' : '浅色'}`, 'success');
} catch {
showToast('主题切换失败', 'error');
}
}

function isInjectableUrl(url: string): boolean {
return url.startsWith('http://') || url.startsWith('https://');
}

async function safeSendMessage(tabId: number, tabUrl: string, message: any): Promise<any> {
if (!isInjectableUrl(tabUrl)) {
throw new Error('当前页面不支持注入内容脚本');
}
try {
await browser.tabs.sendMessage(tabId, { action: 'ping' });
} catch {
throw new Error('无法连接内容脚本，请刷新页面后重试');
}
return await browser.tabs.sendMessage(tabId, message);
}

async function loadStatus(): Promise<void> {
try {
const tabs = await browser.tabs.query({ active: true, currentWindow: true });
const tab = tabs?.[0];
if (!tab?.id || !tab.url) return;

const url = new URL(tab.url);
currentHostname = url.hostname;

const rulesResponse = await browser.runtime.sendMessage({ action: 'getSiteRules' });
const rules = rulesResponse?.success ? rulesResponse.rules : {};
const currentUrl = tab.url;

let matched: { key: string; rule: any } | null = null;
for (const key of Object.keys(rules)) {
const rule = rules[key];
if (!rule?.enabled) continue;
if (rule.fullUrl && currentUrl === rule.fullUrl) {
matched = { key, rule };
break;
}
if (rule.urlPattern && currentUrl.startsWith(rule.urlPattern)) {
matched = { key, rule };
break;
}
if (rule.hostname === currentHostname && !rule.fullUrl && !rule.urlPattern) {
matched = { key, rule };
}
}
if (matched) {
currentSiteRuleKey = matched.key;
currentSiteRule = matched.rule;
showRuleSection(matched.rule);
} else {
currentSiteRuleKey = null;
currentSiteRule = null;
elements.ruleSection?.classList.add('hidden');
}

const statusResponse = await safeSendMessage(tab.id, tab.url, { action: 'getStatus' });
if (statusResponse?.success) {
hasCustomInput = !!statusResponse.hasCustomInput;
hasCustomCaptcha = !!statusResponse.hasCustomCaptcha;
isReady = !!statusResponse.isReady;

if (hasCustomInput) showInputSection();
else elements.inputSection?.classList.add('hidden');

updateReadyStatus();
}

const scanResponse = await safeSendMessage(tab.id, tab.url, { action: 'scan' });
if (scanResponse?.success) {
elements.captchaCount!.textContent = `${scanResponse.captchas.length} 个验证码`;
if (scanResponse.captchas.length > 0 || hasCustomCaptcha) {
currentCaptcha = scanResponse.bestCaptcha;
updateCaptchaInfo(scanResponse.bestCaptcha || { type: 'custom', confidence: 100 });
} else {
currentCaptcha = null;
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
const selectorText = String(rule?.selector || '');
const selector = selectorText.length > 25 ? selectorText.substring(0, 25) + '...' : selectorText;
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
elements.captchaType!.textContent = String(captcha.type || 'unknown').toUpperCase();
}

function updateOcrStatusView(status: string, message?: string): void {
if (!elements.ocrStatus) return;

if (status === 'ready') {
elements.ocrStatus.textContent = '就绪';
elements.ocrStatus.className = 'value status-ready';
elements.ocrStatus.title = '';
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
const resp = await browser.runtime.sendMessage({ action: 'getOcrStatus' });
if (resp?.success && resp.ocrStatus) {
updateOcrStatusView(resp.ocrStatus.status, resp.ocrStatus.message);
}
} catch { }
};

poll();
if (statusTimer) window.clearInterval(statusTimer);
statusTimer = window.setInterval(poll, 800);
}

async function selectCaptcha(): Promise<void> {
setStatus('processing', '选择验证码...');
(elements.btnCaptcha as HTMLButtonElement).disabled = true;

try {
const tabs = await browser.tabs.query({ active: true, currentWindow: true });
const tab = tabs?.[0];
if (!tab?.id || !tab.url) throw new Error('无法获取当前标签页');

const response = await safeSendMessage(tab.id, tab.url, { action: 'startPicker' });
if (response?.success) {
hasCustomCaptcha = true;
showToast('已进入选择模式', 'success');
updateReadyStatus();
}
window.close();
} catch (error) {
showToast((error as Error).message || '选择失败', 'error');
setStatus('idle', '自动识别中');
(elements.btnCaptcha as HTMLButtonElement).disabled = false;
}
}

async function selectInput(): Promise<void> {
setStatus('processing', '选择输入框...');
(elements.btnInput as HTMLButtonElement).disabled = true;

try {
const tabs = await browser.tabs.query({ active: true, currentWindow: true });
const tab = tabs?.[0];
if (!tab?.id || !tab.url) throw new Error('无法获取当前标签页');

const response = await safeSendMessage(tab.id, tab.url, { action: 'startInputPicker' });
if (response?.success) {
hasCustomInput = true;
showInputSection();
showToast('已进入选择模式', 'success');
updateReadyStatus();
}
window.close();
} catch (error) {
showToast((error as Error).message || '选择失败', 'error');
setStatus('idle', '自动识别中');
(elements.btnInput as HTMLButtonElement).disabled = false;
}
}

async function clearCustomInput(): Promise<void> {
try {
const ok = await showConfirm({
title: '清除选择',
message: '确定要清除本页手动选择的输入框吗？',
confirmText: '确定清除',
cancelText: '取消',
});
if (!ok) return;

const tabs = await browser.tabs.query({ active: true, currentWindow: true });
const tab = tabs?.[0];
if (!tab?.id || !tab.url) throw new Error('无法获取当前标签页');

await safeSendMessage(tab.id, tab.url, { action: 'clearCustomInput' });

elements.inputSection?.classList.add('hidden');
hasCustomInput = false;
showToast('已清除输入框选择', 'success');
await loadStatus();
} catch (error) {
showToast((error as Error).message || '清除失败', 'error');
}
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
const tabs = await browser.tabs.query({ active: true, currentWindow: true });
const tab = tabs?.[0];
if (!tab?.id || !tab.url) throw new Error('无法获取当前标签页');

await safeSendMessage(tab.id, tab.url, { action: 'previewCaptcha', captchaId: currentCaptcha?.id });
showToast('预览窗口已在页面中打开', 'success');
} catch (error) {
showToast((error as Error).message || '预览失败', 'error');
}
}

async function deleteSiteRule(): Promise<void> {
if (!currentSiteRuleKey) {
showToast('未找到可删除的规则', 'error');
return;
}
const ok = await showConfirm({
title: '删除规则',
message: '确定要删除当前网站规则吗？',
confirmText: '确定删除',
cancelText: '取消',
});
if (!ok) return;

try {
await browser.runtime.sendMessage({ action: 'deleteSiteRule', ruleKey: currentSiteRuleKey });
elements.ruleSection?.classList.add('hidden');
currentSiteRuleKey = null;
currentSiteRule = null;
showToast('已删除网站规则', 'success');
await loadStatus();
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
export { };