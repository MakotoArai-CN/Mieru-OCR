import { describe, expect, test } from 'bun:test';
import { reconcileSubscriptionRules as reconcile, type SubscriptionRuleState, type SiteRules } from '../src/core/subscription-rules';
import type { Subscription } from '../src/core/subscription';

const rule = (selector: string) => ({ hostname: 'example.test', selector, enabled: true, createdAt: 1, updatedAt: 1 });
const subscription = (id: string, selector = '#' + id): Subscription => ({
  id, url: 'https://example.test/' + id, name: id, enabled: true,
  updateInterval: 24, lastUpdated: 10, lastStatus: 'success', createdAt: 1,
  cachedPackage: { name: id, version: '1', includeKeywords: ['shared', id], siteRules: { login: rule(selector) } },
});
function update(state: SubscriptionRuleState, old: Subscription[], next: Subscription[], retainId?: string) {
  return reconcile(state.applied.settings, state.applied.siteRules, state, old, next, retainId);
}

describe('subscription ownership', () => {
  test('keeps manual rules and keywords through refresh and deletion', () => {
    const a = subscription('a');
    let state = reconcile({ customIncludeKeywords: ['shared'] }, { login: rule('#manual') }, undefined, [], [a]);
    expect(state.applied.siteRules.login.selector).toBe('#manual');
    state = update(state, [a], []);
    expect(state.applied.siteRules.login.selector).toBe('#manual');
    expect(state.applied.settings.customIncludeKeywords).toEqual(['shared']);
  });

  test('removing either overlapping subscription preserves the other', () => {
    const a = subscription('a'), b = subscription('b');
    const state = reconcile({}, {}, undefined, [], [a, b]);
    const withoutA = update(state, [a, b], [b]);
    expect(withoutA.applied.siteRules.login.subscriptionId).toBe('b');
    expect(withoutA.applied.settings.customIncludeKeywords).toEqual(['shared', 'b']);
    const withoutB = update(state, [a, b], [a]);
    expect(withoutB.applied.siteRules.login.subscriptionId).toBe('a');
    expect(withoutB.applied.settings.customIncludeKeywords).toEqual(['shared', 'a']);
    expect(update(withoutB, [a], []).applied.siteRules).toEqual({});
  });

  test('preserves manual edits made after subscription installation', () => {
    const a = subscription('a');
    const state = reconcile({}, {}, undefined, [], [a]);
    const edited: SiteRules = { login: { ...state.applied.siteRules.login, selector: '#edited' } };
    const next = reconcile({ customIncludeKeywords: ['shared', 'a', 'manual'] }, edited, state, [a], []);
    expect(next.applied.siteRules.login.selector).toBe('#edited');
    expect(next.applied.siteRules.login.subscriptionId).toBeUndefined();
    expect(next.applied.settings.customIncludeKeywords).toEqual(['manual']);
  });

  test('disabling and reenabling restores only active subscriptions', () => {
    const a = subscription('a'), off = { ...a, enabled: false };
    const state = reconcile({}, {}, undefined, [], [a]);
    const disabled = update(state, [a], [off]);
    expect(disabled.applied.siteRules).toEqual({});
    expect(disabled.applied.settings.customIncludeKeywords).toEqual([]);
    expect(update(disabled, [off], [a]).applied.siteRules.login.selector).toBe('#a');
  });

  test('refresh removes obsolete contributions without removing manual ones', () => {
    const a = subscription('a');
    const state = reconcile({ customIncludeKeywords: ['manual'] }, {}, undefined, [], [a]);
    const refreshed = { ...a, cachedPackage: { name: 'a', version: '2', includeKeywords: ['new'] } };
    const next = update(state, [a], [refreshed]);
    expect(next.applied.settings.customIncludeKeywords).toEqual(['manual', 'new']);
    expect(next.applied.siteRules).toEqual({});
  });

  test('legacy migration preserves ambiguous lists and removes attributed rules', () => {
    const a = subscription('a');
    const state = reconcile({ customIncludeKeywords: ['shared'] }, { login: { ...rule('#a'), subscriptionId: 'a' } }, undefined, [a], []);
    expect(state.applied.settings.customIncludeKeywords).toEqual(['shared']);
    expect(state.applied.siteRules).toEqual({});
  });

  test('keep rules converts removed subscription contributions to manual rules', () => {
    const a = subscription('a');
    const state = reconcile({}, {}, undefined, [], [a]);
    const kept = update(state, [a], [], 'a');
    expect(kept.applied.siteRules.login.selector).toBe('#a');
    expect(kept.applied.siteRules.login.subscriptionId).toBeUndefined();
    expect(kept.applied.settings.customIncludeKeywords).toEqual(['shared', 'a']);
  });

  test('uses package keys instead of collapsing rules onto a hostname', () => {
    const a = subscription('a');
    a.cachedPackage!.siteRules = { first: rule('#first'), second: rule('#second') };
    expect(Object.keys(reconcile({}, {}, undefined, [], [a]).applied.siteRules)).toEqual(['first', 'second']);
  });
});
