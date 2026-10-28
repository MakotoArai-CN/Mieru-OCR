declare const browser: any;
import { createModelEngines } from '../model-engines';
import { matchSliderImages } from '../slider-worker-client';
import { labelBoxesWithEngines, decodeDataURLToImage } from '@core/interaction/click-select-solver';
import type { ExtensionSettings } from '@core/types';
import { autoUpdateSubscriptions } from '../subscription-manager';
import { getActiveModelId } from '../model-store';
import { ensureDetModel } from '../det-model';
import { recordAttempt, backoffCooldownMs, type RuleStat, type RuleStatsMap } from '@core/rule-stats';

const SUBSCRIPTION_ALARM_NAME = 'Mieru-subscription-update';

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

const engines = createModelEngines({
  getOrt: loadOrt,
  getURL: path => browser.runtime.getURL(path),
  getActiveModelId,
  ensureDetectionModel: async () => {
    const result = await ensureDetModel();
    if (!result.ready) throw new Error(result.reason || 'DET_NOT_PROVISIONED');
  },
});

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

const CONTEXT_MENU_ID_FF = 'Mieru-recognize-image';

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
      // 见 service-worker.ts 同样修复：info.frameId 指向 iframe 时需要显式 frameId 发送
      const sendOptions: any = {};
      if (typeof info.frameId === 'number') {
        sendOptions.frameId = info.frameId;
      }
      await browser.tabs.sendMessage(tab.id, {
        action: 'recognizeImageBySrc',
        srcUrl: info.srcUrl,
      }, sendOptions);
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
      case 'matchSlider':
        sendResponse({ success: true, result: await matchSliderImages(message.targetData, message.backgroundData) });
        break;
      case 'fetchImageData':
        // 跨域图片无 CORS 头时 content 侧 canvas 被污染，这里用扩展权限代抓。
        sendResponse(await fetchImageAsDataURL(message.url));
        break;
      case 'recognizeCaptcha':
        await handleRecognize(message, sendResponse);
        break;
      case 'detectText':
        await handleDetectText(message, sendResponse);
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
      case 'ensureDetModel':
        await handleEnsureDetModel(sendResponse);
        break;
      case 'detModelChanged':
        await engines.invalidateDetection();
        sendResponse({ success: true });
        break;
      case 'invalidateModel':
        await engines.invalidateOCR(message.modelId);
        sendResponse({ success: true });
        break;
      case 'getRuleStat':
        await handleGetRuleStat(message, sendResponse);
        break;
      case 'recordRuleAttempt':
        await handleRecordRuleAttempt(message, sendResponse);
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

