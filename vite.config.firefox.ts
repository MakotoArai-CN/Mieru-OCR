import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'fs';
import AdmZip from 'adm-zip';

function readVersion(): string {
  const versionPath = resolve(__dirname, 'version');
  if (existsSync(versionPath)) {
    return readFileSync(versionPath, 'utf-8').trim();
  }
  return '1.1.0';
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
    closeBundle() {
      const distDir = resolve(__dirname, 'dist/firefox');
      const publicDir = resolve(__dirname, 'public');
      const iconsDir = resolve(__dirname, 'icons');
      const localeDir = resolve(__dirname, '_locales');
      const version = readVersion();

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
        manifest.version = version;
        writeFileSync(manifestDistPath, JSON.stringify(manifest, null, 2));
        console.log(`Copied manifest.firefox.json as manifest.json with version ${version}`);
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

      const zipFile = new AdmZip();
      zipFile.addLocalFolder(distDir);
      const zipPath = resolve(__dirname, `dist/ddddocr-firefox-v${version}.zip`);
      zipFile.writeZip(zipPath);
      console.log(`Created ${zipPath}`);
      console.log(`Firefox build completed (version ${version})`);
    }
  };
}

export default defineConfig({
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