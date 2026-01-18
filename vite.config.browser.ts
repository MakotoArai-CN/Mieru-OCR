import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'fs';
import Zip from 'adm-zip';

function readVersion(): string {
  const versionPath = resolve(__dirname, 'version');
  if (existsSync(versionPath)) {
    return readFileSync(versionPath, 'utf-8').trim();
  }
  // 如果mainifest.json的版本号低于version值，修改manifest.json的版本号为version值
  const manifestPath = resolve(__dirname,'manifest.json');
  if (existsSync(manifestPath)) {
    const manifestContent = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);
    const manifestVersion = manifest.version;
    if (manifestVersion < readFileSync(versionPath, 'utf-8').trim()) {
      manifest.version = readFileSync(versionPath, 'utf-8').trim();
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log(`Updated manifest.json version to ${manifest.version}`);
    }
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

function copyPublicAssets() {
  return {
    name: 'copy-public-assets',
    closeBundle() {
      const distDir = resolve(__dirname, 'dist/extension');
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

      const testHtmlPath = resolve(publicDir, 'test.html');
      if (existsSync(testHtmlPath)) {
        copyFileSync(testHtmlPath, resolve(distDir, 'test.html'));
        console.log('Copied test.html');
      }

      const ortDistDir = resolve(__dirname, 'node_modules/onnxruntime-web/dist');
      if (existsSync(ortDistDir)) {
        const files = readdirSync(ortDistDir);
        const runtimeFiles = files.filter((f) => {
          if (f === 'ort.min.js') return true;
          if (f.startsWith('ort-') && f.endsWith('.wasm')) return true;
          if (f.startsWith('ort-') && f.endsWith('.mjs')) return true;
          if (f.startsWith('ort-') && f.endsWith('.worker.js')) return true;
          if (f.startsWith('ort-') && f.endsWith('.jsep.mjs')) return true;
          if (f.startsWith('ort-') && f.endsWith('.jsep.wasm')) return true;
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

        if (!runtimeFiles.includes('ort.min.js')) {
          console.warn('ort.min.js not found in onnxruntime-web/dist, runtime may fail');
        }
      } else {
        console.warn('onnxruntime-web dist not found, skipping runtime files...');
      }

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
        manifest.version = version;
        writeFileSync(manifestDistPath, JSON.stringify(manifest, null, 2));
        console.log(`Copied manifest.json with version ${version}`);
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

      const zipFile = new Zip();
      zipFile.addLocalFolder(distDir);
      const zipPath = resolve(import.meta.dirname, `dist/ddddocr-extension-v${version}.zip`);
      zipFile.writeZip(zipPath);
      console.log(`Created ${zipPath}`);

      console.log(`Build completed (version ${version})`);
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
    },
  },
  plugins: [copyPublicAssets()],
});