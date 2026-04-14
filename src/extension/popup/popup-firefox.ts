import { showConfirm } from '../ui/modal';
import { initLocale, t, translatePage } from '@core/i18n';

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
const result = await browser.storage.local.get('settings');
const lang = result?.settings?.language || 'auto';
initLocale(lang);
translatePage();
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
showToast(t('settings.theme.changed', t(`settings.theme.${settings.theme}`)), 'success');
} catch {
showToast(t('settings.theme.switchFailed'), 'error');
}
}

function isInjectableUrl(url: string): boolean {
return url.startsWith('http://') || url.startsWith('https://');
}

async function safeSendMessage(tabId: number, tabUrl: string, message: any): Promise<any> {
if (!isInjectableUrl(tabUrl)) {
throw new Error(t('popup.cannotInject'));
}
try {
await browser.tabs.sendMessage(tabId, { action: 'ping' });
} catch {
throw new Error(t('popup.cannotConnectRefresh'));
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

if (!isInjectableUrl(tab.url)) {
updateCaptchaInfo(null);
return;
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
elements.captchaCount!.textContent = t('popup.captchaCount', scanResponse.captchas.length);
if (scanResponse.captchas.length > 0 || hasCustomCaptcha) {
currentCaptcha = scanResponse.bestCaptcha;
updateCaptchaInfo(scanResponse.bestCaptcha || { type: 'custom', confidence: 100 });
} else {
currentCaptcha = null;
updateCaptchaInfo(null);
}
}
} catch (error) {
console.error(t('popup.loadFailed'), error);
showToast((error as Error).message || t('popup.loadFailed'), 'error');
}
}

function updateReadyStatus(): void {
if (isReady) {
setStatus('idle', t('popup.waitRecognize'));
} else if (hasCustomCaptcha || hasCustomInput) {
setStatus('idle', t('popup.selectMissing'));
} else {
setStatus('idle', t('popup.autoDetecting'));
}
}

function showRuleSection(rule: any): void {
elements.ruleSection?.classList.remove('hidden');
const selectorText = String(rule?.selector || '');
const selector = selectorText.length > 25 ? selectorText.substring(0, 25) + '...' : selectorText;
elements.ruleText!.textContent = t('popup.ruleRemembered', selector);
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
elements.ocrStatus.textContent = t('popup.status.ready');
elements.ocrStatus.className = 'value status-ready';
elements.ocrStatus.title = '';
return;
}
if (status === 'fault') {
elements.ocrStatus.textContent = t('popup.status.fault');
elements.ocrStatus.className = 'value status-fault';
elements.ocrStatus.title = message || '';
return;
}

elements.ocrStatus.textContent = t('popup.status.init');
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
setStatus('processing', t('popup.selecting'));
(elements.btnCaptcha as HTMLButtonElement).disabled = true;

try {
const tabs = await browser.tabs.query({ active: true, currentWindow: true });
const tab = tabs?.[0];
if (!tab?.id || !tab.url) throw new Error(t('popup.tabError'));

const response = await safeSendMessage(tab.id, tab.url, { action: 'startPicker' });
if (response?.success) {
hasCustomCaptcha = true;
showToast(t('popup.selectionMode'), 'success');
updateReadyStatus();
}
window.close();
} catch (error) {
showToast((error as Error).message || t('popup.selectionFailed'), 'error');
setStatus('idle', t('popup.autoRecognizing'));
(elements.btnCaptcha as HTMLButtonElement).disabled = false;
}
}

async function selectInput(): Promise<void> {
setStatus('processing', t('popup.selectingInput'));
(elements.btnInput as HTMLButtonElement).disabled = true;

try {
const tabs = await browser.tabs.query({ active: true, currentWindow: true });
const tab = tabs?.[0];
if (!tab?.id || !tab.url) throw new Error(t('popup.tabError'));

const response = await safeSendMessage(tab.id, tab.url, { action: 'startInputPicker' });
if (response?.success) {
hasCustomInput = true;
showInputSection();
showToast(t('popup.selectionMode'), 'success');
updateReadyStatus();
}
window.close();
} catch (error) {
showToast((error as Error).message || t('popup.selectionFailed'), 'error');
setStatus('idle', t('popup.autoRecognizing'));
(elements.btnInput as HTMLButtonElement).disabled = false;
}
}

async function clearCustomInput(): Promise<void> {
try {
const ok = await showConfirm({
title: t('popup.clearInput'),
message: t('popup.clearInputConfirm'),
confirmText: t('stats.clearConfirmBtn'),
cancelText: t('common.cancel'),
});
if (!ok) return;

const tabs = await browser.tabs.query({ active: true, currentWindow: true });
const tab = tabs?.[0];
if (!tab?.id || !tab.url) throw new Error(t('popup.tabError'));

await safeSendMessage(tab.id, tab.url, { action: 'clearCustomInput' });

elements.inputSection?.classList.add('hidden');
hasCustomInput = false;
showToast(t('popup.inputCleared'), 'success');
await loadStatus();
} catch (error) {
showToast((error as Error).message || t('popup.clearFailed'), 'error');
}
}

async function copyResult(): Promise<void> {
if (!recognizedText) return;
try {
await navigator.clipboard.writeText(recognizedText);
showToast(t('popup.copied'), 'success');
} catch {
showToast(t('popup.copyFailed'), 'error');
}
}

async function previewCaptcha(): Promise<void> {
try {
const tabs = await browser.tabs.query({ active: true, currentWindow: true });
const tab = tabs?.[0];
if (!tab?.id || !tab.url) throw new Error(t('popup.tabError'));

await safeSendMessage(tab.id, tab.url, { action: 'previewCaptcha', captchaId: currentCaptcha?.id });
showToast(t('popup.previewOpened'), 'success');
} catch (error) {
showToast((error as Error).message || t('popup.previewFailed'), 'error');
}
}

async function deleteSiteRule(): Promise<void> {
if (!currentSiteRuleKey) {
showToast(t('popup.noRuleFound'), 'error');
return;
}
const ok = await showConfirm({
title: t('popup.deleteRule'),
message: t('rules.deleteRuleConfirmMsg'),
confirmText: t('common.delete'),
cancelText: t('common.cancel'),
});
if (!ok) return;

try {
await browser.runtime.sendMessage({ action: 'deleteSiteRule', ruleKey: currentSiteRuleKey });
elements.ruleSection?.classList.add('hidden');
currentSiteRuleKey = null;
currentSiteRule = null;
showToast(t('popup.ruleDeleted'), 'success');
await loadStatus();
} catch {
showToast(t('popup.deleteFailed'), 'error');
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