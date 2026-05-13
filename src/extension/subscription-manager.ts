import type { Subscription, SubscriptionRulePackage, SubscriptionFetcher } from '@core/subscription';
import {
  fetchRulePackage,
  generateSubscriptionId,
  computeMerge,
  isValidSubscriptionUrl,
  shouldUpdate as shouldUpdateSub,
} from '@core/subscription';
import type { CalculateRule } from '@core/types';

const SUBSCRIPTIONS_KEY = 'subscriptions';

declare const chrome: any;
declare const browser: any;

let cachedStorage: any = null;

// Lazy storage shim — defers global access until first use. Prefer Firefox's Promise-based
// browser.storage in Firefox builds, then fall back to chrome.storage for Chromium.
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
  const diag = {
    hasChrome: typeof chrome !== 'undefined',
    hasBrowser: typeof browser !== 'undefined',
    chromeStorage: typeof chrome !== 'undefined' && !!(chrome as any)?.storage,
  };
  throw new Error('No browser storage available; diag=' + JSON.stringify(diag));
}

const storage = {
  get(key: string | string[]): Promise<any> {
    return getStorage().get(key);
  },
  set(items: Record<string, any>): Promise<void> {
    return getStorage().set(items);
  },
};

/**
 * 用 fetch() 实现拉取（扩展有 host_permissions: <all_urls>）
 */
const extensionFetcher: SubscriptionFetcher = {
  async fetch(url: string, timeout = 30000): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: ctrl.signal,
        cache: 'no-cache',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } finally {
      clearTimeout(timer);
    }
  },
};

export async function getSubscriptions(): Promise<Subscription[]> {
  const result = await storage.get(SUBSCRIPTIONS_KEY);
  return result[SUBSCRIPTIONS_KEY] || [];
}

export async function saveSubscriptions(subs: Subscription[]): Promise<void> {
  await storage.set({ [SUBSCRIPTIONS_KEY]: subs });
}

export async function addSubscription(input: { url: string; name?: string; updateInterval?: number }): Promise<Subscription> {
  if (!isValidSubscriptionUrl(input.url)) throw new Error('Invalid URL');
  const subs = await getSubscriptions();
  if (subs.some((s) => s.url === input.url)) throw new Error('Subscription already exists');
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
  await saveSubscriptions(subs);
  return sub;
}

export async function deleteSubscription(id: string, removeRules = true): Promise<void> {
  const subs = await getSubscriptions();
  const sub = subs.find((s) => s.id === id);
  if (!sub) return;
  if (removeRules && sub.cachedPackage) {
    await removeAppliedRules(sub.cachedPackage);
  }
  await saveSubscriptions(subs.filter((s) => s.id !== id));
}

export async function updateSubscriptionMeta(id: string, patch: Partial<Subscription>): Promise<void> {
  const subs = await getSubscriptions();
  const idx = subs.findIndex((s) => s.id === id);
  if (idx < 0) return;
  subs[idx] = { ...subs[idx], ...patch };
  await saveSubscriptions(subs);
}

export async function refreshSubscription(
  id: string
): Promise<{ success: boolean; error?: string; pkg?: SubscriptionRulePackage }> {
  const subs = await getSubscriptions();
  const sub = subs.find((s) => s.id === id);
  if (!sub) return { success: false, error: 'Subscription not found' };

  await updateSubscriptionMeta(id, { lastStatus: 'pending' });

  try {
    const pkg = await fetchRulePackage(sub.url, extensionFetcher);

    if (sub.cachedPackage) {
      await removeAppliedRules(sub.cachedPackage);
    }
    await applyRulePackage(sub.id, pkg);

    await updateSubscriptionMeta(id, {
      lastStatus: 'success',
      lastUpdated: Date.now(),
      lastError: undefined,
      cachedPackage: pkg,
      name: sub.name === sub.url ? pkg.name : sub.name,
    });
    return { success: true, pkg };
  } catch (e) {
    const error = (e as Error).message || String(e);
    await updateSubscriptionMeta(id, {
      lastStatus: 'error',
      lastError: error,
      lastUpdated: Date.now(),
    });
    return { success: false, error };
  }
}

