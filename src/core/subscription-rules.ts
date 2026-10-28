import type { Subscription, SubscriptionRulePackage } from './subscription';
import type { CalculateRule, SiteRule } from './types';

const listFields = {
  customIncludeKeywords: 'includeKeywords',
  customExcludePatterns: 'excludePatterns',
  customAgreementKeywords: 'agreementKeywords',
  customInputExcludeKeywords: 'inputExcludeKeywords',
  agreementSelectors: 'agreementSelectors',
  siteBlacklist: 'siteBlacklist',
} as const;

type ListField = keyof typeof listFields;
export type RuleSettings = Partial<Record<ListField, string[]>> & { calculateRules?: CalculateRule[] };
export type SiteRules = Record<string, SiteRule & { hostname: string; subscriptionId?: string }>;
interface RuleLayer {
  settings: RuleSettings;
  siteRules: SiteRules;
}
export interface SubscriptionRuleState {
  version: 1;
  manual: RuleLayer;
  applied: RuleLayer;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const lower = (value: string): string => value.toLowerCase();
const calcKey = (rule: CalculateRule): string => JSON.stringify([rule.pattern, rule.matchType]);

function mergeList<T>(base: T[], incoming: T[], key: (value: T) => string): T[] {
  const seen = new Set(base.map(key));
  return [...base, ...incoming.filter(value => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  })];
}

function manualList<T>(current: T[], manual: T[], applied: T[], key: (value: T) => string): T[] {
  const before = new Map(applied.map(value => [key(value), value]));
  const owned = new Set(manual.map(key));
  return current.filter(value => owned.has(key(value)) || !equal(before.get(key(value)), value));
}

function untag(rule: SiteRules[string]): SiteRules[string] {
  const result = { ...rule };
  delete result.subscriptionId;
  return result;
}

/** Reconcile edits made by existing settings UIs before rebuilding subscribed rules. */
export function reconcileSubscriptionRules(
  settings: RuleSettings,
  siteRules: SiteRules,
  previous: SubscriptionRuleState | undefined,
  oldSubscriptions: Subscription[],
  subscriptions: Subscription[],
  retainId?: string,
): SubscriptionRuleState {
  const manual: RuleLayer = { settings: {}, siteRules: Object.create(null) };
  const prior = previous?.version === 1 ? previous : undefined;
  for (const field of Object.keys(listFields) as ListField[]) {
    const current = settings[field] || [];
    // Legacy lists have no provenance. Preserve them rather than guessing ownership.
    manual.settings[field] = prior
      ? manualList(current, prior.manual.settings[field] || [], prior.applied.settings[field] || [], lower)
      : [...current];
  }
  manual.settings.calculateRules = prior
    ? manualList(settings.calculateRules || [], prior.manual.settings.calculateRules || [], prior.applied.settings.calculateRules || [], calcKey)
    : [...(settings.calculateRules || [])];

  for (const [key, rule] of Object.entries(siteRules)) {
    if (prior) {
      if (!equal(rule, prior.applied.siteRules[key])) manual.siteRules[key] = untag(rule);
      else if (prior.manual.siteRules[key]) manual.siteRules[key] = prior.manual.siteRules[key];
    } else {
      const owner = oldSubscriptions.find(sub => sub.id === rule.subscriptionId);
      const source = owner?.cachedPackage?.siteRules?.[key];
      const isUneditedSubscriptionRule = source && Object.entries(source).every(([field, value]) =>
        equal((rule as unknown as Record<string, unknown>)[field], value));
      if (!isUneditedSubscriptionRule) manual.siteRules[key] = untag(rule);
    }
  }

  if (retainId) {
    const retained = oldSubscriptions.find(sub => sub.id === retainId)?.cachedPackage;
    if (retained) {
      for (const field of Object.keys(listFields) as ListField[]) {
        const values = new Set((retained[listFields[field]] || []).map(lower));
        manual.settings[field] = mergeList(manual.settings[field] || [], (settings[field] || []).filter(value => values.has(lower(value))), lower);
      }
      const values = new Set((retained.calculateRules || []).map(calcKey));
      manual.settings.calculateRules = mergeList(manual.settings.calculateRules || [], (settings.calculateRules || []).filter(value => values.has(calcKey(value))), calcKey);
      for (const [key, rule] of Object.entries(siteRules)) {
        if (rule.subscriptionId === retainId) manual.siteRules[key] = untag(rule);
      }
    }
  }

  const applied = clone(manual);
  applied.siteRules = Object.assign(Object.create(null), applied.siteRules);
  for (const sub of subscriptions) {
    const pkg: SubscriptionRulePackage | undefined = sub.cachedPackage;
    if (!sub.enabled || !pkg) continue;
    for (const field of Object.keys(listFields) as ListField[]) {
      applied.settings[field] = mergeList(applied.settings[field] || [], pkg[listFields[field]] || [], lower);
    }
    applied.settings.calculateRules = mergeList(applied.settings.calculateRules || [], pkg.calculateRules || [], calcKey);
    for (const [key, rule] of Object.entries(pkg.siteRules || {})) {
      if (Object.prototype.hasOwnProperty.call(manual.siteRules, key)) continue;
      applied.siteRules[key] = {
        ...rule,
        hostname: rule.hostname || key,
        enabled: true,
        createdAt: siteRules[key]?.createdAt || Date.now(),
        updatedAt: sub.lastUpdated || Date.now(),
        subscriptionId: sub.id,
      } as SiteRules[string];
    }
  }
  return clone({ version: 1, manual, applied });
}
