import type { OCRConfig, ExtensionSettings } from './types';

export const CONSTANTS = {
  MODEL_VERSION: '1.5.1',
  MODEL_REPO: 'MakotoArai-CN/ddddocr-webjs',
  MODEL_BRANCH: 'main',
  MODEL_PATH: 'public/common.onnx',
  CHARSETS_PATH: 'public/charsets.json',
  WASM_VERSION: '1.17.0',
  CACHE_DURATION: 30 * 24 * 60 * 60 * 1000,
  CAPTCHA_KEYWORDS: [
    'captcha', 'verify', 'code', 'vcode', 'authcode', '验证码',
    'checkcode', 'yzm', 'capimg', 'signCaptcha', 'imgcode',
    'seccode', 'validcode', 'yanzhengma', 'validatecode', 'piccode',
    'imgverify', 'codeimg', 'randcode', 'identify', 'kaptcha',
    'verifycode', 'imgCaptcha', 'captchaImg', 'vcodeImg',
  ],
  INPUT_KEYWORDS: [
    'captcha', 'verify', 'code', 'vcode', 'authcode', '验证码',
    'checkcode', 'yzm', 'validatecode', 'validcode', 'seccode',
    'imgcode', 'randcode', 'identify', 'kaptcha', 'answer',
    'verifycode', 'captchaInput', 'vcodeInput',
  ],
  AGREEMENT_KEYWORDS: [
    'agree', 'agreement', 'accept', 'terms', 'policy', 'privacy',
    '同意', '协议', '条款', '隐私', '用户协议', '隐私政策',
    'tos', 'consent',
  ],
  INPUT_EXCLUDE_KEYWORDS: [
    '手机', '短信', 'sms', 'phone', 'mobile',
    '手机验证码', '短信验证码', '手机号', '滑动验证码',
    'email', 'mail', '邮箱', '邮箱验证码', '邮件验证码',
    'username', 'user', 'account', '账号', '用户名',
    'otp', 'one time', 'verification code', '动态码', '校验码', '短信校验', '手机校验码',
  ],
  EXCLUDED_INPUT_TYPES: [
    'password', 'email', 'tel', 'phone', 'mobile', 'hidden',
    'submit', 'button', 'reset', 'file', 'image', 'checkbox', 'radio',
  ],
  EXCLUDED_INPUT_NAMES: [
    'username', 'user', 'account', 'email', 'mail', 'phone', 'mobile', 'tel',
    'password', 'pwd', 'pass', 'name', 'realname', 'nickname',
    'search', 'query', 'q', 'keyword', 'address', 'city',
  ],
  EXCLUDE_PATTERNS: [
    'avatar', 'logo', 'icon', 'banner', 'ad', 'sponsor',
    'background', 'bg', 'profile', 'user', 'photo',
    'emoji', 'emoticon', 'sticker', 'gif',
    'loading', 'spinner', 'placeholder',
    'slider', 'slide', 'drag', 'puzzle', 'jigsaw',
  ],
  MIN_CAPTCHA_WIDTH: 50,
  MIN_CAPTCHA_HEIGHT: 20,
  MAX_CAPTCHA_WIDTH: 400,
  MAX_CAPTCHA_HEIGHT: 150,
  AUTO_DETECT_INTERVAL: 2000,
  GITHUB_MIRRORS: [
    'https://raw.githubusercontent.com',
    'https://ghproxy.com/https://raw.githubusercontent.com',
    'https://ghfast.top/https://raw.githubusercontent.com',
    'https://mirror.ghproxy.com/https://raw.githubusercontent.com',
    'https://raw.kkgithub.com',
    'https://gh-proxy.org',
    'https://hk.gh-proxy.org',
    'https://cdn.gh-proxy.org',
    'https://edgeone.gh-proxy.org',
    'https://github.moeyy.xyz/https://raw.githubusercontent.com',
    'https://ghps.cc/https://raw.githubusercontent.com',
    'https://cors.isteed.cc/github.com/MakotoArai-CN/ddddocr-webjs/raw/main',
    'https://raw.githubusercontents.com',
  ],
  CDN_SOURCES: [
    'https://cdn.jsdelivr.net',
    'https://unpkg.com',
    'https://cdnjs.cloudflare.com',
    'https://fastly.jsdelivr.net',
    'https://registry.npmmirror.com',
  ],
};

