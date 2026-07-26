#!/usr/bin/env bun
/**
 * Unified DDDDOCR Model Benchmark
 *
 * Replays the EXACT preprocessing + decode pipeline used by the browser
 * extension and userscript (see src/core/image-processor.ts +
 * src/core/ocr-engine.ts), so accuracy/speed numbers reported here reflect
 * what users will see in production — not a parallel pipeline that drifts.
 *
 * Runs every model registered in BUNDLED_MODELS against benchmark_dataset/
 * (manifest at benchmark_dataset/captchas.json).
 *
 *   bun run benchmark_unified.ts
 *   bun run benchmark_unified.ts --warmup 10 --json out.json
 *   bun run benchmark_unified.ts --models common,common_small
 */

import { readFileSync, existsSync, statSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { createRequire } from 'module';

// Use createRequire so this script works under both Node ESM and Bun.
// onnxruntime-node and @napi-rs/canvas are CJS-only, and Bun's `require`
// exists in ESM but Node's does not.
const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node');
const { loadImage, createCanvas } = require('@napi-rs/canvas');

// ─── Bundled model registry (must match src/extension/model-store.ts) ────────

interface ModelEntry {
  id: string;
  name: string;
  modelFile: string;
  charsetsFile: string;
  fixedWidth?: number;
  preprocess?: 'simple' | 'standardize';
  preprocessMean?: number;
  preprocessStd?: number;
}

const BUNDLED: ModelEntry[] = [
  {
    id: 'common',
    name: 'common (默认)',
    modelFile: 'public/common.onnx',
    charsetsFile: 'public/charsets.json',
  },
  {
    id: 'common_small',
    name: 'common_small (轻量)',
    modelFile: 'public/common_small.onnx',
    charsetsFile: 'public/charsets_small.json',
  },
  {
    id: 'extreme_v6',
    name: 'extreme v6 (实验)',
    modelFile: 'public/model_extreme_v6.onnx',
    charsetsFile: 'public/charsets_extreme_v6.json',
    fixedWidth: 192,
    preprocess: 'standardize',
    preprocessMean: 0.456,
    preprocessStd: 0.224,
  },
];

// ─── Mirrored preprocessing (see src/core/image-processor.ts) ────────────────

function toGrayscale(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const gray = new Uint8ClampedArray(rgba.length / 4);
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
    const alpha = a / 255;
    const rr = r * alpha + 255 * (1 - alpha);
    const gg = g * alpha + 255 * (1 - alpha);
    const bb = b * alpha + 255 * (1 - alpha);
    gray[i / 4] = Math.round(0.2126 * rr + 0.7152 * gg + 0.0722 * bb);
  }
  return gray;
}

function resizeBilinear(
  data: Uint8ClampedArray,
  width: number, height: number,
  newWidth: number, newHeight: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(newWidth * newHeight);
  const xRatio = width / newWidth;
  const yRatio = height / newHeight;
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      const px = x * xRatio, py = y * yRatio;
      const x1 = Math.floor(px), x2 = Math.min(x1 + 1, width - 1);
      const y1 = Math.floor(py), y2 = Math.min(y1 + 1, height - 1);
      const fx = px - x1, fy = py - y1;
      const v1 = data[y1 * width + x1];
      const v2 = data[y1 * width + x2];
      const v3 = data[y2 * width + x1];
      const v4 = data[y2 * width + x2];
      out[y * newWidth + x] = Math.round(
        v1 * (1 - fx) * (1 - fy) + v2 * fx * (1 - fy)
        + v3 * (1 - fx) * fy + v4 * fx * fy,
      );
    }
  }
  return out;
}

function normalize(data: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] / 255;
  return out;
}

function normalizeStd(data: Uint8ClampedArray, mean: number, std: number): Float32Array {
  const out = new Float32Array(data.length);
  const inv = 1 / std;
  for (let i = 0; i < data.length; i++) out[i] = (data[i] / 255 - mean) * inv;
  return out;
}

