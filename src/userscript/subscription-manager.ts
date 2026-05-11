import type { Subscription, SubscriptionRulePackage, SubscriptionFetcher } from '@core/subscription';
import {
  fetchRulePackage,
  generateSubscriptionId,
  computeMerge,
  shouldUpdate as shouldUpdateSub,
  isValidSubscriptionUrl,
} from '@core/subscription';
import { Logger } from '@core/config';
import type { CalculateRule, SiteRule } from '@core/types';
import { getConfig, saveConfig, getSiteRules, saveSiteRule, deleteSiteRule } from './storage';

const SUBSCRIPTIONS_KEY = 'ddddocr_subscriptions';

declare const GM_xmlhttpRequest: any;

/**
 * GM_xmlhttpRequest fetcher（绕过 CORS）
 */
const gmFetcher: SubscriptionFetcher = {
  fetch(url: string, timeout = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          timeout,
          headers: { 'Accept': 'application/json' },
          onload: (resp: any) => {
            if (resp.status >= 200 && resp.status < 300) {
              resolve(resp.responseText);
            } else {
              reject(new Error(`HTTP ${resp.status}`));
            }
          },
          onerror: () => reject(new Error('网络请求失败')),
          ontimeout: () => reject(new Error('请求超时')),
        });
      } catch (e) {
        reject(e);
      }
    });
  },
};

export function getSubscriptions(): Subscription[] {
  return GM_getValue(SUBSCRIPTIONS_KEY) || [];
}

export function saveSubscriptions(subs: Subscription[]): void {
  GM_setValue(SUBSCRIPTIONS_KEY, subs);
}

export function getSubscription(id: string): Subscription | undefined {
  return getSubscriptions().find((s) => s.id === id);
}

export function addSubscription(input: { url: string; name?: string; updateInterval?: number }): Subscription {
  if (!isValidSubscriptionUrl(input.url)) {
    throw new Error('无效的 URL');
  }
  const subs = getSubscriptions();
  if (subs.some((s) => s.url === input.url)) {
    throw new Error('该订阅已存在');
  }
  const sub: Subscription = {
    id: generateSubscriptionId(),
    url: input.url,
    name: input.name || input.url,
    enabled: true,
    updateInterval: input.updateInterval ?? 24,
    lastUpdated: 0,
    lastStatus: 'never',
    createdAt: Date.now(),
  };
  subs.push(sub);
  saveSubscriptions(subs);
  return sub;
}

export function deleteSubscription(id: string, removeRules = true): void {
  const subs = getSubscriptions();
  const sub = subs.find((s) => s.id === id);
  if (!sub) return;

  if (removeRules && sub.cachedPackage) {
    removeAppliedRules(sub.id, sub.cachedPackage);
  }

  saveSubscriptions(subs.filter((s) => s.id !== id));
}

export function updateSubscriptionMeta(id: string, patch: Partial<Subscription>): void {
  const subs = getSubscriptions();
  const idx = subs.findIndex((s) => s.id === id);
  if (idx < 0) return;
  subs[idx] = { ...subs[idx], ...patch };
  saveSubscriptions(subs);
}

/**
 * 拉取并应用订阅
 */
export async function refreshSubscription(id: string): Promise<{ success: boolean; error?: string; pkg?: SubscriptionRulePackage }> {
  const subs = getSubscriptions();
  const idx = subs.findIndex((s) => s.id === id);
  if (idx < 0) return { success: false, error: '订阅不存在' };
  const sub = subs[idx];

  updateSubscriptionMeta(id, { lastStatus: 'pending' });

  try {
    const pkg = await fetchRulePackage(sub.url, gmFetcher);

    // 先移除旧规则（如有缓存）
    if (sub.cachedPackage) {
      removeAppliedRules(sub.id, sub.cachedPackage);
    }

    // 合并并写入
    applyRulePackage(sub.id, pkg);

    updateSubscriptionMeta(id, {
      lastStatus: 'success',
      lastUpdated: Date.now(),
      lastError: undefined,
      cachedPackage: pkg,
      name: sub.name === sub.url ? pkg.name : sub.name, // 首次更新时用规则包名替换 URL
    });

    Logger.info('订阅更新成功:', sub.url, pkg.name);
    return { success: true, pkg };
  } catch (e) {
    const error = (e as Error).message || String(e);
    updateSubscriptionMeta(id, {
      lastStatus: 'error',
      lastError: error,
      lastUpdated: Date.now(),
    });
    Logger.error('订阅更新失败:', sub.url, error);
    return { success: false, error };
  }
}

/**
 * 将规则包应用到当前配置/规则
 */
