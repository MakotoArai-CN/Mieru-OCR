import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');

export function copyWasmRuntime(distDir: string): void {
  const runtimeDir = resolve(root, 'node_modules/onnxruntime-web/dist');
  const files = [
    ['ort.wasm.min.js', 'ort.min.js'],
    ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.mjs'],
    ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
  ];
  mkdirSync(distDir, { recursive: true });
  for (const [source, destination] of files) {
    const path = resolve(runtimeDir, source);
    if (!existsSync(path)) throw new Error(`Required ONNX runtime file is missing: ${source}`);
    copyFileSync(path, resolve(distDir, destination));
  }
}

export async function bundleContentScript(distDir: string, entryPath: string, isFirefox = false): Promise<void> {
  await build({
    entryPoints: {
      content: entryPath,
      'slider-worker': resolve(root, 'src/core/interaction/slide-worker.ts'),
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    tsconfig: resolve(root, 'tsconfig.json'),
    outdir: distDir,
    allowOverwrite: true,
    legalComments: 'none',
    logLevel: 'silent',
    define: { __FIREFOX__: String(isFirefox) },
  });
}

/**
 * Firefox 的背景页在 MV3 里只能用 `background.scripts`（不支持 service worker），
 * 而 scripts 是按顺序执行的**经典脚本**——所以这里把背景页打成单个 IIFE，
 * 由 manifest 先加载 ort.min.js（设置 window.ort）再加载它。
 * 这样既不需要 background.html，也不再依赖 Vite 的 ESM 分块。
 */
export async function bundleBackground(distDir: string): Promise<void> {
  await build({
    entryPoints: { background: resolve(root, 'src/extension/background/background-firefox.ts') },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    tsconfig: resolve(root, 'tsconfig.json'),
    outdir: distDir,
    outExtension: { '.js': '.js' },
    allowOverwrite: true,
    legalComments: 'none',
    logLevel: 'silent',
    define: { __FIREFOX__: 'true' },
  });
}
