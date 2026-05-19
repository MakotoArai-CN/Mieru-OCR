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
  /** 当目标元素位于子 iframe 内时，记录顶层文档中定位到该 iframe 的 selector。
   *  自动应用规则时：sub-frame 自己用 selector 命中元素；top-frame 用 frameSelector 命中 iframe。 */
  frameSelector?: string;
  /** 规则采集时的 iframe URL（仅用于诊断/迁移，不参与匹配，URL 跨实例可能不稳定） */
  frameUrl?: string;
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