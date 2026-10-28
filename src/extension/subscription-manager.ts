import type { Subscription, SubscriptionRulePackage, SubscriptionFetcher } from '@core/subscription';
import { fetchRulePackage, generateSubscriptionId, isValidSubscriptionUrl, shouldUpdate } from '@core/subscription';
import { reconcileSubscriptionRules } from '@core/subscription-rules';
import { getDetModelMeta, clearDetModel } from './model-store';
import { storage } from './platform';

const SUBSCRIPTIONS_KEY = 'subscriptions';
const STATE_KEY = 'subscriptionRuleState';
let pending: Promise<unknown> = Promise.resolve();

async function locked<T>(task: () => Promise<T>): Promise<T> {
  // Web Locks also serialize the options page and background page/service worker.
  if (globalThis.navigator?.locks) return await navigator.locks.request('mieru-subscriptions', task);
  const result = pending.then(task, task);
  pending = result.catch(() => {});
  return result;
}

const extensionFetcher: SubscriptionFetcher = {
  async fetch(url, timeout = 30000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const resp = await fetch(url, {
        headers: { Accept: 'application/json' }, signal: ctrl.signal, cache: 'no-cache',
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

async function commit(oldSubs: Subscription[], subs: Subscription[], retainId?: string): Promise<void> {
  const current = await storage.get(['settings', 'siteRules', STATE_KEY]);
  const state = reconcileSubscriptionRules(current.settings || {}, current.siteRules || {}, current[STATE_KEY], oldSubs, subs, retainId);
  await storage.set({
    settings: { ...current.settings, ...state.applied.settings },
    siteRules: state.applied.siteRules,
    [SUBSCRIPTIONS_KEY]: subs,
    [STATE_KEY]: state,
  });
}

export function addSubscription(input: { url: string; name?: string; updateInterval?: number }): Promise<Subscription> {
  return locked(async () => {
    if (!isValidSubscriptionUrl(input.url)) throw new Error('Invalid URL');
    const subs = await getSubscriptions();
    if (subs.some(sub => sub.url === input.url)) throw new Error('Subscription already exists');
    const sub: Subscription = {
      id: generateSubscriptionId(), url: input.url, name: input.name || input.url,
      enabled: true, updateInterval: input.updateInterval ?? 24,
      lastUpdated: 0, lastStatus: 'never', createdAt: Date.now(),
    };
    await saveSubscriptions([...subs, sub]);
    return sub;
  });
}

export function deleteSubscription(id: string, removeRules = true): Promise<void> {
  return locked(async () => {
    const subs = await getSubscriptions();
    const sub = subs.find(item => item.id === id);
    if (!sub) return;
    await commit(subs, subs.filter(item => item.id !== id), removeRules ? undefined : id);
    if (removeRules && sub.cachedPackage?.detModel) {
      const meta = await getDetModelMeta();
      if (meta?.source === 'subscription' && !subs.some(item => item.id !== id && item.enabled && item.cachedPackage?.detModel)) {
        await clearDetModel();
      }
    }
  });
}

export function updateSubscriptionMeta(id: string, patch: Partial<Subscription>): Promise<void> {
  return locked(async () => {
    const subs = await getSubscriptions();
    if (!subs.some(sub => sub.id === id)) return;
    const next = subs.map(sub => sub.id === id ? { ...sub, ...patch } : sub);
    if ('enabled' in patch || 'cachedPackage' in patch) await commit(subs, next);
    else await saveSubscriptions(next);
  });
}

export function refreshSubscription(id: string): Promise<{ success: boolean; error?: string; pkg?: SubscriptionRulePackage }> {
  return locked(async () => {
    const subs = await getSubscriptions();
    const sub = subs.find(item => item.id === id);
    if (!sub) return { success: false, error: 'Subscription not found' };
    await saveSubscriptions(subs.map(item => item.id === id ? { ...item, lastStatus: 'pending' } : item));
    try {
      const pkg = await fetchRulePackage(sub.url, extensionFetcher);
      const next = subs.map(item => item.id === id ? {
        ...item, lastStatus: 'success' as const, lastUpdated: Date.now(), lastError: undefined,
        cachedPackage: pkg, name: item.name === item.url ? pkg.name : item.name,
      } : item);
      await commit(subs, next);
      return { success: true, pkg };
    } catch (error) {
      const message = (error as Error).message || String(error);
      await saveSubscriptions(subs.map(item => item.id === id ? {
        ...item, lastStatus: 'error', lastError: message, lastUpdated: Date.now(),
      } : item));
      return { success: false, error: message };
    }
  });
}

export async function autoUpdateSubscriptions(): Promise<{ updated: number; failed: number }> {
  let updated = 0, failed = 0;
  for (const sub of await getSubscriptions()) {
    if (!shouldUpdate(sub)) continue;
    const result = await refreshSubscription(sub.id);
    if (result.success) updated++;
    else failed++;
  }
  return { updated, failed };
}
