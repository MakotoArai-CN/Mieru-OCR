/**
 * 滑块求解器：把缺口检测（slide-detector）+ 人类轨迹（trajectory）+ 合成事件（pointer）
 * 串成一次完整的「找缺口 → 拖到位」。运行在 content script（需要 canvas 像素）。
 *
 * 仅在用户开启对应开关后由调用方触发（enableSliderPuzzleAssist / enableSingleSliderAssist）。
 * 这里不读配置——由 content.ts 在调用前 gate，保持本模块纯逻辑、可单测。
 */

import {
  slideMatch,
  detectGapByColumnEdges,
  detectGapByBrightness,
  fuseGapCandidates,
  type GapCandidate,
  type ImageLike,
  type SlideMatchResult,
} from '../slide-detector';
import { humanDragTrajectory, type DragProfile } from './trajectory';
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
  /** 求解过程中的几何信息，便于线上诊断（不参与业务判断）。 */
  debug?: { scale: number; bgW: number; nativeW: number; pieceStart: number };
}

export interface SliderSolveOptions {
  /** slideMatch 得分低于此值视为缺口不可信，放弃拖拽（仅对有 piece 的匹配生效）。默认 0.3 */
  minScore?: number;
  /** 缺口检测出的距离上叠加的修正（px），针对个别库的固定偏差。默认 0 */
  offset?: number;
  /** 拖拽速度档位（来自规则 dragProfile），影响轨迹拟人程度。默认 'normal' */
  profile?: DragProfile;
  onLog?: (msg: string) => void;
  match?: (target: ImageLike, background: ImageLike) => Promise<ReturnType<typeof slideMatch>>;
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
    const img = ctx.getImageData(0, 0, w, h);
    // Firefox 内容脚本（隔离沙箱）里 getImageData 返回的 data 是 Xray 包装的
    // Uint8ClampedArray，直接传给 putImageData/TypedArray.set 会 "Permission denied"。
    // 复制成本 O(w*h*4)，对验证码尺寸可忽略。
    const copy = new Uint8ClampedArray(img.data.length);
    for (let i = 0; i < copy.length; i++) copy[i] = img.data[i];
    return { data: copy, width: w, height: h };
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

  // 多算法缺口检测融合：模板匹配(NCC) + 列边缘 + 亮度梯度，各产出归一化候选后投票。
  const marginX = Math.round(bg.width * 0.1);
  const candidates: GapCandidate[] = [];
  let pieceX = NaN;
  let pieceScore = NaN;
  /** 模板位置的内容相关性（拼图块与背景是否同一块内容），用于低分时兜底判断。 */
  let pieceContent = NaN;
  /** slideMatch 内部最终采纳的方法（shape-match/content-search 表示已通过严格校验）。 */
  let pieceMethod = '';
  const piece = captcha.sliderPiece ? elementToImageData(captcha.sliderPiece) : null;
  if (piece) {
    let m: SlideMatchResult;
    if (opts.match) {
      try {
        m = await opts.match(piece, bg);
      } catch (error) {
        // 扩展侧把匹配放到 offscreen 的 Worker 里（不阻塞页面主线程），但一次消息 / Worker
        // 失败不该让整个滑块功能不可用——退回本页计算，只是多占几十毫秒主线程。
        log(`后台匹配失败，回退本地计算: ${(error as Error)?.message || String(error)}`);
        m = slideMatch(piece, bg);
      }
    } else {
      m = slideMatch(piece, bg);
    }
    pieceX = m.x;
    pieceScore = m.score;
    pieceContent = m.contentScore;
    pieceMethod = m.method;
    candidates.push({ x: m.x, conf: Math.max(0, m.score), method: m.method, weight: 1.6 });
    const content = Number.isFinite(m.contentScore) ? m.contentScore.toFixed(2) : 'n/a';
    log(`slideMatch: x=${m.x}px score=${m.score.toFixed(3)} content=${content} margin=${m.margin.toFixed(3)} method=${m.method} (${m.elapsed.toFixed(0)}ms)`);
  }
  const ce = detectGapByColumnEdges(bg, marginX);
  candidates.push({ x: ce.x, conf: ce.score, method: 'column-edge', weight: 1 });
  const br = detectGapByBrightness(bg, marginX);
  candidates.push({ x: br.x, conf: br.score, method: 'brightness', weight: 0.8 });

