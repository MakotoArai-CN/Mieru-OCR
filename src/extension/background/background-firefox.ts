declare const browser: any;
import { OCREngine } from '@core/ocr-engine';
import type { ExtensionSettings } from '@core/types';
import { autoUpdateSubscriptions } from '../subscription-manager';
import { BUILTIN_MODEL_ID, getActiveModelId, getModelData } from '../model-store';

const SUBSCRIPTION_ALARM_NAME = 'ddddocr-subscription-update';

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

interface EngineEntry {
  id: string;
  engine: OCREngine;
  lastUsed: number;
}
const MAX_CACHED_ENGINES = 2;
const engineCache: Map<string, EngineEntry> = new Map();
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

async function fetchBuiltinModel(): Promise<{ model: ArrayBuffer; charsets: string[] }> {
  const [modelRes, charsetsRes] = await Promise.all([
    fetch(browser.runtime.getURL('common.onnx')),
    fetch(browser.runtime.getURL('charsets.json')),
  ]);
  return {
    model: await modelRes.arrayBuffer(),
    charsets: await charsetsRes.json(),
  };
}

async function buildEngine(modelId: string): Promise<OCREngine> {
  const ort = await loadOrt();
  const engine = new OCREngine({
    getModel: async () => {
      if (modelId === BUILTIN_MODEL_ID) {
        return fetchBuiltinModel();
      }
      const data = await getModelData(modelId);
      if (!data) {
        console.warn(`[Background Firefox] Model ${modelId} not found, falling back to builtin`);
        return fetchBuiltinModel();
      }
      return { model: data.modelBlob, charsets: data.charsets };
    },
    getOrt: async () => ort,
    wasmPaths: browser.runtime.getURL('/'),
  });
  await engine.init();
  return engine;
}

async function getOCREngine(): Promise<OCREngine> {
  let modelId: string;
  try {
    modelId = await getActiveModelId();
  } catch {
    modelId = BUILTIN_MODEL_ID;
  }

  const cached = engineCache.get(modelId);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.engine;
  }

  try {
    const engine = await buildEngine(modelId);
    engineCache.set(modelId, { id: modelId, engine, lastUsed: Date.now() });
    if (engineCache.size > MAX_CACHED_ENGINES) {
      let oldestId: string | null = null;
      let oldestTime = Infinity;
      for (const [id, entry] of engineCache) {
        if (entry.lastUsed < oldestTime) {
          oldestTime = entry.lastUsed;
          oldestId = id;
        }
      }
      if (oldestId) engineCache.delete(oldestId);
    }
    return engine;
  } catch (e) {
    if (modelId !== BUILTIN_MODEL_ID) {
      console.warn(`[Background Firefox] Active model ${modelId} failed: ${(e as Error).message}, falling back to builtin`);
      const fallback = await buildEngine(BUILTIN_MODEL_ID);
      engineCache.set(BUILTIN_MODEL_ID, { id: BUILTIN_MODEL_ID, engine: fallback, lastUsed: Date.now() });
      return fallback;
    }
    throw e;
  }
}

browser.runtime.onInstalled.addListener((details: any) => {
  console.log('[Background Firefox] 扩展安装/更新:', details.reason);
  if (details.reason === 'install') {
    browser.runtime.openOptionsPage();
  }
  // 注册订阅自动更新闹钟
  if (browser.alarms) {
    browser.alarms.create(SUBSCRIPTION_ALARM_NAME, {
      periodInMinutes: 30,
      delayInMinutes: 1,
    });
  }
  syncImageContextMenu();
});

const CONTEXT_MENU_ID_FF = 'ddddocr-recognize-image';

async function syncImageContextMenu(): Promise<void> {
  const ctxApi = (browser as any).contextMenus || (browser as any).menus;
  if (!ctxApi) return;
  let enabled = false;
  try {
    const r = await browser.storage.local.get('settings');
    enabled = !!r.settings?.imageContextMenuEnabled;
  } catch { /* default off */ }

  try {
    await new Promise<void>((resolve) => {
      try { ctxApi.removeAll(() => resolve()); } catch { resolve(); }
    });
  } catch { /* non-fatal */ }
  if (!enabled) return;

  try {
    ctxApi.create({
      id: CONTEXT_MENU_ID_FF,
      title: '用 Mieru-OCR 识别此图片',
      contexts: ['image'],
    });
  } catch (e) {
    console.warn('[Background Firefox] 创建右键菜单失败:', e);
  }
}

const ctxApiFF = (browser as any).contextMenus || (browser as any).menus;
if (ctxApiFF?.onClicked) {
  ctxApiFF.onClicked.addListener(async (info: any, tab: any) => {
    if (info.menuItemId !== CONTEXT_MENU_ID_FF) return;
    if (!info.srcUrl || !tab?.id) return;
    try {
      await browser.tabs.sendMessage(tab.id, {
        action: 'recognizeImageBySrc',
        srcUrl: info.srcUrl,
      });
    } catch (e) {
      console.warn('[Background Firefox] 发送右键识别消息失败:', e);
    }
  });
}

// 后台脚本启动时同步一次菜单（MV2 的持久化背景页通常常驻，重载扩展时会重启脚本）
syncImageContextMenu().catch((e) => console.warn('[Background Firefox] 启动时同步右键菜单失败:', e));

// 监听 settings 变化自动同步菜单 —— 与 saveSettings 处理器去重，避免双调用
if (browser.storage?.onChanged) {
  browser.storage.onChanged.addListener((changes: any, areaName: string) => {
    if (areaName !== 'local' || !changes.settings) return;
    const oldVal = changes.settings.oldValue?.imageContextMenuEnabled;
    const newVal = changes.settings.newValue?.imageContextMenuEnabled;
    if (oldVal === newVal) return;
    syncImageContextMenu().catch((e) => console.warn('[Background Firefox] storage.onChanged 同步失败:', e));
  });
}

if (browser.alarms) {
  browser.alarms.onAlarm.addListener(async (alarm: any) => {
    if (alarm.name !== SUBSCRIPTION_ALARM_NAME) return;
    try {
      const result = await autoUpdateSubscriptions();
      if (result.updated > 0 || result.failed > 0) {
        console.log(`[Background Firefox] 订阅自动更新: 成功 ${result.updated}, 失败 ${result.failed}`);
      }
    } catch (e) {
      console.warn('[Background Firefox] 订阅自动更新出错:', e);
    }
  });
}

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
  // 菜单同步交给 storage.onChanged 监听器统一处理
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
    language: 'auto',
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
    customIncludeKeywords: [],
    customExcludePatterns: [],
    customAgreementKeywords: [],
    customInputExcludeKeywords: [],
    disabledCaptchaKeywords: [],
    disabledExcludePatterns: [],
    disabledAgreementKeywords: [],
    disabledInputExcludeKeywords: [],
    enableInteractiveCaptchaAssist: false,
    enableInteractiveCaptchaDebugOverlay: false,
    enableSliderPuzzleAssist: true,
    enableSingleSliderAssist: true,
    enableClickSelectAssist: false,
    siteBlacklist: [],
    imageContextMenuEnabled: false,
    imageContextMenuAutoFill: true,
    preserveFocus: false,
  };
}

console.log('[Background Firefox] 初始化完成');