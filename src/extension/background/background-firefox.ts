declare const browser: any;
import { OCREngine } from '@core/ocr-engine';
import type { ExtensionSettings } from '@core/types';

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

let ocrEngine: OCREngine | null = null;
let ocrEnginePromise: Promise<OCREngine> | null = null;
let ortInstance: any = null;

function setOcrStatus(status: OcrEngineStatus, message?: string): void {
  ocrStatus = { status, message, updatedAt: Date.now() };
  console.log('[Background Firefox] OCR状态更新:', status, message);
}

function getOrtFromGlobal(): any {
  const g = (typeof window !== 'undefined' ? window : self) as any;
  return g.ort || null;
}

async function loadOrt(): Promise<any> {
  if (ortInstance) return ortInstance;

  ortInstance = getOrtFromGlobal();
  if (!ortInstance) {
    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      ortInstance = getOrtFromGlobal();
      if (ortInstance) break;
    }
  }

  if (!ortInstance) {
    throw new Error('ort.min.js 未加载，全局 ort 对象不存在');
  }

  const base = browser.runtime.getURL('/');
  ortInstance.env.wasm.numThreads = 1;
  ortInstance.env.wasm.simd = true;
  ortInstance.env.wasm.proxy = false;
  ortInstance.env.wasm.wasmPaths = base;
  ortInstance.env.logLevel = 'error';

  console.log('[Background Firefox] ort.min.js 已就绪');
  return ortInstance;
}

async function getOCREngine(): Promise<OCREngine> {
  if (ocrEngine) return ocrEngine;

  if (ocrEnginePromise) return ocrEnginePromise;

  ocrEnginePromise = (async () => {
    try {
      const ort = await loadOrt();

      const engine = new OCREngine({
        getModel: async () => {
          const [modelRes, charsetsRes] = await Promise.all([
            fetch(browser.runtime.getURL('common.onnx')),
            fetch(browser.runtime.getURL('charsets.json')),
          ]);
          return {
            model: await modelRes.arrayBuffer(),
            charsets: await charsetsRes.json(),
          };
        },
        getOrt: async () => ort,
        wasmPaths: browser.runtime.getURL('/'),
      });

      await engine.init();
      ocrEngine = engine;
      return engine;
    } catch (error) {
      ocrEnginePromise = null;
      throw error;
    }
  })();

  return ocrEnginePromise;
}

browser.runtime.onInstalled.addListener((details: any) => {
  console.log('[Background Firefox] 扩展安装/更新:', details.reason);
  if (details.reason === 'install') {
    browser.runtime.openOptionsPage();
  }
});

browser.runtime.onMessage.addListener((message: any, sender: any, sendResponse: any) => {
  if (typeof sendResponse === 'function') {
    handleMessage(message, sender, sendResponse);
    return true;
  }

  return new Promise((resolve) => {
    handleMessage(message, sender, resolve);
  });
});

async function handleMessage(
  message: any,
  sender: any,
  sendResponse: (response: any) => void
): Promise<void> {
  const debugMode = await getDebugMode();

  if (debugMode) {
    console.log('[Background Firefox] 收到消息:', message.action, message);
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
          console.log('[Background Firefox] 检测到验证码:', message.count);
        }
        sendResponse({ success: true });
        break;
      case 'recordStats':
        await handleRecordStats(message, sendResponse);
        break;
      case 'getStats':
        await handleGetStats(sendResponse);
        break;
      case 'clearStats':
        await handleClearStats(sendResponse);
        break;
      default:
        sendResponse({ success: false, error: '未知操作: ' + message.action });
    }
  } catch (error) {
    console.error('[Background Firefox] 处理消息失败:', error);
    sendResponse({ success: false, error: (error as Error).message });
  }
}

async function getDebugMode(): Promise<boolean> {
  try {
    const result = await browser.storage.local.get('settings');
    return result?.settings?.debugMode || false;
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
      console.log('[Background Firefox] 开始识别, 图像大小:', message.imageData?.length);
    }
    setOcrStatus('initializing', '正在初始化OCR引擎...');
    const engine = await getOCREngine();

    if (debugMode) {
      console.log('[Background Firefox] OCR引擎就绪, 开始识别...');
    }

    const recognizeStart = Date.now();
    const result = await engine.recognize(message.imageData);
    const elapsed = Date.now() - recognizeStart;

    setOcrStatus('ready', '识别完成');
    if (debugMode) {
      console.log('[Background Firefox] 识别成功:', result.text, '耗时:', elapsed, 'ms');
    }

    sendResponse({ success: true, text: result.text, elapsed, totalElapsed: Date.now() - startTime });
  } catch (error) {
    const elapsed = Date.now() - startTime;
    setOcrStatus('fault', (error as Error).message);
    console.error('[Background Firefox] 识别异常:', error);
    sendResponse({ success: false, error: (error as Error).message, elapsed });
  }
}

