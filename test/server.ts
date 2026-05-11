/**
 * Mieru-OCR 订阅功能测试服务器 (Standalone)
 *
 * 独立于扩展构建流程，不依赖项目源码。提供：
 *   - GET /subscription.json    => 测试用规则包（CORS 全开，方便扩展抓取）
 *   - GET /                     => 测试页 index.html
 *   - GET /index.html           => 测试页
 *
 * 运行方式：
 *   bun test-subscription-service/server.ts            # 默认 http://localhost:8765
 *   PORT=9000 bun test-subscription-service/server.ts  # 自定义端口
 *   bun test-subscription-service/server.ts 9000       # 命令行参数指定端口
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const argPort = process.argv[2] ? Number(process.argv[2]) : NaN;
const envPort = process.env.PORT ? Number(process.env.PORT) : NaN;
const PORT = Number.isFinite(argPort) ? argPort : (Number.isFinite(envPort) ? envPort : 8765);

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Cache-Control': 'no-cache, no-store, must-revalidate',
};

function mimeFor(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function safeJoin(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const cleaned = decoded.replace(/^\/+/, '');
  const full = resolve(root, cleaned);
  // 防止 path traversal: 解析后路径必须仍在根目录内
  if (!full.startsWith(root)) return null;
  return full;
}

function logRequest(method: string, url: string, status: number): void {
  const stamp = new Date().toISOString().slice(11, 19);
  const tag = status >= 400 ? `\x1b[31m${status}\x1b[0m` : `\x1b[32m${status}\x1b[0m`;
  console.log(`[${stamp}] ${method.padEnd(7)} ${tag} ${url}`);
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    let pathname = url.pathname;

    // OPTIONS 预检
    if (req.method === 'OPTIONS') {
      logRequest('OPTIONS', pathname, 204);
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (req.method !== 'GET') {
      logRequest(req.method, pathname, 405);
      return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
    }

    // 根路径默认 index.html
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    const filePath = safeJoin(__dirname, pathname);
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      logRequest(req.method, pathname, 404);
      return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
    }

    try {
      const body = readFileSync(filePath);
      const headers = {
        ...CORS_HEADERS,
        'Content-Type': mimeFor(filePath),
        'Content-Length': String(body.byteLength),
      };
      logRequest(req.method, pathname, 200);
      return new Response(body, { status: 200, headers });
    } catch (e) {
      logRequest(req.method, pathname, 500);
      return new Response('Internal Server Error: ' + (e as Error).message, {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  },
});

const lanIp = (() => {
  try {
    // 试着从 OS 接口里拿一个 LAN IP，方便手机/其它机器访问
    const os = require('os');
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] || []) {
        if (!iface.internal && iface.family === 'IPv4') return iface.address;
      }
    }
  } catch { /* ignore */ }
  return null;
})();

const lines = [
  '',
  '╭───────────────────────────────────────────────────────────╮',
  '│  Mieru-OCR 订阅测试服务                                    │',
  '├───────────────────────────────────────────────────────────┤',
  `│  本机:        http://localhost:${PORT}`.padEnd(60) + '│',
  `│  本机 IP:     http://127.0.0.1:${PORT}`.padEnd(60) + '│',
];
if (lanIp) lines.push(`│  局域网:      http://${lanIp}:${PORT}`.padEnd(60) + '│');
lines.push(
  '├───────────────────────────────────────────────────────────┤',
  `│  订阅 URL:    /subscription.json`.padEnd(60) + '│',
  `│  测试页面:    /  或  /index.html`.padEnd(60) + '│',
  '├───────────────────────────────────────────────────────────┤',
  '│  在扩展里粘贴上面任一 Host + /subscription.json 即可订阅 │',
  '│  按 Ctrl+C 停止                                           │',
  '╰───────────────────────────────────────────────────────────╯',
  '',
);
console.log(lines.join('\n'));

process.on('SIGINT', () => {
  console.log('\n停止服务……');
  server.stop();
  process.exit(0);
});
