// A small HTTP layer over node:http: routing with :params, JSON bodies, byte
// ranges for media, and server-sent events. Small enough to read in one go,
// which is the point of not pulling in a framework.

import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HOST, PORT } from './config.ts';
import { HttpError } from './store.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body. */
  body<T = Record<string, unknown>>(): Promise<T>;
  json(data: unknown, status?: number): void;
}

type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ttf: 'font/ttf',
  woff2: 'font/woff2',
  bin: 'application/octet-stream',
  map: 'application/json',
  txt: 'text/plain; charset=utf-8',
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

export class Router {
  private routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): void {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  }
  get(pattern: string, handler: Handler) {
    this.on('GET', pattern, handler);
  }
  post(pattern: string, handler: Handler) {
    this.on('POST', pattern, handler);
  }
  put(pattern: string, handler: Handler) {
    this.on('PUT', pattern, handler);
  }
  patch(pattern: string, handler: Handler) {
    this.on('PATCH', pattern, handler);
  }
  delete(pattern: string, handler: Handler) {
    this.on('DELETE', pattern, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const want = r.parts[i];
        if (want.startsWith(':')) {
          try {
            params[want.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            ok = false;
          }
        } else if (want !== parts[i]) ok = false;
        if (!ok) break;
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }
}

export function readBody(req: IncomingMessage, limit = 20 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': TYPES.json, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

/** Serve a file with byte-range support, which the browser needs to seek inside video. */
export function sendFile(req: IncomingMessage, res: ServerResponse, file: string, opts: { cache?: string; type?: string } = {}): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const etag = `"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`;
  const headers: Record<string, string | number> = {
    'Content-Type': opts.type ?? contentType(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.cache ?? 'no-cache',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag && !req.headers.range) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (m && stat.size > 0) {
    if (m[1] === '' && m[2] !== '') start = Math.max(0, stat.size - Number(m[2]));
    else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || stat.size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/**
 * Only this machine's own browser may talk to the server. Checking Host stops
 * DNS-rebinding; checking Origin stops other web pages from posting here.
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  const allowed = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
  if (!allowed.has(req.headers.host ?? '')) return false;
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      if (!allowed.has(new URL(origin).host)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export interface Sse {
  send(event: string, data: unknown): void;
  close(): void;
}

export function openSse(req: IncomingMessage, res: ServerResponse): Sse {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const beat = setInterval(() => res.write(': ping\n\n'), 20000);
  const close = () => {
    clearInterval(beat);
    res.end();
  };
  req.on('close', () => clearInterval(beat));
  return {
    send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close,
  };
}

export function safeJoin(root: string, rel: string): string | null {
  const full = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  return full === root || full.startsWith(root + path.sep) ? full : null;
}
