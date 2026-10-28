import { afterAll, beforeEach, expect, test } from 'bun:test';

let state: Record<string, any> = {};
let failWrite = false;
let response: any;
const originalChrome = (globalThis as any).chrome;
const originalFetch = globalThis.fetch;
(globalThis as any).chrome = { storage: { local: {
  async get(keys: string | string[]) {
    return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, state[key]])));
  },
  async set(items: any) {
    if (failWrite && items.subscriptionRuleState) { failWrite = false; throw new Error('Storage failed'); }
    Object.assign(state, structuredClone(items));
  },
} } };
const manager = await import('../src/extension/subscription-manager');

beforeEach(() => {
  state = { settings: { customIncludeKeywords: ['manual'] }, siteRules: {}, subscriptions: [] };
  failWrite = false;
  response = { name: 'rules', version: '1', includeKeywords: ['shared'], siteRules: { login: { hostname: 'example.test', selector: '#captcha' } } };
  globalThis.fetch = (async () => new Response(JSON.stringify(response))) as typeof fetch;
});
afterAll(() => {
  (globalThis as any).chrome = originalChrome;
  globalThis.fetch = originalFetch;
});

test('concurrent additions and updates do not lose subscriptions', async () => {
  const [a, b] = await Promise.all([
    manager.addSubscription({ url: 'https://example.test/a' }),
    manager.addSubscription({ url: 'https://example.test/b' }),
  ]);
  const results = await Promise.all([manager.refreshSubscription(a.id), manager.refreshSubscription(b.id)]);
  expect(results.every(result => result.success)).toBe(true);
  expect((await manager.getSubscriptions()).length).toBe(2);
  await manager.deleteSubscription(a.id);
  expect(state.siteRules.login.subscriptionId).toBe(b.id);
  expect(state.settings.customIncludeKeywords).toEqual(['manual', 'shared']);
  await manager.deleteSubscription(b.id);
  expect(state.siteRules).toEqual({});
  expect(state.settings.customIncludeKeywords).toEqual(['manual']);
});

test('failed refresh commits leave the last working configuration intact', async () => {
  const sub = await manager.addSubscription({ url: 'https://example.test/a' });
  await manager.refreshSubscription(sub.id);
  const before = structuredClone({ settings: state.settings, siteRules: state.siteRules, ruleState: state.subscriptionRuleState });
  response = { name: 'rules', version: '2', includeKeywords: ['replacement'] };
  failWrite = true;
  expect((await manager.refreshSubscription(sub.id)).success).toBe(false);
  expect({ settings: state.settings, siteRules: state.siteRules, ruleState: state.subscriptionRuleState }).toEqual(before);
  expect((await manager.getSubscriptions())[0].cachedPackage?.version).toBe('1');
});

test('subscription enabled switch applies and rolls back cached rules', async () => {
  const sub = await manager.addSubscription({ url: 'https://example.test/a' });
  await manager.refreshSubscription(sub.id);
  await manager.updateSubscriptionMeta(sub.id, { enabled: false });
  expect(state.siteRules).toEqual({});
  await manager.updateSubscriptionMeta(sub.id, { enabled: true });
  expect(state.siteRules.login.selector).toBe('#captcha');
});