async function handleGetSettings(sendResponse: (response: any) => void): Promise<void> {
  try {
    const result = await browser.storage.local.get('settings');
    sendResponse({ success: true, settings: result?.settings || getDefaultSettings() });
  } catch {
    sendResponse({ success: true, settings: getDefaultSettings() });
  }
}

async function handleSaveSettings(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  await browser.storage.local.set({ settings: message.settings });
  try {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url?.startsWith('http')) {
        try {
          await browser.tabs.sendMessage(tab.id, { action: 'updateSettings' });
        } catch { }
      }
    }
  } catch { }
  sendResponse({ success: true });
}

async function handleGetSiteRules(sendResponse: (response: any) => void): Promise<void> {
  try {
    const result = await browser.storage.local.get('siteRules');
    sendResponse({ success: true, rules: result?.siteRules || {} });
  } catch {
    sendResponse({ success: true, rules: {} });
  }
}

async function handleSaveSiteRule(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  const { hostname, rule } = message;
  let rules: Record<string, any> = {};
  try {
    const result = await browser.storage.local.get('siteRules');
    rules = result?.siteRules || {};
  } catch { }

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

  await browser.storage.local.set({ siteRules: rules });
  console.log('[Background Firefox] 规则已保存:', ruleKey, rules[ruleKey]);
  sendResponse({ success: true });
}

async function handleUpdateSiteRule(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  const { oldKey, newRule } = message;
  let rules: Record<string, any> = {};
  try {
    const result = await browser.storage.local.get('siteRules');
    rules = result?.siteRules || {};
  } catch { }

  if (oldKey && rules[oldKey]) {
    delete rules[oldKey];
  }

  const newKey = newRule.fullUrl || newRule.urlPattern || newRule.hostname;
  rules[newKey] = {
    ...newRule,
    updatedAt: Date.now(),
  };

  await browser.storage.local.set({ siteRules: rules });
  sendResponse({ success: true });
}

async function handleDeleteSiteRule(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  const { hostname, ruleKey } = message;
  let rules: Record<string, any> = {};
  try {
    const result = await browser.storage.local.get('siteRules');
    rules = result?.siteRules || {};
  } catch { }

  const keyToDelete = ruleKey || hostname;
  if (rules[keyToDelete]) {
    delete rules[keyToDelete];
    console.log('[Background Firefox] 规则已删除:', keyToDelete);
  }

  await browser.storage.local.set({ siteRules: rules });
  sendResponse({ success: true });
}

async function handleExportConfig(sendResponse: (response: any) => void): Promise<void> {
  try {
    const result = await browser.storage.local.get(['settings', 'siteRules']);
    sendResponse({ success: true, config: result || {} });
  } catch {
    sendResponse({ success: true, config: {} });
  }
}

async function handleImportConfig(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  const { config } = message;
  await browser.storage.local.set(config);
  sendResponse({ success: true });
}

interface SiteStats {
  count: number;
  lastTime: number;
  totalTime: number;
}

interface StatsData {
  sites: Record<string, SiteStats>;
  total: number;
  updated: number;
}

const MAX_STATS_SITES = 100;

async function getStatsData(): Promise<StatsData> {
  try {
    const result = await browser.storage.local.get('recognitionStats');
    return result?.recognitionStats || { sites: {}, total: 0, updated: Date.now() };
  } catch {
    return { sites: {}, total: 0, updated: Date.now() };
  }
}

async function saveStatsData(data: StatsData): Promise<void> {
  data.updated = Date.now();
  await browser.storage.local.set({ recognitionStats: data });
}

async function handleRecordStats(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  const { hostname, elapsed } = message;
  const stats = await getStatsData();

  if (!stats.sites[hostname]) {
    if (Object.keys(stats.sites).length >= MAX_STATS_SITES) {
      const entries = Object.entries(stats.sites);
      entries.sort((a, b) => a[1].lastTime - b[1].lastTime);
      const toRemove = entries.slice(0, 10);
      for (const [key] of toRemove) {
        delete stats.sites[key];
      }
    }
    stats.sites[hostname] = { count: 0, lastTime: 0, totalTime: 0 };
  }

  stats.sites[hostname].count++;
  stats.sites[hostname].lastTime = Date.now();
  stats.sites[hostname].totalTime += elapsed || 0;
  stats.total++;

  await saveStatsData(stats);
  sendResponse({ success: true });
}

async function handleGetStats(sendResponse: (response: any) => void): Promise<void> {
  const stats = await getStatsData();
  sendResponse({ success: true, stats });
}

async function handleClearStats(sendResponse: (response: any) => void): Promise<void> {
  await saveStatsData({ sites: {}, total: 0, updated: Date.now() });
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
    useUploadedWasm: false,
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

console.log('[Background Firefox] 初始化完成');