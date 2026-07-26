/**
 * 文字点选检测模型（common_det.onnx）按需 provisioning（1.2.3 起）。
 *
 * 检测模型不再随扩展内置。本模块按优先级解析「该用哪个检测模型」并在需要时下载、
 * sha256 校验、写入 IndexedDB（model-store 的 __det__ 槽）：
 *   1. detModelPreference === 'local'：仅用用户上传的本地模型（不回退远程）。
 *   2. auto：启用订阅里指定的 detModel（按 version/sha256 判断是否需重新下载）。
 *   3. auto：已有任意可用模型（之前下过）→ 直接复用。
 *   4. auto + autoDownload：从仓库镜像下载默认 common_det.onnx。
 *
 * Chrome（service worker）与 Firefox（background page）共用本模块——两者都有
 * fetch + host_permissions:<all_urls> + IndexedDB + storage。offscreen 不调用本模块，
 * 它只从 IndexedDB 读取已写好的模型。
 */

import { CONSTANTS } from '@core/config';
import { verifyIntegrity } from '@core/integrity';
import type { DetModelSpec, Subscription } from '@core/subscription';
import { getDetModelData, getDetModelMeta, saveDetModel, type DetModelMeta } from './model-store';

declare const chrome: any;
declare const browser: any;

let cachedStorage: any = null;
function getStorage(): any {
  if (cachedStorage) return cachedStorage;
  try {
    if (typeof browser !== 'undefined' && browser?.storage?.local) {
      cachedStorage = browser.storage.local;
      return cachedStorage;
    }
  } catch { /* fall through */ }
  try {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      cachedStorage = chrome.storage.local;
      return cachedStorage;
    }
  } catch { /* fall through */ }
  throw new Error('No browser storage available');
}

async function getSettings(): Promise<any> {
  const r = await getStorage().get('settings');
  return r.settings || {};
}

async function getSubscriptions(): Promise<Subscription[]> {
  const r = await getStorage().get('subscriptions');
  return r.subscriptions || [];
}

/** 复刻 userscript model-loader 的镜像 URL 构造，覆盖 raw.githubusercontent / 各代理 / jsdelivr。 */
function buildMirrorUrl(mirror: string, path: string): string {
  const normalizedMirror = mirror.replace(/\/+$/, '');
  const normalizedPath = path.replace(/^\/+/, '');
  if (normalizedMirror.includes('jsdelivr')) {
    return `${normalizedMirror}/${CONSTANTS.MODEL_REPO}@${CONSTANTS.MODEL_BRANCH}/${normalizedPath}`;
  }
  const repoToken = `/${CONSTANTS.MODEL_REPO}/`;
  if (normalizedMirror.includes(repoToken)) {
    return `${normalizedMirror}/${normalizedPath}`;
  }
  return `${normalizedMirror}/${CONSTANTS.MODEL_REPO}/${CONSTANTS.MODEL_BRANCH}/${normalizedPath}`;
}

