/**
 * Extension custom model storage
 *
 * Uses IndexedDB for binary data (~50MB+ per model), and chrome.storage.local
 * for lightweight metadata (id, name, size, charsets-length etc.) so the
 * options page can list models without loading binaries.
 *
 * Key design:
 * - Multiple uploaded models keyed by id
 * - User selects activeModelId; offscreen reads that on next inference
 * - Validation: ONNX magic bytes + charsets is JSON array of strings + size limit
 */

declare const chrome: any;
declare const browser: any;

let cachedStorage: any = null;

function getStorage(): any {
  if (cachedStorage) return cachedStorage;
  // chrome first — this module is bundled into both Chrome MV3 (offscreen/background/options) and
  // Firefox MV2 builds. In Chrome contexts `browser` is occasionally polyfilled by other extensions
  // as a Proxy that throws on property access, so wrap each probe in try/catch.
  try {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      cachedStorage = chrome.storage.local;
      return cachedStorage;
    }
  } catch { /* fall through */ }
  try {
    if (typeof browser !== 'undefined' && browser?.storage?.local) {
      cachedStorage = browser.storage.local;
      return cachedStorage;
    }
  } catch { /* fall through */ }
  const diag = {
    hasChrome: typeof chrome !== 'undefined',
    hasBrowser: typeof browser !== 'undefined',
    chromeStorage: typeof chrome !== 'undefined' && !!(chrome as any)?.storage,
  };
  throw new Error('No browser storage available; diag=' + JSON.stringify(diag));
}

const storage = {
  get(key: string | string[]): Promise<any> {
    return getStorage().get(key);
  },
  set(items: Record<string, any>): Promise<void> {
    return getStorage().set(items);
  },
};

const DB_NAME = 'DdddOCRExtensionModels';
const DB_VERSION = 1;
const STORE_NAME = 'models';
const META_KEY = 'customModels';
const ACTIVE_KEY = 'activeModelId';

/** Built-in default model id (always available, baked into the extension) */
export const BUILTIN_MODEL_ID = '__builtin__';

/**
 * Extra models bundled with the extension. Loaded via chrome.runtime.getURL,
 * so they don't need IndexedDB or chrome.storage. Add a new entry here when
 * shipping additional models in public/.
 *
 * The first entry (BUILTIN_MODEL_ID) is the default common model.
 */
export interface BundledModelDef {
  id: string;
  name: string;
  description: string;
  modelFile: string;     // path under extension root, served by chrome.runtime.getURL
  charsetsFile: string;
  approxSize: number;    // bytes — purely for display, not enforced
  approxCharsets: number;
  /**
   * Recognition options applied when this bundled model is loaded.
   * Match the training pipeline of the model (see export scripts in onnx-quant-cuda):
   * - common-architecture models: dynamic width, simple /255 (omit all)
   * - custom-trained CRNN (train_v3+): fixedWidth=192, standardize(0.456, 0.224)
   */
  fixedWidth?: number;
  preprocess?: 'simple' | 'standardize';
  preprocessMean?: number;
  preprocessStd?: number;
}

export const BUNDLED_MODELS: BundledModelDef[] = [
  {
    id: BUILTIN_MODEL_ID,
    name: 'common (默认)',
    description: 'DDDDOCR 通用模型（已量化版本，约 28 MB），覆盖大多数英数字符与汉字验证码',
    modelFile: 'common.onnx',
    charsetsFile: 'charsets.json',
    approxSize: 0,
    approxCharsets: 0,
  }
];

export function getBundledModel(id: string): BundledModelDef | undefined {
  return BUNDLED_MODELS.find((m) => m.id === id);
}

export function isBundledModelId(id: string): boolean {
  return BUNDLED_MODELS.some((m) => m.id === id);
}

/** Maximum allowed model file size (bytes). Larger models likely won't run in offscreen. */
export const MAX_MODEL_SIZE = 200 * 1024 * 1024;

