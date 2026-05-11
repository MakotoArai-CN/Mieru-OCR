import { OCREngine } from '@core/ocr-engine';
import { BUILTIN_MODEL_ID, BUNDLED_MODELS, getBundledModel, getModelData, isBundledModelId } from '../model-store';

/**
 * Offscreen document with multi-model support.
 *
 * - Caches up to 2 OCREngine instances (LRU-ish: keeps last used + builtin)
 * - On recognize, reads activeModelId from chrome.storage.local
 * - Falls back to builtin model if upload is missing/corrupt
 */

interface EngineEntry {
  id: string;
  engine: OCREngine;
  lastUsed: number;
}

const MAX_CACHED_ENGINES = 2;
const engineCache: Map<string, EngineEntry> = new Map();

function configureOrt(ort: any): void {
  const cfg = (globalThis as any).ortConfig || {};
  const base: string = cfg.base || chrome.runtime.getURL('/');

  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = base;

  ort.env.logLevel = 'error';
}

function getOrtGlobal(): any {
  return (globalThis as any).ort;
}

async function fetchBundledModel(id: string): Promise<{ model: ArrayBuffer; charsets: string[] }> {
  const def = getBundledModel(id) || BUNDLED_MODELS[0];
  const [modelRes, charsetsRes] = await Promise.all([
    fetch(chrome.runtime.getURL(def.modelFile)),
    fetch(chrome.runtime.getURL(def.charsetsFile)),
  ]);
  if (!modelRes.ok) throw new Error(`内置模型 ${def.modelFile} 加载失败 (HTTP ${modelRes.status})`);
  if (!charsetsRes.ok) throw new Error(`字符表 ${def.charsetsFile} 加载失败 (HTTP ${charsetsRes.status})`);
  return {
    model: await modelRes.arrayBuffer(),
    charsets: await charsetsRes.json(),
  };
}

async function buildEngine(modelId: string): Promise<OCREngine> {
  const ort = getOrtGlobal();
  if (!ort) throw new Error('ort.min.js 未加载或全局 ort 不存在');
  configureOrt(ort);

  // Pull preprocessing config from BUNDLED_MODELS for bundled ids; user uploads
  // get the safe default (simple /255, dynamic width).
  const bundledDef = isBundledModelId(modelId) ? getBundledModel(modelId) : undefined;

  const engine = new OCREngine({
    getModel: async () => {
      if (isBundledModelId(modelId)) {
        return fetchBundledModel(modelId);
      }
      const data = await getModelData(modelId);
      if (!data) {
        console.warn(`[offscreen] Model ${modelId} not found, falling back to builtin`);
        return fetchBundledModel(BUILTIN_MODEL_ID);
      }
      return { model: data.modelBlob, charsets: data.charsets };
    },
    getOrt: async () => ort,
    wasmPaths: chrome.runtime.getURL('/'),
    fixedWidth: bundledDef?.fixedWidth,
    preprocess: bundledDef?.preprocess,
    preprocessMean: bundledDef?.preprocessMean,
    preprocessStd: bundledDef?.preprocessStd,
  });

  await engine.init();
  return engine;
}

async function getEngine(modelId: string): Promise<OCREngine> {
  const cached = engineCache.get(modelId);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.engine;
  }

  const engine = await buildEngine(modelId);
  engineCache.set(modelId, { id: modelId, engine, lastUsed: Date.now() });

  // Evict least recently used if over capacity
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
}

/**
 * Ask the service worker for the active model id.
 * Offscreen documents in Chrome only get chrome.runtime — no chrome.storage —
 * so we can't read it directly here.
 */
async function fetchActiveModelIdFromSW(): Promise<string> {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'getActiveModelId' });
    if (resp?.success && typeof resp.modelId === 'string' && resp.modelId) {
      return resp.modelId;
    }
  } catch (e) {
    console.warn('[offscreen] 向 service worker 请求 activeModelId 失败:', (e as Error).message);
  }
  return BUILTIN_MODEL_ID;
}

async function getActiveEngine(): Promise<{ engine: OCREngine; modelId: string }> {
  const modelId = await fetchActiveModelIdFromSW();
  try {
    const engine = await getEngine(modelId);
    return { engine, modelId };
  } catch (e) {
    if (modelId !== BUILTIN_MODEL_ID) {
      console.warn(`[offscreen] Active model ${modelId} failed to load: ${(e as Error).message}. Falling back to builtin.`);
      const engine = await getEngine(BUILTIN_MODEL_ID);
      return { engine, modelId: BUILTIN_MODEL_ID };
    }
    throw e;
  }
}

/** Listen for storage changes to invalidate cached engines */
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes: any, areaName: string) => {
    if (areaName !== 'local') return;
    if (changes.activeModelId) {
      // Active model changed; we don't evict — just lazy-load on next recognize.
      // The new model will be built on demand, old stays in cache.
    }
  });
}

chrome.runtime.onMessage.addListener((message: any, sender: any, sendResponse: any) => {
  if (message?.action === 'offscreen:ping') {
    sendResponse({ ready: true });
    return false;
  }
  if (message?.action === 'offscreen:recognize') {
    handleRecognize(message, sendResponse);
    return true;
  }
  if (message?.action === 'offscreen:invalidate-model') {
    // Called when a model is deleted — remove from cache
    const id = message.modelId;
    if (id) engineCache.delete(id);
    sendResponse({ success: true });
    return false;
  }
  if (message?.action === 'offscreen:smoke-test') {
    handleSmokeTest(message, sendResponse);
    return true;
  }
  return false;
});

async function handleRecognize(message: any, sendResponse: (response: any) => void) {
  try {
    const { engine, modelId } = await getActiveEngine();
    if (message.imageData) {
      const startTime = Date.now();
      const result = await engine.recognize(message.imageData);
      const elapsed = Date.now() - startTime;
      sendResponse({ success: true, text: result.text, elapsed, modelId });
      return;
    }
    sendResponse({ success: false, error: '缺少图像数据' });
  } catch (error) {
    sendResponse({ success: false, error: (error as Error).message });
  }
}

/**
 * Smoke test: try to construct a session from an arbitrary modelId without
 * caching it. Used by the upload UI to confirm the model can run before
 * the user keeps it.
 */
async function handleSmokeTest(message: any, sendResponse: (response: any) => void) {
  try {
    const id = message.modelId;
    if (!id) {
      sendResponse({ success: false, error: 'missing modelId' });
      return;
    }
    const engine = await buildEngine(id);
    // If init() didn't throw, the session is good. Drop the temp engine.
    void engine;
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: (error as Error).message });
  }
}

console.log('Offscreen OCR 初始化完成（多模型支持）');
