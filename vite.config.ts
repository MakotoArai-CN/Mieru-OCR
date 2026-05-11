import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';
import { resolve } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';

function readVersion(): string {
  const versionPath = resolve(__dirname, 'version');
  if (existsSync(versionPath)) {
    return readFileSync(versionPath, 'utf-8').trim();
  }
  // 如果package.json的版本号低于version值，修改package.json的版本号为version值
  const packageJsonPath = resolve(__dirname, 'package.json');
  if (existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    if (packageJson.version < APP_VERSION) {
      packageJson.version = APP_VERSION;
      writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    }
  }
  return '1.2.0';
}

const APP_VERSION = readVersion();
const WASM_VERSION = '1.17.0';
const BUILDATE = new Date().toLocaleString();

const iconData = readFileSync(resolve(__dirname, 'icons/icon48.png')).toString('base64');

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@userscript': resolve(__dirname, 'src/userscript'),
    },
  },
  build: {
    minify: 'terser',
    rollupOptions: {
      external: ['onnxruntime-web'],
    },
    outDir: 'dist/userscript',
    terserOptions: {
      compress: {
        ecma: 2020,
        keep_infinity: true,
        drop_console: false,
        drop_debugger: true,
        passes: 3,
      },
      mangle: {
        toplevel: true,
        keep_classnames: false,
        keep_fnames: false,
      },
      format: {
        comments: true,
        quote_style: 3,
        beautify: false,
      },
    },
  },
  plugins: [
    monkey({
      entry: 'src/userscript/main.ts',
      userscript: {
        author: 'MakotoArai-CN',
        name: 'Mieru-OCR - 验证码自动识别',
        namespace: 'https://github.com/MakotoArai-CN/Mieru-OCR',
        version: APP_VERSION + '-' + BUILDATE,
        description: '自动检测并识别页面验证码，自动填充到输入框。首次使用需设置白名单，会自动下载约50MB模型文件以及20MB左右的ONNX推理运行时文件。',
        license: 'MIT',
        match: ['*://*/*'],
        icon: 'data:image/png;base64,' + iconData,
        grant: [
          'GM_xmlhttpRequest',
          'GM_registerMenuCommand',
          'GM_unregisterMenuCommand',
          'GM_notification',
          'GM_getValue',
          'GM_setValue',
        ],
        connect: [
          'cdn.jsdelivr.net',
          'unpkg.com',
          'cdnjs.cloudflare.com',
          'fastly.jsdelivr.net',
          'registry.npmmirror.com',
          'raw.githubusercontent.com',
          'ghproxy.com',
          'ghfast.top',
          'mirror.ghproxy.com',
          'raw.kkgithub.com',
          'github.moeyy.xyz',
          'ghps.cc',
          'cors.isteed.cc',
          'raw.githubusercontents.com',
        ],
        require: [
          `https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/${WASM_VERSION}/ort.min.js`,
        ],
      },
      build: {
        fileName: 'Mieru-OCR.user.js',
        metaFileName: true,
      },
    }),
  ],
});