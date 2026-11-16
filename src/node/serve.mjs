#!/usr/bin/env node
/**
 * Zero-dependency static server for the wide-angle rectification page.
 * Usage: npm start  ->  http://localhost:5178/
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const PORT = Number(process.env.PORT || (portArg ? portArg.split('=')[1] : 5178));
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function safeJoin(base, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const normalized = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const target = join(base, normalized);
  const resolved = resolve(target);
  if (resolved !== base && !resolved.startsWith(base + sep)) return null;
  return resolved;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = url.pathname;
    if (pathname === '/' || pathname === '') {
      res.writeHead(302, { location: '/src/ui/index.html' });
      res.end();
      return;
    }
    if (pathname === '/src/ui') {
      res.writeHead(302, { location: '/src/ui/index.html' });
      res.end();
      return;
    }
    const filePath = safeJoin(root, pathname);
    if (!filePath) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('非法路径');
      return;
    }
    let info;
    try {
      info = await stat(filePath);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('未找到资源');
      return;
    }
    if (info.isDirectory()) {
      res.writeHead(302, { location: `${pathname.replace(/\/?$/, '/')}index.html` });
      res.end();
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`服务器错误: ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log('广角校正页面已启动');
  console.log(`  打开 http://${HOST}:${PORT}/`);
  console.log('  建议窗口启动步骤见 README.md；终端命令只用于生成/校验产物。');
  console.log('  按 Ctrl+C 停止。');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。换一个端口: npm start -- --port=5180`);
  } else {
    console.error(err.message);
  }
  process.exitCode = 1;
});
