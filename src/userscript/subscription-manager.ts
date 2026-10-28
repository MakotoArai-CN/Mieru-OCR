import type { Subscription, SubscriptionRulePackage, SubscriptionFetcher } from '@core/subscription';
import { fetchRulePackage, generateSubscriptionId, shouldUpdate, isValidSubscriptionUrl } from '@core/subscription';
import { reconcileSubscriptionRules } from '@core/subscription-rules';
import { getConfig, saveConfig, getSiteRules, saveSiteRules } from './storage';

const SUBSCRIPTIONS_KEY = 'ddddocr_subscriptions';
const STATE_KEY = 'ddddocr_subscription_rule_state';
const refreshing = new Map<string, Promise<{ success: boolean; error?: string; pkg?: SubscriptionRulePackage }>>();

const gmFetcher: SubscriptionFetcher = {
  fetch(url, timeout = 30000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout, headers: { Accept: 'application/json' },
        onload: resp => resp.status >= 200 && resp.status < 300
          ? resolve(resp.responseText) : reject(new Error(`HTTP ${resp.status}`)),
        onerror: () => reject(new Error('网络请求失败')),
        ontimeout: () => reject(new Error('请求超时')),
      });
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
  return getSubscriptions().find(sub => sub.id === id);
}

function commit(oldSubs: Subscription[], subs: Subscription[], retainId?: string): void {
  const state = reconcileSubscriptionRules(getConfig(), getSiteRules(), GM_getValue(STATE_KEY), oldSubs, subs, retainId);
  saveConfig(state.applied.settings);
  saveSiteRules(state.applied.siteRules);
  GM_setValue(STATE_KEY, state);
  saveSubscriptions(subs);
}

export function addSubscription(input: { url: string; name?: string; updateInterval?: number }): Subscription {
  if (!isValidSubscriptionUrl(input.url)) throw new Error('无效的 URL');
  const subs = getSubscriptions();
  if (subs.some(sub => sub.url === input.url)) throw new Error('该订阅已存在');
  const sub: Subscription = {
    id: generateSubscriptionId(), url: input.url, name: input.name || input.url, enabled: true,
    updateInterval: input.updateInterval ?? 24, lastUpdated: 0, lastStatus: 'never', createdAt: Date.now(),
  };
  saveSubscriptions([...subs, sub]);
  return sub;
}

export function deleteSubscription(id: string, removeRules = true): void {
  const subs = getSubscriptions();
  if (!subs.some(sub => sub.id === id)) return;
  commit(subs, subs.filter(sub => sub.id !== id), removeRules ? undefined : id);
}

export function updateSubscriptionMeta(id: string, patch: Partial<Subscription>): void {
  const subs = getSubscriptions();
  if (!subs.some(sub => sub.id === id)) return;
  const next = subs.map(sub => sub.id === id ? { ...sub, ...patch } : sub);
  if ('enabled' in patch || 'cachedPackage' in patch) commit(subs, next);
  else saveSubscriptions(next);
}

export function refreshSubscription(id: string): Promise<{ success: boolean; error?: string; pkg?: SubscriptionRulePackage }> {
  const existing = refreshing.get(id);
  if (existing) return existing;
  const request = refresh(id).finally(() => refreshing.delete(id));
  refreshing.set(id, request);
  return request;
}

async function refresh(id: string): Promise<{ success: boolean; error?: string; pkg?: SubscriptionRulePackage }> {
  const sub = getSubscription(id);
  if (!sub) return { success: false, error: '订阅不存在' };
  updateSubscriptionMeta(id, { lastStatus: 'pending' });
  try {
    const pkg = await fetchRulePackage(sub.url, gmFetcher);
    // A user may delete or edit a subscription while its request is in flight.
    const subs = getSubscriptions();
    const current = subs.find(item => item.id === id);
    if (!current || current.url !== sub.url) return { success: false, error: '订阅已变更' };
    commit(subs, subs.map(item => item.id === id ? {
      ...item, lastStatus: 'success', lastUpdated: Date.now(), lastError: undefined,
      cachedPackage: pkg, name: item.name === item.url ? pkg.name : item.name,
    } : item));
    return { success: true, pkg };
  } catch (error) {
    const message = (error as Error).message || String(error);
    updateSubscriptionMeta(id, { lastStatus: 'error', lastError: message, lastUpdated: Date.now() });
    return { success: false, error: message };
  }
}

export async function autoUpdateSubscriptions(): Promise<void> {
  for (const sub of getSubscriptions()) {
    if (shouldUpdate(sub)) await refreshSubscription(sub.id);
  }
}
