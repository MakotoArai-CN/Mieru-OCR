/**
 * 文字点选求解器：检测字符框 → 逐框 OCR 标字 → 按题面顺序匹配 → 贝塞尔轨迹逐个点击。
 *
 * 分两层，便于在不同环境复用：
 *  - `labelBoxesWithEngines(image, det, ocr)`：纯「模型」编排（检测 + 裁剪 + OCR），
 *    在有 det/OCR 两个引擎的地方运行（扩展的 offscreen 文档、playground、userscript 页面）。
 *  - `solveClickSelect(captcha, { labelBoxes, ... })`：纯「DOM」编排（题序解析 + 坐标换算 + 点击），
 *    在 content script 运行，模型部分通过 labelBoxes 回调注入（扩展里回调走 offscreen 消息）。
 *
 * 仅在用户开启 enableClickSelectAssist 后由调用方触发；本模块不读配置，保持可单测。
 *
 * 局限：准确率受 det 检测质量 + OCR 对该字体的识别率双重制约；题序依赖题面可读
 * （DOM 文本或可 OCR 的题图）。合成点击 isTrusted=false，带行为风控的点选可能仍拒。
 */

import { elementToImageData } from './slider-solver';
import { bezierPath, type Point } from './trajectory';
import { moveAndClick, delay } from './pointer';
import type { DetectedCaptcha } from '../captcha-detector';
import type { ImageLike } from '../slide-detector';
import type { DetectionBox, DetectionEngine } from '../detection-engine';
import type { OCREngine } from '../ocr-engine';

/** 带标注字符的检测框（坐标 = 主图像素系）。 */
export interface LabeledBox extends DetectionBox {
  char: string;
}

export interface ClickSelectOptions {
  /**
   * 给定验证码主图，返回带字符标注的检测框（坐标=主图像素系）。
   * 扩展里走 offscreen（det + OCR）；playground/userscript 可直接传 labelBoxesWithEngines 的偏函数。
   */
  labelBoxes: (image: ImageLike) => Promise<LabeledBox[]>;
  /** 题面字符顺序。优先使用；缺省时尝试从 DOM 文本解析，再不行用 recognizePromptImage。 */
  promptOrder?: string[];
  /** 题面为图片时的题图像素，配合 recognizePromptImage 使用。 */
  promptImage?: ImageLike;
  /** OCR 题图得到顺序字符串。 */
  recognizePromptImage?: (image: ImageLike) => Promise<string>;
  /** 每次点击之间的停顿区间 [min,max] ms。默认 [180,360]。 */
  clickGap?: [number, number];
  onLog?: (msg: string) => void;
}

export interface ClickSelectResult {
  success: boolean;
  reason?: string;
  /** 实际点击点（视口坐标）及对应字符。 */
  clicks?: { x: number; y: number; char: string }[];
  /** 检测到的候选框标注串，便于调试。 */
  detected?: string;
}

/** 用 document 创建画布（offscreen / 页面 / playground 均有 document）。 */
function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 2d 上下文');
  return { canvas, ctx };
}

/** 从主图裁出一个框（带少量留白，白底），返回 dataURL 供 OCR。 */
function cropToDataURL(image: ImageLike, box: DetectionBox): string {
  const sx = Math.round(box.x);
  const sy = Math.round(box.y);
  const sw = Math.max(1, Math.round(box.w));
  const sh = Math.max(1, Math.round(box.h));

  const full = makeCanvas(image.width, image.height);
  full.ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);

  const pad = Math.max(2, Math.round(Math.min(sw, sh) * 0.15));
  const cw = sw + pad * 2;
  const ch = sh + pad * 2;
  const crop = makeCanvas(cw, ch);
  crop.ctx.fillStyle = '#ffffff';
  crop.ctx.fillRect(0, 0, cw, ch);
  crop.ctx.drawImage(full.canvas, sx - pad, sy - pad, cw, ch, 0, 0, cw, ch);
  return crop.canvas.toDataURL();
}

/**
 * 把 dataURL 解码回像素（ImageLike）。供「引擎宿主」环境用：扩展里 content script 持有
 * 主图像素，但 det/OCR 跑在 offscreen（Chrome）/ 背景页（Firefox），跨消息边界只能传字符串，
 * 故 content 端把 ImageLike 编码成 dataURL，宿主端用本函数解回。两类宿主都有 createImageBitmap。
 */
