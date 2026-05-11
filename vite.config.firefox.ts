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

async function bundleContentScript(distDir: string, entryPath: string): Promise<void> {
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    tsconfig: resolve(__dirname, 'tsconfig.json'),
    outfile: resolve(distDir, 'content.js'),
    allowOverwrite: true,
    legalComments: 'none',
    logLevel: 'silent',
  });
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

      const extraBundled = [
        ['common_small.onnx', 'charsets_small.json'],
        ['model_extreme_v6.onnx', 'charsets_extreme_v6.json'],
      ];
      for (const [m, c] of extraBundled) {
        const mp = resolve(publicDir, m);
        const cp = resolve(publicDir, c);
        if (existsSync(mp) && existsSync(cp)) {
          copyFileSync(mp, resolve(distDir, m));
          copyFileSync(cp, resolve(distDir, c));
          console.log(`Copied bundled extra: ${m} + ${c}`);
        }
      }

      const ortDistDir = resolve(__dirname, 'node_modules/onnxruntime-web/dist');
      if (existsSync(ortDistDir)) {
        const files = readdirSync(ortDistDir);
        const runtimeFiles = files.filter((f) => {
          if (f === 'ort.min.js') return true;
          if (f.startsWith('ort-') && f.endsWith('.wasm')) return true;
          if (f.startsWith('ort-') && f.endsWith('.mjs')) return true;
          if (f.startsWith('ort-') && f.endsWith('.worker.js')) return true;
          return false;
        });
        runtimeFiles.forEach((file) => {
          const srcPath = resolve(ortDistDir, file);
          const destPath = resolve(distDir, file);
          if (existsSync(srcPath)) {
            copyFileSync(srcPath, destPath);
            console.log(`Copied ${file}`);
          }
        });
      }

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
      const nestedBgHtml = resolve(distDir, 'src/extension/background/background-firefox.html');

      const rootPopup = resolve(distDir, 'popup.html');
      const rootOptions = resolve(distDir, 'options.html');
      const rootBgHtml = resolve(distDir, 'background.html');

      if (existsSync(nestedPopup)) {
        copyFileSync(nestedPopup, rootPopup);
        console.log('Copied popup-firefox.html to popup.html');
      }
      if (existsSync(nestedOptions)) {
        copyFileSync(nestedOptions, rootOptions);
        console.log('Copied options-firefox.html to options.html');
      }
      if (existsSync(nestedBgHtml)) {
        copyFileSync(nestedBgHtml, rootBgHtml);
        console.log('Copied background-firefox.html to background.html');
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

      await bundleContentScript(distDir, resolve(__dirname, 'src/extension/content/content-firefox.ts'));
      console.log('Rebundled Firefox content.js as classic script');

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
  customLogger: makeQuietLogger(),
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
        'background-html': resolve(__dirname, 'src/extension/background/background-firefox.html'),
        background: resolve(__dirname, 'src/extension/background/background-firefox.ts'),
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