#!/usr/bin/env bun
/**
 * DDDD OCR Model Benchmark Tool
 *
 * Setup:
 *   bun add onnxruntime-node @napi-rs/canvas
 *
 * Usage:
 *   bun run benchmark.ts --models ./models --charsets ./public/charsets.json
 *   bun run benchmark.ts --models ./models --count 300 --top 15
 */

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { resolve, basename, join } from 'path';
import { tmpdir } from 'os';

declare const process: {
    argv: string[];
    cwd(): string;
    env: Record<string, string | undefined>;
    stdout: { write(message: string): void };
    exit(code?: number): never;
};

declare function require(name: string): any;

// ─── Types ───────────────────────────────────────────────────────────────────

interface CLIArgs {
    modelsDir: string;
    charsetsPath: string;
    count: number;
    warmup: number;
    top: number;
    saveCaptchas: string | null;
    datasetDir: string | null;
    outputJson: string | null;
    timeout: number;
}

interface TestCaptcha {
    id: string;
    text: string;
    width: number;
    height: number;
    pngPath: string;
    fileName: string;
    generatedAt: string;
}

interface DatasetManifest {
    generatedAt: string;
    source: 'benchmark.ts';
    count: number;
    charsetsPath: string;
    samples: Array<{
        id: string;
        fileName: string;
        text: string;
        width: number;
        height: number;
        generatedAt: string;
    }>;
}

interface WorkerResult {
    success: boolean;
    loadTimeMs: number;
    loadError: string | null;
    results: { predicted: string; timeMs: number; error: string | null }[];
    crashed: boolean;
}

interface ModelMetrics {
    name: string;
    filePath: string;
    fileSize: number;
    loadTimeMs: number;
    loadError: string | null;
    exactMatchCount: number;
    charMatchCount: number;
    charTotalCount: number;
    exactMatchRate: number;
    charAccuracy: number;
    avgLevenshtein: number;
    avgTimeMs: number;
    medianTimeMs: number;
    p95TimeMs: number;
    p99TimeMs: number;
    minTimeMs: number;
    maxTimeMs: number;
    stddevTimeMs: number;
    errorCount: number;
    compositeScore: number;
    crashed: boolean;
}

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
};

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

function parseArgs(): CLIArgs {
    const args = process.argv.slice(2);
    const result: CLIArgs = {
        modelsDir: '',
        charsetsPath: './public/charsets.json',
        count: 200,
        warmup: 5,
        top: 10,
        saveCaptchas: null,
        datasetDir: null,
        outputJson: null,
        timeout: 120000,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--models': case '-m': result.modelsDir = args[++i] || ''; break;
            case '--charsets': case '-c': result.charsetsPath = args[++i] || result.charsetsPath; break;
            case '--count': case '-n': result.count = parseInt(args[++i]) || result.count; break;
            case '--warmup': case '-w': result.warmup = parseInt(args[++i]) || result.warmup; break;
            case '--top': case '-t': result.top = parseInt(args[++i]) || result.top; break;
            case '--save-captchas': result.saveCaptchas = args[++i] || null; break;
            case '--dataset-dir': result.datasetDir = args[++i] || null; break;
            case '--output': case '-o': result.outputJson = args[++i] || null; break;
            case '--timeout': result.timeout = parseInt(args[++i]) * 1000 || result.timeout; break;
            case '--help': case '-h': printHelp(); process.exit(0);
        }
    }

    if (!result.modelsDir) {
        console.error(`${C.red}错误: 请指定模型目录 --models <dir>${C.reset}`);
        printHelp();
        process.exit(1);
    }

    return result;
}