function padOrCropWidth(
  data: Float32Array, width: number, height: number,
  targetWidth: number, fillValue: number,
): Float32Array {
  if (width === targetWidth) return data;
  const out = new Float32Array(targetWidth * height);
  if (width < targetWidth) {
    out.fill(fillValue);
    for (let y = 0; y < height; y++) {
      const srcOff = y * width, dstOff = y * targetWidth;
      for (let x = 0; x < width; x++) out[dstOff + x] = data[srcOff + x];
    }
  } else {
    for (let y = 0; y < height; y++) {
      const srcOff = y * width, dstOff = y * targetWidth;
      for (let x = 0; x < targetWidth; x++) out[dstOff + x] = data[srcOff + x];
    }
  }
  return out;
}

async function loadAndPreprocess(
  pngPath: string,
  cfg: ModelEntry,
): Promise<{ tensor: Float32Array; finalWidth: number }> {
  const img = await loadImage(pngPath);
  // Replicate browser canvas: fillStyle = '#FFFFFF'; fillRect; drawImage
  const cnv = createCanvas(img.width, img.height);
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, img.width, img.height);
  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, img.width, img.height).data as Uint8ClampedArray;

  const gray = toGrayscale(rgba);
  const targetHeight = 64;
  let targetWidth = Math.floor(img.width * (targetHeight / img.height));
  if (targetWidth < 1) targetWidth = 1;
  const resized = resizeBilinear(gray, img.width, img.height, targetWidth, targetHeight);

  const style = cfg.preprocess ?? 'simple';
  let normalized: Float32Array;
  let fillValue = 1.0;
  if (style === 'standardize') {
    const mean = cfg.preprocessMean ?? 0.456;
    const std = cfg.preprocessStd ?? 0.224;
    normalized = normalizeStd(resized, mean, std);
    fillValue = (1.0 - mean) / std;
  } else {
    normalized = normalize(resized);
    fillValue = 1.0;
  }

  let finalWidth = targetWidth;
  if (cfg.fixedWidth) {
    normalized = padOrCropWidth(normalized, targetWidth, targetHeight, cfg.fixedWidth, fillValue);
    finalWidth = cfg.fixedWidth;
  }
  return { tensor: normalized, finalWidth };
}

// ─── CTC decode (matches src/core/ocr-engine.ts decodeOutput) ────────────────

function decodeCTC(data: any, charsets: string[]): string {
  const indices: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (typeof v === 'bigint') indices.push(Number(v));
    else if (typeof v === 'number') indices.push(Math.round(v));
    else indices.push(0);
  }
  const out: string[] = [];
  let prev = -1;
  for (const idx of indices) {
    if (idx === prev) continue;
    prev = idx;
    if (idx <= 0 || idx >= charsets.length) continue;
    const ch = charsets[idx];
    if (!ch) continue;
    out.push(ch);
  }
  return out.join('');
}

// ─── Levenshtein for soft-accuracy reporting ─────────────────────────────────

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
      prev = tmp;
    }
  }
  return dp[n];
}

// ─── Bench loop ──────────────────────────────────────────────────────────────

interface SampleResult {
  fileName: string;
  truth: string;
  pred: string;
  exact: boolean;
  edit: number;
  ms: number;
}

interface ModelReport {
  id: string;
  name: string;
  fileSize: number;
  loadMs: number;
  charsetSize: number;
  exactRate: number;
  charAcc: number;
  avgLev: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  errors: number;
  loadError?: string;
}

