// Filmstrips and waveforms for the timeline, fetched once per media file.

import type { ID, MediaAsset } from '../../shared/types.ts';

const strips = new Map<string, HTMLImageElement>();
const peaks = new Map<string, { data: Uint8Array | null; max: number }>();
const waiting = new Set<() => void>();

function notify(): void {
  for (const fn of waiting) fn();
}

/** Be told whenever a filmstrip or waveform finishes loading. */
export function onAssetLoaded(fn: () => void): () => void {
  waiting.add(fn);
  return () => waiting.delete(fn);
}

export function getStrip(projectId: ID, m: MediaAsset): HTMLImageElement | null {
  if (!m.strip) return null;
  const key = `${m.id}:${m.rev}`;
  let img = strips.get(key);
  if (!img) {
    img = new Image();
    img.onload = notify;
    img.src = `/api/projects/${projectId}/media/${m.id}/strip.jpg?r=${m.rev}`;
    strips.set(key, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/** Peak level per 10 ms (0..255) and the loudest value, for scaling the drawing. */
export function getPeaks(projectId: ID, m: MediaAsset): { data: Uint8Array; max: number } | null {
  if (m.analysis !== 'done') return null;
  const key = `${m.id}:${m.rev}`;
  const hit = peaks.get(key);
  if (hit) return hit.data ? { data: hit.data, max: hit.max } : null;
  peaks.set(key, { data: null, max: 1 });
  fetch(`/api/projects/${projectId}/media/${m.id}/peaks.bin?r=${m.rev}`)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
    .then((buf) => {
      const data = new Uint8Array(buf);
      let max = 1;
      for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i];
      peaks.set(key, { data, max: Math.max(40, max) });
      notify();
    })
    .catch(() => peaks.delete(key));
  return null;
}
