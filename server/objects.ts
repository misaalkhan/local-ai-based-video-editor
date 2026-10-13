// Object tracking for graphics that follow something: a small Swift program
// (Apple's Vision framework) follows a box the user drew through the video.
// Each track is kept with the media, so any graphic can use it.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, findBinary } from './config.ts';
import { run } from './proc.ts';
import { proxyFile } from './media.ts';
import type { Project } from './store.ts';
import { getObjectTracks, patchMedia, setObjectTracks } from './store.ts';
import { proxyFps } from './stabilize.ts';
import { uid } from '../shared/ops.ts';
import type { ID, ObjectTrack } from '../shared/types.ts';

const BIN = path.join(ROOT, 'bin', 'objtrack');
const SRC = path.join(ROOT, 'server', 'native', 'objtrack.swift');
let building: Promise<boolean> | null = null;

/** Compile the helper the first time it is needed. */
export function ensureObjectTool(): Promise<boolean> {
  if (fs.existsSync(BIN)) return Promise.resolve(true);
  if (building) return building;
  const swiftc = findBinary('swiftc');
  if (!swiftc) return Promise.resolve(false);
  fs.mkdirSync(path.dirname(BIN), { recursive: true });
  building = run(swiftc, ['-O', SRC, '-o', BIN]).then(
    () => true,
    (err) => {
      console.error('[objects] could not build the object tracker:', (err as Error).message.split('\n').slice(-3).join(' '));
      return false;
    },
  );
  return building;
}

export interface TrackRequest {
  /** Source seconds of the box. */
  t: number;
  /** The box, as fractions of the frame: centre and size. */
  cx: number;
  cy: number;
  w: number;
  h: number;
  name?: string;
  /** How far to follow at most, seconds. */
  maxSeconds?: number;
}

/** The tool's per-frame boxes to a track sampled every frame from the first box. */
export function buildObjectTrack(rows: { t: number; box: number[] }[], fps: number, id: ID, name: string): ObjectTrack {
  const interval = 1 / Math.max(1, fps);
  const start = rows.length ? rows[0].t : 0;
  const boxes: ObjectTrack['boxes'] = [];
  let last = -Infinity;
  const round = (v: number) => Math.round(v * 10000) / 10000;
  for (const r of rows) {
    const missing = Number.isFinite(last) ? Math.round((r.t - last) / interval) - 1 : 0;
    for (let k = 0; k < Math.min(missing, 300); k++) boxes.push(null);
    const [cx, cy, w, h, conf] = r.box;
    boxes.push(conf >= 0.3 && w > 0.005 && h > 0.005 ? [round(cx), round(cy), round(w), round(h)] : null);
    last = r.t;
  }
  return { id, name, interval, start: round(start), boxes };
}

/** Follow a box through a video from `t` onwards and keep the result with the media. */
export async function trackObject(p: Project, mediaId: ID, req: TrackRequest, signal?: AbortSignal): Promise<ObjectTrack> {
  const m = p.media.get(mediaId);
  if (!m || m.kind !== 'video') throw new Error('Only video can be tracked.');
  const proxy = proxyFile(p, m);
  if (!fs.existsSync(proxy)) throw new Error('The preview copy of this file is not ready yet.');
  if (!(await ensureObjectTool())) throw new Error('The object tracker could not be built (it needs the Xcode command line tools).');
  const args = [proxy, String(Math.max(0, req.t)), String(req.cx), String(req.cy), String(req.w), String(req.h), String(Math.max(0.5, Math.min(600, req.maxSeconds ?? 600)))];
  const r = await run(BIN, args, { signal });
  const rows = r.stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as { t: number; box: number[] });
  if (!rows.length) throw new Error('Nothing could be tracked there.');
  const existing = getObjectTracks(p, mediaId) ?? [];
  const name = req.name?.trim() || `Object ${existing.length + 1}`;
  const track = buildObjectTrack(rows, proxyFps(m.fps), uid('t'), name);
  setObjectTracks(p, mediaId, [...existing, track]);
  summarise(p, mediaId);
  return track;
}

export function removeObjectTrack(p: Project, mediaId: ID, trackId: ID): void {
  const existing = getObjectTracks(p, mediaId) ?? [];
  setObjectTracks(p, mediaId, existing.filter((t) => t.id !== trackId));
  summarise(p, mediaId);
}

/** Keep a short list of the tracks on the media record, so the client knows what exists. */
function summarise(p: Project, mediaId: ID): void {
  const tracks = (getObjectTracks(p, mediaId) ?? []).map((t) => ({ id: t.id, name: t.name, start: t.start, end: Math.round((t.start + t.boxes.length * t.interval) * 100) / 100 }));
  const cur = p.media.get(mediaId);
  patchMedia(p, mediaId, { tracks, rev: (cur?.rev ?? 0) + 1 });
}
