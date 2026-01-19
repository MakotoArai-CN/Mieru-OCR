import type { ExtensionSettings } from '@core/types';

const OFFSCREEN_URL = 'offscreen.html';

type OcrEngineStatus = 'ready' | 'initializing' | 'fault';

let ocrStatus: { status: OcrEngineStatus; message?: string; updatedAt: number } = {
  status: 'initializing',
  message: '初始化中',
  updatedAt: Date.now(),
};

function setOcrStatus(status: OcrEngineStatus, message?: string) {
  ocrStatus = { status, message, updatedAt: Date.now() };
}

async function ensureOffscreenDocument(): Promise<void> {
  const offscreenApi = (chrome as any).offscreen;
  if (!offscreenApi) {
    setOcrStatus('fault', '浏览器不支持 offscreen API');
    throw new Error('chrome.offscreen API 不可用，请确认 Chrome 版本支持 MV3 offscreen document');
  }

  const getContexts = (chrome.runtime as any).getContexts;
  if (typeof getContexts === 'function') {
    const existing = await getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (Array.isArray(existing) && existing.length > 0) return;
  }

  await offscreenApi.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_SCRAPING'],
    justification: 'Run OCR inference with onnxruntime-web in a DOM-capable context',
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('扩展安装/更新', details.reason);
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true;
});

async function handleMessage(message: any, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
  try {
    switch (message.action) {
      case 'recognizeCaptcha':
        await handleRecognize(message, sendResponse);
        break;
      case 'getSettings':
        await handleGetSettings(sendResponse);
        break;
      case 'saveSettings':
        await handleSaveSettings(message, sendResponse);
        break;
      case 'getSiteRules':
        await handleGetSiteRules(sendResponse);
        break;
      case 'saveSiteRule':
        await handleSaveSiteRule(message, sendResponse);
        break;
      case 'deleteSiteRule':
        await handleDeleteSiteRule(message, sendResponse);
        break;
      case 'exportConfig':
        await handleExportConfig(sendResponse);
        break;
      case 'importConfig':
        await handleImportConfig(message, sendResponse);
        break;
      case 'getOcrStatus':
        sendResponse({ success: true, ocrStatus });
        break;
      default:
        sendResponse({ success: false, error: '未知操作' });
    }
  } catch (error) {
    console.error('处理消息失败', error);
    sendResponse({ success: false, error: (error as Error).message });
  }
}

async function handleRecognize(message: any, sendResponse: (response: any) => void) {
  const startTime = Date.now();
  try {
    setOcrStatus('initializing', '初始化中');

    await ensureOffscreenDocument();

    const resp = await chrome.runtime.sendMessage({
      action: 'offscreen:recognize',
      imageData: message.imageData,
    });

    if (resp?.success) {
      setOcrStatus('ready', '就绪');
      sendResponse({ success: true, text: resp.text, elapsed: Date.now() - startTime });
    } else {
      setOcrStatus('fault', resp?.error || '识别失败');
      sendResponse({ success: false, error: resp?.error || '识别失败', elapsed: Date.now() - startTime });
    }
  } catch (error) {
    setOcrStatus('fault', (error as Error).message);
    sendResponse({ success: false, error: (error as Error).message, elapsed: Date.now() - startTime });
  }
}

async function handleGetSettings(sendResponse: (response: any) => void) {
  const result = await chrome.storage.local.get('settings');
  sendResponse({ success: true, settings: result.settings || getDefaultSettings() });
}

async function handleSaveSettings(message: any, sendResponse: (response: any) => void) {
  await chrome.storage.local.set({ settings: message.settings });
  sendResponse({ success: true });
}

async function handleGetSiteRules(sendResponse: (response: any) => void) {
  const result = await chrome.storage.local.get('siteRules');
  sendResponse({ success: true, rules: result.siteRules || {} });
}

async function handleSaveSiteRule(message: any, sendResponse: (response: any) => void) {
  const { hostname, rule } = message;
  const result = await chrome.storage.local.get('siteRules');
  const rules = result.siteRules || {};
  rules[hostname] = { ...rule, hostname, updatedAt: Date.now() };
  await chrome.storage.local.set({ siteRules: rules });
  sendResponse({ success: true });
}

async function handleDeleteSiteRule(message: any, sendResponse: (response: any) => void) {
  const { hostname } = message;
  const result = await chrome.storage.local.get('siteRules');
  const rules = result.siteRules || {};
  delete rules[hostname];
  await chrome.storage.local.set({ siteRules: rules });
  sendResponse({ success: true });
}

async function handleExportConfig(sendResponse: (response: any) => void) {
  const result = await chrome.storage.local.get(['settings', 'siteRules']);
  sendResponse({ success: true, config: result });
}

async function handleImportConfig(message: any, sendResponse: (response: any) => void) {
  const { config } = message;
  await chrome.storage.local.set(config);
  sendResponse({ success: true });
}

function getDefaultSettings(): ExtensionSettings {
  return {
    autoDetect: true,
    captchaSelector: '',
    inputSelector: '',
    submitSelector: '',
    agreementSelector: '',
    useLocalModel: false,
    localModelPath: '',
    localCharsetsPath: '',
    autoDownload: true,
    enableWhitelist: true,
    whitelist: [],
    useUploadedModel: false,
    theme: 'auto',
    typewriterEffect: true,
    autoCalculate: false,
    calculateOutputMode: 'result',
    calculateRules: [],
    timeout: 30000,
    retryCount: 3,
    autoFill: true,
    autoSubmit: false,
    autoSolveOnRule: true,
    debugMode: false,
    historyRetention: 7,
  };
}

console.log('✅ Service Worker 初始化完成');