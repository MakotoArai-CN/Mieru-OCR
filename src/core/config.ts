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
  ],
  INPUT_KEYWORDS: [
    'captcha', 'verify', 'code', 'vcode', 'authcode', '验证码',
    'checkcode', 'yzm', 'validatecode', 'validcode', 'seccode',
    'imgcode', 'randcode', 'identify', 'kaptcha', 'answer',
  ],
  MIN_CAPTCHA_WIDTH: 40,
  MIN_CAPTCHA_HEIGHT: 20,
  MAX_CAPTCHA_WIDTH: 500,
  MAX_CAPTCHA_HEIGHT: 200,
  AUTO_DETECT_INTERVAL: 2000,
  GITHUB_MIRRORS: [
    'https://raw.githubusercontent.com',
    'https://ghproxy.com/https://raw.githubusercontent.com',
    'https://ghfast.top/https://raw.githubusercontent.com',
    'https://mirror.ghproxy.com/https://raw.githubusercontent.com',
    'https://raw.kkgithub.com',
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
  autoDetect: true,
  captchaSelector: '',
  inputSelector: '',
  submitSelector: '',
  agreementSelector: '',
  useLocalModel: false,
  localModelPath: '',
  localCharsetsPath: '',
  autoDownload: true,
  enableWhitelist: true,
  whitelist: [],
  useUploadedModel: false,
  theme: 'auto',
};

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  ...DEFAULT_CONFIG,
  timeout: 30000,
  retryCount: 3,
  autoFill: true,
  autoSubmit: false,
  autoSolveOnRule: true,
  debugMode: false,
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