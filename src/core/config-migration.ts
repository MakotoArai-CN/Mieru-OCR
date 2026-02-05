import type { OCRConfig, CalculateRule } from './types';
import { DEFAULT_CONFIG } from './config';

const CONFIG_VERSION = 2;
const CONFIG_VERSION_KEY = 'ddddocr_config_version';

interface LegacyConfig {
  autoDetect?: boolean;
  captchaSelector?: string;
  inputSelector?: string;
  submitSelector?: string;
  agreementSelector?: string;
  useLocalModel?: boolean;
  localModelPath?: string;
  localCharsetsPath?: string;
  autoDownload?: boolean;
  enableWhitelist?: boolean;
  whitelist?: string[];
  useUploadedModel?: boolean;
  theme?: string;
  typewriterEffect?: boolean;
  autoCalculate?: boolean;
  calculateOutputMode?: string;
  calculateRules?: CalculateRule[];
  enableNotification?: boolean;
  debugMode?: boolean;
  agreementSelectors?: string[];
  autoCheckAgreement?: boolean;
  useUploadedWasm?: boolean;
}

export function migrateConfig(stored: LegacyConfig | null, getVersion: () => number, setVersion: (v: number) => void): OCRConfig {
  if (!stored) {
    setVersion(CONFIG_VERSION);
    return { ...DEFAULT_CONFIG };
  }

  const currentVersion = getVersion();
  
  // 关键修复：先用默认值初始化，然后将存储的值合并进去
  let config: OCRConfig = { ...DEFAULT_CONFIG };
  
  // 将stored中所有有效的字段值复制到config
  for (const key of Object.keys(stored) as (keyof LegacyConfig)[]) {
    const value = stored[key];
    if (value !== undefined && key in DEFAULT_CONFIG) {
      (config as any)[key] = value;
    }
  }

  // 版本迁移：处理旧版本字段兼容
  if (currentVersion < 2) {
    // 旧的单个agreementSelector迁移到agreementSelectors数组
    if (stored.agreementSelector && (!config.agreementSelectors || config.agreementSelectors.length === 0)) {
      const selector = stored.agreementSelector.trim();
      if (selector) {
        config.agreementSelectors = [selector];
      }
    }
  }

  // 确保所有必需字段都存在（处理新版本新增字段的情况）
  for (const key of Object.keys(DEFAULT_CONFIG) as (keyof OCRConfig)[]) {
    if (config[key] === undefined) {
      (config as any)[key] = DEFAULT_CONFIG[key];
    }
  }

  // 只在版本变化时更新版本号
  if (currentVersion !== CONFIG_VERSION) {
    setVersion(CONFIG_VERSION);
  }

  return config;
}

export function createConfigManager(
  getValue: (key: string) => any,
  setValue: (key: string, value: any) => void,
  configKey: string
) {
  const getVersion = () => getValue(CONFIG_VERSION_KEY) || 1;
  const setVersion = (v: number) => setValue(CONFIG_VERSION_KEY, v);

  return {
    getConfig(): OCRConfig {
      const stored = getValue(configKey);
      return migrateConfig(stored, getVersion, setVersion);
    },
    saveConfig(config: Partial<OCRConfig>): void {
      const current = this.getConfig();
      const merged = { ...current, ...config };
      setValue(configKey, merged);
    },
    resetConfig(): void {
      setValue(configKey, DEFAULT_CONFIG);
      setVersion(CONFIG_VERSION);
    }
  };
}