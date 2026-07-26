export interface CachedModel {
  model: ArrayBuffer;
  charsets: string[];
  timestamp: number;
  version: string;
}

export interface OCRResult {
  text: string;
  confidence?: number;
}

export interface CaptchaElementInfo {
  tagName: string;
  id: string | null;
  className: string;
  width: number;
  height: number;
  src?: string;
}

export interface InputElementInfo {
  tagName: string;
  id: string | null;
  name: string | null;
  className: string;
  placeholder: string | null;
  type: string;
}

export interface OCREvents {
  'init:start': void;
  'init:complete': void;
  'init:error': Error;
  'detect:found': { element: Element; type: string };
  'recognize:start': { element: Element };
  'recognize:complete': { element: Element; result: OCRResult };
  'recognize:error': { element: Element; error: Error };
}

export class EventEmitter<T extends Record<string, any>> {
  private listeners = new Map<keyof T, Set<(data: any) => void>>();

  on<K extends keyof T>(event: K, callback: (data: T[K]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off<K extends keyof T>(event: K, callback: (data: T[K]) => void): void {
    this.listeners.get(event)?.delete(callback);
  }

  emit<K extends keyof T>(event: K, data: T[K]): void {
    this.listeners.get(event)?.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error(`Event handler error [${String(event)}]:`, error);
      }
    });
  }

  clear(): void {
    this.listeners.clear();
  }
}

export interface SiteRule {
  selector: string;
  inputSelector?: string;
  submitSelector?: string;
  agreementSelectors?: string[];
  fullUrl?: string;
  urlPattern?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** 验证码类型。缺省 = 文本/图片 OCR（向后兼容旧规则）；
   *  'slider' = 滑块拖拽，命中后走 solveSlider；'click-select' = 文字点选，走 solveClickSelect。
   *  交互类仍受 enableSliderPuzzleAssist / enableClickSelectAssist 等全局开关 gate。 */
  subType?: 'slider' | 'click-select';
  /** 当目标元素位于子 iframe 内时，记录顶层文档中定位到该 iframe 的 selector。
   *  自动应用规则时：sub-frame 自己用 selector 命中元素；top-frame 用 frameSelector 命中 iframe。 */
  frameSelector?: string;
  /** 规则采集时的 iframe URL（仅用于诊断/迁移，不参与匹配，URL 跨实例可能不稳定） */
  frameUrl?: string;
  /** URL 匹配模式。缺省时由旧字段推断（有 fullUrl→'origin-path'，有 urlPattern→'prefix'，皆无→'hostname'）。
   *  'origin-path' = 忽略全部 query/hash，按 origin+pathname 匹配（抗随机参数，推荐默认）；
   *  'prefix' = 对归一化后的 origin+pathname 做前缀匹配；
   *  'exact' = 含 query 的完全一致（旧 fullUrl 行为，需严格含参时用）；
   *  'hostname' = 仅域名。 */
  urlMatch?: 'origin-path' | 'prefix' | 'exact' | 'hostname';
  /** 必须参与匹配的 query 参数名白名单：仅比对这些参数的值，其余（含随机数）一律忽略。 */
  matchQuery?: string[];
  /** 命中后延迟多少毫秒再首次求解，应对懒加载 / 入场动画的验证码。缺省沿用 500。 */
  solveDelayMs?: number;
  /** 求解未成功时的重试间隔（毫秒）。缺省 / 0 = 不重试。 */
  retryMs?: number;
  /** 从命中到放弃的最长等待（毫秒），超过后停止重试。缺省 / 0 = 仅首次尝试。 */
  maxWaitMs?: number;
  /** 滑块拖拽速度档位：影响轨迹时长 / 抖动 / 过冲幅度。缺省 'normal'。 */
  dragProfile?: 'fast' | 'normal' | 'cautious';
}

export interface SiteRuleStorage {
  [key: string]: SiteRule & { hostname: string };
}

export interface CalculateRule {
  pattern: string;
  matchType: 'wildcard' | 'regex';
  outputMode: 'result' | 'equation';
  enabled: boolean;
}

export interface OCRConfig {
  debugMode: boolean;
  autoDetect: boolean;
  captchaSelector: string;
  inputSelector: string;
  submitSelector: string;
  agreementSelector: string;
  agreementSelectors: string[];
  autoCheckAgreement: boolean;
  useLocalModel: boolean;
  localModelPath: string;
  localCharsetsPath: string;
  autoDownload: boolean;
  enableWhitelist: boolean;
  whitelist: string[];
  useUploadedModel: boolean;
  useUploadedWasm: boolean;
  theme: 'light' | 'dark' | 'auto';
  language: 'auto' | 'zh' | 'ja' | 'en';
  typewriterEffect: boolean;
  autoCalculate: boolean;
  calculateOutputMode: 'result' | 'equation';
  calculateRules: CalculateRule[];
  customIncludeKeywords: string[];
  customExcludePatterns: string[];
  customAgreementKeywords: string[];
  customInputExcludeKeywords: string[];
  disabledCaptchaKeywords: string[];
  disabledExcludePatterns: string[];
  disabledAgreementKeywords: string[];
  disabledInputExcludeKeywords: string[];
  enableInteractiveCaptchaAssist: boolean;
  enableInteractiveCaptchaDebugOverlay: boolean;
  enableSliderPuzzleAssist: boolean;
  enableSingleSliderAssist: boolean;
  enableClickSelectAssist: boolean;
  enableNotification: boolean;
  autoSubmit: boolean;
  autoSolveOnRule: boolean;
  siteBlacklist: string[];
  /** Show "用 Mieru-OCR 识别图片" item in the browser's right-click menu on images. Default off. Extension only. */
  imageContextMenuEnabled: boolean;
  /** When the right-click result is recognized, also try to fill a related input. Default on. Always copies to clipboard regardless. */
  imageContextMenuAutoFill: boolean;
  /** Preserve the user's current focus when auto-filling the captcha input. Default off (steal focus, more visible).
   *  Set to true on sites whose anti-bot detection flags sudden focus jumps as automation.
   */
  preserveFocus: boolean;
  /** 深度扫描：让 content script 在所有子 iframe 中也运行，并启用顶层 picker 跨框架接力。
   *  默认关闭——开启后广告/分析 iframe 也会注入脚本。仅在常规模式拾取不到目标元素时打开。 */
  deepScan: boolean;
  /** 文字点选检测模型来源偏好：'auto'(默认) = 优先订阅指定 / 远程下载的模型；
   *  'local' = 优先使用用户上传的本地点选模型。检测模型不再随扩展内置（1.2.3 起）。 */
  detModelPreference: 'auto' | 'local';
}

export interface ExtensionSettings extends OCRConfig {
  timeout: number;
  retryCount: number;
  autoFill: boolean;
  historyRetention: number;
}

export interface DetectionContext {
  url: string;
  hostname: string;
  pathname: string;
  timestamp: number;
}

export interface ResourceStatus {
  modelReady: boolean;
  modelSize: number;
  wasmReady: boolean;
  wasmFiles: string[];
  ortReady: boolean;
}

export interface SiteStats {
  count: number;
  lastTime: number;
  totalTime: number;
}

export interface StatsData {
  sites: Record<string, SiteStats>;
  total: number;
  updated: number;
}