import { copyWasmRuntime, bundleContentScript, bundleBackground } from './scripts/extension-assets';
import { defineConfig, createLogger } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'fs';
import AdmZip from 'adm-zip';

function makeQuietLogger() {
  const logger = createLogger();
  const origWarn = logger.warn.bind(logger);
  logger.warn = (msg: string, opts?: any) => {
    if (typeof msg === 'string'
      && (msg.includes('ort.min.js') || msg.includes('background.js'))
      && msg.includes("can't be bundled")) {
      return; // expected — copyPublicAssets writes them at build time
    }
    origWarn(msg, opts);
  };
  return logger;
}

function readVersion(): string {
  const versionPath = resolve(__dirname, 'version');
  if (existsSync(versionPath)) {
    return readFileSync(versionPath, 'utf-8').trim();
  }
  return '1.1.0';
}

function toManifestVersion(version: string): string {
  const normalized = version.trim().replace(/^v/i, '');
  const base = normalized.split('-')[0];
  return /^\d+(?:\.\d+){0,3}$/.test(base) ? base : '1.1.0';
}

function getBuildVersions(): { releaseVersion: string; manifestVersion: string } {
  const releaseVersion = readVersion();
  return {
    releaseVersion,
    manifestVersion: toManifestVersion(releaseVersion),
  };
}

