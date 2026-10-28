import { expect, test } from 'bun:test';
import { createCanvas } from '@napi-rs/canvas';
import { maskedContentScore, matchTemplate, slideMatch, type ImageLike } from '../src/core/slide-detector';

/**
 * 拼图滑块回归：背景 = 渐变 + 随机色块/椭圆 + 噪点，拼图块 = 从缺口处裁出的圆形碎片。
 * 其中 "circles" 模式用规则圆斑模拟重复纹理背景——早期算法在这种背景上会出现
 * 竞争峰（最高分位置不是缺口），靠 contentScore 校验 + 灰度路径复算才能纠正。
 */
const W = 300, H = 150, S = 50;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toImageLike(canvas: ReturnType<typeof createCanvas>): ImageLike {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  return { data: new Uint8ClampedArray(data.data), width: canvas.width, height: canvas.height };
}

function makePuzzle(seed: number, pattern: 'photo' | 'circles') {
  const rand = mulberry32(seed);
  const bg = createCanvas(W, H);
  const b = bg.getContext('2d');
  const grad = b.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0b1a33');
  grad.addColorStop(0.55, '#1f4e79');
  grad.addColorStop(1, '#7fb3d5');
  b.fillStyle = grad;
  b.fillRect(0, 0, W, H);

  if (pattern === 'circles') {
    for (let i = 0; i < 26; i++) {
      b.beginPath();
      b.fillStyle = `hsla(${(i * 53) % 360}, 75%, ${35 + ((i * 17) % 35)}%, .9)`;
      b.arc(((i * 71) + 23) % W, ((i * 43) + 11) % H, 8 + ((i * 7) % 26), 0, Math.PI * 2);
      b.fill();
    }
  } else {
    for (let i = 0; i < 120; i++) {
      b.fillStyle = `hsla(${Math.floor(rand() * 360)}, ${60 + rand() * 35}%, ${25 + rand() * 55}%, ${0.65 + rand() * 0.3})`;
      const x = rand() * W;
      const y = rand() * H;
      const w = 6 + rand() * 42;
      const h = 6 + rand() * 36;
      if (rand() < 0.5) {
        b.fillRect(x, y, w, h);
      } else {
        b.beginPath();
        b.ellipse(x, y, w / 2, h / 2, rand() * 3.14, 0, Math.PI * 2);
        b.fill();
      }
    }
  }
  for (let i = 0; i < 1200; i++) {
    b.fillStyle = `rgba(255,255,255,${rand() * 0.14})`;
    b.fillRect(rand() * W, rand() * H, 1 + rand() * 2, 1 + rand() * 2);
  }

  const gapX = 70 + Math.floor(rand() * (W - S - 120));
  const gapY = 15 + Math.floor(rand() * (H - S - 30));

  const piece = createCanvas(S, S);
  const p = piece.getContext('2d');
  p.drawImage(bg, gapX, gapY, S, S, 0, 0, S, S);
  p.globalCompositeOperation = 'destination-in';
  p.beginPath();
  p.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
  p.fill();
  p.globalCompositeOperation = 'source-over';
  p.lineWidth = 3;
  p.strokeStyle = 'rgba(255,255,255,.92)';
  p.beginPath();
  p.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
  p.stroke();

  b.save();
  b.lineWidth = 3;
  b.strokeStyle = 'rgba(255,255,255,.95)';
  b.shadowColor = 'rgba(0,0,0,.5)';
  b.shadowBlur = 6;
  b.beginPath();
  b.arc(gapX + S / 2, gapY + S / 2, S / 2 - 2, 0, Math.PI * 2);
  b.stroke();
  b.restore();

  return { bgCanvas: bg, pieceCanvas: piece, gapX, gapY };
}

test('maskedContentScore peaks at the real gap and drops off elsewhere', () => {
  const { bgCanvas, pieceCanvas, gapX, gapY } = makePuzzle(7919, 'photo');
  const bg = toImageLike(bgCanvas);
  const piece = toImageLike(pieceCanvas);

  const atGap = maskedContentScore(bg, piece, gapX, gapY);
  expect(atGap).toBeGreaterThan(0.95);
  expect(maskedContentScore(bg, piece, gapX + 25, gapY)).toBeLessThan(0.5);
  expect(maskedContentScore(bg, piece, gapX, gapY + 30)).toBeLessThan(0.5);
});

test('slideMatch lands within tolerance on photo-like backgrounds', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const { bgCanvas, pieceCanvas, gapX, gapY } = makePuzzle(seed * 7919, 'photo');
    const result = slideMatch(toImageLike(pieceCanvas), toImageLike(bgCanvas));
    expect(Math.abs(result.x - gapX)).toBeLessThanOrEqual(6);
    expect(Math.abs(result.y - gapY)).toBeLessThanOrEqual(6);
    expect(result.contentScore).toBeGreaterThan(0.9);
  }
});

test('slideMatch survives repetitive backgrounds that produce competing peaks', () => {
  // 规则圆斑背景：纯边缘匹配会把缺口定到错误位置，内容校验必须能纠正。
  for (let seed = 1; seed <= 4; seed++) {
    const { bgCanvas, pieceCanvas, gapX, gapY } = makePuzzle(seed * 104729, 'circles');
    const result = slideMatch(toImageLike(pieceCanvas), toImageLike(bgCanvas));
    expect(Math.abs(result.x - gapX)).toBeLessThanOrEqual(6);
    expect(Math.abs(result.y - gapY)).toBeLessThanOrEqual(6);
    expect(result.contentScore).toBeGreaterThan(0.9);
  }
});

test('matchTemplate reports a runner-up peak for repeated content', () => {
  // 完全重复的图案：两个不重叠位置得分相同，margin 应接近 0。
  const width = 40, height = 10;
  const image = { width, height, data: new Float32Array(width * height) };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) image.data[y * width + x] = x % 10;
  }
  const template = { width: 10, height: 10, data: Float32Array.from({ length: 100 }, (_, i) => i % 10) };
  const result = matchTemplate(image, template);
  expect(result.secondScore).toBeGreaterThan(0.9);
  expect(result.score - result.secondScore).toBeLessThan(0.05);
});
