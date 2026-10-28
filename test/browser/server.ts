import { resolve, relative, isAbsolute } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const port = Number(process.argv[2] || 8766);
const server = Bun.serve({
  hostname: '127.0.0.1', port,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const runtime = pathname.startsWith('/runtime/');
    const root = resolve(repo, runtime ? 'dist/extension' : 'test');
    const suffix = runtime ? pathname.slice('/runtime/'.length) : (pathname === '/' ? 'browser/index.html' : pathname.slice(1));
    const path = resolve(root, decodeURIComponent(suffix));
    const local = relative(root, path);
    if (local.startsWith('..') || isAbsolute(local)) return new Response('Forbidden', { status: 403 });
    const file = Bun.file(path);
    if (!await file.exists()) return new Response('Not Found', { status: 404 });
    return new Response(file);
  },
});
console.log(`Browser regression: ${server.url}`);
