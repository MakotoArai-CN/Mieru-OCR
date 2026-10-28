/**
 * 旋转拼图基准（手动运行，不属于 `bun test` 用例）：
 *
 *   bun test/rotation-bench.ts
 *
 * 结论（2026-10，见表格）：
 *   - 现有管线（边缘 NCC + 内容校验 + 内容直搜）在拼图块被旋转 ±20° 时仍稳定命中，
 *     平均误差 ≤1.5px；±25° 开始出现个例退化，±35° 才明显变差。
 *   - 曾实现「按候选角度转回再匹配」的补偿分支：15 个角度 × 3 种形状 × 4 seeds
 *     的夹具上修复 0 例、破坏 8 例（±20° 时把 1.5px 顶到 7px），已回退。
 *
 * 本文件保留为旋转鲁棒性的证据工具：改动匹配管线（尤其内容校验/直搜）后重跑一次，
 * 确认小角度旋转没有回归。真正的「旋转对齐」是另一种题型（目标是角度而非水平位移），
 * 需要独立求解器，不在本题范围内。
 */

import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { alphaBBox, slideMatch } from '../src/core/slide-detector';

const W = 300;
const H = 160;
const S = 50;
const PAD = 20;
const TOL = 6;

type Shape = 'circle' | 'jigsaw' | 'rect';

interface ImageLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toImageLike(canvas: Canvas): ImageLike {
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  return { data: new Uint8ClampedArray(d.data), width: canvas.width, height: canvas.height };
}

function paintBackground(rand: () => number): Canvas {
  const c = createCanvas(W, H);
  const b = c.getContext('2d');
  const g = b.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0b1a33');
  g.addColorStop(0.55, '#1f4e79');
  g.addColorStop(1, '#7fb3d5');
  b.fillStyle = g;
  b.fillRect(0, 0, W, H);
  for (let i = 0; i < 140; i++) {
    b.fillStyle = `hsla(${Math.floor(rand() * 360)},${60 + rand() * 35}%,${25 + rand() * 55}%,${0.7 + rand() * 0.25})`;
    const x = rand() * W;
    const y = rand() * H;
    const w = 6 + rand() * 42;
    const h = 6 + rand() * 36;
    if (rand() < 0.5) b.fillRect(x, y, w, h);
    else {
      b.beginPath();
      b.ellipse(x, y, w / 2, h / 2, rand() * 3.14, 0, Math.PI * 2);
      b.fill();
    }
  }
  for (let i = 0; i < 1500; i++) {
    b.fillStyle = `rgba(255,255,255,${rand() * 0.14})`;
    b.fillRect(rand() * W, rand() * H, 1 + rand() * 2, 1 + rand() * 2);
  }
  return c;
}

/** 在 (x,y) 处画一个 S×S 的拼图轮廓；jigsaw 的"凹弧"从顶边挖进去。 */
function shapePath(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, shape: Shape): void {
  ctx.beginPath();
  if (shape === 'circle') {
    ctx.arc(x + s / 2, y + s / 2, s / 2 - 2, 0, Math.PI * 2);
    return;
  }
  if (shape === 'rect') {
    const r = 8;
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + s - r, y);
    ctx.quadraticCurveTo(x + s, y, x + s, y + r);
    ctx.lineTo(x + s, y + s - r);
    ctx.quadraticCurveTo(x + s, y + s, x + s - r, y + s);
    ctx.lineTo(x + r, y + s);
    ctx.quadraticCurveTo(x, y + s, x, y + s - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    return;
  }
  const r = s * 0.18;
  ctx.moveTo(x, y);
  ctx.lineTo(x + s / 2 - r, y);
  ctx.arc(x + s / 2, y, r, Math.PI, 0, false);
  ctx.lineTo(x + s, y);
  ctx.lineTo(x + s, y + s);
  ctx.lineTo(x, y + s);
  ctx.closePath();
}

