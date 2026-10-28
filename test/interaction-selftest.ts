#!/usr/bin/env bun
/**
 * 滑块 / 文字点选 基础识别自测（无浏览器）。
 *
 * 覆盖：
 *  1. 订阅规则包字段校验（slider / click-select / detModel）
 *  2. 滑块缺口 slideMatch 准确率（合成拼图）
 *  3. 文字点选 det + OCR 标注通过率（合成点选图）
 *
 * 用法：
 *   bun test/interaction-selftest.ts
 *   bun test/interaction-selftest.ts --slider-n 40 --click-n 8
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createCanvas, Image, loadImage } from '@napi-rs/canvas';
import { OCREngine } from '../src/core/ocr-engine';
import { DetectionEngine } from '../src/core/detection-engine';
import * as ort from 'onnxruntime-node';

import { slideMatch, type ImageLike } from '../src/core/slide-detector';
import { validateRulePackage } from '../src/core/subscription';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

// ─── CLI ─────────────────────────────────────────────────────────────────────

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) return def;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : def;
}

let randomState = argNum('--seed', 20260908) >>> 0;
function random(): number {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState / 4294967296;
}

const SLIDER_N = argNum('--slider-n', 40);
const CLICK_N = argNum('--click-n', 8);
const SLIDER_TOL = argNum('--slider-tol', 6); // px

// ─── 路径 ────────────────────────────────────────────────────────────────────

const SUB_PATH = resolve(__dirname, 'subscription.json');
const OCR_MODEL = resolve(REPO, 'public/common.onnx');
const CHARSETS = resolve(REPO, 'public/charsets.json');
const DET_MODEL = existsSync(resolve(__dirname, 'fixtures/common_det.onnx'))
  ? resolve(__dirname, 'fixtures/common_det.onnx')
  : resolve(REPO, 'public/common_det.onnx');

// ─── 日志 ────────────────────────────────────────────────────────────────────

const C = {
  g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  r: (s: string) => `\x1b[31m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`,
  d: (s: string) => `\x1b[90m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function ok(msg: string) { console.log(C.g('✓'), msg); }
function fail(msg: string) { console.log(C.r('✗'), msg); }
function info(msg: string) { console.log(C.d('·'), msg); }
function head(msg: string) { console.log('\n' + C.b(msg)); }

// ─── 1. 订阅规则校验 ─────────────────────────────────────────────────────────

function testSubscription(): boolean {
  head('① 订阅规则包（slider / click-select / detModel）');
  if (!existsSync(SUB_PATH)) {
    fail(`找不到 ${SUB_PATH}`);
    return false;
  }
  const raw = JSON.parse(readFileSync(SUB_PATH, 'utf-8'));
  const { valid, error, pkg } = validateRulePackage(raw);
  if (!valid || !pkg) {
    fail(`validateRulePackage 失败: ${error || 'unknown'}`);
    return false;
  }
  ok(`包名=${pkg.name} version=${pkg.version}`);

  let pass = true;
  if (!pkg.detModel?.url) {
    fail('缺少 detModel.url（文字点选需要）');
    pass = false;
  } else {
    ok(`detModel.url=${pkg.detModel.url}`);
    if (pkg.detModel.sha256) ok(`detModel.sha256=${pkg.detModel.sha256.slice(0, 16)}…`);
    else console.log(C.y('!'), 'detModel.sha256 未填（建议填）');
  }

  const rules = pkg.siteRules || {};
  const sliders = Object.entries(rules).filter(([, r]) => (r as any).subType === 'slider');
  const clicks = Object.entries(rules).filter(([, r]) => (r as any).subType === 'click-select');
  if (sliders.length === 0) { fail('siteRules 中无 subType=slider'); pass = false; }
  else ok(`slider 规则 ${sliders.length} 条: ${sliders.map(([k]) => k).join(', ')}`);
  if (clicks.length === 0) { fail('siteRules 中无 subType=click-select'); pass = false; }
  else ok(`click-select 规则 ${clicks.length} 条: ${clicks.map(([k]) => k).join(', ')}`);

  for (const [key, r] of [...sliders, ...clicks]) {
    const rule = r as any;
    if (!rule.selector) { fail(`${key}: 缺 selector`); pass = false; }
    if (!rule.hostname && !rule.urlPattern && !rule.fullUrl) {
      fail(`${key}: 缺 hostname/urlPattern/fullUrl`);
      pass = false;
    }
  }
  return pass;
}

// ─── 2. 滑块缺口识别 ─────────────────────────────────────────────────────────

const BG_W = 320, BG_H = 160, TPL = 60;

function puzzlePath(ctx: any, w: number, h: number): void {
  const r = w * 0.18;
  const cx = w / 2, cy = h / 2;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(cx - r, 0);
  ctx.arc(cx, 0, r, Math.PI, 0, true);
  ctx.lineTo(w, 0);
  ctx.lineTo(w, cy - r);
  ctx.arc(w, cy, r, Math.PI * 1.5, Math.PI * 0.5, true);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
}

export function renderSliderPuzzle(): { bg: ImageLike; piece: ImageLike; gapX: number; gapY: number } {
  const gapX = 90 + Math.floor(random() * (BG_W - TPL - 110));
  const gapY = Math.floor((BG_H - TPL) / 2 + (random() - 0.5) * 30);

  const bgC = createCanvas(BG_W, BG_H);
  const bctx = bgC.getContext('2d');
  const grad = bctx.createLinearGradient(0, 0, BG_W, BG_H);
  grad.addColorStop(0, '#43cea2');
  grad.addColorStop(1, '#185a9d');
  bctx.fillStyle = grad;
  bctx.fillRect(0, 0, BG_W, BG_H);
  for (let i = 0; i < 80; i++) {
    bctx.fillStyle = `rgba(255,255,255,${0.05 + random() * 0.25})`;
    bctx.beginPath();
    bctx.arc(random() * BG_W, random() * BG_H, 3 + random() * 16, 0, Math.PI * 2);
    bctx.fill();
  }
  for (let i = 0; i < 6; i++) {
    bctx.strokeStyle = `rgba(0,0,0,${0.1 + random() * 0.2})`;
    bctx.lineWidth = 1;
    bctx.beginPath();
    bctx.moveTo(random() * BG_W, 0);
    bctx.lineTo(random() * BG_W, BG_H);
    bctx.stroke();
  }

  // 滑块小图（透明底）
  const slC = createCanvas(TPL, BG_H);
  const sctx = slC.getContext('2d');
  sctx.clearRect(0, 0, TPL, BG_H);
  sctx.save();
  sctx.translate(0, gapY);
  puzzlePath(sctx, TPL, TPL);
  sctx.clip();
  sctx.drawImage(bgC, gapX, gapY, TPL, TPL, 0, 0, TPL, TPL);
  sctx.restore();

  // 背景挖缺口
  bctx.save();
  bctx.translate(gapX, gapY);
  puzzlePath(bctx, TPL, TPL);
  bctx.fillStyle = 'rgba(0,0,0,0.5)';
  bctx.fill();
  bctx.strokeStyle = 'rgba(0,0,0,0.85)';
  bctx.lineWidth = 2;
  bctx.stroke();
  bctx.restore();

  const bgImg = bctx.getImageData(0, 0, BG_W, BG_H);
  const pieceImg = sctx.getImageData(0, 0, TPL, BG_H);
  return {
    bg: { data: new Uint8ClampedArray(bgImg.data), width: BG_W, height: BG_H },
    piece: { data: new Uint8ClampedArray(pieceImg.data), width: TPL, height: BG_H },
    gapX,
    gapY,
  };
}

function testSlider(): boolean {
  head(`② 滑块缺口识别（slideMatch × ${SLIDER_N}，容差 ≤${SLIDER_TOL}px）`);
  let okCount = 0;
  let totalErr = 0;
  let totalMs = 0;
  const samples: number[] = [];

  for (let i = 0; i < SLIDER_N; i++) {
    const { bg, piece, gapX } = renderSliderPuzzle();
    const m = slideMatch(piece, bg);
    const err = Math.abs(m.x - gapX);
    samples.push(err);
    totalErr += err;
    totalMs += m.elapsed;
    if (err <= SLIDER_TOL) okCount++;
  }

  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  const acc = (okCount / SLIDER_N) * 100;
  const avg = totalErr / SLIDER_N;
  const avgMs = totalMs / SLIDER_N;

  info(`成功率 ${acc.toFixed(1)}% (${okCount}/${SLIDER_N})  平均误差 ${avg.toFixed(2)}px  p50=${p50.toFixed(1)} p95=${p95.toFixed(1)}  平均 ${avgMs.toFixed(1)}ms`);

  // 合成图应接近 100%；阈值放宽到 90% 以免边缘噪声偶发失败
  if (acc >= 90) {
    ok(`滑块缺口识别通过（≥90%）`);
    return true;
  }
  fail(`滑块缺口识别失败：成功率 ${acc.toFixed(1)}% < 90%`);
  return false;
}

// ─── 3. 文字点选 det + OCR ───────────────────────────────────────────────────

const CS_POOL = '天地人和山水风云日月星辰花鸟鱼虫春夏秋冬东南西北中上下左右大小多少';
const CS_K = 6;
const CS_W = 300;
const CS_H = 200;

interface CsTruth { char: string; cx: number; cy: number; r: number }

function renderClickSelect(): { image: ImageLike; truth: CsTruth[]; order: string[] } {
  const canvas = createCanvas(CS_W, CS_H);
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, CS_W, CS_H);
  grad.addColorStop(0, '#eef3f8');
  grad.addColorStop(1, '#dde6f0');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CS_W, CS_H);
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(120,140,170,${0.04 + random() * 0.10})`;
    ctx.beginPath();
    ctx.arc(random() * CS_W, random() * CS_H, 4 + random() * 14, 0, Math.PI * 2);
    ctx.fill();
  }

  const pool = Array.from(CS_POOL);
  const chosen: string[] = [];
  while (chosen.length < CS_K) {
    const c = pool[Math.floor(random() * pool.length)];
    if (!chosen.includes(c)) chosen.push(c);
  }

  const cols = 3, rows = 2, cellW = CS_W / cols, cellH = CS_H / rows, font = 38;
  const truth: CsTruth[] = [];
  chosen.forEach((ch, idx) => {
    const col = idx % cols, row = Math.floor(idx / cols);
    const cx = cellW * col + cellW / 2 + (random() - 0.5) * cellW * 0.35;
    const cy = cellH * row + cellH / 2 + (random() - 0.5) * cellH * 0.35;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((random() - 0.5) * 0.35);
    ctx.font = `bold ${font}px "Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `hsl(${Math.floor(random() * 360)},70%,26%)`;
    ctx.fillText(ch, 0, 0);
    ctx.restore();
    truth.push({ char: ch, cx, cy, r: font * 0.75 });
  });

  const order = chosen.slice().sort(() => random() - 0.5).slice(0, 3);
  const img = ctx.getImageData(0, 0, CS_W, CS_H);
  return {
    image: { data: new Uint8ClampedArray(img.data), width: CS_W, height: CS_H },
    truth,
    order,
  };
}

// Keep preprocessing and decoding identical to the extension; only adapt DOM and runtime.
(globalThis as any).HTMLImageElement = Image;
(globalThis as any).document = { createElement: () => createCanvas(1, 1) };
const nodeOrt = {
  env: { wasm: {} },
  Tensor: ort.Tensor,
  InferenceSession: {
    create: (model: ArrayBuffer) => ort.InferenceSession.create(new Uint8Array(model), {
      executionProviders: ['cpu'], graphOptimizationLevel: 'all',
    }),
  },
};

class NodeDet {
  private engine!: DetectionEngine;
  async init(modelPath: string) {
    this.engine = new DetectionEngine({
      getOrt: async () => nodeOrt,
      getModel: async () => ({ model: new Uint8Array(readFileSync(modelPath)).buffer }),
    });
    await this.engine.init();
  }
  detect(image: ImageLike) { return this.engine.detect(image); }
  destroy() { return this.engine.destroy(); }
}

class NodeOcr {
  private engine!: OCREngine;
  async init(modelPath: string, charsetsPath: string) {
    this.engine = new OCREngine({
      getOrt: async () => nodeOrt,
      getModel: async () => ({
        model: new Uint8Array(readFileSync(modelPath)).buffer,
        charsets: JSON.parse(readFileSync(charsetsPath, 'utf8')),
      }),
    });
    await this.engine.init();
  }

  async recognizeCrop(image: ImageLike, box: { x: number; y: number; w: number; h: number }): Promise<string> {
    const sx = Math.max(0, Math.round(box.x)), sy = Math.max(0, Math.round(box.y));
    const sw = Math.max(1, Math.round(box.w)), sh = Math.max(1, Math.round(box.h));
    const pad = Math.max(2, Math.round(Math.min(sw, sh) * 0.15));
    const cw = sw + pad * 2, ch = sh + pad * 2;
    const crop = createCanvas(cw, ch), ctx = crop.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    const full = createCanvas(image.width, image.height), fullCtx = full.getContext('2d');
    const pixels = fullCtx.createImageData(image.width, image.height);
    pixels.data.set(image.data);
    fullCtx.putImageData(pixels, 0, 0);
    ctx.drawImage(full, sx - pad, sy - pad, cw, ch, 0, 0, cw, ch);
    const input = await loadImage(crop.toBuffer('image/png'));
    return (await this.engine.recognize(input as unknown as HTMLImageElement)).text;
  }
  destroy() { return this.engine.destroy(); }
}

async function testClickSelect(): Promise<boolean> {
  head(`③ 文字点选识别（det + OCR × ${CLICK_N}）`);
  if (!existsSync(DET_MODEL)) {
    fail(`找不到 det 模型: ${DET_MODEL}`);
    return false;
  }
  if (!existsSync(OCR_MODEL) || !existsSync(CHARSETS)) {
    fail(`找不到 OCR 模型或 charsets`);
    return false;
  }

  info('加载 common_det.onnx …');
  const det = new NodeDet();
  await det.init(DET_MODEL);
  ok('det 就绪');

  info('加载 common.onnx …');
  const ocr = new NodeOcr();
  await ocr.init(OCR_MODEL, CHARSETS);
  ok('ocr 就绪');

  let detHits = 0;      // 检出框数接近真值的次数
  let charCorrect = 0;  // 正确识别的字符数
  let charTotal = 0;
  let orderOk = 0;      // 题面 3 字全命中
  let samples = 0;

  for (let i = 0; i < CLICK_N; i++) {
    const { image, truth, order } = renderClickSelect();
    const boxes = await det.detect(image);
    samples++;

    // 把检测框匹配到最近真值字符
    const labeled: { char: string; truth?: string }[] = [];
    for (const b of boxes) {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      let best: CsTruth | null = null;
      let bestD = Infinity;
      for (const t of truth) {
        const d = Math.hypot(cx - t.cx, cy - t.cy);
        if (d < bestD) { bestD = d; best = t; }
      }
      const rec = await ocr.recognizeCrop(image, b);
      // OCR 可能返回多字，取第一个
      const ch = (rec || '').replace(/\s+/g, '')[0] || '';
      labeled.push({ char: ch, truth: best && bestD <= best.r ? best.char : undefined });
    }

    const detOk = boxes.length >= Math.max(1, truth.length - 1) && boxes.length <= truth.length + 2;
    if (detOk) detHits++;

    // 按真值字符核对 OCR（用落在框内的真值）
    const recognizedMap = new Map<string, string>();
    for (const l of labeled) {
      if (l.truth) {
        charTotal++;
        if (l.char === l.truth) {
          charCorrect++;
          recognizedMap.set(l.truth, l.char);
        }
      }
    }
    // 题面顺序是否都能在识别结果中找到
    const allFound = order.every((c) => recognizedMap.has(c) || labeled.some((l) => l.char === c));
    if (allFound) orderOk++;

    info(
      `  #${i + 1} det=${boxes.length}/${truth.length} 题面=${order.join('')} ` +
      `标注=${labeled.map((l) => l.char || '?').join('') || '—'} ` +
      `${allFound ? C.g('题面OK') : C.y('题面缺')}`,
    );
  }

  const detRate = (detHits / samples) * 100;
  const charRate = charTotal ? (charCorrect / charTotal) * 100 : 0;
  const orderRate = (orderOk / samples) * 100;
  info(`det 召回合格率 ${detRate.toFixed(0)}%  单字 OCR ${charRate.toFixed(0)}% (${charCorrect}/${charTotal})  题面可匹配 ${orderRate.toFixed(0)}%`);

  // 合成宋体/黑体字，OCR 通常较好；阈值保守
  await det.destroy();
  await ocr.destroy();
  const pass = detRate >= 70 && charTotal > 0 && charRate >= 50 && orderRate >= 50;
  if (pass) ok('文字点选识别通过（det≥70%、OCR≥50%、题面匹配≥50%）');
  else fail(`文字点选识别未达标：det=${detRate.toFixed(0)}% OCR=${charRate.toFixed(0)}%`);
  return pass;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(C.b('Mieru-OCR 滑块 / 点选 基础识别自测'));
  console.log(C.d(`repo=${REPO}`));

  const results: { name: string; ok: boolean }[] = [];
  results.push({ name: '订阅规则', ok: testSubscription() });
  results.push({ name: '滑块缺口', ok: testSlider() });
  results.push({ name: '文字点选', ok: await testClickSelect() });

  head('汇总');
  let all = true;
  for (const r of results) {
    if (r.ok) ok(r.name);
    else { fail(r.name); all = false; }
  }
  process.exit(all ? 0 : 1);
}

if (import.meta.main) main().catch((e) => {
  console.error(e);
  process.exit(2);
});
