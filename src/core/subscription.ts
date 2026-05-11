import type { SiteRule, CalculateRule } from './types';

export interface SubscriptionRulePackage {
  /** 规则包名称 */
  name: string;
  /** 描述 */
  description?: string;
  /** 规则包版本 */
  version: string;
  /** 规则包作者 */
  author?: string;
  /** 站点规则（hostname/url -> rule） */
  siteRules?: Record<string, Omit<SiteRule, 'createdAt' | 'updatedAt' | 'enabled'> & { hostname?: string }>;
  /** 计算规则 */
  calculateRules?: CalculateRule[];
  /** 触发关键词 */
  includeKeywords?: string[];
  /** 排除关键词 */
  excludePatterns?: string[];
  /** 协议关键词 */
  agreementKeywords?: string[];
  /** 输入框排除关键词 */
  inputExcludeKeywords?: string[];
  /** 协议选择器 */
  agreementSelectors?: string[];
  /** 站点黑名单 */
  siteBlacklist?: string[];
  /** 元数据 */
  updatedAt?: number;
}

export interface Subscription {
  /** 订阅唯一 ID */
  id: string;
  /** 订阅 URL */
  url: string;
  /** 名称（用户自定义或从规则包读取） */
  name: string;
  /** 启用 */
  enabled: boolean;
  /** 自动更新间隔（小时），0 = 不自动更新 */
  updateInterval: number;
  /** 上次更新时间 */
  lastUpdated: number;
  /** 上次更新结果 */
  lastStatus: 'success' | 'error' | 'pending' | 'never';
  /** 上次错误信息 */
  lastError?: string;
  /** 创建时间 */
  createdAt: number;
  /** 已应用的规则包内容（用于增量删除） */
  cachedPackage?: SubscriptionRulePackage;
}

export interface SubscriptionStorage {
  subscriptions: Subscription[];
}

/**
 * HTTP 获取器接口（油猴脚本和扩展实现不同）
 */
export interface SubscriptionFetcher {
  fetch(url: string, timeout?: number): Promise<string>;
}

const SUBSCRIPTION_TIMEOUT = 30000;

/**
 * 校验订阅规则包格式
 */
export function validateRulePackage(data: any): { valid: boolean; error?: string; pkg?: SubscriptionRulePackage } {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: '订阅内容不是有效的 JSON 对象' };
  }
  if (!data.name || typeof data.name !== 'string') {
    return { valid: false, error: '缺少 name 字段' };
  }
  if (!data.version || typeof data.version !== 'string') {
    return { valid: false, error: '缺少 version 字段' };
  }

  const pkg: SubscriptionRulePackage = {
    name: data.name,
    description: typeof data.description === 'string' ? data.description : undefined,
    version: data.version,
    author: typeof data.author === 'string' ? data.author : undefined,
    siteRules: typeof data.siteRules === 'object' && data.siteRules !== null ? data.siteRules : undefined,
    calculateRules: Array.isArray(data.calculateRules) ? data.calculateRules : undefined,
    includeKeywords: Array.isArray(data.includeKeywords) ? data.includeKeywords.filter((s: any) => typeof s === 'string') : undefined,
    excludePatterns: Array.isArray(data.excludePatterns) ? data.excludePatterns.filter((s: any) => typeof s === 'string') : undefined,
    agreementKeywords: Array.isArray(data.agreementKeywords) ? data.agreementKeywords.filter((s: any) => typeof s === 'string') : undefined,
    inputExcludeKeywords: Array.isArray(data.inputExcludeKeywords) ? data.inputExcludeKeywords.filter((s: any) => typeof s === 'string') : undefined,
    agreementSelectors: Array.isArray(data.agreementSelectors) ? data.agreementSelectors.filter((s: any) => typeof s === 'string') : undefined,
    siteBlacklist: Array.isArray(data.siteBlacklist) ? data.siteBlacklist.filter((s: any) => typeof s === 'string') : undefined,
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
  };
  return { valid: true, pkg };
}

/**
 * 从 URL 拉取订阅规则包并解析
 */
export async function fetchRulePackage(
  url: string,
  fetcher: SubscriptionFetcher,
  timeout = SUBSCRIPTION_TIMEOUT
): Promise<SubscriptionRulePackage> {
  const text = await fetcher.fetch(url, timeout);
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error('订阅内容不是有效的 JSON: ' + (e as Error).message);
  }
  const result = validateRulePackage(data);
  if (!result.valid) {
    throw new Error(result.error || '订阅格式错误');
  }
  return result.pkg!;
}