function copyDirRecursive(srcDir: string, destDir: string): void {
  if (!existsSync(srcDir)) return;
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  const entries = readdirSync(srcDir);
  for (const entry of entries) {
    const srcPath = resolve(srcDir, entry);
    const destPath = resolve(destDir, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (st.isFile()) {
      copyFileSync(srcPath, destPath);
    }
  }
}


function copyFirefoxAssets() {
  return {
    name: 'copy-firefox-assets',
    async closeBundle() {
      const distDir = resolve(__dirname, 'dist/firefox');
      const publicDir = resolve(__dirname, 'public');
      const iconsDir = resolve(__dirname, 'icons');
      const localeDir = resolve(__dirname, '_locales');
      const { releaseVersion, manifestVersion } = getBuildVersions();

      if (!existsSync(distDir)) {
        mkdirSync(distDir, { recursive: true });
      }

      const modelPath = resolve(publicDir, 'common.onnx');
      if (existsSync(modelPath)) {
        copyFileSync(modelPath, resolve(distDir, 'common.onnx'));
        console.log('Copied common.onnx');
      }

      const charsetsPath = resolve(publicDir, 'charsets.json');
      if (existsSync(charsetsPath)) {
        copyFileSync(charsetsPath, resolve(distDir, 'charsets.json'));
        console.log('Copied charsets.json');
      }

      // 1.2.3 起检测模型（common_det.onnx）不再随扩展内置（省 ~20MB），改为按需提供：
      // 用户上传 / 订阅指定下载 / 仓库镜像下载（见 src/extension/det-model.ts ensureDetModel）。
      // 主动清除上一次构建可能遗留的同名文件，避免 zip 仍带上 20MB 陈旧模型。
      const staleDet = resolve(distDir, 'common_det.onnx');
      if (existsSync(staleDet)) {
        rmSync(staleDet);
        console.log('Removed stale common_det.onnx from dist (no longer bundled)');
      }

      // const extraBundled = [
      //   ['common_small.onnx', 'charsets_small.json'],
      //   ['model_extreme_v6.onnx', 'charsets_extreme_v6.json'],
      // ];
      // for (const [m, c] of extraBundled) {
      //   const mp = resolve(publicDir, m);
      //   const cp = resolve(publicDir, c);
      //   if (existsSync(mp) && existsSync(cp)) {
      //     copyFileSync(mp, resolve(distDir, m));
      //     copyFileSync(cp, resolve(distDir, c));
      //     console.log(`Copied bundled extra: ${m} + ${c}`);
      //   }
      // }

      copyWasmRuntime(distDir);

      const distIconsDir = resolve(distDir, 'icons');
      if (!existsSync(distIconsDir)) {
        mkdirSync(distIconsDir, { recursive: true });
      }
      if (existsSync(iconsDir)) {
        const iconFiles = readdirSync(iconsDir).filter(f => f.endsWith('.png'));
        iconFiles.forEach(icon => {
          copyFileSync(resolve(iconsDir, icon), resolve(distIconsDir, icon));
          console.log(`Copied icons/${icon}`);
        });
      }

      const distLocaleDir = resolve(distDir, '_locales');
      if (!existsSync(distLocaleDir)) {
        mkdirSync(distLocaleDir, { recursive: true });
      }
      if (existsSync(localeDir)) {
        const localeEntries = readdirSync(localeDir);
        localeEntries.forEach(locale => {
          const srcPath = resolve(localeDir, locale);
          const destPath = resolve(distLocaleDir, locale);
          if (statSync(srcPath).isDirectory()) {
            copyDirRecursive(srcPath, destPath);
            console.log(`Copied _locales/${locale}`);
          }
        });
      }

      const manifestSrcPath = resolve(__dirname, 'manifest.firefox.json');
      const manifestDistPath = resolve(distDir, 'manifest.json');
      if (existsSync(manifestSrcPath)) {
        const manifestContent = readFileSync(manifestSrcPath, 'utf-8');
        const manifest = JSON.parse(manifestContent);
        manifest.version = manifestVersion;
        writeFileSync(manifestDistPath, JSON.stringify(manifest, null, 2));
        console.log(`Copied manifest.firefox.json as manifest.json with version ${manifestVersion}`);
      }

      const nestedPopup = resolve(distDir, 'src/extension/popup/popup-firefox.html');
      const nestedOptions = resolve(distDir, 'src/extension/options/options-firefox.html');

      const rootPopup = resolve(distDir, 'popup.html');
      const rootOptions = resolve(distDir, 'options.html');

      if (existsSync(nestedPopup)) {
        copyFileSync(nestedPopup, rootPopup);
        console.log('Copied popup-firefox.html to popup.html');
      }
      if (existsSync(nestedOptions)) {
        copyFileSync(nestedOptions, rootOptions);
        console.log('Copied options-firefox.html to options.html');
      }

      const nestedSrcDir = resolve(distDir, 'src');
      if (existsSync(nestedSrcDir)) {
        try {
          rmSync(nestedSrcDir, { recursive: true, force: true });
          console.log('Removed dist/firefox/src');
        } catch (err) {
          console.warn('Failed to remove dist/firefox/src:', err);
        }
      }

      await bundleContentScript(distDir, resolve(__dirname, 'src/extension/content/content-firefox.ts'), true);
      console.log('Rebundled Firefox content.js as classic script');

      // MV3 背景页：`background.scripts` 只接受按顺序执行的经典脚本，不能是 ESM 分块，
      // 所以这里单独打成 IIFE（manifest 里先加载 ort.min.js，再加载 background.js）。
      await bundleBackground(distDir);
      console.log('Bundled Firefox background.js as classic script');

      const zipFile = new AdmZip();
      zipFile.addLocalFolder(distDir);
      const zipPath = resolve(__dirname, `dist/Mieru-OCR-firefox-v${releaseVersion}.zip`);
      zipFile.writeZip(zipPath);
      console.log(`Created ${zipPath}`);
      console.log(`Firefox build completed (release ${releaseVersion}, manifest ${manifestVersion})`);
    }
  };
}

export default defineConfig({
  publicDir: false,
  customLogger: makeQuietLogger(),
  // 平台判定用构建期常量，便于 tree-shaking 掉 MV3 专有分支。
  // 注意 content script 走 bundleContentScript 的 esbuild 二次编译，需在那里单独 define。
  define: {
    __FIREFOX__: 'true',
  },
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@extension': resolve(__dirname, 'src/extension'),
    },
  },
  build: {
    outDir: 'dist/firefox',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'popup-firefox': resolve(__dirname, 'src/extension/popup/popup-firefox.html'),
        'options-firefox': resolve(__dirname, 'src/extension/options/options-firefox.html'),
        content: resolve(__dirname, 'src/extension/content/content-firefox.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') return 'background.js';
          if (chunkInfo.name === 'content') return 'content.js';
          return '[name].js';
        },
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css')) {
            if (assetInfo.name.includes('popup')) return 'popup.css';
            if (assetInfo.name.includes('options')) return 'options.css';
            if (assetInfo.name.includes('content')) return 'content.css';
            return 'styles/[name][extname]';
          }
          return 'assets/[name][extname]';
        },
      },
    },
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: false,
        drop_debugger: true,
      },
      mangle: {
        toplevel: true,
        keep_classnames: true,
        keep_fnames: true,
      },
      format: {
        comments: false,
        quote_style: 3,
        beautify: true,
      },
    },
  },
  plugins: [copyFirefoxAssets()],
});
