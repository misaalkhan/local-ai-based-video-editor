// Face tracking for reframing. A small Swift program (Apple's Vision
// framework) reports where faces are a few times a second; this file turns
// that into one steady path for the crop to follow.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, findBinary } from './config.ts';
import { run } from './proc.ts';
import { proxyFile } from './media.ts';
import type { Project } from './store.ts';
import { patchMedia, setFaces } from './store.ts';
import type { FaceTrack, ID } from '../shared/types.ts';

const BIN = path.join(ROOT, 'bin', 'facetrack');
const SRC = path.join(ROOT, 'server', 'native', 'facetrack.swift');
const RATE = 5;
let building: Promise<boolean> | null = null;

/** Compile the helper the first time it is needed. */
export function ensureFaceTool(): Promise<boolean> {
  if (fs.existsSync(BIN)) return Promise.resolve(true);
  if (building) return building;
  const swiftc = findBinary('swiftc');
  if (!swiftc) return Promise.resolve(false);
  fs.mkdirSync(path.dirname(BIN), { recursive: true });
  building = run(swiftc, ['-O', SRC, '-o', BIN]).then(
    () => true,
    (err) => {
      console.error('[faces] could not build the face tracker:', (err as Error).message.split('\n').slice(-3).join(' '));
      return false;
    },
  );
  return building;
}

type Box = [number, number, number, number];

/** Zero-phase smoothing: once forwards, once backwards, so the path does not lag behind the face. */
function smooth(values: number[], alpha: number): number[] {
  const out = [...values];
  for (let i = 1; i < out.length; i++) out[i] = out[i - 1] + alpha * (out[i] - out[i - 1]);
  for (let i = out.length - 2; i >= 0; i--) out[i] = out[i + 1] + alpha * (out[i] - out[i + 1]);
  return out;
}

/**
 * Turn raw detections into a camera path: follow one face, bridge short
 * dropouts, and hold still when the subject barely moves (a locked-off crop
 * looks better than one that drifts with every nod).
 */
export function buildTrack(samples: { t: number; faces: number[][] }[], duration: number): FaceTrack {
  const interval = 1 / RATE;
  const n = Math.max(1, Math.ceil(duration / interval));
  const picked: (Box | null)[] = new Array(n).fill(null);
  let prev: Box | null = null;
  for (const s of samples) {
    const i = Math.min(n - 1, Math.max(0, Math.round(s.t / interval)));
    const faces = s.faces.filter((f) => f[4] >= 0.5 && f[2] > 0.03);
    if (!faces.length) continue;
    const biggest = Math.max(...faces.map((f) => f[2] * f[3]));
    const main = faces.filter((f) => f[2] * f[3] >= biggest * 0.5);
    if (main.length >= 2) {
      // Several people of similar size: frame the group, not one of them.
      const x0 = Math.min(...main.map((f) => f[0] - f[2] / 2));
      const x1 = Math.max(...main.map((f) => f[0] + f[2] / 2));
      const y0 = Math.min(...main.map((f) => f[1] - f[3] / 2));
      const y1 = Math.max(...main.map((f) => f[1] + f[3] / 2));
      prev = [(x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0];
    } else {
      // One main face. Stay with the one we were following if a similar one appears.
      const last: Box | null = prev;
      const dist = (f: number[]) => (last ? Math.hypot(f[0] - last[0], f[1] - last[1]) : 0);
      const pick: number[] = main.reduce((a, b) => (dist(a) <= dist(b) ? a : b), main[0]);
      prev = [pick[0], pick[1], pick[2], pick[3]];
    }
    picked[i] = prev;
  }
  // Bridge gaps of up to two seconds by interpolating between the neighbours.
  const maxGap = Math.round(2 / interval);
  let lastSeen = -1;
  for (let i = 0; i < n; i++) {
    if (!picked[i]) continue;
    if (lastSeen >= 0 && i - lastSeen > 1 && i - lastSeen <= maxGap) {
      const a = picked[lastSeen]!;
      const b = picked[i]!;
      for (let k = lastSeen + 1; k < i; k++) {
        const u = (k - lastSeen) / (i - lastSeen);
        picked[k] = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
      }
    }
    lastSeen = i;
  }
  // Smooth each continuous stretch on its own.
  let i = 0;
  while (i < n) {
    if (!picked[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && picked[j + 1]) j++;
    const seg = picked.slice(i, j + 1) as Box[];
    const alpha = 1 - Math.exp(-interval / 0.45);
    const cols = [0, 1, 2, 3].map((c) => smooth(seg.map((b) => b[c]), alpha));
    const range = (v: number[]) => Math.max(...v) - Math.min(...v);
    const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
    // Small movements: lock the crop instead of following.
    const still = range(cols[0]) < 0.05 && range(cols[1]) < 0.05;
    for (let k = 0; k < seg.length; k++) {
      picked[i + k] = still
        ? [median(cols[0]), median(cols[1]), median(cols[2]), median(cols[3])]
        : [cols[0][k], cols[1][k], cols[2][k], cols[3][k]];
    }
    i = j + 1;
  }
  const round = (v: number) => Math.round(v * 10000) / 10000;
  return { interval, boxes: picked.map((b) => (b ? [round(b[0]), round(b[1]), round(b[2]), round(b[3])] : null)) };
}

const pending = new Map<string, Promise<FaceTrack | null>>();

/** Find faces in a video (once; the result is kept with the media). */
export function analyzeFaces(p: Project, mediaId: ID, signal?: AbortSignal): Promise<FaceTrack | null> {
  const key = `${p.id}/${mediaId}`;
  const running = pending.get(key);
  if (running) return running;
  const job = (async (): Promise<FaceTrack | null> => {
    const m = p.media.get(mediaId);
    if (!m || m.kind !== 'video') return null;
    const proxy = proxyFile(p, m);
    if (!fs.existsSync(proxy) || !(await ensureFaceTool())) {
      patchMedia(p, mediaId, { faces: 'skipped' });
      return null;
    }
    patchMedia(p, mediaId, { faces: 'running' });
    try {
      const r = await run(BIN, [proxy, String(RATE)], { signal });
      const samples = r.stdout
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l) as { t: number; faces: number[][] });
      const track = buildTrack(samples, m.duration);
      setFaces(p, mediaId, track);
      const cur = p.media.get(mediaId);
      patchMedia(p, mediaId, { faces: 'done', rev: (cur?.rev ?? 0) + 1 });
      return track;
    } catch (err) {
      if (!signal?.aborted) console.error(`[faces] failed for ${m.name}:`, (err as Error).message.split('\n').pop());
      patchMedia(p, mediaId, { faces: 'error' });
      return null;
    }
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

/** How much of the clip has a face in view, 0..1. */
export function faceCoverage(track: FaceTrack | undefined): number {
  if (!track || !track.boxes.length) return 0;
  return track.boxes.filter(Boolean).length / track.boxes.length;
}