/** ArrayBuffer → dataURL（背景页没有可直接复用的编码器，手工 base64）。 */
function arrayBufferToDataURL(buffer: ArrayBuffer, mime: string): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x2000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime || 'image/png'};base64,${btoa(binary)}`;
}

/** 用扩展权限抓取页面读不到的图片（跨域且无 CORS 头），以 dataURL 回传给 content。 */
async function fetchImageAsDataURL(rawUrl: unknown): Promise<{ success: boolean; dataUrl?: string; error?: string }> {
  try {
    const url = String(rawUrl || '');
    if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http(s) 图片地址');
    const resp = await fetch(url, { credentials: 'include', cache: 'force-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const contentType = (resp.headers.get('content-type') || '').split(';')[0].trim();
    if (!contentType.startsWith('image/')) throw new Error('目标不是图片');
    const buffer = await resp.arrayBuffer();
    if (buffer.byteLength === 0) throw new Error('图片内容为空');
    return { success: true, dataUrl: arrayBufferToDataURL(buffer, contentType) };
  } catch (error) {
    return { success: false, error: (error as Error)?.message || String(error) };
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
    const { result, elapsed, modelId, fallbackFrom } = await engines.useOCR(async (engine, id, ctx) => {
      const recognizeStart = Date.now();
      const result = await engine.recognize(message.imageData);
      return {
        result,
        elapsed: Date.now() - recognizeStart,
        modelId: id,
        fallbackFrom: ctx.fallbackFrom,
      };
    });

    setOcrStatus('ready', '识别完成');
    if (debugMode) {
      console.log('[Background Firefox] 识别成功:', result.text, '耗时:', elapsed, 'ms');
    }

    sendResponse({
      success: true,
      text: result.text,
      elapsed,
      totalElapsed: Date.now() - startTime,
      modelId,
      fallbackFrom,
    });
  } catch (error) {
    const elapsed = Date.now() - startTime;
    setOcrStatus('fault', (error as Error).message);
    console.error('[Background Firefox] 识别异常:', error);
    sendResponse({ success: false, error: (error as Error).message, elapsed });
  }
}

/**
 * Click-select text detection (MV2, in-page). Decodes the captcha image dataURL,
 * runs detection + per-box OCR labeling, returns boxes in the image's pixel
 * coordinate system. Mirrors the Chrome offscreen handler, but runs here since
 * Firefox MV2 has no offscreen document.
 */
async function handleDetectText(
  message: any,
  sendResponse: (response: any) => void
): Promise<void> {
  try {
    if (!message.imageData) {
      sendResponse({ success: false, error: '缺少图像数据' });
      return;
    }
    const startTime = Date.now();
    const image = await decodeDataURLToImage(message.imageData);
    const boxes = await engines.useDetection(det =>
      engines.useOCR(ocr => labelBoxesWithEngines(image, det, ocr)));
    sendResponse({ success: true, boxes, elapsed: Date.now() - startTime });
  } catch (error) {
    console.error('[Background Firefox] 文字检测异常:', error);
    sendResponse({ success: false, error: (error as Error).message });
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

/**
 * content 在点选求解前调用：按优先级 provisioning 检测模型（本地/订阅/镜像）。
 * Firefox 无 offscreen，模型与引擎都在本页；changed 时丢弃缓存引擎以加载新模型。
 */
async function handleEnsureDetModel(sendResponse: (response: any) => void): Promise<void> {
  try {
    const res = await ensureDetModel();
    if (res.changed) await engines.invalidateDetection();
    sendResponse({ success: res.ready, ...res });
  } catch (e) {
    sendResponse({ success: false, ready: false, reason: (e as Error).message });
  }
}

async function handleGetRuleStat(message: any, sendResponse: (response: any) => void): Promise<void> {
  try {
    const result = await browser.storage.local.get('ruleStats');
    const map: RuleStatsMap = result?.ruleStats || {};
    sendResponse({ success: true, stat: map[message.ruleKey] || null });
  } catch (e) {
    sendResponse({ success: false, error: (e as Error).message });
  }
}

/** 记录一次规则求解结果，返回更新后的 stat 与建议冷却（含指数退避）。 */
async function handleRecordRuleAttempt(message: any, sendResponse: (response: any) => void): Promise<void> {
  try {
    const { ruleKey, success } = message as { ruleKey: string; success: boolean };
    const result = await browser.storage.local.get('ruleStats');
    const map: RuleStatsMap = result?.ruleStats || {};
    const updated: RuleStat = recordAttempt(map[ruleKey], !!success, Date.now());
    map[ruleKey] = updated;
    await browser.storage.local.set({ ruleStats: map });
    sendResponse({ success: true, stat: updated, cooldownMs: backoffCooldownMs(!!success, updated) });
  } catch (e) {
    sendResponse({ success: false, error: (e as Error).message });
  }
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
    enableSliderPuzzleAssist: false,
    enableSingleSliderAssist: false,
    enableClickSelectAssist: false,
    siteBlacklist: [],
    imageContextMenuEnabled: false,
    imageContextMenuAutoFill: true,
    preserveFocus: false,
    deepScan: false,
    detModelPreference: 'auto',
  };
}

console.log('[Background Firefox] 初始化完成');
