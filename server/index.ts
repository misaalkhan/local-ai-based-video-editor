// Local Studio server. Serves the editor, stores projects, prepares media and
// runs exports. It listens on this machine only.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DIST_DIR, FONTS_DIR, HOST, PORT, ROOT, toolStatus } from './config.ts';
import type { Ctx } from './http.ts';
import { Router, isLocalRequest, readBody, safeJoin, sendFile, sendJson } from './http.ts';
import { HttpError, ensureDirs, flushAll } from './store.ts';
import { registerRoutes } from './routes.ts';

const dev = process.argv.includes('--dev');
const router = new Router();
registerRoutes(router);

for (const extra of ['./tools/routes.ts', './agent/routes.ts', './export/routes.ts']) {
  const file = path.join(ROOT, 'server', extra);
  if (fs.existsSync(file)) {
    const mod = (await import(file)) as { register?: (r: Router) => void };
    mod.register?.(router);
  }
}

type Middleware = (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;
let vite: { middlewares: Middleware } | null = null;
if (dev) {
  const { createServer } = await import('vite');
  vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'spa' });
}

function serveApp(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
  if (vite) {
    vite.middlewares(req, res, () => {
      res.writeHead(404);
      res.end('not found');
    });
    return;
  }
  const file = safeJoin(DIST_DIR, pathname === '/' ? 'index.html' : pathname);
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
    // Vite fingerprints everything under /assets, so those never change.
    sendFile(req, res, file, { cache: pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    return;
  }
  const index = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(index)) sendFile(req, res, index);
  else {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('The editor has not been built yet. Run: npm run build');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
  const pathname = url.pathname;
  try {
    if (!isLocalRequest(req)) throw new HttpError(403, 'This server only answers requests from this computer.');
    if (pathname.startsWith('/fonts/')) {
      const file = safeJoin(FONTS_DIR, pathname.slice('/fonts/'.length));
      if (!file) throw new HttpError(404, 'not found');
      sendFile(req, res, file, { cache: 'public, max-age=86400' });
      return;
    }
    if (pathname.startsWith('/api/') || pathname.startsWith('/internal/')) {
      const hit = router.match(req.method ?? 'GET', pathname);
      if (!hit) throw new HttpError(404, `no such endpoint: ${req.method} ${pathname}`);
      const ctx: Ctx = {
        req,
        res,
        params: hit.params,
        query: url.searchParams,
        async body<T>() {
          const raw = await readBody(req);
          if (!raw.length) return {} as T;
          try {
            return JSON.parse(raw.toString('utf8')) as T;
          } catch {
            throw new HttpError(400, 'request body is not valid JSON');
          }
        },
        json: (data, status) => sendJson(res, data, status),
      };
      await hit.handler(ctx);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    serveApp(req, res, pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[http] ${req.method} ${pathname}:`, err);
    if (res.headersSent) res.destroy();
    else sendJson(res, { error: (err as Error).message || 'internal error' }, status);
  }
});

ensureDirs();
server.listen(PORT, HOST, () => {
  const tools = toolStatus();
  console.log(`\n  Local Studio is running at http://localhost:${PORT}${dev ? '  (dev mode)' : ''}\n`);
  if (!tools.ffmpeg) console.log('  ! ffmpeg was not found. Install it with: brew install ffmpeg');
  if (!tools.whisper) console.log('  ! Speech-to-text is not set up, so captions and transcript editing are off. Run: npm run setup');
  if (!tools.claude) console.log('  ! The claude CLI was not found, so the chat editor is off.');
  if (process.argv.includes('--open')) void import('node:child_process').then((cp) => cp.spawn('/usr/bin/open', [`http://localhost:${PORT}`], { stdio: 'ignore' }));
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is already in use. Is Local Studio already running? (Set PORT=xxxx to use another.)\n`);
  else console.error(err);
  process.exit(1);
});

const shutdown = () => {
  flushAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
