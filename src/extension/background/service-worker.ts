import type { ExtensionSettings, SiteRule } from '@core/types';

const OFFSCREEN_URL = 'offscreen.html';

type OcrEngineStatus = 'ready' | 'initializing' | 'fault';

interface OcrStatus {
  status: OcrEngineStatus;
  message?: string;
  updatedAt: number;
}

let ocrStatus: OcrStatus = {
  status: 'initializing',
  message: '等待首次识别',
  updatedAt: Date.now(),
};

let offscreenCreating: Promise<void> | null = null;

function setOcrStatus(status: OcrEngineStatus, message?: string): void {
  ocrStatus = { status, message, updatedAt: Date.now() };
  console.log('[Service Worker] OCR状态更新:', status, message);
}

async function ensureOffscreenDocument(): Promise<void> {
  const offscreenApi = (chrome as any).offscreen;
  if (!offscreenApi) {
    setOcrStatus('fault', '浏览器不支持 offscreen API');
    throw new Error('chrome.offscreen API 不可用');
  }

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  const getContexts = (chrome.runtime as any).getContexts;
  if (typeof getContexts === 'function') {
    try {
      const existing = await getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      });
      if (Array.isArray(existing) && existing.length > 0) {
        return;
      }
    } catch (e) {
      console.warn('[Service Worker] getContexts 失败:', e);
    }
  }

  offscreenCreating = offscreenApi.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_SCRAPING'],
    justification: 'Run OCR inference with onnxruntime-web',
  });

  try {
    await offscreenCreating;
    console.log('[Service Worker] Offscreen document 已创建');
  } finally {
    offscreenCreating = null;
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Service Worker] 扩展安装/更新:', details.reason);
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true;
});

async function handleMessage(
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void
): Promise<void> {
  const debugMode = await getDebugMode();
  
  if (debugMode) {
    console.log('[Service Worker] 收到消息:', message.action, message);
  }

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

      case 'updateSiteRule':
        await handleUpdateSiteRule(message, sendResponse);
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

      case 'captchaDetected':
        if (debugMode) {
          console.log('[Service Worker] 检测到验证码:', message.count);
        }
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ success: false, error: '未知操作: ' + message.action });
    }
  } catch (error) {
    console.error('[Service Worker] 处理消息失败:', error);
    sendResponse({ success: false, error: (error as Error).message });
  }
}

async function getDebugMode(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get('settings');
    return result.settings?.debugMode || false;
  } catch {
    return false;
  }
}

async function handleRecognize(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  const startTime = Date.now();
  const debugMode = await getDebugMode();

  try {
    if (debugMode) {
      console.log('[Service Worker] 开始识别, 图像大小:', message.imageData?.length);
    }

    setOcrStatus('initializing', '正在初始化OCR引擎...');
    await ensureOffscreenDocument();

    if (debugMode) {
      console.log('[Service Worker] Offscreen document 就绪, 发送识别请求...');
    }

    const resp = await chrome.runtime.sendMessage({
      action: 'offscreen:recognize',
      imageData: message.imageData,
    });

    const elapsed = Date.now() - startTime;

    if (resp?.success) {
      setOcrStatus('ready', '识别完成');
      if (debugMode) {
        console.log('[Service Worker] 识别成功:', resp.text, '耗时:', elapsed, 'ms');
      }
      sendResponse({ success: true, text: resp.text, elapsed });
    } else {
      setOcrStatus('fault', resp?.error || '识别失败');
      console.error('[Service Worker] 识别失败:', resp?.error);
      sendResponse({ success: false, error: resp?.error || '识别失败', elapsed });
    }
  } catch (error) {
    const elapsed = Date.now() - startTime;
    setOcrStatus('fault', (error as Error).message);
    console.error('[Service Worker] 识别异常:', error);
    sendResponse({ success: false, error: (error as Error).message, elapsed });
  }
}

async function handleGetSettings(sendResponse: (response: any) => void): Promise<void> {
  const result = await chrome.storage.local.get('settings');
  sendResponse({ success: true, settings: result.settings || getDefaultSettings() });
}

async function handleSaveSettings(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  await chrome.storage.local.set({ settings: message.settings });
  
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && tab.url?.startsWith('http')) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'updateSettings' });
      } catch {}
    }
  }
  
  sendResponse({ success: true });
}

async function handleGetSiteRules(sendResponse: (response: any) => void): Promise<void> {
  const result = await chrome.storage.local.get('siteRules');
  sendResponse({ success: true, rules: result.siteRules || {} });
}

async function handleSaveSiteRule(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  const { hostname, rule } = message;
  const result = await chrome.storage.local.get('siteRules');
  const rules = result.siteRules || {};

  const ruleKey = rule.fullUrl || rule.urlPattern || hostname;

  const existingRule = rules[ruleKey] || {};
  
  rules[ruleKey] = {
    ...existingRule,
    ...rule,
    hostname,
    fullUrl: rule.fullUrl || existingRule.fullUrl,
    urlPattern: rule.urlPattern || existingRule.urlPattern,
    createdAt: existingRule.createdAt || Date.now(),
    updatedAt: Date.now(),
  };

  await chrome.storage.local.set({ siteRules: rules });
  
  console.log('[Service Worker] 规则已保存:', ruleKey, rules[ruleKey]);
  
  sendResponse({ success: true });
}

async function handleUpdateSiteRule(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  const { oldKey, newRule } = message;
  const result = await chrome.storage.local.get('siteRules');
  const rules = result.siteRules || {};

  if (oldKey && rules[oldKey]) {
    delete rules[oldKey];
  }

  const newKey = newRule.fullUrl || newRule.urlPattern || newRule.hostname;
  rules[newKey] = {
    ...newRule,
    updatedAt: Date.now(),
  };

  await chrome.storage.local.set({ siteRules: rules });
  sendResponse({ success: true });
}

async function handleDeleteSiteRule(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  const { hostname, ruleKey } = message;
  const result = await chrome.storage.local.get('siteRules');
  const rules = result.siteRules || {};

  const keyToDelete = ruleKey || hostname;
  
  if (rules[keyToDelete]) {
    delete rules[keyToDelete];
    console.log('[Service Worker] 规则已删除:', keyToDelete);
  }

  await chrome.storage.local.set({ siteRules: rules });
  sendResponse({ success: true });
}

async function handleExportConfig(sendResponse: (response: any) => void): Promise<void> {
  const result = await chrome.storage.local.get(['settings', 'siteRules']);
  sendResponse({ success: true, config: result });
}

async function handleImportConfig(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
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
    agreementSelectors: [],
    autoCheckAgreement: true,
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
    enableNotification: true,
    timeout: 30000,
    retryCount: 3,
    autoFill: true,
    autoSubmit: false,
    autoSolveOnRule: true,
    debugMode: false,
    historyRetention: 7,
  };
}

console.log('[Service Worker] 初始化完成');