export interface ModelMeta {
  id: string;
  name: string;
  size: number;
  charsetsLength: number;
  uploadedAt: number;
  /** 'uploaded' = user upload, 'subscription' = from rule subscription, 'builtin' = baked in */
  source: 'uploaded' | 'subscription' | 'builtin';
  description?: string;
}

export interface ModelData {
  id: string;
  modelBlob: ArrayBuffer;
  charsets: string[];
}

let db: IDBDatabase | null = null;

async function openDb(): Promise<IDBDatabase> {
  if (db) return db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_NAME)) {
        d.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      db = req.result;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

/** ONNX file should start with magic bytes that indicate a protobuf-encoded ModelProto */
function looksLikeOnnx(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 16) return false;
  const view = new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength));
  // ONNX is protobuf; first byte is typically 0x08 (field 1 varint) for ir_version
  // It's not 100% reliable but catches most non-ONNX uploads (ZIP, PNG, text...)
  if (view[0] === 0x50 && view[1] === 0x4b) return false; // PKZIP
  if (view[0] === 0x89 && view[1] === 0x50) return false; // PNG
  if (view[0] === 0xff && view[1] === 0xd8) return false; // JPG
  if (view[0] === 0x7b) return false; // '{' JSON
  // 0x08 = (field 1, varint) — ir_version is field 1; very common first byte for ONNX
  return view[0] === 0x08 || view[0] === 0x0a; // 0x0a = field 1 length-delimited (some encoders)
}

/** Parse charsets file content. Accepts JSON array of strings, or newline-delimited. */
export function parseCharsetsContent(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('字符表为空');

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) throw new Error('字符表必须是数组');
      const result = parsed.map((c) => String(c));
      if (result.length === 0) throw new Error('字符表为空');
      return result;
    } catch (e) {
      throw new Error('字符表 JSON 解析失败: ' + (e as Error).message);
    }
  }

  // Newline-delimited fallback
  const lines = trimmed.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error('字符表为空');
  return lines;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  modelBuffer?: ArrayBuffer;
  charsets?: string[];
}

/**
 * Validate uploaded files before storing.
 * Catches: wrong file type, oversize, malformed JSON.
 *
 * Note: we do NOT try to construct an ort session here — it's expensive and
 * the offscreen document is the right place. We do offer a smoke test entry point
 * (smokeTestModel) that can be invoked separately.
 */
