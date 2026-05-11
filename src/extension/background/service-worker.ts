import type { ExtensionSettings, SiteRule } from '@core/types';
import { autoUpdateSubscriptions } from '../subscription-manager';

const OFFSCREEN_URL = 'offscreen.html';
const SUBSCRIPTION_ALARM_NAME = 'ddddocr-subscription-update';
const CONTEXT_MENU_ID = 'ddddocr-recognize-image';

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
    await waitForOffscreenReady();
    return;
  }

  const getContexts = (chrome.runtime as any).getContexts;
  if (typeof getContexts === 'function') {
    try {
      const existing = await getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      });
      if (Array.isArray(existing) && existing.length > 0) {
        await waitForOffscreenReady();
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

  await waitForOffscreenReady();
}

/**
 * Poll the offscreen document with a ping until it responds. createDocument()
 * resolves once the page exists, but the page's scripts may not yet have
 * registered their message listener — sending immediately would hit
 * "Receiving end does not exist". This bridges that gap.
 */
async function waitForOffscreenReady(timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'offscreen:ping' });
      if (resp && resp.ready) return;
    } catch {
      // listener not registered yet; back off and retry
    }
    attempt++;
    const delay = Math.min(50 * attempt, 250);
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error('Offscreen document 未在超时时间内就绪');
}

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Service Worker] 扩展安装/更新:', details.reason);
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
  // 注册订阅自动更新闹钟（每 30 分钟检查一次到期订阅）
  try {
    await chrome.alarms.create(SUBSCRIPTION_ALARM_NAME, {
      periodInMinutes: 30,
      delayInMinutes: 1,
    });
  } catch (e) {
    console.warn('[Service Worker] 注册订阅闹钟失败:', e);
  }
  // Sync the right-click menu state with current settings.
  await syncImageContextMenu();
});

chrome.runtime.onStartup.addListener(async () => {
  // service worker 启动时也确保闹钟存在
  try {
    const existing = await chrome.alarms.get(SUBSCRIPTION_ALARM_NAME);
    if (!existing) {
      await chrome.alarms.create(SUBSCRIPTION_ALARM_NAME, {
        periodInMinutes: 30,
        delayInMinutes: 1,
      });
    }
  } catch (e) {
    console.warn('[Service Worker] 检查订阅闹钟失败:', e);
  }
  await syncImageContextMenu();
});

/**
 * Add or remove the "Recognize image with Mieru-OCR" context menu based on
 * the user's current setting. Image-only via contexts: ['image']. Idempotent.
 */
async function syncImageContextMenu(): Promise<void> {
  const ctxApi = (chrome as any).contextMenus;
  if (!ctxApi) {
    console.warn('[Service Worker] chrome.contextMenus 不可用，请检查 manifest 权限');
    return;
  }
  let enabled = false;
  try {
    const r = await chrome.storage.local.get('settings');
    enabled = !!r.settings?.imageContextMenuEnabled;
  } catch (e) {
    console.warn('[Service Worker] 读取右键菜单设置失败:', e);
  }

  await new Promise<void>((resolve) => {
    try {
      ctxApi.removeAll(() => {
        if (chrome.runtime.lastError) {
          console.warn('[Service Worker] removeAll lastError:', chrome.runtime.lastError.message);
        }
        resolve();
      });
    } catch (e) {
      console.warn('[Service Worker] removeAll 异常:', e);
      resolve();
    }
  });

  console.log(`[Service Worker] 右键菜单同步: enabled=${enabled}`);
  if (!enabled) return;

  ctxApi.create(
    {
      id: CONTEXT_MENU_ID,
      title: '用 Mieru-OCR 识别此图片',
      contexts: ['image'],
    },
    () => {
      // chrome.contextMenus.create errors via lastError, NOT throw — must check
      // this callback or failures are silent.
      if (chrome.runtime.lastError) {
        console.warn('[Service Worker] 创建右键菜单失败:', chrome.runtime.lastError.message);
      } else {
        console.log('[Service Worker] 右键菜单已注册:', CONTEXT_MENU_ID);
      }
    },
  );
}

// Top-level listener registration — required for MV3 to wake the SW on click.
// Wrapping in `if` is fine; Chrome inspects whether addListener is called
// during initial script execution, not the surrounding control flow.
if ((chrome as any).contextMenus?.onClicked) {
  (chrome as any).contextMenus.onClicked.addListener(async (info: any, tab: any) => {
    console.log('[Service Worker] 右键菜单点击:', info.menuItemId, 'srcUrl=', info.srcUrl);
    if (info.menuItemId !== CONTEXT_MENU_ID) return;
    if (!info.srcUrl || !tab?.id) {
      console.warn('[Service Worker] 右键点击缺少 srcUrl 或 tab.id');
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'recognizeImageBySrc',
        srcUrl: info.srcUrl,
      });
    } catch (e) {
      console.warn('[Service Worker] 发送右键识别消息失败:', e);
    }
  });
}