function applyRulePackage(subId: string, pkg: SubscriptionRulePackage): void {
  const config = getConfig();
  const siteRules = getSiteRules();

  const merge = computeMerge(
    pkg,
    {
      customIncludeKeywords: config.customIncludeKeywords || [],
      customExcludePatterns: config.customExcludePatterns || [],
      customAgreementKeywords: config.customAgreementKeywords || [],
      customInputExcludeKeywords: config.customInputExcludeKeywords || [],
      agreementSelectors: config.agreementSelectors || [],
      siteBlacklist: config.siteBlacklist || [],
      calculateRules: config.calculateRules || [],
      siteRulesKeys: Object.keys(siteRules),
    },
    subId
  );

  // 应用关键词类
  const updates: Partial<typeof config> = {};
  if (merge.includeKeywordsToAdd.length) {
    updates.customIncludeKeywords = [...(config.customIncludeKeywords || []), ...merge.includeKeywordsToAdd];
  }
  if (merge.excludePatternsToAdd.length) {
    updates.customExcludePatterns = [...(config.customExcludePatterns || []), ...merge.excludePatternsToAdd];
  }
  if (merge.agreementKeywordsToAdd.length) {
    updates.customAgreementKeywords = [...(config.customAgreementKeywords || []), ...merge.agreementKeywordsToAdd];
  }
  if (merge.inputExcludeKeywordsToAdd.length) {
    updates.customInputExcludeKeywords = [...(config.customInputExcludeKeywords || []), ...merge.inputExcludeKeywordsToAdd];
  }
  if (merge.agreementSelectorsToAdd.length) {
    updates.agreementSelectors = [...(config.agreementSelectors || []), ...merge.agreementSelectorsToAdd];
  }
  if (merge.siteBlacklistToAdd.length) {
    updates.siteBlacklist = [...(config.siteBlacklist || []), ...merge.siteBlacklistToAdd];
  }
  if (merge.calculateRulesToAdd.length) {
    updates.calculateRules = [...(config.calculateRules || []), ...merge.calculateRulesToAdd];
  }
  if (Object.keys(updates).length) saveConfig(updates);

  // 应用站点规则
  for (const { key, rule } of merge.siteRulesToWrite) {
    saveSiteRule(rule.hostname || key, {
      ...rule,
      enabled: true,
    } as Partial<SiteRule>);
  }
}

/**
 * 从配置/规则中移除某订阅的规则
 */
function removeAppliedRules(subId: string, pkg: SubscriptionRulePackage): void {
  const config = getConfig();
  const lower = (s: string) => s.toLowerCase();

  const removeFromList = (current: string[] | undefined, toRemove: string[] | undefined): string[] | undefined => {
    if (!current || !toRemove || !toRemove.length) return current;
    const removeSet = new Set(toRemove.map(lower));
    return current.filter((s) => !removeSet.has(lower(s)));
  };

  const updates: Partial<typeof config> = {};
  if (pkg.includeKeywords) updates.customIncludeKeywords = removeFromList(config.customIncludeKeywords, pkg.includeKeywords);
  if (pkg.excludePatterns) updates.customExcludePatterns = removeFromList(config.customExcludePatterns, pkg.excludePatterns);
  if (pkg.agreementKeywords) updates.customAgreementKeywords = removeFromList(config.customAgreementKeywords, pkg.agreementKeywords);
  if (pkg.inputExcludeKeywords) updates.customInputExcludeKeywords = removeFromList(config.customInputExcludeKeywords, pkg.inputExcludeKeywords);
  if (pkg.agreementSelectors) updates.agreementSelectors = removeFromList(config.agreementSelectors, pkg.agreementSelectors);
  if (pkg.siteBlacklist) updates.siteBlacklist = removeFromList(config.siteBlacklist, pkg.siteBlacklist);
  if (pkg.calculateRules) {
    const removeSigs = new Set(pkg.calculateRules.map((r) => r.pattern + '::' + r.matchType));
    updates.calculateRules = (config.calculateRules || []).filter((r: CalculateRule) => !removeSigs.has(r.pattern + '::' + r.matchType));
  }
  if (Object.keys(updates).length) saveConfig(updates);

  // 删除站点规则
  if (pkg.siteRules) {
    for (const key of Object.keys(pkg.siteRules)) {
      deleteSiteRule(key);
    }
  }
}

/**
 * 检查所有订阅，按需自动更新
 */
export async function autoUpdateSubscriptions(): Promise<void> {
  const subs = getSubscriptions();
  for (const sub of subs) {
    if (shouldUpdateSub(sub)) {
      Logger.info('自动更新订阅:', sub.url);
      await refreshSubscription(sub.id);
    }
  }
}