export async function validateModelFiles(
  modelFile: File,
  charsetsFile: File
): Promise<ValidationResult> {
  if (modelFile.size > MAX_MODEL_SIZE) {
    return { ok: false, error: `模型文件过大（${(modelFile.size / 1024 / 1024).toFixed(1)} MB），上限 ${MAX_MODEL_SIZE / 1024 / 1024} MB` };
  }
  if (modelFile.size < 1024) {
    return { ok: false, error: '模型文件过小，可能损坏' };
  }
  if (charsetsFile.size > 1024 * 1024) {
    return { ok: false, error: '字符表文件过大' };
  }

  const buffer = await modelFile.arrayBuffer();
  if (!looksLikeOnnx(buffer)) {
    return { ok: false, error: '文件不是有效的 ONNX 模型（魔数校验失败）' };
  }

  let charsets: string[];
  try {
    const text = await charsetsFile.text();
    charsets = parseCharsetsContent(text);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  return { ok: true, modelBuffer: buffer, charsets };
}

/** Returns user-uploaded + subscription models. Does NOT include bundled built-ins. */
export async function listUploadedModels(): Promise<ModelMeta[]> {
  const result = await storage.get(META_KEY);
  return result[META_KEY] || [];
}

/** Returns all models the user can pick: bundled built-ins + uploads. */
export async function listModels(): Promise<ModelMeta[]> {
  const uploaded = await listUploadedModels();
  const builtin: ModelMeta[] = BUNDLED_MODELS.map((b) => ({
    id: b.id,
    name: b.name,
    size: b.approxSize,
    charsetsLength: b.approxCharsets,
    uploadedAt: 0,
    source: 'builtin',
    description: b.description,
  }));
  return [...builtin, ...uploaded];
}

async function saveMeta(metas: ModelMeta[]): Promise<void> {
  await storage.set({ [META_KEY]: metas });
}

async function loadUploadedMetas(): Promise<ModelMeta[]> {
  const result = await storage.get(META_KEY);
  return result[META_KEY] || [];
}

export async function getActiveModelId(): Promise<string> {
  const result = await storage.get(ACTIVE_KEY);
  return result[ACTIVE_KEY] || BUILTIN_MODEL_ID;
}

export async function setActiveModelId(id: string): Promise<void> {
  await storage.set({ [ACTIVE_KEY]: id });
}

export async function getModelData(id: string): Promise<ModelData | null> {
  if (isBundledModelId(id)) return null;
  const d = await openDb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction([STORE_NAME], 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function generateId(): string {
  return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

/**
 * Save validated model files into IndexedDB and append metadata.
 * Throws if name conflicts.
 */
export async function saveModel(input: {
  name: string;
  description?: string;
  modelBuffer: ArrayBuffer;
  charsets: string[];
  source?: 'uploaded' | 'subscription';
}): Promise<ModelMeta> {
  const metas = await loadUploadedMetas();
  const trimmed = input.name.trim();
  if (!trimmed) throw new Error('模型名称不能为空');
  if (BUNDLED_MODELS.some((b) => b.name === trimmed)) {
    throw new Error('模型名称与内置模型冲突');
  }
  if (metas.some((m) => m.name === trimmed)) {
    throw new Error('模型名称已存在');
  }

  const id = generateId();
  const meta: ModelMeta = {
    id,
    name: trimmed,
    size: input.modelBuffer.byteLength,
    charsetsLength: input.charsets.length,
    uploadedAt: Date.now(),
    source: input.source || 'uploaded',
    description: input.description,
  };

  const d = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.put({ id, modelBlob: input.modelBuffer, charsets: input.charsets } as ModelData);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  metas.push(meta);
  await saveMeta(metas);

  // Try persistent storage (browser may otherwise evict under disk pressure)
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && (navigator.storage as any).persist) {
      await (navigator.storage as any).persist();
    }
  } catch {
    /* non-fatal */
  }

  return meta;
}

export async function renameModel(id: string, newName: string): Promise<void> {
  if (isBundledModelId(id)) throw new Error('不能重命名内置模型');
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('模型名称不能为空');
  if (BUNDLED_MODELS.some((b) => b.name === trimmed)) {
    throw new Error('模型名称与内置模型冲突');
  }
  const metas = await loadUploadedMetas();
  const idx = metas.findIndex((m) => m.id === id);
  if (idx < 0) throw new Error('模型不存在');
  if (metas.some((m, i) => i !== idx && m.name === trimmed)) {
    throw new Error('模型名称已存在');
  }
  metas[idx] = { ...metas[idx], name: trimmed };
  await saveMeta(metas);
}

export async function deleteModel(id: string): Promise<void> {
  if (isBundledModelId(id)) throw new Error('不能删除内置模型');
  const metas = await loadUploadedMetas();
  const newMetas = metas.filter((m) => m.id !== id);
  await saveMeta(newMetas);

  const d = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  // If active model was deleted, fall back to builtin
  const active = await getActiveModelId();
  if (active === id) {
    await setActiveModelId(BUILTIN_MODEL_ID);
  }
}

/**
 * Truncate a model name for compact display: "very_long_model_name" -> "very_lo…name"
 */
export function truncateName(name: string, maxLen = 24): string {
  if (name.length <= maxLen) return name;
  const head = Math.ceil((maxLen - 1) / 2);
  const tail = Math.floor((maxLen - 1) / 2);
  return name.slice(0, head) + '…' + name.slice(name.length - tail);
}