interface Fixture {
  piece: ImageLike;
  bg: ImageLike;
  expectedX: number;
  expectedY: number;
}

function buildFixture(seed: number, shape: Shape, angle: number): Fixture {
  const rand = rng(seed);
  const bg = paintBackground(rand);
  const b = bg.getContext('2d');
  const gapX = 60 + Math.floor(rand() * (W - S - 120));
  const gapY = 25 + Math.floor(rand() * (H - S - 50));

  const size = S + PAD * 2;
  const piece = createCanvas(size, size);
  const p = piece.getContext('2d');
  p.save();
  shapePath(p, PAD, PAD, S, shape);
  p.clip();
  p.drawImage(bg, gapX, gapY, S, S, PAD, PAD, S, S);
  p.restore();

  const mask = createCanvas(size, size);
  shapePath(mask.getContext('2d'), PAD, PAD, S, shape);
  mask.getContext('2d').fill();
  p.globalCompositeOperation = 'destination-in';
  p.drawImage(mask, 0, 0);
  p.globalCompositeOperation = 'source-over';
  p.lineWidth = 3;
  p.strokeStyle = 'rgba(255,255,255,.92)';
  shapePath(p, PAD, PAD, S, shape);
  p.stroke();

  let rotated = piece;
  if (angle !== 0) {
    rotated = createCanvas(size, size);
    const rc = rotated.getContext('2d');
    rc.translate(size / 2, size / 2);
    rc.rotate((angle * Math.PI) / 180);
    rc.drawImage(piece, -size / 2, -size / 2);
  }

  b.save();
  b.lineWidth = 3;
  b.strokeStyle = 'rgba(255,255,255,.95)';
  b.shadowColor = 'rgba(0,0,0,.5)';
  b.shadowBlur = 6;
  shapePath(b, gapX, gapY, S, shape);
  b.stroke();
  b.restore();

  const like = toImageLike(rotated);
  const bbox = alphaBBox(like);
  return {
    piece: like,
    bg: toImageLike(bg),
    // 拼图块的画布左上角对应背景的 (gapX - PAD, gapY - PAD)；bbox 再叠加自身偏移。
    expectedX: gapX - PAD + (bbox?.x ?? 0),
    expectedY: gapY - PAD + (bbox?.y ?? 0),
  };
}

const SHAPES: Shape[] = ['jigsaw', 'circle', 'rect'];
const ANGLES = [-35, -25, -20, -14, -10, -6, 0, 6, 10, 14, 20, 25, 35];
const SEEDS = [11, 29, 47, 83];
const PER_ANGLE = SHAPES.length * SEEDS.length;

console.log('| 角度 | 命中 | 平均误差 | 最大误差 |');
const sep = '|' + '----'.padEnd(6, '-') + '|' + '----'.padEnd(6, '-') + '|' + '----'.padEnd(6, '-') + '|' + '----'.padEnd(6, '-') + '|';
console.log(sep);

let allOk = 0;
let allTotal = 0;
for (const angle of ANGLES) {
  let ok = 0;
  const errors: number[] = [];
  for (const shape of SHAPES) {
    for (const seed of SEEDS) {
      const f = buildFixture(seed * 101 + 7, shape, angle);
      const m = slideMatch(f.piece, f.bg);
      const err = Math.abs(m.x - f.expectedX);
      errors.push(err);
      if (err <= TOL) ok++;
    }
  }
  allOk += ok;
  allTotal += PER_ANGLE;
  const avg = (errors.reduce((a, b) => a + b, 0) / errors.length).toFixed(1);
  const max = Math.max(...errors).toFixed(1);
  console.log(`| ${angle.toString().padStart(3)}° | ${ok}/${PER_ANGLE} | ${avg}px | ${max}px |`);
}

console.log('');
console.log(`合计命中 ${allOk}/${allTotal}（容差 ±${TOL}px）`);