// 监听 storage 变化自动同步菜单 —— storage.onChanged 在 storage.set 完成后才触发，
// 不会像顶层 fire-and-forget 那样读到旧数据，从而避免与 saveSettings 处理器的竞态。
// onInstalled / onStartup 处理首次注册和浏览器启动；Chrome 本身会持久化 contextMenus
// 跨 SW 休眠，所以不需要在每次 SW 唤醒时无条件同步。
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!changes.settings) return;
  const oldVal = changes.settings.oldValue?.imageContextMenuEnabled;
  const newVal = changes.settings.newValue?.imageContextMenuEnabled;
  if (oldVal === newVal) return;
  console.log('[Service Worker] 检测到右键菜单设置变化:', oldVal, '->', newVal);
  syncImageContextMenu().catch((e) => console.warn('[Service Worker] storage.onChanged 同步失败:', e));
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SUBSCRIPTION_ALARM_NAME) return;
  try {
    const result = await autoUpdateSubscriptions();
    if (result.updated > 0 || result.failed > 0) {
      console.log(`[Service Worker] 订阅自动更新: 成功 ${result.updated}, 失败 ${result.failed}`);
    }
  } catch (e) {
    console.warn('[Service Worker] 订阅自动更新出错:', e);
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
      case 'recordStats':
        await handleRecordStats(message, sendResponse);
        break;
      case 'getStats':
        await handleGetStats(sendResponse);
        break;
      case 'clearStats':
        await handleClearStats(sendResponse);
        break;
      case 'smokeTestModel':
        await handleSmokeTestModel(message, sendResponse);
        break;
      case 'invalidateModel':
        await handleInvalidateModel(message, sendResponse);
        break;
      case 'getActiveModelId':
        await handleGetActiveModelId(sendResponse);
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
    const totalElapsed = Date.now() - startTime;

    if (resp?.success) {
      setOcrStatus('ready', '识别完成');
      const elapsed = typeof resp.elapsed === 'number' ? resp.elapsed : totalElapsed;
      if (debugMode) {
        console.log('[Service Worker] 识别成功:', resp.text, '耗时:', elapsed, 'ms');
      }
      sendResponse({ success: true, text: resp.text, elapsed });
    } else {
      setOcrStatus('fault', resp?.error || '识别失败');
      console.error('[Service Worker] 识别失败:', resp?.error);
      sendResponse({ success: false, error: resp?.error || '识别失败', elapsed: totalElapsed });
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

  // 注意：菜单同步交给 chrome.storage.onChanged 监听器统一处理，避免双调用产生竞态。

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id && tab.url?.startsWith('http')) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'updateSettings' });
      } catch { }
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
  const result = await chrome.storage.local.get('recognitionStats');
  return result.recognitionStats || { sites: {}, total: 0, updated: Date.now() };
}

async function saveStatsData(data: StatsData): Promise<void> {
  data.updated = Date.now();
  await chrome.storage.local.set({ recognitionStats: data });
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

async function handleSmokeTestModel(message: any, sendResponse: (response: any) => void): Promise<void> {
  try {
    await ensureOffscreenDocument();
    const resp = await chrome.runtime.sendMessage({
      action: 'offscreen:smoke-test',
      modelId: message.modelId,
    });
    sendResponse(resp || { success: false, error: 'no response' });
  } catch (e) {
    sendResponse({ success: false, error: (e as Error).message });
  }
}

async function handleInvalidateModel(message: any, sendResponse: (response: any) => void): Promise<void> {
  try {
    // Try to notify offscreen if it exists; if not, just succeed
    const offscreenApi = (chrome as any).offscreen;
    const getContexts = (chrome.runtime as any).getContexts;
    if (offscreenApi && typeof getContexts === 'function') {
      const existing = await getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (Array.isArray(existing) && existing.length > 0) {
        await chrome.runtime.sendMessage({
          action: 'offscreen:invalidate-model',
          modelId: message.modelId,
        });
      }
    }
    sendResponse({ success: true });
  } catch (e) {
    sendResponse({ success: false, error: (e as Error).message });
  }
}

/**
 * Resolve the user's selected model id. Called by the offscreen document,
 * which has chrome.runtime but no chrome.storage access.
 */
async function handleGetActiveModelId(sendResponse: (response: any) => void): Promise<void> {
  try {
    const result = await chrome.storage.local.get('activeModelId');
    sendResponse({ success: true, modelId: result.activeModelId || '__builtin__' });
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
    enableSliderPuzzleAssist: true,
    enableSingleSliderAssist: true,
    enableClickSelectAssist: false,
    siteBlacklist: [],
    imageContextMenuEnabled: false,
    imageContextMenuAutoFill: true,
    preserveFocus: false,
  };
}

console.log('[Service Worker] 初始化完成');