export async function decodeDataURLToImage(dataURL: string): Promise<ImageLike> {
  const res = await fetch(dataURL);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const { ctx } = makeCanvas(bmp.width, bmp.height);
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { data: img.data, width: img.width, height: img.height };
}

/**
 * 用 det + OCR 引擎给主图打标：检测所有字符框，逐框裁剪 + OCR。
 * 在 offscreen / playground / userscript 等同时拥有两个引擎的环境调用。
 */
export async function labelBoxesWithEngines(
  image: ImageLike,
  det: DetectionEngine,
  ocr: OCREngine,
): Promise<LabeledBox[]> {
  const boxes = await det.detect(image);
  const out: LabeledBox[] = [];
  for (const b of boxes) {
    let char = '';
    try {
      const r = await ocr.recognize(cropToDataURL(image, b));
      char = (r.text || '').trim();
    } catch {
      char = '';
    }
    out.push({ ...b, char });
  }
  return out;
}

/** 拆成单字符数组（按 Unicode 码点，过滤空白与常见标点）。 */
function splitChars(text: string): string[] {
  return Array.from(text || '')
    .map((c) => c.trim())
    .filter((c) => c && !/[，。、,.\s:：;；!！?？·…—\-_/\\|()（）[\]【】]/.test(c));
}

/**
 * 指令性词语：题面里常见的「请按顺序点击下列文字」等措辞。解析目标字符前先整体剥离，
 * 避免把「点」「击」「文」「字」「顺」「序」等指令字误当成要点击的目标（曾导致 unmatched:点）。
 * 多字词放前面，确保先于单字被替换掉。
 */
const PROMPT_INSTRUCTION_PHRASES = [
  '从上到下', '从左到右', '从右到左', '从下到上', '请依次', '依次',
  '请按照', '请按', '按照', '按顺序', '顺序', '先后顺序', '先后',
  '请点击', '请选择', '请在', '点击下列', '点击下面', '点击图中', '点击图片中',
  '点击', '点选', '选择', '选中', '下列', '下面', '图中', '图片中', '其中',
  '完成验证', '验证码', '验证', '提示', '目标', '汉字', '文字', '中文', '词语',
  '正确', '识别', '所示', '如图', '图形', '这些', '上方', '下方', '请',
];

/** 把指令性词语从题面文本里整体剥离（多字词优先），返回剩余可能含目标字符的串。 */
function stripInstructionWords(text: string): string {
  let out = text;
  for (const w of PROMPT_INSTRUCTION_PHRASES) {
    out = out.split(w).join('');
  }
  return out;
}

/** 题面字符是否与某个框的标注匹配（精确，或单字被包含）。 */
function charMatch(boxChar: string, target: string): boolean {
  if (!boxChar) return false;
  if (boxChar === target) return true;
  if (target.length === 1 && boxChar.includes(target)) return true;
  return false;
}

