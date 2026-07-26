import type { SiteRule } from './types';

/**
 * 站点规则的 URL 匹配（1.2.3 起）。
 *
 * 默认按 `origin + pathname` 匹配，**忽略全部 query/hash** —— 很多站点的验证码页 URL 带
 * 随机数 / 一次性 token（`?t=168...`、`?nonce=...`），字面比较会永远不命中。规则可用
 * `matchQuery` 白名单声明少数「必须校验」的参数（如 `lang`、`step`），其余一律忽略。
 *
 * hostname 兜底不在这里处理——调用方用 candidateHostnames（含子框架的父 hostname）单独判定。
 */

export type UrlMatchMode = NonNullable<SiteRule['urlMatch']>;

/** 规则未显式声明 urlMatch 时，由旧字段推断匹配模式（向后兼容）。 */
export function inferUrlMatchMode(rule: Pick<SiteRule, 'urlMatch' | 'fullUrl' | 'urlPattern'>): UrlMatchMode {
  if (rule.urlMatch) return rule.urlMatch;
  if (rule.fullUrl) return 'origin-path';
  if (rule.urlPattern) return 'prefix';
  return 'hostname';
}

/** 归一化为 `origin + pathname`：去掉 query/hash，并把多余的尾斜杠折成一个（根 '/' 保留）。 */
export function normalizeUrl(u: string): string {
  try {
    const url = new URL(u);
    let path = url.pathname || '/';
    if (path.length > 1) path = path.replace(/\/+$/, '') || '/';
    return url.origin + path;
  } catch {
    return '';
  }
}

function matchQueryOk(rule: Pick<SiteRule, 'matchQuery'>, currentUrl: string, target: string): boolean {
  if (!rule.matchQuery || rule.matchQuery.length === 0) return true;
  try {
    const a = new URL(currentUrl).searchParams;
    const b = new URL(target).searchParams;
    for (const p of rule.matchQuery) {
      if (a.get(p) !== b.get(p)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断规则的「URL 部分」是否命中当前页 URL。
 * 返回 false 不代表规则不适用——纯 hostname 规则（mode='hostname'）在这里恒返回 false，
 * 由调用方的 hostname 兜底逻辑处理。
 */
export function ruleMatchesUrl(
  rule: Pick<SiteRule, 'urlMatch' | 'fullUrl' | 'urlPattern' | 'matchQuery'>,
  currentUrl: string,
): boolean {
  const mode = inferUrlMatchMode(rule);
  if (mode === 'hostname') return false;

  const target = rule.fullUrl || rule.urlPattern || '';
  if (!target) return false;

  if (mode === 'exact') {
    return currentUrl === target && matchQueryOk(rule, currentUrl, target);
  }

  const cur = normalizeUrl(currentUrl);
  const tgt = normalizeUrl(target);
  if (!cur || !tgt) return false;

  const base = mode === 'prefix' ? cur.startsWith(tgt) : cur === tgt;
  if (!base) return false;
  return matchQueryOk(rule, currentUrl, target);
}
