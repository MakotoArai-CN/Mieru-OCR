/**
 * 每规则求解成功率统计 + 自适应退避（1.2.3）。
 *
 * 纯计算模块，不触碰存储——由扩展侧（content/service-worker）负责持久化到
 * chrome.storage.local 的 `ruleStats`。失败时按连续失败次数指数放大冷却，避免对
 * 同一站点反复触发自动拖拽 / 点击而被风控标记。
 */

export interface RuleStat {
  /** 累计尝试次数 */
  attempts: number;
  /** 累计成功次数 */
  successes: number;
  /** 当前连续失败次数（成功即清零） */
  consecFails: number;
  /** 最近一次尝试时间戳 */
  lastAt: number;
  /** 最近一次成功时间戳 */
  lastSuccessAt: number;
}

export type RuleStatsMap = Record<string, RuleStat>;

export function emptyStat(): RuleStat {
  return { attempts: 0, successes: 0, consecFails: 0, lastAt: 0, lastSuccessAt: 0 };
}

/** 记录一次尝试结果，返回更新后的 stat（不可变更新）。 */
export function recordAttempt(prev: RuleStat | undefined, success: boolean, now: number): RuleStat {
  const s = prev ? { ...prev } : emptyStat();
  s.attempts += 1;
  s.lastAt = now;
  if (success) {
    s.successes += 1;
    s.consecFails = 0;
    s.lastSuccessAt = now;
  } else {
    s.consecFails += 1;
  }
  return s;
}

export interface BackoffOptions {
  /** 成功后的冷却（默认 30s，与既有 INTERACTIVE_COOLDOWN_OK_MS 对齐） */
  okMs?: number;
  /** 失败基础冷却（默认 8s，与既有 INTERACTIVE_COOLDOWN_FAIL_MS 对齐） */
  baseFailMs?: number;
  /** 退避封顶（默认 10 分钟） */
  capMs?: number;
}

/**
 * 依据 stat 计算下一次该规则的冷却时长。
 * - 成功 / 无失败：返回 okMs。
 * - 连续失败 n 次：baseFailMs * 2^(n-1)，封顶 capMs（指数退避）。
 */
export function backoffCooldownMs(
  success: boolean,
  stat: RuleStat | undefined,
  opts: BackoffOptions = {},
): number {
  const okMs = opts.okMs ?? 30000;
  const baseFailMs = opts.baseFailMs ?? 8000;
  const capMs = opts.capMs ?? 10 * 60 * 1000;
  if (success) return okMs;
  const consec = stat?.consecFails ?? 1;
  const mult = Math.pow(2, Math.min(Math.max(consec, 1) - 1, 8));
  return Math.min(baseFailMs * mult, capMs);
}

/** 成功率（0~1），无尝试返回 NaN。 */
export function successRate(stat: RuleStat | undefined): number {
  if (!stat || stat.attempts === 0) return NaN;
  return stat.successes / stat.attempts;
}