function printHelp(): void {
    console.log(`
${C.bold}DDDD OCR Model Benchmark Tool${C.reset}

${C.cyan}Usage:${C.reset}
  bun run benchmark.ts --models <dir> [options]

${C.cyan}Options:${C.reset}
  --models, -m <dir>       模型文件目录 (必须)
  --charsets, -c <file>    charsets.json 路径 (默认: ./public/charsets.json)
  --count, -n <num>        测试验证码数量 (默认: 200)
  --warmup, -w <num>       预热轮数 (默认: 5)
  --top, -t <num>          显示前N个模型 (默认: 10)
  --timeout <seconds>      每个模型超时秒数 (默认: 120)
  --save-captchas <dir>    兼容旧参数，保存生成的验证码图片
  --dataset-dir <dir>      导出稳定数据集目录（图片 + captchas.json）
  --output, -o <file>      结果输出JSON文件
  --help, -h               显示帮助
`);
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
    return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil(sorted.length * p / 100) - 1;
    return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function medianVal(sorted: number[]): number {
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stddev(values: number[], avg: number): number {
    if (values.length < 2) return 0;
    const sumSq = values.reduce((s, v) => s + (v - avg) ** 2, 0);
    return Math.sqrt(sumSq / (values.length - 1));
}

function levenshtein(a: string, b: string): number {
    const la = a.length;
    const lb = b.length;
    const dp = Array.from({ length: la + 1 }, (_, i) =>
        Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
    );
    for (let i = 1; i <= la; i++) {
        for (let j = 1; j <= lb; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
    }
    return dp[la][lb];
}

function charAccuracy(predicted: string, expected: string): { matched: number; total: number } {
    const p = predicted.toUpperCase();
    const e = expected.toUpperCase();
    if (e.length === 0) return { matched: 0, total: 0 };
    let matched = 0;
    const minLen = Math.min(p.length, e.length);
    for (let i = 0; i < minLen; i++) {
        if (p[i] === e[i]) matched++;
    }
    return { matched, total: e.length };
}

function progressBar(current: number, total: number, width: number = 30): string {
    const ratio = current / total;
    const filled = Math.round(width * ratio);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const pct = (ratio * 100).toFixed(0);
    return `${bar} ${pct}% (${current}/${total})`;
}

// ─── Captcha Generator ──────────────────────────────────────────────────────

function generateCaptchaImages(count: number, charsets: string[], outDir: string): TestCaptcha[] {
    const { createCanvas } = require('@napi-rs/canvas');
    const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const COLORS = ['#2c5f8a', '#8a2c5f', '#2c8a5f', '#8a5f2c', '#5f2c8a', '#c0392b'];

    const validChars = charsets.filter(c => c && c.length === 1 && /[A-Za-z0-9]/.test(c));
    const useChars = validChars.length > 10
        ? [...new Set(validChars.map(c => c.toUpperCase()))]
        : CHARS.split('');

    const captchas: TestCaptcha[] = [];

    for (let i = 0; i < count; i++) {
        let len: number;
        const r = Math.random();
        if (r < 0.6) len = 4;
        else if (r < 0.9) len = 5;
        else len = 6;

        let text = '';
        for (let j = 0; j < len; j++) {
            text += useChars[Math.floor(Math.random() * useChars.length)];
        }

        const w = 120;
        const h = 40;
        const canvas = createCanvas(w, h);
        const ctx = canvas.getContext('2d');

        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#f0f5fa');
        grad.addColorStop(1, '#faf0f5');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        for (let li = 0; li < 2 + Math.floor(Math.random() * 2); li++) {
            ctx.strokeStyle = `rgba(${80 + Math.random() * 100},${80 + Math.random() * 100},${80 + Math.random() * 100},${0.2 + Math.random() * 0.2})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.random() * w, Math.random() * h);
            ctx.lineTo(Math.random() * w, Math.random() * h);
            ctx.stroke();
        }

        for (let di = 0; di < 20 + Math.floor(Math.random() * 20); di++) {
            ctx.fillStyle = `rgba(${100 + Math.random() * 100},${100 + Math.random() * 100},${100 + Math.random() * 100},${0.3 + Math.random() * 0.3})`;
            ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random(), 1 + Math.random());
        }

        const fontSize = Math.floor(h * 0.5) + Math.floor(Math.random() * 4);
        ctx.font = `bold ${fontSize}px Arial, sans-serif`;
        ctx.textBaseline = 'middle';
        const totalW = text.length * (fontSize * 0.7);
        const startX = Math.max(4, (w - totalW) / 2);
        const spacing = (w - startX * 2) / text.length;

        for (let ci = 0; ci < text.length; ci++) {
            ctx.save();
            const x = startX + ci * spacing + spacing / 2;
            const y = h / 2 + (Math.random() - 0.5) * 6;
            ctx.translate(x, y);
            ctx.rotate((Math.random() - 0.5) * 0.4);
            ctx.fillStyle = COLORS[Math.floor(Math.random() * COLORS.length)];
            const cw = ctx.measureText(text[ci]).width;
            ctx.fillText(text[ci], -cw / 2, 0);
            ctx.restore();
        }

        const fileName = `${String(i).padStart(4, '0')}_${text}.png`;
        const pngPath = join(outDir, fileName);
        const pngBuffer = canvas.toBuffer('image/png');
        const generatedAt = new Date().toISOString();
        writeFileSync(pngPath, pngBuffer);

        captchas.push({
            id: `captcha-${String(i).padStart(4, '0')}`,
            text,
            width: w,
            height: h,
            pngPath,
            fileName,
            generatedAt,
        });
    }

    return captchas;
}

// ─── Worker Script (runs in subprocess) ──────────────────────────────────────

function generateWorkerScript(): string {
    return `
const ort = require('onnxruntime-node');
const fs = require('fs');
const path = require('path');

let canvasLib;
try {
    canvasLib = require('@napi-rs/canvas');
} catch (e) {
    try {
        canvasLib = require('canvas');
    } catch (e2) {
        process.stdout.write(JSON.stringify({
            success: false, loadTimeMs: 0,
            loadError: '缺少canvas库，请安装: npm install @napi-rs/canvas',
            results: [], crashed: false
        }));
        process.exit(0);
    }
}
const { createCanvas, loadImage } = canvasLib;

function toGrayscale(rgba) {
    const gray = new Uint8ClampedArray(rgba.length / 4);
    for (let i = 0; i < rgba.length; i += 4) {
        const r = rgba[i], g = rgba[i+1], b = rgba[i+2], a = rgba[i+3];
        const alpha = a / 255;
        const rr = r * alpha + 255 * (1 - alpha);
        const gg = g * alpha + 255 * (1 - alpha);
        const bb = b * alpha + 255 * (1 - alpha);
        gray[i / 4] = Math.round(0.2126 * rr + 0.7152 * gg + 0.0722 * bb);
    }
    return gray;
}

function resize(data, w, h, nw, nh) {
    const result = new Uint8ClampedArray(nw * nh);
    const xr = w / nw, yr = h / nh;
    for (let y = 0; y < nh; y++) {
        for (let x = 0; x < nw; x++) {
            const px = x * xr, py = y * yr;
            const x1 = Math.floor(px), x2 = Math.min(x1+1, w-1);
            const y1 = Math.floor(py), y2 = Math.min(y1+1, h-1);
            const fx = px - x1, fy = py - y1;
            result[y * nw + x] = Math.round(
                data[y1*w+x1]*(1-fx)*(1-fy) + data[y1*w+x2]*fx*(1-fy) +
                data[y2*w+x1]*(1-fx)*fy + data[y2*w+x2]*fx*fy
            );
        }
    }
    return result;
}

function decodeOutput(tensor, charsets) {
    const dims = tensor.dims;
    let indices = [];
    if (dims.length === 3) {
        const seqLen = Number(dims[1]), numClasses = Number(dims[2]);
        const data = tensor.data;
        for (let t = 0; t < seqLen; t++) {
            let maxIdx = 0, maxVal = -Infinity;
            for (let c = 0; c < numClasses; c++) {
                const val = Number(data[t * numClasses + c]);
                if (val > maxVal) { maxVal = val; maxIdx = c; }
            }
            indices.push(maxIdx);
        }
    } else {
        const data = tensor.data;
        for (let i = 0; i < data.length; i++) {
            const v = data[i];
            indices.push(typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? Math.round(v) : 0);
        }
    }
    const result = [];
    let prev = -1;
    for (const idx of indices) {
        if (idx === prev) continue;
        prev = idx;
        if (idx > 0 && idx < charsets.length && charsets[idx]) result.push(charsets[idx]);
    }
    return result.join('');
}

async function main() {
    const args = JSON.parse(process.argv[2]);
    const { modelPath, charsetsPath, captchaListPath, warmup } = args;

    const charsets = JSON.parse(fs.readFileSync(charsetsPath, 'utf-8'));
    const captchas = JSON.parse(fs.readFileSync(captchaListPath, 'utf-8'));

    const output = {
        success: false,
        loadTimeMs: 0,
        loadError: null,
        results: [],
        crashed: false,
    };

    let session;
    try {
        const loadStart = performance.now();
        session = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'all',
        });
        output.loadTimeMs = Math.round(performance.now() - loadStart);
    } catch (e) {
        output.loadError = e.message || String(e);
        process.stdout.write(JSON.stringify(output));
        process.exit(0);
    }

    async function recognize(pngPath) {
        const img = await loadImage(fs.readFileSync(pngPath));
        const canvas = createCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, img.width, img.height);
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, img.width, img.height);

        const gray = toGrayscale(imageData.data);
        const targetHeight = 64;
        const targetWidth = Math.floor(img.width * (targetHeight / img.height));
        const resized = resize(gray, img.width, img.height, targetWidth, targetHeight);

        const normalized = new Float32Array(resized.length);
        for (let i = 0; i < resized.length; i++) normalized[i] = resized[i] / 255.0;

        const inputName = session.inputNames[0];
        const tensor = new ort.Tensor('float32', normalized, [1, 1, targetHeight, targetWidth]);
        const results = await session.run({ [inputName]: tensor });
        const outputName = session.outputNames[0];
        return decodeOutput(results[outputName], charsets);
    }

    const warmupCount = Math.min(warmup, captchas.length);
    for (let i = 0; i < warmupCount; i++) {
        try { await recognize(captchas[i].pngPath); } catch {}
    }

    for (let i = 0; i < captchas.length; i++) {
        const start = performance.now();
        try {
            const text = await recognize(captchas[i].pngPath);
            output.results.push({ predicted: text, timeMs: performance.now() - start, error: null });
        } catch (e) {
            output.results.push({ predicted: '', timeMs: performance.now() - start, error: e.message || String(e) });
        }
    }

    output.success = true;
    try { await session.release(); } catch {}
    process.stdout.write(JSON.stringify(output));
}

main().catch(e => {
    process.stdout.write(JSON.stringify({
        success: false, loadTimeMs: 0, loadError: e.message || String(e), results: [], crashed: true
    }));
    process.exit(1);
});
`;
}

// ─── Run Model in Subprocess ────────────────────────────────────────────────

async function runModelInSubprocess(
    modelPath: string,
    charsetsPath: string,
    captchaListPath: string,
    warmup: number,
    workerScriptPath: string,
    timeout: number
): Promise<WorkerResult> {
    const argsPayload = JSON.stringify({
        modelPath: resolve(modelPath),
        charsetsPath: resolve(charsetsPath),
        captchaListPath: resolve(captchaListPath),
        warmup,
    });

    return new Promise<WorkerResult>((resolveP) => {
        const defaultResult: WorkerResult = {
            success: false,
            loadTimeMs: 0,
            loadError: null,
            results: [],
            crashed: true,
        };

        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (result: WorkerResult) => {
            if (settled) return;
            settled = true;
            resolveP(result);
        };

        let timer: ReturnType<typeof setTimeout> | null = null;

        try {
            const proc = Bun.spawn(['node', workerScriptPath, argsPayload], {
                stdout: 'pipe',
                stderr: 'pipe',
                cwd: resolve(process.cwd()),
                env: {
                    ...process.env,
                    NODE_PATH: resolve(process.cwd(), 'node_modules'),
                },
            });

            timer = setTimeout(() => {
                try { proc.kill(); } catch { }
                finish({ ...defaultResult, loadError: `超时 (${timeout / 1000}s)` });
            }, timeout);

            (async () => {
                try {
                    const reader = proc.stdout.getReader();
                    const decoder = new TextDecoder();
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        stdout += decoder.decode(value, { stream: true });
                    }
                } catch { }
            })();

            (async () => {
                try {
                    const reader = proc.stderr.getReader();
                    const decoder = new TextDecoder();
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        stderr += decoder.decode(value, { stream: true });
                    }
                } catch { }
            })();

            proc.exited.then((exitCode) => {
                if (timer) clearTimeout(timer);

                if (exitCode !== 0 && !stdout.trim()) {
                    const errMsg = stderr.trim().split('\n').slice(-3).join(' | ') || `exit code: ${exitCode}`;
                    finish({ ...defaultResult, loadError: errMsg.substring(0, 300) });
                    return;
                }

                try {
                    const jsonStr = stdout.trim();
                    if (!jsonStr) {
                        const errMsg = stderr.trim().split('\n').slice(-2).join(' | ') || '无输出';
                        finish({ ...defaultResult, loadError: errMsg.substring(0, 300) });
                        return;
                    }
                    const parsed = JSON.parse(jsonStr) as WorkerResult;
                    finish(parsed);
                } catch (e) {
                    finish({ ...defaultResult, loadError: `解析失败: ${(e as Error).message}` });
                }
            });
        } catch (e) {
            if (timer) clearTimeout(timer);
            finish({ ...defaultResult, loadError: `启动失败: ${(e as Error).message}` });
        }
    });
}
// ─── Metrics Calculation ────────────────────────────────────────────────────

function computeMetrics(
    name: string,
    filePath: string,
    workerResult: WorkerResult,
    captchas: TestCaptcha[]
): ModelMetrics {
    const fileSize = existsSync(filePath) ? statSync(filePath).size : 0;

    const m: ModelMetrics = {
        name,
        filePath,
        fileSize,
        loadTimeMs: workerResult.loadTimeMs,
        loadError: workerResult.loadError,
        exactMatchCount: 0,
        charMatchCount: 0,
        charTotalCount: 0,
        exactMatchRate: 0,
        charAccuracy: 0,
        avgLevenshtein: 0,
        avgTimeMs: 0,
        medianTimeMs: 0,
        p95TimeMs: 0,
        p99TimeMs: 0,
        minTimeMs: 0,
        maxTimeMs: 0,
        stddevTimeMs: 0,
        errorCount: 0,
        compositeScore: 0,
        crashed: workerResult.crashed,
    };

    if (workerResult.loadError || !workerResult.success) return m;

    const times: number[] = [];
    let totalLev = 0;

    for (let i = 0; i < workerResult.results.length && i < captchas.length; i++) {
        const r = workerResult.results[i];
        if (r.error) { m.errorCount++; continue; }

        const predicted = r.predicted.toUpperCase();
        const expected = captchas[i].text.toUpperCase();

        if (predicted === expected) m.exactMatchCount++;

        const ca = charAccuracy(predicted, expected);
        m.charMatchCount += ca.matched;
        m.charTotalCount += ca.total;

        totalLev += levenshtein(predicted, expected);
        times.push(r.timeMs);
    }

    const total = Math.max(captchas.length, 1);
    times.sort((a, b) => a - b);
    const avg = times.length > 0 ? times.reduce((s, t) => s + t, 0) / times.length : 0;

    m.exactMatchRate = (m.exactMatchCount / total) * 100;
    m.charAccuracy = m.charTotalCount > 0 ? (m.charMatchCount / m.charTotalCount) * 100 : 0;
    m.avgLevenshtein = totalLev / total;
    m.avgTimeMs = Math.round(avg * 100) / 100;
    m.medianTimeMs = Math.round(medianVal(times) * 100) / 100;
    m.p95TimeMs = Math.round(percentile(times, 95) * 100) / 100;
    m.p99TimeMs = Math.round(percentile(times, 99) * 100) / 100;
    m.minTimeMs = times.length > 0 ? Math.round(times[0] * 100) / 100 : 0;
    m.maxTimeMs = times.length > 0 ? Math.round(times[times.length - 1] * 100) / 100 : 0;
    m.stddevTimeMs = Math.round(stddev(times, avg) * 100) / 100;

    return m;
}

function calculateScores(allMetrics: ModelMetrics[]): void {
    const valid = allMetrics.filter(m => !m.loadError && !m.crashed);
    if (valid.length === 0) return;

    const maxCharAcc = Math.max(...valid.map(m => m.charAccuracy));
    const maxExactAcc = Math.max(...valid.map(m => m.exactMatchRate));
    const minAvgTime = Math.min(...valid.map(m => m.avgTimeMs));
    const maxAvgTime = Math.max(...valid.map(m => m.avgTimeMs));
    const minLoadTime = Math.min(...valid.map(m => m.loadTimeMs));
    const maxLoadTime = Math.max(...valid.map(m => m.loadTimeMs));
    const minFileSize = Math.min(...valid.map(m => m.fileSize));
    const maxFileSize = Math.max(...valid.map(m => m.fileSize));
    const minStddev = Math.min(...valid.map(m => m.stddevTimeMs));
    const maxStddev = Math.max(...valid.map(m => m.stddevTimeMs));

    function norm(val: number, min: number, max: number, invert: boolean = false): number {
        if (max === min) return 1;
        const ratio = (val - min) / (max - min);
        return invert ? 1 - ratio : ratio;
    }

    for (const m of allMetrics) {
        if (m.loadError || m.crashed) { m.compositeScore = 0; continue; }
        m.compositeScore = Math.round((
            (maxCharAcc > 0 ? (m.charAccuracy / maxCharAcc) * 35 : 0) +
            (maxExactAcc > 0 ? (m.exactMatchRate / maxExactAcc) * 20 : 0) +
            norm(m.avgTimeMs, minAvgTime, maxAvgTime, true) * 20 +
            norm(m.stddevTimeMs, minStddev, maxStddev, true) * 10 +
            norm(m.loadTimeMs, minLoadTime, maxLoadTime, true) * 10 +
            norm(m.fileSize, minFileSize, maxFileSize, true) * 5
        ) * 100) / 100;
    }
}

// ─── Display ────────────────────────────────────────────────────────────────

function printResults(metrics: ModelMetrics[], topN: number): void {
    const sorted = [...metrics].filter(m => !m.loadError && !m.crashed).sort((a, b) => b.compositeScore - a.compositeScore);
    const failed = metrics.filter(m => m.loadError || m.crashed);
    const showCount = Math.min(topN, sorted.length);

    console.log(`\n${C.bold}${C.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
    console.log(`${C.bold}  🏆 TOP ${showCount} MODELS${C.reset}`);
    console.log(`${C.bold}${C.yellow}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);

    const header = `  ${'Rank'.padEnd(5)}${'Model'.padEnd(34)}${'Score'.padStart(7)}${'CharAcc'.padStart(9)}${'ExactAcc'.padStart(10)}${'AvgMs'.padStart(8)}${'P95Ms'.padStart(8)}${'Load'.padStart(8)}${'Size'.padStart(8)}`;
    console.log(`${C.dim}${header}${C.reset}`);
    console.log(`  ${C.dim}${'─'.repeat(header.length - 2)}${C.reset}`);

    for (let i = 0; i < showCount; i++) {
        const m = sorted[i];
        const nameStr = m.name.length > 32 ? m.name.substring(0, 29) + '...' : m.name;
        const rc = i === 0 ? C.yellow : i === 1 ? C.cyan : i === 2 ? C.magenta : C.white;
        const sc = m.compositeScore >= 70 ? C.green : m.compositeScore >= 40 ? C.yellow : C.red;
        const cc = m.charAccuracy >= 80 ? C.green : m.charAccuracy >= 50 ? C.yellow : C.red;
        const ec = m.exactMatchRate >= 60 ? C.green : m.exactMatchRate >= 30 ? C.yellow : C.red;

        console.log(
            `  ${rc}${C.bold}${'#' + (i + 1)}${C.reset}`.padEnd(5 + rc.length + C.bold.length + C.reset.length) +
            `${nameStr.padEnd(34)}` +
            `${sc}${m.compositeScore.toFixed(1).padStart(7)}${C.reset}` +
            `${cc}${(m.charAccuracy.toFixed(1) + '%').padStart(9)}${C.reset}` +
            `${ec}${(m.exactMatchRate.toFixed(1) + '%').padStart(10)}${C.reset}` +
            `${m.avgTimeMs.toFixed(1).padStart(8)}` +
            `${m.p95TimeMs.toFixed(1).padStart(8)}` +
            `${(m.loadTimeMs + 'ms').padStart(8)}` +
            `${formatSize(m.fileSize).padStart(8)}`
        );
    }

    console.log(`  ${C.dim}${'─'.repeat(header.length - 2)}${C.reset}`);

    if (sorted.length > 0) {
        const bestAcc = sorted.reduce((a, b) => a.charAccuracy > b.charAccuracy ? a : b);
        const bestExact = sorted.reduce((a, b) => a.exactMatchRate > b.exactMatchRate ? a : b);
        const fastest = sorted.reduce((a, b) => a.avgTimeMs < b.avgTimeMs ? a : b);
        const smallest = sorted.reduce((a, b) => a.fileSize < b.fileSize ? a : b);
        const best = sorted[0];

        console.log(`
${C.bold}  📊 详细分析${C.reset}
    ${C.dim}最高字符准确:${C.reset}  ${C.green}${bestAcc.name}${C.reset} (${bestAcc.charAccuracy.toFixed(1)}%)
    ${C.dim}最高完全匹配:${C.reset}  ${C.green}${bestExact.name}${C.reset} (${bestExact.exactMatchRate.toFixed(1)}%)
    ${C.dim}推理最快:${C.reset}      ${C.green}${fastest.name}${C.reset} (${fastest.avgTimeMs.toFixed(1)}ms avg)
    ${C.dim}体积最小:${C.reset}      ${C.green}${smallest.name}${C.reset} (${formatSize(smallest.fileSize)})
    ${C.dim}综合最佳:${C.reset}      ${C.green}${C.bold}${best.name}${C.reset} (score: ${best.compositeScore.toFixed(1)})
`);
    }

    if (sorted.length > showCount) {
        console.log(`\n${C.bold}  📋 剩余模型${C.reset}`);
        for (let i = showCount; i < sorted.length; i++) {
            const m = sorted[i];
            console.log(
                `  ${C.dim}#${i + 1}${C.reset} ${m.name.padEnd(32)} ` +
                `score=${m.compositeScore.toFixed(1).padStart(5)} ` +
                `charAcc=${m.charAccuracy.toFixed(1).padStart(5)}% ` +
                `avgMs=${m.avgTimeMs.toFixed(1).padStart(6)}`
            );
        }
    }

    if (failed.length > 0) {
        console.log(`\n${C.bold}${C.red}  ❌ 失败的模型 (${failed.length})${C.reset}`);
        for (const m of failed) {
            const reason = m.loadError || '进程崩溃(未知原因)';
            console.log(`    ${C.red}${m.name}${C.reset}: ${C.dim}${reason}${C.reset}`);
        }
    }
}