async function benchModel(
  cfg: ModelEntry,
  samples: Array<{ fileName: string; text: string }>,
  datasetDir: string,
  warmup: number,
  caseSensitive: boolean,
): Promise<{ report: ModelReport; details: SampleResult[] }> {
  const root = process.cwd();
  const modelPath = resolve(root, cfg.modelFile);
  const charsetsPath = resolve(root, cfg.charsetsFile);
  const fileSize = statSync(modelPath).size;
  const charsets: string[] = JSON.parse(readFileSync(charsetsPath, 'utf-8'));

  const t0 = performance.now();
  let session: any;
  try {
    session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
  } catch (e) {
    return {
      report: {
        id: cfg.id, name: cfg.name, fileSize, loadMs: performance.now() - t0,
        charsetSize: charsets.length, exactRate: 0, charAcc: 0, avgLev: 0,
        avgMs: 0, medianMs: 0, p95Ms: 0, p99Ms: 0, errors: samples.length,
        loadError: (e as Error).message,
      },
      details: [],
    };
  }
  const loadMs = performance.now() - t0;

  // Warmup with first sample
  const warmupSample = samples[0];
  for (let i = 0; i < warmup; i++) {
    try {
      const { tensor, finalWidth } = await loadAndPreprocess(join(datasetDir, warmupSample.fileName), cfg);
      const t = new ort.Tensor('float32', tensor, [1, 1, 64, finalWidth]);
      await session.run({ [session.inputNames[0]]: t });
    } catch { /* tolerate warmup misses */ }
  }

  const details: SampleResult[] = [];
  let errors = 0;
  let charCorrect = 0, charTotal = 0, exact = 0, levSum = 0;
  for (const s of samples) {
    try {
      const { tensor, finalWidth } = await loadAndPreprocess(join(datasetDir, s.fileName), cfg);
      const t = new ort.Tensor('float32', tensor, [1, 1, 64, finalWidth]);
      const t1 = performance.now();
      const out = await session.run({ [session.inputNames[0]]: t });
      const ms = performance.now() - t1;
      const outTensor = out[session.outputNames[0]];
      let pred = decodeCTC(outTensor.data, charsets);
      const truth = caseSensitive ? s.text : s.text.toLowerCase();
      const predCmp = caseSensitive ? pred : pred.toLowerCase();
      const ex = predCmp === truth;
      const editDist = lev(predCmp, truth);
      details.push({ fileName: s.fileName, truth: s.text, pred, exact: ex, edit: editDist, ms });
      if (ex) exact++;
      levSum += editDist;
      const minL = Math.min(predCmp.length, truth.length);
      for (let k = 0; k < minL; k++) if (predCmp[k] === truth[k]) charCorrect++;
      charTotal += truth.length;
    } catch (e) {
      errors++;
      details.push({ fileName: s.fileName, truth: s.text, pred: '<error: ' + (e as Error).message + '>', exact: false, edit: s.text.length, ms: 0 });
    }
  }

  const times = details.filter((d) => d.ms > 0).map((d) => d.ms).sort((a, b) => a - b);
  const pct = (p: number) => times.length ? times[Math.min(times.length - 1, Math.floor(times.length * p))] : 0;

  return {
    report: {
      id: cfg.id, name: cfg.name, fileSize, loadMs,
      charsetSize: charsets.length,
      exactRate: exact / samples.length,
      charAcc: charTotal > 0 ? charCorrect / charTotal : 0,
      avgLev: levSum / samples.length,
      avgMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
      medianMs: pct(0.5),
      p95Ms: pct(0.95),
      p99Ms: pct(0.99),
      errors,
    },
    details,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function parseArgs(): { warmup: number; caseSensitive: boolean; jsonOut?: string; models?: string[] } {
  const argv = (globalThis as any).Bun?.argv || (globalThis as any).process.argv;
  let warmup = 5;
  let caseSensitive = false;
  let jsonOut: string | undefined;
  let models: string[] | undefined;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--warmup') warmup = parseInt(argv[++i], 10);
    else if (a === '--case-sensitive') caseSensitive = true;
    else if (a === '--json') jsonOut = argv[++i];
    else if (a === '--models') models = argv[++i].split(',').map((s: string) => s.trim());
  }
  return { warmup, caseSensitive, jsonOut, models };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function main() {
  const { warmup, caseSensitive, jsonOut, models: modelFilter } = parseArgs();
  const root = process.cwd();
  const datasetDir = resolve(root, 'benchmark_dataset');
  const manifestPath = resolve(datasetDir, 'captchas.json');
  if (!existsSync(manifestPath)) {
    console.error(`benchmark_dataset/captchas.json 不存在 — 请先用 benchmark.ts 生成数据集`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const samples: Array<{ fileName: string; text: string }> = manifest.samples;

  const targets = modelFilter
    ? BUNDLED.filter((m) => modelFilter.includes(m.id) || modelFilter.includes(m.name))
    : BUNDLED;

  console.log(`\nUnified Benchmark — pipeline mirrors src/core/image-processor.ts + ocr-engine.ts`);
  console.log(`Dataset: ${datasetDir} (${samples.length} samples)`);
  console.log(`Warmup: ${warmup}  CaseSensitive: ${caseSensitive}`);
  console.log(`Runtime: onnxruntime-node CPU EP\n`);

  const reports: ModelReport[] = [];
  for (const cfg of targets) {
    const modelPath = resolve(root, cfg.modelFile);
    if (!existsSync(modelPath)) {
      console.warn(`  [skip] ${cfg.name}: model file missing (${cfg.modelFile})`);
      continue;
    }
    process.stdout.write(`Benching ${cfg.name} ... `);
    const t0 = Date.now();
    const { report } = await benchModel(cfg, samples, datasetDir, warmup, caseSensitive);
    reports.push(report);
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  console.log('\n=== Results ===\n');
  console.log(
    'Model'.padEnd(28) + 'Size'.padStart(10) + 'Exact'.padStart(8)
    + 'Char'.padStart(8) + 'avgLev'.padStart(8) + 'Avg ms'.padStart(9)
    + 'p95 ms'.padStart(9) + 'p99 ms'.padStart(9),
  );
  console.log('─'.repeat(89));
  reports
    .slice()
    .sort((a, b) => b.exactRate - a.exactRate)
    .forEach((r) => {
      if (r.loadError) {
        console.log(`${r.name.padEnd(28)} LOAD ERROR: ${r.loadError}`);
        return;
      }
      console.log(
        r.name.padEnd(28)
        + fmtBytes(r.fileSize).padStart(10)
        + `${(r.exactRate * 100).toFixed(1)}%`.padStart(8)
        + `${(r.charAcc * 100).toFixed(1)}%`.padStart(8)
        + r.avgLev.toFixed(2).padStart(8)
        + r.avgMs.toFixed(2).padStart(9)
        + r.p95Ms.toFixed(2).padStart(9)
        + r.p99Ms.toFixed(2).padStart(9),
      );
    });
  console.log('');

  // Caveat: benchmark_dataset/ is A-Z 0-9 synthetic captchas — the training
  // distribution of the ddddocr common model. Models trained on different
  // distributions (e.g. extreme_v6 on mixed Chinese, common_small on a
  // narrower charset) will show artificially low accuracy here. Speed
  // numbers (Avg/p95/p99) are still apples-to-apples and meaningful.
  const lowAccuracy = reports.filter((r) => !r.loadError && r.exactRate < 0.4);
  if (lowAccuracy.length) {
    console.log('注意: 以下模型准确率明显偏低，可能是训练分布与本数据集（A-Z 0-9 合成验证码）不匹配：');
    lowAccuracy.forEach((r) => console.log(`  - ${r.name}: ${(r.exactRate * 100).toFixed(1)}% exact`));
    console.log('  → 速度数字仍然可比；准确率需要在该模型对应的训练分布数据集上重新测才有意义。\n');
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({
      generatedAt: new Date().toISOString(),
      datasetDir, sampleCount: samples.length, warmup, caseSensitive,
      runtime: 'onnxruntime-node CPU',
      reports,
    }, null, 2), 'utf-8');
    console.log(`JSON 报告已写入 ${jsonOut}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