/** 从 DOM 启发式读取题面顺序（如「请依次点击：黄瓜皮」「请按顺序点击"辰人鸟"」）。失败返回 null。 */
function readPromptOrderFromDom(captcha: DetectedCaptcha): string[] | null {
  const container = captcha.element as HTMLElement;
  const candidates: string[] = [];
  const scan = (el: Element | null, depth: number) => {
    if (!el || depth < 0) return;
    const text = (el.textContent || '').trim();
    if (text && text.length <= 40) candidates.push(text);
  };
  scan(container, 1);
  scan(container.previousElementSibling, 0);
  scan(container.parentElement, 0);

  // 解析优先级：引号内容 > 冒号后内容 > 剥离指令词后的剩余。
  // 每种方式得到候选串后，仍会再剥一遍指令词，防止 "点击文字：春夏" 这类把指令字裹进来。
  const extractTargets = (text: string): string[] | null => {
    // 1) 引号内（中英文引号、书名号）——题面里目标字常被引号包裹
    const quoted = text.match(/[「『"'""']([^「』"'""']{1,12})[」』"'""']/);
    if (quoted && quoted[1]) {
      const chars = splitChars(stripInstructionWords(quoted[1]));
      if (chars.length >= 1) return chars;
    }
    // 2) 冒号后内容
    const afterColon = text.match(/[：:]\s*(.+)$/);
    if (afterColon && afterColon[1]) {
      const chars = splitChars(stripInstructionWords(afterColon[1]));
      if (chars.length >= 1) return chars;
    }
    // 3) 整体剥离指令词，剩余即目标（如 "请点击春夏" → "春夏"）。
    //    若题面只有纯指令（如 "请按从上到下顺序点击文字"），剥完为空 → 返回 null，
    //    交由 recognizePromptImage 兜底（这类题目目标渲染在图里，不在 DOM 文本）。
    const stripped = splitChars(stripInstructionWords(text));
    if (stripped.length >= 1) return stripped;
    return null;
  };

  for (const text of candidates) {
    // 必须先确认这是一条「点选指令」文本，避免把无关 DOM 文本当题面
    if (!/(依次|顺序|点击|点选|选择|选中)/.test(text)) continue;
    const targets = extractTargets(text);
    if (targets && targets.length >= 1) return targets;
  }
  return null;
}

export async function solveClickSelect(
  captcha: DetectedCaptcha,
  opts: ClickSelectOptions,
): Promise<ClickSelectResult> {
  const log = opts.onLog || (() => {});

  const imgEl = captcha.innerCanvas;
  if (!imgEl) return { success: false, reason: 'no-image' };
  const image = elementToImageData(imgEl);
  if (!image) {
    log('点选主图不可读（跨域 tainted canvas）');
    return { success: false, reason: 'tainted-canvas' };
  }

  // 1. 题面顺序
  let order: string[] | undefined = opts.promptOrder && opts.promptOrder.length ? opts.promptOrder : undefined;
  if (!order) {
    const fromDom = readPromptOrderFromDom(captcha);
    if (fromDom) {
      order = fromDom;
      log(`从 DOM 读到题序: ${order.join('')}`);
    }
  }
  if (!order && opts.recognizePromptImage && opts.promptImage) {
    const txt = await opts.recognizePromptImage(opts.promptImage);
    order = splitChars(txt);
    log(`OCR 题图得到题序: ${order.join('')}`);
  }
  if (!order || order.length === 0) return { success: false, reason: 'no-prompt-order' };

  // 2. 检测 + 标字
  const labeled = await opts.labelBoxes(image);
  const detected = labeled.map((b) => b.char || '?').join('');
  log(`检测到 ${labeled.length} 个候选框: ${detected}`);
  if (labeled.length === 0) return { success: false, reason: 'no-boxes', detected };

  // 3. 按题序匹配
  const used = new Set<number>();
  const chosen: LabeledBox[] = [];
  for (const target of order) {
    let bestIdx = -1;
    let bestConf = -1;
    for (let i = 0; i < labeled.length; i++) {
      if (used.has(i)) continue;
      if (charMatch(labeled[i].char, target) && labeled[i].conf > bestConf) {
        bestIdx = i;
        bestConf = labeled[i].conf;
      }
    }
    if (bestIdx < 0) {
      log(`题面字符「${target}」未在候选框中找到`);
      return { success: false, reason: `unmatched:${target}`, detected };
    }
    used.add(bestIdx);
    chosen.push(labeled[bestIdx]);
  }

  // 4. 逐个点击（主图像素系 → 视口坐标）
  const rect = imgEl.getBoundingClientRect();
  const scaleX = rect.width / image.width;
  const scaleY = rect.height / image.height;
  const rootDoc = imgEl.ownerDocument || document;
  const [gapMin, gapMax] = opts.clickGap ?? [180, 360];

  const clicks: { x: number; y: number; char: string }[] = [];
  let from: Point = { x: rect.left - 30, y: rect.top - 30 };
  for (const b of chosen) {
    const cx = rect.left + (b.x + b.w / 2) * scaleX;
    const cy = rect.top + (b.y + b.h / 2) * scaleY;
    const path = bezierPath(from, { x: cx, y: cy }, 22 + Math.floor(Math.random() * 10));
    await moveAndClick(path, rootDoc);
    clicks.push({ x: cx, y: cy, char: b.char });
    log(`点击「${b.char}」@ (${cx.toFixed(0)}, ${cy.toFixed(0)})`);
    from = { x: cx, y: cy };
    await delay(gapMin + Math.random() * (gapMax - gapMin));
  }

  return { success: true, clicks, detected };
}