function buildDatasetManifest(captchas: TestCaptcha[], charsetsPath: string): DatasetManifest {
    return {
        generatedAt: new Date().toISOString(),
        source: 'benchmark.ts',
        count: captchas.length,
        charsetsPath,
        samples: captchas.map((captcha) => ({
            id: captcha.id,
            fileName: captcha.fileName,
            text: captcha.text,
            width: captcha.width,
            height: captcha.height,
            generatedAt: captcha.generatedAt,
        })),
    };
}

function exportDataset(captchas: TestCaptcha[], datasetDir: string, charsetsPath: string): void {
    if (!existsSync(datasetDir)) {
        mkdirSync(datasetDir, { recursive: true });
    }
    for (const captcha of captchas) {
        copyFileSync(captcha.pngPath, join(datasetDir, captcha.fileName));
    }
    const manifest = buildDatasetManifest(captchas, charsetsPath);
    writeFileSync(join(datasetDir, 'captchas.json'), JSON.stringify(manifest, null, 2), 'utf-8');
}

function getDatasetDir(args: CLIArgs): string {
    const requestedDir = args.datasetDir || args.saveCaptchas;
    if (requestedDir) {
        return resolve(requestedDir);
    }
    return resolve('benchmark_dataset');
}

function getOutputPath(args: CLIArgs): string {
    return args.outputJson || `benchmark_${new Date().toISOString().slice(0, 10)}.json`;
}

