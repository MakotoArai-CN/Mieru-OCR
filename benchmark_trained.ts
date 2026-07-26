#!/usr/bin/env bun
/**
 * Focused benchmark for our small custom-trained models.
 * Uses the held-out validation samples (synthetic A-Z 0-9 captchas like benchmark.ts).
 */
import { readFileSync, statSync, existsSync } from 'fs';
import { resolve } from 'path';
const ort = require('onnxruntime-node');
const { createCanvas } = require('@napi-rs/canvas');

declare const process: any;

interface ModelInfo { name: string; path: string; size: number }

async function loadModel(p: string) {
    const sess = await ort.InferenceSession.create(p, { executionProviders: ['cpu'] });
    return sess;
}

function genImage(text: string, w = 120, h = 40): Buffer {
    const COLORS = ['#2c5f8a', '#8a2c5f', '#2c8a5f', '#8a5f2c', '#5f2c8a', '#c0392b'];
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
    return canvas.toBuffer('image/png');
}

async function preprocessForTrained(buf: Buffer, w = 192, h = 64): Promise<Float32Array> {
    const { loadImage, createCanvas } = require('@napi-rs/canvas');
    const img = await loadImage(buf);
    // Compute scaled width preserving aspect to height=h
    const tw = Math.max(1, Math.round((img.width * h) / img.height));
    const cnv = createCanvas(w, h);
    const ctx = cnv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, tw, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const out = new Float32Array(w * h);
    // Convert to grayscale, normalize with mean=0.456 std=0.224 (matches training)
    const PAD_FROM = tw < w ? tw : w;
    const padVal = (1.0 - 0.456) / 0.224;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const gray = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255.0;
            out[y * w + x] = x < PAD_FROM ? (gray - 0.456) / 0.224 : padVal;
        }
    }
    return out;
}

function decodeCTC(arr: BigInt64Array | Int32Array | number[], charsets: string[]): string {
    const out: string[] = [];
    let prev = 0;
    for (let i = 0; i < arr.length; i++) {
        const v = Number(arr[i]);
        if (v !== 0 && v !== prev && v < charsets.length && charsets[v]) out.push(charsets[v]);
        prev = v;
    }
    return out.join('');
}

async function bench(modelPath: string, charsets: string[], usableChars: string[], count = 200, warmup = 5) {
    const sess = await loadModel(modelPath);
    const inputName = sess.inputNames[0];
    const outputName = sess.outputNames[0];

    // warmup
    for (let i = 0; i < warmup; i++) {
        const text = 'AAAA';
        const buf = genImage(text);
        const x = await preprocessForTrained(buf);
        const tensor = new ort.Tensor('float32', x, [1, 1, 64, 192]);
        await sess.run({ [inputName]: tensor });
    }

    let exact = 0;
    let charCorrect = 0;
    let charTotal = 0;
    const times: number[] = [];
    for (let i = 0; i < count; i++) {
        // 4-char captcha sampled from chars used in training
        let text = '';
        for (let j = 0; j < 4; j++) text += usableChars[Math.floor(Math.random() * usableChars.length)];
        const buf = genImage(text);
        const x = await preprocessForTrained(buf);
        const tensor = new ort.Tensor('float32', x, [1, 1, 64, 192]);
        const t0 = performance.now();
        const r = await sess.run({ [inputName]: tensor });
        times.push(performance.now() - t0);
        const dataAny: any = r[outputName].data;
        const pred = decodeCTC(dataAny, charsets);
        if (pred === text) exact++;
        const minL = Math.min(pred.length, text.length);
        for (let k = 0; k < minL; k++) if (pred[k] === text[k]) charCorrect++;
        charTotal += text.length;
    }
    times.sort((a, b) => a - b);
    return {
        exact: exact / count,
        charAcc: charCorrect / charTotal,
        avg: times.reduce((a, b) => a + b, 0) / times.length,
        p95: times[Math.floor(times.length * 0.95)],
    };
}

async function main() {
    const charsetPath = resolve('./trained_charsets.json');
    if (!existsSync(charsetPath)) {
        console.error('missing trained_charsets.json'); process.exit(1);
    }
    const charsets: string[] = JSON.parse(readFileSync(charsetPath, 'utf-8'));
    // chars used during training (skip blank at idx 0); subset that's safe to render
    const usable = charsets.slice(1).filter(c => /[A-Za-z0-9]/.test(c));
    console.log(`charset size: ${charsets.length}, usable for synthesis: ${usable.length}`);

    const models: ModelInfo[] = [
        { name: 'trained_base', path: './models/trained_base.onnx', size: 0 },
        { name: 'trained_fp16', path: './models/trained_fp16.onnx', size: 0 },
        { name: 'trained_v5', path: './models/trained_v5.onnx', size: 0 },
        { name: 'trained_v6', path: './models/trained_v6.onnx', size: 0 },
    ];
    for (const m of models) m.size = statSync(m.path).size;

    const COUNT = 200;
    console.log(`\nBenchmarking ${COUNT} synthetic captchas per model...\n`);
    const results: any[] = [];
    for (const m of models) {
        const r = await bench(m.path, charsets, usable, COUNT, 3);
        results.push({ ...m, ...r });
        console.log(`${m.name.padEnd(18)} ${(m.size / 1024 / 1024).toFixed(2).padStart(6)} MB  exact=${(r.exact * 100).toFixed(1)}%  char=${(r.charAcc * 100).toFixed(1)}%  avg=${r.avg.toFixed(1)}ms  p95=${r.p95.toFixed(1)}ms`);
    }

    console.log('\n=== Summary ===');
    results.sort((a, b) => (b.exact * 100 - b.size / 1024 / 1024) - (a.exact * 100 - a.size / 1024 / 1024));
    for (const r of results) {
        console.log(`  ${r.name}: ${(r.size / 1024 / 1024).toFixed(2)}MB / ${(r.exact * 100).toFixed(1)}% exact / ${(r.charAcc * 100).toFixed(1)}% char`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