  const tol = Math.max(6, Math.round(bg.width * 0.04));
  const fused = fuseGapCandidates(candidates, tol);
  log(`缺口候选: ${candidates.map((c) => `${c.method}@${Math.round(c.x)}(${c.conf.toFixed(2)})`).join(', ')}`
    + ` → 融合 x=${fused ? Math.round(fused.x) : '?'} agree=${fused?.agree ?? 0}`);

  // 位置可信度按三条独立信号判断（任一成立即可，融合只作最后兜底）：
  //   1) 边缘 NCC 分数达标；
  //   2) 内容相关性 ≥0.55：拼图块与缺口是同一块内容，错位时相关性会掉到 0 附近；
  //      旋转过的拼图块相关性约 0.6~0.7，仍远高于错误位置；
  //   3) slideMatch 内部已采纳 shape-match / content-search：这两条路径本身要求
  //      轮廓分 ≥0.5 或内容分 ≥0.8，等价于已经通过了一次严格校验。
  // 低分模板若改用「列边缘 + 亮度」融合"补救"，在照片/高密度纹理背景上经常被强
  // 纹理带到完全错误的位置（实测偏差 49~90px，而同一次匹配的内容相关性是 0.65~0.99）。
  const contentOk = Number.isFinite(pieceContent) && pieceContent >= 0.55;
  const methodTrusted = pieceMethod === 'shape-match' || pieceMethod === 'content-search';

  if (piece && (pieceScore >= minScore || contentOk || methodTrusted)) {
    // 模板匹配可信（分数够高，或内容验证通过）：以其为准，其余两路仅作记录/印证。
    gapXNative = pieceX;
    score = pieceScore;
    method = pieceScore >= minScore || methodTrusted
      ? 'template-match'
      : (contentOk ? 'template-match(content)' : 'template-match');
    if (pieceScore < minScore) {
      log(`边缘分偏低(${pieceScore.toFixed(3)} < ${minScore})，但${contentOk ? `内容相关性 ${pieceContent.toFixed(3)}` : `内部方法 ${pieceMethod}`}可信 → 采用模板位置`);
    }
  } else if (piece) {
    // 模板匹配置信低：要求列边缘 + 亮度两路互相印证（agree≥2）才接受融合结果，否则放弃。
    if (fused && fused.agree >= 2) {
      gapXNative = fused.x;
      score = pieceScore;
      method = `fusion(${fused.method})`;
      log(`模板匹配置信低(${pieceScore.toFixed(3)} < ${minScore})，改用多算法融合 x=${Math.round(fused.x)}`);
    } else {
      return fail('low-confidence', { gapX: pieceX, score: pieceScore, method: 'template-match' });
    }
  } else {
    // 无滑块小图：用融合结果（不硬失败，沿用旧的列边缘兜底语义，但更稳）。
    if (!fused) return fail('no-gap');
    gapXNative = fused.x;
    score = NaN;
    method = `fusion(${fused.method})`;
    log(`无滑块小图，多算法融合兜底: x=${Math.round(fused.x)} agree=${fused.agree}`);
  }

  // native px → 显示 px
  const bgRect = bgEl.getBoundingClientRect();
  const nativeW = (bgEl as HTMLImageElement).naturalWidth || (bgEl as HTMLCanvasElement).width || bgRect.width;
  const scale = bgRect.width / Math.max(1, nativeW);
  const debug = { scale, bgW: bgRect.width, nativeW, pieceStart: 0 };

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
  debug.pieceStart = pieceStartOffset;
  const distance = Math.max(0, gapDisplayX - pieceStartOffset + (opts.offset ?? 0));
  log(`scale=${scale.toFixed(3)} gapX=${gapDisplayX.toFixed(1)}px pieceStart=${pieceStartOffset.toFixed(1)}px → distance=${distance.toFixed(1)}px`);

  if (distance < 2) return fail('distance-too-small', { gapX: gapDisplayX, distance, score, method });

  const traj = humanDragTrajectory(distance, { profile: opts.profile });
  log(`拖拽轨迹点数=${traj.length} 档位=${opts.profile ?? 'normal'}`);
  const finalX = await dragAlong(handle, traj);
  log(`拖拽完成，终点 clientX=${finalX.toFixed(1)}`);

  return { success: true, gapX: gapDisplayX, distance, score, method, debug };
}