function cleanupTempDir(tempDir: string): void {
    try {
        const { rmSync } = require('fs');
        rmSync(tempDir, { recursive: true, force: true });
    } catch { }
}

function saveResults(metrics: ModelMetrics[], outputPath: string, datasetDir: string | null, captchas: TestCaptcha[]): void {
    const sorted = [...metrics].sort((a, b) => b.compositeScore - a.compositeScore);
    const exportData = {
        generatedAt: new Date().toISOString(),
        dataset: {
            directory: datasetDir,
            count: captchas.length,
            manifest: datasetDir ? join(datasetDir, 'captchas.json') : null,
        },
        models: sorted.map((m, i) => ({
            rank: i + 1,
            name: m.name,
            compositeScore: m.compositeScore,
            charAccuracy: Math.round(m.charAccuracy * 100) / 100,
            exactMatchRate: Math.round(m.exactMatchRate * 100) / 100,
            avgLevenshtein: Math.round(m.avgLevenshtein * 100) / 100,
            avgTimeMs: m.avgTimeMs,
            medianTimeMs: m.medianTimeMs,
            p95TimeMs: m.p95TimeMs,
            p99TimeMs: m.p99TimeMs,
            minTimeMs: m.minTimeMs,
            maxTimeMs: m.maxTimeMs,
            stddevTimeMs: m.stddevTimeMs,
            loadTimeMs: m.loadTimeMs,
            fileSize: m.fileSize,
            fileSizeFormatted: formatSize(m.fileSize),
            errorCount: m.errorCount,
            loadError: m.loadError,
            crashed: m.crashed,
        })),
    };
    writeFileSync(outputPath, JSON.stringify(exportData, null, 2), 'utf-8');
    console.log(`${C.green}💾 结果已保存: ${outputPath}${C.reset}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args = parseArgs();

    const modelsDir = resolve(args.modelsDir);
    if (!existsSync(modelsDir)) {
        console.error(`${C.red}错误: 模型目录不存在: ${modelsDir}${C.reset}`);
        process.exit(1);
    }

    const charsetsPath = resolve(args.charsetsPath);
    if (!existsSync(charsetsPath)) {
        console.error(`${C.red}错误: charsets.json 不存在: ${charsetsPath}${C.reset}`);
        process.exit(1);
    }

    const charsets: string[] = JSON.parse(readFileSync(charsetsPath, 'utf-8'));

    const modelFiles = readdirSync(modelsDir)
        .filter(f => f.endsWith('.onnx'))
        .sort()
        .map(f => resolve(modelsDir, f));

    if (modelFiles.length === 0) {
        console.error(`${C.red}错误: 目录中没有 .onnx 文件: ${modelsDir}${C.reset}`);
        process.exit(1);
    }

    console.log(`
${C.bold}${C.blue}╔══════════════════════════════════════════════════════════════╗${C.reset}
${C.bold}${C.blue}║${C.reset}          ${C.bold}DDDD OCR Model Benchmark${C.reset}                           ${C.bold}${C.blue}║${C.reset}
${C.bold}${C.blue}╚══════════════════════════════════════════════════════════════╝${C.reset}

  ${C.dim}模型目录:${C.reset}  ${modelsDir}
  ${C.dim}字符集:${C.reset}    ${charsetsPath}
  ${C.dim}模型数量:${C.reset}  ${modelFiles.length}
  ${C.dim}测试数量:${C.reset}  ${args.count}
  ${C.dim}预热轮数:${C.reset}  ${args.warmup}
  ${C.dim}超时时间:${C.reset}  ${args.timeout / 1000}s
`);

    // prepare temp dir for captcha images and worker script
    const tempDir = join(tmpdir(), `ddddocr-bench-${Date.now()}`);
    const captchaDir = join(tempDir, 'captchas');
    mkdirSync(captchaDir, { recursive: true });

    console.log(`${C.bold}📝 生成测试验证码...${C.reset}`);
    const captchas = generateCaptchaImages(args.count, charsets, captchaDir);

    const charLenDist = new Map<number, number>();
    for (const c of captchas) {
        charLenDist.set(c.text.length, (charLenDist.get(c.text.length) || 0) + 1);
    }
    const distStr = Array.from(charLenDist.entries()).sort((a, b) => a[0] - b[0]).map(([len, count]) => `${count}×${len}字符`).join(', ');
    console.log(`  ${C.green}✓${C.reset} 已生成 ${captchas.length} 张验证码 (${distStr})`);

    const datasetDir = getDatasetDir(args);
    exportDataset(captchas, datasetDir, charsetsPath);
    console.log(`  ${C.green}✓${C.reset} 验证码数据集已导出到: ${datasetDir}`);

    // write captcha list and worker script
    const captchaListPath = join(tempDir, 'captchas.json');
    writeFileSync(captchaListPath, JSON.stringify(captchas), 'utf-8');

    const workerScriptPath = join(tempDir, 'worker.js');
    writeFileSync(workerScriptPath, generateWorkerScript(), 'utf-8');

    console.log(`\n${C.bold}🏃 开始跑分 (每个模型在独立子进程中运行)...${C.reset}`);

    const allMetrics: ModelMetrics[] = [];
    const totalStart = performance.now();

    for (let i = 0; i < modelFiles.length; i++) {
        const modelPath = modelFiles[i];
        const name = basename(modelPath);
        const fileSize = statSync(modelPath).size;

        process.stdout.write(
            `\n  ${C.cyan}[${i + 1}/${modelFiles.length}]${C.reset} ${C.bold}${name}${C.reset} (${formatSize(fileSize)})\n`
        );
        process.stdout.write(`    运行中... `);

        const startTime = performance.now();
        const workerResult = await runModelInSubprocess(
            modelPath,
            charsetsPath,
            captchaListPath,
            args.warmup,
            workerScriptPath,
            args.timeout
        );
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

        const metrics = computeMetrics(name, modelPath, workerResult, captchas);
        allMetrics.push(metrics);

        if (metrics.loadError || metrics.crashed) {
            const reason = metrics.loadError || '进程崩溃(未知原因)';
            process.stdout.write(`${C.red}失败${C.reset} (${elapsed}s)\n    ${C.dim}${reason}${C.reset}\n`);
        } else {
            process.stdout.write(
                `${C.green}完成${C.reset} (${elapsed}s)\n` +
                `    ${C.green}结果:${C.reset} ` +
                `完全匹配=${C.bold}${metrics.exactMatchRate.toFixed(1)}%${C.reset} ` +
                `字符准确=${C.bold}${metrics.charAccuracy.toFixed(1)}%${C.reset} ` +
                `平均耗时=${C.bold}${metrics.avgTimeMs.toFixed(1)}ms${C.reset} ` +
                `加载=${metrics.loadTimeMs}ms ` +
                `错误=${metrics.errorCount}\n`
            );
        }
    }

    const totalTimeS = ((performance.now() - totalStart) / 1000).toFixed(1);
    console.log(`\n  ${C.dim}总用时: ${totalTimeS}s${C.reset}`);

    calculateScores(allMetrics);
    printResults(allMetrics, args.top);

    const outputPath = getOutputPath(args);
    saveResults(allMetrics, outputPath, datasetDir, captchas);

    cleanupTempDir(tempDir);
}

main().catch(e => {
    console.error(`${C.red}致命错误: ${e}${C.reset}`);
    process.exit(1);
});