async function fetchArrayBuffer(url: string, timeout = 60000): Promise<ArrayBuffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, { method: 'GET', signal: ctrl.signal, cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

/** 从仓库镜像顺序下载默认 common_det.onnx，任一成功即返回。 */
async function downloadFromMirrors(): Promise<ArrayBuffer> {
  let lastErr: Error | null = null;
  for (const mirror of CONSTANTS.GITHUB_MIRRORS) {
    try {
      const url = buildMirrorUrl(mirror, CONSTANTS.DET_MODEL_PATH);
      const buf = await fetchArrayBuffer(url);
      if (buf.byteLength > 1024) return buf;
      lastErr = new Error('下载内容过小，疑似失败');
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw new Error('所有镜像下载失败: ' + (lastErr?.message || 'unknown'));
}

export interface EnsureDetResult {
  ready: boolean;
  source?: DetModelMeta['source'];
  reason?: string;
  /** 是否本次重新下载 / 写入（用于让 offscreen 失效缓存引擎） */
  changed?: boolean;
}

/**
 * 解析并（按需）下载检测模型，写入 IndexedDB。返回是否就绪。
 * 不抛错——失败信息放在 reason，由调用方决定是否提示用户。
 *
 * 并发去重：多个点选验证码 / 重试可能同时触发，用 in-flight promise 合流，避免重复下载 20MB。
 */
let ensureInFlight: Promise<EnsureDetResult> | null = null;
export function ensureDetModel(): Promise<EnsureDetResult> {
  if (ensureInFlight) return ensureInFlight;
  ensureInFlight = ensureDetModelImpl();
  const done = ensureInFlight;
  done.finally(() => { if (ensureInFlight === done) ensureInFlight = null; });
  return done;
}

async function ensureDetModelImpl(): Promise<EnsureDetResult> {
  const settings = await getSettings();
  const pref: 'auto' | 'local' = settings.detModelPreference === 'local' ? 'local' : 'auto';
  const meta = await getDetModelMeta();
  const haveData = !!(await getDetModelData());

  // 1) 用户显式选用本地上传模型：只认本地，不回退远程。
  if (pref === 'local') {
    if (meta?.source === 'uploaded' && haveData) return { ready: true, source: 'uploaded' };
    return { ready: false, reason: 'detModelPreference=local 但未上传本地点选模型' };
  }

  // 2) auto：优先订阅指定的 detModel。
  const subs = await getSubscriptions();
  const specSub = subs.find((s) => s.enabled && s.cachedPackage?.detModel?.url);
  const spec: DetModelSpec | undefined = specSub?.cachedPackage?.detModel;
  if (spec) {
    const versionChanged = spec.version ? meta?.version !== spec.version : false;
    const shaChanged = !spec.version && spec.sha256 ? meta?.sha256 !== spec.sha256 : false;
    const needDownload = !haveData || meta?.source !== 'subscription' || versionChanged || shaChanged;
    if (!needDownload) return { ready: true, source: 'subscription' };
    try {
      const buf = await fetchArrayBuffer(spec.url);
      const integ = await verifyIntegrity(buf, spec.sha256);
      if (!integ.ok) {
        return { ready: false, reason: `检测模型 sha256 校验失败（期望 ${integ.expected}，实际 ${integ.actual}）` };
      }
      await saveDetModel(buf, {
        source: 'subscription',
        version: spec.version,
        sha256: spec.sha256 || integ.actual,
        name: spec.name || '订阅指定检测模型',
      });
      return { ready: true, source: 'subscription', changed: true };
    } catch (e) {
      // 订阅下载失败 → 若已有任意模型则降级使用，否则尝试镜像兜底。
      if (haveData && meta) return { ready: true, source: meta.source };
      if (settings.autoDownload === false) {
        return { ready: false, reason: '订阅检测模型下载失败: ' + (e as Error).message };
      }
    }
  }

  // 3) 已有可用模型（之前下过 / 上传过）→ 直接复用。
  if (haveData && meta) return { ready: true, source: meta.source };

  // 4) auto + autoDownload：仓库镜像下载默认模型。
  if (settings.autoDownload !== false) {
    try {
      const buf = await downloadFromMirrors();
      await saveDetModel(buf, { source: 'mirror', version: CONSTANTS.MODEL_VERSION, name: 'common_det（仓库默认）' });
      return { ready: true, source: 'mirror', changed: true };
    } catch (e) {
      return { ready: false, reason: '检测模型镜像下载失败: ' + (e as Error).message };
    }
  }

  return { ready: false, reason: '无可用检测模型来源（未上传本地、无订阅指定、自动下载已关闭）' };
}

/** options 页「下载默认模型」按钮：强制从仓库镜像下载默认 common_det.onnx 并写入。 */
export async function forceDownloadDefaultDetModel(): Promise<DetModelMeta> {
  const buf = await downloadFromMirrors();
  return saveDetModel(buf, { source: 'mirror', version: CONSTANTS.MODEL_VERSION, name: 'common_det（仓库默认）' });
}
