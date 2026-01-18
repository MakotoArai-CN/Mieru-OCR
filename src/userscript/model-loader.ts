import { CONSTANTS } from '@core/config';
import type { CachedModel, OCRConfig } from '@core/types';

const CACHE_KEY = 'ddddocr_model_cache';
const UPLOADED_MODEL_KEY = 'ddddocr_uploaded_model';
const CONFIG_KEY = 'ddddocr_config';

function getConfig(): Partial<OCRConfig> {
  const stored = GM_getValue(CONFIG_KEY);
  return stored || {};
}

export class ModelCache {
  private dbName = 'DdddOCRDB';
  private storeName = 'modelStore';
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
    });
  }

  async get(): Promise<CachedModel | null> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(CACHE_KEY);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cached = request.result as CachedModel | undefined;
        if (!cached) {
          resolve(null);
          return;
        }
        if (Date.now() - cached.timestamp > CONSTANTS.CACHE_DURATION) {
          this.delete();
          resolve(null);
          return;
        }
        if (cached.version !== CONSTANTS.MODEL_VERSION) {
          this.delete();
          resolve(null);
          return;
        }
        resolve(cached);
      };
    });
  }

  async set(model: ArrayBuffer, charsets: string[]): Promise<void> {
    if (!this.db) await this.init();
    const cached: CachedModel = {
      model,
      charsets,
      timestamp: Date.now(),
      version: CONSTANTS.MODEL_VERSION,
    };
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.put(cached, CACHE_KEY);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async delete(): Promise<void> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(CACHE_KEY);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async getUploadedModel(): Promise<CachedModel | null> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(UPLOADED_MODEL_KEY);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  }

  async setUploadedModel(model: ArrayBuffer, charsets: string[]): Promise<void> {
    if (!this.db) await this.init();
    const cached: CachedModel = {
      model,
      charsets,
      timestamp: Date.now(),
      version: 'uploaded',
    };
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.put(cached, UPLOADED_MODEL_KEY);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async deleteUploadedModel(): Promise<void> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(UPLOADED_MODEL_KEY);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
}

function downloadFile(url: string, timeout = 30000): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      timeout,
      headers: { 'Cache-Control': 'max-age=2592000' },
      onload: (response) => {
        if (response.status === 200) {
          resolve(response.response as ArrayBuffer);
        } else {
          reject(new Error(`HTTP ${response.status}`));
        }
      },
      onerror: (error) => reject(error),
      ontimeout: () => reject(new Error('下载超时')),
    });
  });
}

function downloadJSON<T>(url: string, timeout = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url,
      responseType: 'json',
      timeout,
      headers: { 'Cache-Control': 'max-age=2592000' },
      onload: (response) => {
        if (response.status === 200) {
          resolve(response.response as T);
        } else {
          reject(new Error(`HTTP ${response.status}`));
        }
      },
      onerror: (error) => reject(error),
      ontimeout: () => reject(new Error('下载超时')),
    });
  });
}

function buildURL(mirror: string, path: string): string {
  if (mirror.includes('jsdelivr')) {
    return `${mirror}/${CONSTANTS.MODEL_REPO}@${CONSTANTS.MODEL_BRANCH}/${path}`;
  }
  return `${mirror}/${CONSTANTS.MODEL_REPO}/${CONSTANTS.MODEL_BRANCH}/${path}`;
}

export async function loadModel(): Promise<{ model: ArrayBuffer; charsets: string[] }> {
  const config = getConfig();
  const cache = new ModelCache();

  if (config.useUploadedModel) {
    const uploaded = await cache.getUploadedModel();
    if (uploaded) {
      console.log('✅ 使用上传的模型');
      return { model: uploaded.model, charsets: uploaded.charsets };
    }
  }

  if (config.autoDownload === false) {
    throw new Error('自动下载已禁用，请上传模型文件或启用自动下载');
  }

  const cached = await cache.get();
  if (cached) {
    console.log('✅ 使用缓存的模型');
    return { model: cached.model, charsets: cached.charsets };
  }

  console.log('📥 开始下载模型');

  let model: ArrayBuffer | null = null;
  let charsets: string[] | null = null;

  for (let i = 0; i < CONSTANTS.GITHUB_MIRRORS.length; i++) {
    const mirror = CONSTANTS.GITHUB_MIRRORS[i];
    try {
      console.log(`🌐 镜像 [${i + 1}/${CONSTANTS.GITHUB_MIRRORS.length}]`);
      const [modelData, charsetsData] = await Promise.all([
        downloadFile(buildURL(mirror, CONSTANTS.MODEL_PATH)),
        downloadJSON<string[]>(buildURL(mirror, CONSTANTS.CHARSETS_PATH)),
      ]);
      model = modelData;
      charsets = charsetsData;
      console.log(`✅ 下载成功 (${(model.byteLength / 1024 / 1024).toFixed(2)} MB)`);
      break;
    } catch (error) {
      console.warn(`❌ 镜像 ${i + 1} 失败`, error);
      if (i === CONSTANTS.GITHUB_MIRRORS.length - 1) {
        throw new Error('所有镜像均失败，请检查网络或上传模型文件');
      }
    }
  }

  if (!model || !charsets) {
    throw new Error('模型下载失败');
  }

  await cache.set(model, charsets);
  console.log('💾 模型已缓存');

  return { model, charsets };
}

export async function clearModelCache(): Promise<void> {
  const cache = new ModelCache();
  await cache.delete();
  console.log('🗑️ 模型缓存已清除');
}

export async function saveUploadedModel(modelFile: File, charsetsFile: File): Promise<void> {
  const modelData = await modelFile.arrayBuffer();
  const charsetsText = await charsetsFile.text();
  const charsets = JSON.parse(charsetsText) as string[];
  const cache = new ModelCache();
  await cache.setUploadedModel(modelData, charsets);
  console.log('✅ 上传的模型已保存');
}

export async function deleteUploadedModel(): Promise<void> {
  const cache = new ModelCache();
  await cache.deleteUploadedModel();
  console.log('🗑️ 上传的模型已删除');
}