/**
 * 生成订阅 ID
 */
export function generateSubscriptionId(): string {
  return 'sub_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

/**
 * 应用订阅规则包到现有配置/规则中（合并）。
 *
 * 策略：
 * - 关键词类：合并到 customIncludeKeywords / customExcludePatterns 等（去重）
 * - 站点规则：以订阅的 key 为准插入到 siteRules（标记 source 为订阅 ID）
 * - 计算规则：追加到 calculateRules（按 pattern 去重）
 * - 协议选择器、黑名单：合并去重
 *
 * 注意：本函数返回合并后的"差异"，由调用方写入存储。
 */
export interface ApplyMergeResult {
  /** 要追加到 customIncludeKeywords 的新关键词（去重后） */
  includeKeywordsToAdd: string[];
  excludePatternsToAdd: string[];
  agreementKeywordsToAdd: string[];
  inputExcludeKeywordsToAdd: string[];
  agreementSelectorsToAdd: string[];
  siteBlacklistToAdd: string[];
  /** 站点规则：key -> rule（覆盖式写入） */
  siteRulesToWrite: Array<{ key: string; rule: Omit<SiteRule, 'createdAt' | 'updatedAt' | 'enabled'> & { hostname: string; subscriptionId?: string } }>;
  /** 计算规则：要追加（按 pattern 去重） */
  calculateRulesToAdd: CalculateRule[];
}

export function computeMerge(
  pkg: SubscriptionRulePackage,
  current: {
    customIncludeKeywords: string[];
    customExcludePatterns: string[];
    customAgreementKeywords: string[];
    customInputExcludeKeywords: string[];
    agreementSelectors: string[];
    siteBlacklist: string[];
    calculateRules: CalculateRule[];
    siteRulesKeys: string[];
  },
  subscriptionId: string
): ApplyMergeResult {
  const dedup = (existing: string[], incoming: string[] | undefined): string[] => {
    if (!incoming) return [];
    const lower = new Set(existing.map((s) => s.toLowerCase()));
    return incoming.filter((s) => {
      const k = s.toLowerCase();
      if (lower.has(k)) return false;
      lower.add(k);
      return true;
    });
  };

  const calcRulesToAdd: CalculateRule[] = [];
  if (pkg.calculateRules) {
    const existingPatterns = new Set(current.calculateRules.map((r) => r.pattern + '::' + r.matchType));
    for (const rule of pkg.calculateRules) {
      const sig = rule.pattern + '::' + rule.matchType;
      if (!existingPatterns.has(sig)) {
        calcRulesToAdd.push(rule);
        existingPatterns.add(sig);
      }
    }
  }

  const siteRulesToWrite: ApplyMergeResult['siteRulesToWrite'] = [];
  if (pkg.siteRules) {
    for (const [key, rule] of Object.entries(pkg.siteRules)) {
      siteRulesToWrite.push({
        key,
        rule: {
          ...rule,
          hostname: rule.hostname || key,
          subscriptionId,
        } as any,
      });
    }
  }

  return {
    includeKeywordsToAdd: dedup(current.customIncludeKeywords, pkg.includeKeywords),
    excludePatternsToAdd: dedup(current.customExcludePatterns, pkg.excludePatterns),
    agreementKeywordsToAdd: dedup(current.customAgreementKeywords, pkg.agreementKeywords),
    inputExcludeKeywordsToAdd: dedup(current.customInputExcludeKeywords, pkg.inputExcludeKeywords),
    agreementSelectorsToAdd: dedup(current.agreementSelectors, pkg.agreementSelectors),
    siteBlacklistToAdd: dedup(current.siteBlacklist, pkg.siteBlacklist),
    siteRulesToWrite,
    calculateRulesToAdd: calcRulesToAdd,
  };
}

/**
 * 检查订阅是否需要更新
 */
export function shouldUpdate(sub: Subscription): boolean {
  if (!sub.enabled) return false;
  if (sub.updateInterval <= 0) return false;
  if (sub.lastStatus === 'never' || sub.lastStatus === 'error') return true;
  const elapsed = Date.now() - sub.lastUpdated;
  return elapsed >= sub.updateInterval * 3600 * 1000;
}

/**
 * 检查订阅 URL 格式
 */
export function isValidSubscriptionUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
