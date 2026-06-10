/**
 * Cloudflare Turnstile 辅助点击（**辅助，非绕过**）。
 *
 * ──────────────────────────── 诚实边界（务必先读）────────────────────────────
 * Turnstile 的验证逻辑全部运行在跨域 iframe `challenges.cloudflare.com` 内：
 *  1. 顶层页面 JS（含本扩展在顶层 frame 的 content script）**无法访问该 iframe 的 DOM**，
 *     更无法「替它打勾」。
 *  2. 本扩展靠 manifest `all_frames:true` 也会被注入进该 iframe（隔离世界），那里**能读到**
 *     复选框 DOM；但合成 click 的 `isTrusted=false`，CF 会忽略；且 CF 另有行为层
 *     （鼠标轨迹/停留/键入节奏）与网络层（TLS JA3/JA4、HTTP2 帧序、IP 信誉）指纹，
 *     **客户端无法伪造**。
 *  3. 所以本模块只做两件诚实的事：
 *      - 在 CF iframe 内：尽力把指针自然移动到复选框并尝试点击（**多半被拒**，如实记录）。
 *      - 在顶层 frame：降级为「滚动到可视 + 高亮」，提示用户**亲自**点击。
 *  4. 绝不声称能自动通过 CF。仅在用户开启 `enableInteractiveCaptchaAssist` 后由调用方触发；
 *     本模块不读配置，保持可单测。
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { bezierPath, type Point } from './trajectory';
import { moveAndClick, delay } from './pointer';

/** 一个被识别到的 Turnstile 部件。 */
export interface TurnstileWidget {
  /** container = 顶层页面里的 .cf-turnstile 占位容器；iframe = CF 的跨域验证框。 */
  kind: 'container' | 'iframe';
  element: HTMLElement;
  sitekey?: string;
  rect: DOMRect;
}

export interface CfAssistOptions {
  onLog?: (msg: string) => void;
  /** 高亮提示的持续时间（ms），默认 2600。 */
  highlightMs?: number;
}

export interface CfAssistResult {
  /** success = 我们成功执行了**某种辅助动作**，绝不代表 CF 验证通过。 */
  success: boolean;
  mode: 'iframe-click' | 'assist-manual' | 'none';
  /** 识别到的部件数（顶层 frame 统计）。 */
  widgets?: number;
  reason?: string;
  /**
   * 启发式：iframe 内点击后复选框状态看起来变了。仍**不保证** CF 后端通过——
   * 真正的判定在 CF 服务端，客户端无从得知。
   */
  checkboxToggledHint?: boolean;
}

const CF_IFRAME_SELECTOR = 'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]';
const CF_CONTAINER_SELECTOR = '.cf-turnstile, #cf-turnstile, [data-sitekey]';

/** 当前 frame 是否就是 CF 的验证 iframe（content script 在该 frame 内运行时为真）。 */
export function isCloudflareFrame(): boolean {
  try {
    return /(^|\.)challenges\.cloudflare\.com$/.test(location.hostname);
  } catch {
    return false;
  }
}

/** 在给定根下识别 Turnstile 部件（顶层容器 + 跨域 iframe）。 */
export function detectTurnstile(root: ParentNode = document): TurnstileWidget[] {
  const out: TurnstileWidget[] = [];
  const seen = new Set<Element>();

  root.querySelectorAll(CF_CONTAINER_SELECTOR).forEach((el) => {
    if (seen.has(el)) return;
    seen.add(el);
    const he = el as HTMLElement;
    out.push({
      kind: 'container',
      element: he,
      sitekey: he.getAttribute('data-sitekey') || undefined,
      rect: he.getBoundingClientRect(),
    });
  });

  root.querySelectorAll(CF_IFRAME_SELECTOR).forEach((el) => {
    if (seen.has(el)) return;
    seen.add(el);
    const he = el as HTMLElement;
    out.push({ kind: 'iframe', element: he, rect: he.getBoundingClientRect() });
  });

  return out;
}

/** 在 CF iframe 内定位可点击的复选框元素。拿不到返回 null。 */
function findCheckboxInFrame(): HTMLElement | null {
  const candidates = [
    'input[type="checkbox"]',
    '[role="checkbox"]',
    'label',
    '.cb-c', '.ctp-checkbox-label', '#challenge-stage',
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el && el.getBoundingClientRect().width > 0) return el;
  }
  return null;
}

/** 临时高亮一个元素并滚动到可视，提示用户亲自点击。 */
function highlightForManual(el: HTMLElement, ms: number): void {
  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  } catch { /* older engines */ }
  const prev = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = '3px solid #f48120';
  el.style.outlineOffset = '2px';
  setTimeout(() => {
    el.style.outline = prev;
    el.style.outlineOffset = prevOffset;
  }, ms);
}

/**
 * 辅助 Turnstile。行为取决于当前 frame：
 *  - CF iframe 内：自然轨迹移动到复选框 + 合成点击（诚实：多半被 isTrusted 拒）。
 *  - 顶层 frame：识别部件 → 滚动到可视 + 高亮，提示用户亲自点击（降级）。
 */
export async function assistCloudflare(opts: CfAssistOptions = {}): Promise<CfAssistResult> {
  const log = opts.onLog || (() => {});
  const highlightMs = opts.highlightMs ?? 2600;

  // —— CF iframe 内：尽力点击（诚实标注大概率失败）——
  if (isCloudflareFrame()) {
    const box = findCheckboxInFrame();
    if (!box) {
      log('CF iframe 内未找到复选框（可能尚未渲染或结构变化）');
      return { success: false, mode: 'iframe-click', reason: 'no-checkbox' };
    }
    const rect = box.getBoundingClientRect();
    // 落点带轻微偏移更自然（CF 行为层会看落点是否恰在中心）
    const target: Point = {
      x: rect.left + rect.width / 2 + (Math.random() - 0.5) * 6,
      y: rect.top + rect.height / 2 + (Math.random() - 0.5) * 6,
    };
    const from: Point = { x: target.x - 80 - Math.random() * 60, y: target.y + 60 + Math.random() * 50 };
    log('在 CF iframe 内生成自然轨迹并尝试点击（isTrusted=false，CF 很可能拒绝）');
    const path = bezierPath(from, target, 28 + Math.floor(Math.random() * 12));
    await moveAndClick(path, document);
    await delay(120);
    // 启发式：看 aria-checked / checked 是否变化（仅供调试，不代表通过）
    const checked =
      (box as HTMLInputElement).checked === true ||
      box.getAttribute('aria-checked') === 'true';
    log(`点击已派发。复选框状态启发式：${checked ? '看似已勾选' : '未变化'}（CF 最终判定在服务端，客户端无从得知）`);
    return { success: true, mode: 'iframe-click', checkboxToggledHint: checked };
  }

  // —— 顶层 frame：降级为滚动 + 高亮，提示用户亲自点击 ——
  const widgets = detectTurnstile();
  if (widgets.length === 0) {
    return { success: false, mode: 'none', reason: 'no-widget', widgets: 0 };
  }
  log(`顶层 frame 识别到 ${widgets.length} 个 Turnstile 部件；跨域 iframe 无法直接操作，滚动+高亮提示用户亲自点击`);
  for (const w of widgets) {
    highlightForManual(w.element, highlightMs);
  }
  return { success: true, mode: 'assist-manual', widgets: widgets.length };
}
