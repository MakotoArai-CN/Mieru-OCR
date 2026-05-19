import { DEFAULT_CONFIG } from '@core/config';
import type { OCRConfig, SiteRule } from '@core/types';
import { createConfigManager } from '@core/config-migration';
import { StatisticsManager } from '@core/statistics';

const CONFIG_KEY = 'ddddocr_config';
const SITE_RULES_KEY = 'ddddocr_site_rules';

const configManager = createConfigManager(
  (key) => GM_getValue(key),
  (key, value) => GM_setValue(key, value),
  CONFIG_KEY
);

export function getConfig(): OCRConfig {
  return configManager.getConfig();
}

export function saveConfig(config: Partial<OCRConfig>): void {
  configManager.saveConfig(config);
}

export function getSiteRules(): Record<string, SiteRule & { hostname: string }> {
  return GM_getValue(SITE_RULES_KEY) || {};
}

export function saveSiteRule(hostname: string, rule: Partial<SiteRule>): void {
  const rules = getSiteRules();
  const key = rule.fullUrl || rule.urlPattern || hostname;
  const existing = rules[key] || {};
  rules[key] = {
    ...existing,
    ...rule,
    hostname,
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now(),
    enabled: rule.enabled !== false
  } as SiteRule & { hostname: string };
  GM_setValue(SITE_RULES_KEY, rules);
}

export function deleteSiteRule(key: string): void {
  const rules = getSiteRules();
  delete rules[key];
  GM_setValue(SITE_RULES_KEY, rules);
}

export const statsManager = new StatisticsManager({
  get: (key: string) => GM_getValue(key),
  set: (key: string, value: any) => GM_setValue(key, value),
});

export function isWhitelisted(): boolean {
  const config = getConfig();
  if (!config.enableWhitelist) return true;
  if (!config.whitelist || config.whitelist.length === 0) return false;
  const currentHost = window.location.hostname;
  return config.whitelist.some(pattern => {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
    return regex.test(currentHost);
  });
}

export function shouldExecuteScript(): boolean {
  const config = getConfig();
  // 用户脚本 @match *://*/* 会被注入进所有 iframe；除非用户开启「深度扫描」，
  // 否则子框架直接退出，避免广告 / 分析 iframe 中的无谓加载和重复识别。
  const isTopFrame = (() => {
    try { return window.top === window; } catch { return false; }
  })();
  if (!isTopFrame && !(config as any).deepScan) {
    return false;
  }
  if (config.enableWhitelist) {
    if (!config.whitelist || config.whitelist.length === 0) {
      return false;
    }
    if (!isWhitelisted()) {
      return false;
    }
  }
  return true;
}