import { copyWasmRuntime, bundleContentScript } from './scripts/extension-assets';
import { defineConfig, createLogger } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'fs';
import AdmZip from 'adm-zip';

/**
 * ort.min.js is a UMD bundle (sets `window.ort`); it must be a classic
 * <script>, not a module. Vite warns we can't bundle it — that's fine, our
 * copyPublicAssets plugin copies it verbatim. Filter the noise.
 */
function makeQuietLogger() {
  const logger = createLogger();
  const origWarn = logger.warn.bind(logger);
  logger.warn = (msg: string, opts?: any) => {
    if (typeof msg === 'string' && msg.includes('ort.min.js') && msg.includes("can't be bundled")) {
      return; // expected, copied at build time
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


function copyPublicAssets() {
  return {
    name: 'copy-public-assets',
    async closeBundle() {
      const distDir = resolve(__dirname, 'dist/extension');
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
      } else {
        console.warn('common.onnx not found in public/, skipping...');
      }

      const charsetsPath = resolve(publicDir, 'charsets.json');
      if (existsSync(charsetsPath)) {
        copyFileSync(charsetsPath, resolve(distDir, 'charsets.json'));
        console.log('Copied charsets.json');
      } else {
        console.warn('charsets.json not found in public/, skipping...');
      }

      // 1.2.3 起检测模型（common_det.onnx）不再随扩展内置，省 ~20MB。改为按需提供：
      // 用户上传 / 订阅指定下载 / 仓库镜像下载（见 src/extension/det-model.ts ensureDetModel）。
      // public/common_det.onnx 仍保留在仓库，供镜像下载作为默认模型。
      // 主动清除上一次构建可能遗留的同名文件，避免 zip 仍带上 20MB 陈旧模型。
      const staleDet = resolve(distDir, 'common_det.onnx');
      if (existsSync(staleDet)) {
        rmSync(staleDet);
        console.log('Removed stale common_det.onnx from dist (no longer bundled)');
      }

      // Extra bundled models — paired model+charsets files. Skipped silently if absent.
      // const extraBundled = [
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

      const testHtmlPath = resolve(publicDir, 'test.html');
      if (existsSync(testHtmlPath)) {
        copyFileSync(testHtmlPath, resolve(distDir, 'test.html'));
        console.log('Copied test.html');
      }

      copyWasmRuntime(distDir);

      const distIconsDir = resolve(distDir, 'icons');
      if (!existsSync(distIconsDir)) {
        mkdirSync(distIconsDir, { recursive: true });
      }
      if (existsSync(iconsDir)) {
        try {
          const iconFiles = readdirSync(iconsDir).filter(f => f.endsWith('.png'));
          iconFiles.forEach(icon => {
            copyFileSync(resolve(iconsDir, icon), resolve(distIconsDir, icon));
            console.log(`Copied icons/${icon}`);
          });
        } catch (err) {
          console.warn('Failed to copy icons:', err);
        }
      } else {
        console.warn('icons/ directory not found, skipping...');
      }

      const distLocaleDir = resolve(distDir, '_locales');
      if (!existsSync(distLocaleDir)) {
        mkdirSync(distLocaleDir, { recursive: true });
      }
      if (existsSync(localeDir)) {
        try {
          const localeFiles = readdirSync(localeDir);
          localeFiles.forEach(locale => {
            const srcPath = resolve(localeDir, locale);
            const destPath = resolve(distLocaleDir, locale);
            if (statSync(srcPath).isDirectory()) {
              copyDirRecursive(srcPath, destPath);
              console.log(`Copied _locales/${locale}`);
            }
          });
        } catch (err) {
          console.warn('Failed to copy _locales:', err);
        }
      } else {
        console.warn('_locales/ directory not found, skipping...');
      }

      const manifestSrcPath = resolve(__dirname, 'manifest.json');
      const manifestDistPath = resolve(distDir, 'manifest.json');
      if (existsSync(manifestSrcPath)) {
        const manifestContent = readFileSync(manifestSrcPath, 'utf-8');
        const manifest = JSON.parse(manifestContent);
        manifest.version = manifestVersion;
        writeFileSync(manifestDistPath, JSON.stringify(manifest, null, 2));
        console.log(`Copied manifest.json with version ${manifestVersion}`);
      } else {
        console.warn('manifest.json not found!');
      }

      const nestedPopup = resolve(distDir, 'src/extension/popup/popup.html');
      const nestedOptions = resolve(distDir, 'src/extension/options/options.html');
      const nestedOffscreen = resolve(distDir, 'src/extension/offscreen/offscreen.html');
      const rootPopup = resolve(distDir, 'popup.html');
      const rootOptions = resolve(distDir, 'options.html');
      const rootOffscreen = resolve(distDir, 'offscreen.html');

      if (existsSync(nestedPopup)) {
        copyFileSync(nestedPopup, rootPopup);
        console.log('Copied popup.html to root');
      }
      if (existsSync(nestedOptions)) {
        copyFileSync(nestedOptions, rootOptions);
        console.log('Copied options.html to root');
      }
      if (existsSync(nestedOffscreen)) {
        copyFileSync(nestedOffscreen, rootOffscreen);
        console.log('Copied offscreen.html to root');
      }

      const nestedSrcDir = resolve(distDir, 'src');
      if (existsSync(nestedSrcDir)) {
        try {
          rmSync(nestedSrcDir, { recursive: true, force: true });
          console.log('Removed dist/extension/src');
        } catch (err) {
          console.warn('Failed to remove dist/extension/src:', err);
        }
      }

      await bundleContentScript(distDir, resolve(__dirname, 'src/extension/content/content.ts'));
      console.log('Rebundled content.js as classic script');

      const zipFile = new AdmZip();
      zipFile.addLocalFolder(distDir);
      const zipPath = resolve(import.meta.dirname, `dist/Mieru-OCR-v${releaseVersion}.zip`);
      zipFile.writeZip(zipPath);
      console.log(`Created ${zipPath}`);

      console.log(`Build completed (release ${releaseVersion}, manifest ${manifestVersion})`);
    }
  };
}

export default defineConfig({
  publicDir: false,
  customLogger: makeQuietLogger(),
  // 平台判定用构建期常量，便于 tree-shaking 掉另一端的死分支。
  // 注意 content script 走 bundleContentScript 的 esbuild 二次编译，需在那里单独 define。
  define: {
    __FIREFOX__: 'false',
  },
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@extension': resolve(__dirname, 'src/extension'),
    },
  },
  build: {
    outDir: 'dist/extension',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/extension/popup/popup.html'),
        options: resolve(__dirname, 'src/extension/options/options.html'),
        offscreen: resolve(__dirname, 'src/extension/offscreen/offscreen.html'),
        background: resolve(__dirname, 'src/extension/background/service-worker.ts'),
        content: resolve(__dirname, 'src/extension/content/content.ts'),
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
  plugins: [copyPublicAssets()],
});
