/**
 * 滑块求解器：把缺口检测（slide-detector）+ 人类轨迹（trajectory）+ 合成事件（pointer）
 * 串成一次完整的「找缺口 → 拖到位」。运行在 content script（需要 canvas 像素）。
 *
 * 仅在用户开启对应开关后由调用方触发（enableSliderPuzzleAssist / enableSingleSliderAssist）。
 * 这里不读配置——由 content.ts 在调用前 gate，保持本模块纯逻辑、可单测。
 */

import { slideMatch, detectGapByColumnEdges, type ImageLike } from '../slide-detector';
import { humanDragTrajectory } from './trajectory';
import { dragAlong } from './pointer';
import type { DetectedCaptcha } from '../captcha-detector';

export interface SliderSolveResult {
  success: boolean;
  /** 检测到的缺口在显示坐标系下的横坐标（px） */
  gapX: number;
  /** 实际拖拽距离（px） */
  distance: number;
  /** 匹配得分（slideMatch 的 NCC；column-edge 兜底时为 NaN） */
  score: number;
  method: string;
  reason?: string;
}

export interface SliderSolveOptions {
  /** slideMatch 得分低于此值视为缺口不可信，放弃拖拽（仅对有 piece 的匹配生效）。默认 0.3 */
  minScore?: number;
  /** 缺口检测出的距离上叠加的修正（px），针对个别库的固定偏差。默认 0 */
  offset?: number;
  onLog?: (msg: string) => void;
}

/** 把 canvas/img 元素读成 ImageData。跨域 tainted canvas 会抛错 → 返回 null。 */
export function elementToImageData(el: HTMLCanvasElement | HTMLImageElement): ImageLike | null {
  const w = (el as HTMLImageElement).naturalWidth || (el as HTMLCanvasElement).width || 0;
  const h = (el as HTMLImageElement).naturalHeight || (el as HTMLCanvasElement).height || 0;
  if (!w || !h) return null;
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(el as CanvasImageSource, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } catch {
    return null; // tainted / 跨域不可读
  }
}

export async function solveSlider(
  captcha: DetectedCaptcha,
  opts: SliderSolveOptions = {},
): Promise<SliderSolveResult> {
  const log = opts.onLog || (() => {});
  const minScore = opts.minScore ?? 0.3;
  const fail = (reason: string, extra: Partial<SliderSolveResult> = {}): SliderSolveResult => ({
    success: false, gapX: 0, distance: 0, score: NaN, method: 'none', reason, ...extra,
  });

  const bgEl = captcha.innerCanvas;
  const handle = captcha.sliderHandle;
  if (!bgEl) return fail('no-background');
  if (!handle) return fail('no-handle');

  const bg = elementToImageData(bgEl);
  if (!bg) {
    log('背景图不可读（跨域 tainted canvas），无法做缺口检测');
    return fail('tainted-canvas');
  }

  let gapXNative: number;
  let score: number;
  let method: string;
  const piece = captcha.sliderPiece ? elementToImageData(captcha.sliderPiece) : null;
  if (piece) {
    const m = slideMatch(piece, bg);
    gapXNative = m.x;
    score = m.score;
    method = m.method;
    log(`slideMatch: x=${gapXNative}px score=${score.toFixed(3)} method=${method} (${m.elapsed.toFixed(0)}ms)`);
    if (score < minScore) return fail('low-confidence', { gapX: gapXNative, score, method });
  } else {
    const m = detectGapByColumnEdges(bg, Math.round(bg.width * 0.1));
    gapXNative = m.x;
    score = NaN;
    method = 'column-edge';
    log(`无滑块小图，列边缘兜底: x=${gapXNative}px`);
  }

  // native px → 显示 px
  const bgRect = bgEl.getBoundingClientRect();
  const nativeW = (bgEl as HTMLImageElement).naturalWidth || (bgEl as HTMLCanvasElement).width || bgRect.width;
  const scale = bgRect.width / Math.max(1, nativeW);

  // 缺口在显示坐标系下的横坐标
  const gapDisplayX = gapXNative * scale;

  // 拖拽距离 ≈ 缺口显示横坐标 − 滑块小图当前左缘相对背景左缘的偏移（多数库手柄与小图 1:1 移动）。
  // 但只有当 piece 是「贴在最左、待拖动的独立小图」时这个扣减才成立。
  // 实测发现：findSliderParts 有时把贴在缺口处的图层误当 piece，其 left≈缺口位置，
  // 扣减后 distance≈0（日志 gapX=216 distance=1）。因此仅在 pieceStart 明显靠左
  // （< 缺口位置的一半，即确实是起手位置）时才扣减，否则忽略，按缺口位置直接作距离。
  let pieceStartOffset = 0;
  if (captcha.sliderPiece) {
    const pr = captcha.sliderPiece.getBoundingClientRect();
    const rawOffset = Math.max(0, pr.left - bgRect.left);
    if (rawOffset < gapDisplayX * 0.5) {
      pieceStartOffset = rawOffset;
    } else {
      log(`忽略可疑的 piece 起始偏移 ${rawOffset.toFixed(1)}px（≥ 缺口 ${gapDisplayX.toFixed(1)}px 的一半，疑似误识别图层）`);
    }
  }
  const distance = Math.max(0, gapDisplayX - pieceStartOffset + (opts.offset ?? 0));
  log(`scale=${scale.toFixed(3)} gapX=${gapDisplayX.toFixed(1)}px pieceStart=${pieceStartOffset.toFixed(1)}px → distance=${distance.toFixed(1)}px`);

  if (distance < 2) return fail('distance-too-small', { gapX: gapDisplayX, distance, score, method });

  const traj = humanDragTrajectory(distance);
  log(`拖拽轨迹点数=${traj.length}`);
  const finalX = await dragAlong(handle, traj);
  log(`拖拽完成，终点 clientX=${finalX.toFixed(1)}`);

  return { success: true, gapX: gapDisplayX, distance, score, method };
}