export const DEFAULT_CONFIG: OCRConfig = {
  debugMode: false,
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
  typewriterEffect: true,
  autoCalculate: false,
  calculateOutputMode: 'result',
  calculateRules: [],
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
  enableNotification: true,
};

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  ...DEFAULT_CONFIG,
  timeout: 30000,
  retryCount: 3,
  autoFill: true,
  autoSubmit: false,
  autoSolveOnRule: true,
  siteBlacklist: [],
  historyRetention: 7,
};

export function getThemeColors(theme: 'light' | 'dark' | 'auto'): Record<string, string> {
  const prefersDark = typeof window !== 'undefined'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
  const isDark = theme === 'dark' || (theme === 'auto' && prefersDark);

  if (isDark) {
    return {
      '--primary': '#4A90E2',
      '--primary-hover': '#357ABD',
      '--primary-light': 'rgba(74, 144, 226, 0.15)',
      '--accent': '#FF69B4',
      '--accent-hover': '#FF1493',
      '--success': '#10b981',
      '--error': '#ef4444',
      '--warning': '#f59e0b',
      '--bg-primary': '#0f0f1a',
      '--bg-secondary': '#1a1a2e',
      '--bg-tertiary': '#252540',
      '--bg-hover': '#2a2a4a',
      '--text-primary': '#ffffff',
      '--text-secondary': '#a1a1aa',
      '--text-muted': '#71717a',
      '--border': '#27272a',
    };
  }

  return {
    '--primary': '#4A90E2',
    '--primary-hover': '#357ABD',
    '--primary-light': 'rgba(74, 144, 226, 0.1)',
    '--accent': '#FF69B4',
    '--accent-hover': '#FF1493',
    '--success': '#10b981',
    '--error': '#ef4444',
    '--warning': '#f59e0b',
    '--bg-primary': '#ffffff',
    '--bg-secondary': '#f8fbff',
    '--bg-tertiary': '#e8f0fe',
    '--bg-hover': '#d0e2f5',
    '--text-primary': '#1a1a2e',
    '--text-secondary': '#52525b',
    '--text-muted': '#a1a1aa',
    '--border': '#e4e4e7',
  };
}

export class Logger {
  private static debugMode = false;
  private static prefix = '[DDDD OCR]';

  static setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  static isDebugMode(): boolean {
    return this.debugMode;
  }

  static debug(...args: any[]): void {
    if (this.debugMode) {
      console.log(`${this.prefix} [DEBUG]`, ...args);
    }
  }

  static info(...args: any[]): void {
    if (this.debugMode) {
      console.info(`${this.prefix} [INFO]`, ...args);
    }
  }

  static warn(...args: any[]): void {
    console.warn(`${this.prefix} [WARN]`, ...args);
  }

  static error(...args: any[]): void {
    console.error(`${this.prefix} [ERROR]`, ...args);
  }

  static group(label: string): void {
    if (this.debugMode) {
      console.group(`${this.prefix} ${label}`);
    }
  }

  static groupEnd(): void {
    if (this.debugMode) {
      console.groupEnd();
    }
  }

  static table(data: any): void {
    if (this.debugMode) {
      console.table(data);
    }
  }

  static time(label: string): void {
    if (this.debugMode) {
      console.time(`${this.prefix} ${label}`);
    }
  }

  static timeEnd(label: string): void {
    if (this.debugMode) {
      console.timeEnd(`${this.prefix} ${label}`);
    }
  }
}