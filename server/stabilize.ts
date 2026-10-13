// Stabilising. A small Swift program (Apple's Vision framework) measures how
// the picture moved between every pair of frames; this file turns that into
// the camera's path, which the renderers smooth and cancel against.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, findBinary } from './config.ts';
import { run } from './proc.ts';
import { proxyFile } from './media.ts';
import type { Project } from './store.ts';
import { getStability, patchMedia, setStability } from './store.ts';
import type { ID, MotionTrack } from '../shared/types.ts';

const BIN = path.join(ROOT, 'bin', 'stabilize');
const SRC = path.join(ROOT, 'server', 'native', 'stabilize.swift');
let building: Promise<boolean> | null = null;

/** Compile the helper the first time it is needed. */
export function ensureStabTool(): Promise<boolean> {
  if (fs.existsSync(BIN)) return Promise.resolve(true);
  if (building) return building;
  const swiftc = findBinary('swiftc');
  if (!swiftc) return Promise.resolve(false);
  fs.mkdirSync(path.dirname(BIN), { recursive: true });
  building = run(swiftc, ['-O', SRC, '-o', BIN]).then(
    () => true,
    (err) => {
      console.error('[stabilize] could not build the motion tool:', (err as Error).message.split('\n').slice(-3).join(' '));
      return false;
    },
  );
  return building;
}

/**
 * Frame-to-frame shifts (pixels of a `width`×`height` picture, one row per
 * frame at `fps`) to the content's path from the first frame, as fractions.
 */
export function buildPath(rows: { t: number; dx: number; dy: number }[], width: number, height: number, fps: number): MotionTrack {
  const interval = 1 / Math.max(1, fps);
  const path: [number, number][] = [];
  let x = 0;
  let y = 0;
  let last = -Infinity;
  for (const r of rows) {
    // The registration says how far the picture moved to line up with the frame before: the content went the other way.
    // A jump of more than a sixth of the frame between two frames is a failed match (a black or featureless frame), not motion.
    const ok = Math.abs(r.dx) < width / 6 && Math.abs(r.dy) < height / 6;
    if (ok) {
      x -= r.dx / width;
      y -= r.dy / height;
    }
    // One sample per frame; a gap in the timestamps (dropped frames) holds the last position.
    const missing = Number.isFinite(last) ? Math.round((r.t - last) / interval) - 1 : 0;
    for (let k = 0; k < Math.min(missing, 300); k++) path.push(path[path.length - 1] ?? [0, 0]);
    path.push([Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]);
    last = r.t;
  }
  if (!path.length) path.push([0, 0]);
  return { interval, path };
}

/** The frame rate the proxy was made at (see media.ts), which is what the tool reads. */
export function proxyFps(fps: number): number {
  return Math.max(12, Math.min(30, Math.round(fps) || 30));
}

const pending = new Map<string, Promise<MotionTrack | null>>();

/** Measure a video's camera motion (once; the result is kept with the media). */
export function analyzeStability(p: Project, mediaId: ID, signal?: AbortSignal): Promise<MotionTrack | null> {
  const done = getStability(p, mediaId);
  if (done) return Promise.resolve(done);
  const key = `${p.id}/${mediaId}`;
  const running = pending.get(key);
  if (running) return running;
  const job = (async (): Promise<MotionTrack | null> => {
    const m = p.media.get(mediaId);
    if (!m || m.kind !== 'video') return null;
    const proxy = proxyFile(p, m);
    if (!fs.existsSync(proxy) || !(await ensureStabTool())) {
      patchMedia(p, mediaId, { stability: 'skipped' });
      return null;
    }
    patchMedia(p, mediaId, { stability: 'running' });
    try {
      const r = await run(BIN, [proxy], { signal });
      const lines = r.stdout.split('\n').filter((l) => l.startsWith('{'));
      const head = JSON.parse(lines[0] ?? '{}') as { width?: number; height?: number };
      const rows = lines.slice(1).map((l) => JSON.parse(l) as { t: number; dx: number; dy: number });
      const track = buildPath(rows, head.width || m.width, head.height || m.height, proxyFps(m.fps));
      setStability(p, mediaId, track);
      const cur = p.media.get(mediaId);
      patchMedia(p, mediaId, { stability: 'done', rev: (cur?.rev ?? 0) + 1 });
      return track;
    } catch (err) {
      if (!signal?.aborted) console.error(`[stabilize] failed for ${m.name}:`, (err as Error).message.split('\n').pop());
      patchMedia(p, mediaId, { stability: 'error' });
      return null;
    }
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}
