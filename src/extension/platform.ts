/**
 * 浏览器扩展 API 平台抽象层。
 *
 * Chrome(MV3) 与 Firefox(MV2) 的绝大多数扩展 API 只差命名空间：`chrome.*` vs
 * `browser.*`，且 storage / sendMessage / tabs 等在两端都是 Promise 语义、形状一致。
 * 本模块统一入口，让业务代码不必再各写一份。
 *
 * 三处例外**不能**靠命名空间别名抹平，故单独提供适配器：
 *   1. onMessage 的异步响应协议 —— Chrome 要 `return true` + sendResponse，
 *      Firefox(MV2) 要 `return Promise`。见 onMessage()。
 *   2. contextMenus.create 的错误语义 —— Chrome 通过 runtime.lastError 回调报错
 *      （不 throw，不查就静默失败），Firefox 直接 throw；且 Firefox 下该 API 可能
 *      叫 menus。见 contextMenus()。
 *   3. MV3 专有 API（offscreen / scripting）—— 无 MV2 对应物，调用方需用
 *      __FIREFOX__ 分支自行处理，本模块不提供伪实现。
 *
 * 平台判定用构建期常量 __FIREFOX__（三个 vite 配置 + content script 的 esbuild
 * 二次编译各自 define）。运行时探测仅用于 getStorage 的兜底路径。
 */

declare const chrome: any;
declare const browser: any;

/**
 * 统一的扩展 API 命名空间。
 *
 * 用 globalThis 取而非直接引用裸标识符：content script 在某些页面上下文里
 * 访问未定义的 `browser` 会抛 ReferenceError，走 globalThis 则安全返回 undefined。
 */
export const api: any =
  (globalThis as any).browser ?? (globalThis as any).chrome;

/** 当前是否为 Firefox(MV2) 构建。构建期常量，可被 tree-shaking 消除死分支。 */
export const IS_FIREFOX: boolean = typeof __FIREFOX__ !== 'undefined' ? __FIREFOX__ : false;

// ─── storage ────────────────────────────────────────────────────────────────

let cachedStorage: any = null;

/**
 * 惰性解析 storage.local，延迟到首次使用再碰全局对象。
 *
 * 优先 Firefox 的 Promise 版 browser.storage，再回落 chrome.storage。每次探测都
 * 包 try/catch —— 某些上下文（如注入页面的隔离世界）会暴露「一访问就抛」的代理对象。
 */
export function getStorage(): any {
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
  const diag = {
    hasChrome: typeof chrome !== 'undefined',
    hasBrowser: typeof browser !== 'undefined',
    chromeStorage: typeof chrome !== 'undefined' && !!(chrome as any)?.storage,
  };
  throw new Error('No browser storage available; diag=' + JSON.stringify(diag));
}

/** storage.local 的薄封装，签名与 chrome.storage.local 一致。 */
export const storage = {
  get(key: string | string[]): Promise<any> {
    return getStorage().get(key);
  },
  set(items: Record<string, any>): Promise<void> {
    return getStorage().set(items);
  },
  remove(key: string | string[]): Promise<void> {
    return getStorage().remove(key);
  },
  clear(): Promise<void> {
    return getStorage().clear();
  },
};

// ─── onMessage ──────────────────────────────────────────────────────────────

/** 消息处理器：返回 Promise，由本模块负责按平台协议回传。 */
export type MessageHandler = (message: any, sender: any) => Promise<any>;

/**
 * 注册 runtime.onMessage，屏蔽两端的异步响应协议差异。
 *
 * Chrome(MV3)：监听器必须**同步**返回 true，通道才会保持打开等待 sendResponse。
 * Firefox(MV2)：返回 Promise，resolve 值即响应；此处仍优先走 sendResponse 分支，
 * 因为 Firefox 对 chrome 兼容层也支持回调式。
 *
 * 注意 handler 必须自己吞掉异常——若 reject，Chrome 侧通道会挂起直到超时。
 */
export function onMessage(handler: MessageHandler): void {
  api.runtime.onMessage.addListener((message: any, sender: any, sendResponse: any) => {
    if (typeof sendResponse === 'function') {
      handler(message, sender).then(sendResponse, (err) => {
        sendResponse({ success: false, error: String(err?.message || err) });
      });
      return true;
    }
    return handler(message, sender);
  });
}

// ─── contextMenus ───────────────────────────────────────────────────────────

/**
 * 取右键菜单 API。Firefox 的标准名是 menus，同时为兼容也提供 contextMenus；
 * Chrome 只有 contextMenus。取不到返回 null（MV2 下权限未申请时会发生）。
 */
export function contextMenus(): any {
  return (api as any).contextMenus || (api as any).menus || null;
}

/**
 * 创建右键菜单项，统一两端的错误语义。
 *
 * Chrome 的 create 不 throw，错误只出现在 runtime.lastError —— 不在回调里检查就是
 * 静默失败；Firefox 则直接 throw。这里都归一成 Promise<boolean>。
 */
export function createMenuItem(props: any): Promise<boolean> {
  const ctx = contextMenus();
  if (!ctx) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    try {
      const maybePromise = ctx.create(props, () => {
        const err = api.runtime?.lastError;
        if (err) {
          console.warn('[platform] 创建右键菜单失败:', err.message);
          resolve(false);
        } else {
          resolve(true);
        }
      });
      // Firefox 的 create 返回 id 而非 Promise，且不走回调；用微任务兜底 resolve。
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(() => resolve(true), () => resolve(false));
      }
    } catch (e) {
      console.warn('[platform] 创建右键菜单抛错:', e);
      resolve(false);
    }
  });
}

/** 移除全部右键菜单项，抹平回调式与 Promise 式差异。 */
export function removeAllMenuItems(): Promise<void> {
  const ctx = contextMenus();
  if (!ctx) return Promise.resolve();
  return new Promise<void>((resolve) => {
    try {
      const maybePromise = ctx.removeAll(() => {
        // 读一次 lastError 以免 Chrome 在控制台打印「未检查的错误」
        void api.runtime?.lastError;
        resolve();
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(() => resolve(), () => resolve());
      }
    } catch {
      resolve();
    }
  });
}