async function applyRulePackage(subId: string, pkg: SubscriptionRulePackage): Promise<void> {
  const settingsResult = await storage.get('settings');
  const siteRulesResult = await storage.get('siteRules');
  const settings = settingsResult.settings || {};
  const siteRules = siteRulesResult.siteRules || {};

  const merge = computeMerge(
    pkg,
    {
      customIncludeKeywords: settings.customIncludeKeywords || [],
      customExcludePatterns: settings.customExcludePatterns || [],
      customAgreementKeywords: settings.customAgreementKeywords || [],
      customInputExcludeKeywords: settings.customInputExcludeKeywords || [],
      agreementSelectors: settings.agreementSelectors || [],
      siteBlacklist: settings.siteBlacklist || [],
      calculateRules: settings.calculateRules || [],
      siteRulesKeys: Object.keys(siteRules),
    },
    subId
  );

  if (merge.includeKeywordsToAdd.length) settings.customIncludeKeywords = [...(settings.customIncludeKeywords || []), ...merge.includeKeywordsToAdd];
  if (merge.excludePatternsToAdd.length) settings.customExcludePatterns = [...(settings.customExcludePatterns || []), ...merge.excludePatternsToAdd];
  if (merge.agreementKeywordsToAdd.length) settings.customAgreementKeywords = [...(settings.customAgreementKeywords || []), ...merge.agreementKeywordsToAdd];
  if (merge.inputExcludeKeywordsToAdd.length) settings.customInputExcludeKeywords = [...(settings.customInputExcludeKeywords || []), ...merge.inputExcludeKeywordsToAdd];
  if (merge.agreementSelectorsToAdd.length) settings.agreementSelectors = [...(settings.agreementSelectors || []), ...merge.agreementSelectorsToAdd];
  if (merge.siteBlacklistToAdd.length) settings.siteBlacklist = [...(settings.siteBlacklist || []), ...merge.siteBlacklistToAdd];
  if (merge.calculateRulesToAdd.length) settings.calculateRules = [...(settings.calculateRules || []), ...merge.calculateRulesToAdd];

  for (const { key, rule } of merge.siteRulesToWrite) {
    siteRules[key] = {
      ...rule,
      hostname: rule.hostname || key,
      enabled: true,
      createdAt: siteRules[key]?.createdAt || Date.now(),
      updatedAt: Date.now(),
      subscriptionId: subId,
    };
  }

  await storage.set({ settings, siteRules });
}

async function removeAppliedRules(pkg: SubscriptionRulePackage): Promise<void> {
  const settingsResult = await storage.get('settings');
  const siteRulesResult = await storage.get('siteRules');
  const settings = settingsResult.settings || {};
  const siteRules = siteRulesResult.siteRules || {};

  const lower = (s: string) => s.toLowerCase();
  const removeFromList = (current: string[] | undefined, toRemove: string[] | undefined): string[] | undefined => {
    if (!current || !toRemove || !toRemove.length) return current;
    const set = new Set(toRemove.map(lower));
    return current.filter((s) => !set.has(lower(s)));
  };

  if (pkg.includeKeywords) settings.customIncludeKeywords = removeFromList(settings.customIncludeKeywords, pkg.includeKeywords);
  if (pkg.excludePatterns) settings.customExcludePatterns = removeFromList(settings.customExcludePatterns, pkg.excludePatterns);
  if (pkg.agreementKeywords) settings.customAgreementKeywords = removeFromList(settings.customAgreementKeywords, pkg.agreementKeywords);
  if (pkg.inputExcludeKeywords) settings.customInputExcludeKeywords = removeFromList(settings.customInputExcludeKeywords, pkg.inputExcludeKeywords);
  if (pkg.agreementSelectors) settings.agreementSelectors = removeFromList(settings.agreementSelectors, pkg.agreementSelectors);
  if (pkg.siteBlacklist) settings.siteBlacklist = removeFromList(settings.siteBlacklist, pkg.siteBlacklist);
  if (pkg.calculateRules) {
    const sigs = new Set(pkg.calculateRules.map((r) => r.pattern + '::' + r.matchType));
    settings.calculateRules = (settings.calculateRules || []).filter(
      (r: CalculateRule) => !sigs.has(r.pattern + '::' + r.matchType)
    );
  }

  if (pkg.siteRules) {
    for (const key of Object.keys(pkg.siteRules)) {
      delete siteRules[key];
    }
  }

  await storage.set({ settings, siteRules });
}

/**
 * 检查并自动更新到期的订阅（service worker 调用）
 */
export async function autoUpdateSubscriptions(): Promise<{ updated: number; failed: number }> {
  const subs = await getSubscriptions();
  let updated = 0, failed = 0;
  for (const sub of subs) {
    if (shouldUpdateSub(sub)) {
      const result = await refreshSubscription(sub.id);
      if (result.success) updated++;
      else failed++;
    }
  }
  return { updated, failed };
}
