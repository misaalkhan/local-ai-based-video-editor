// Single frames of the finished picture: for the assistant to look at its own
// work, and for contact sheets. Reads the small proxies, so it is quick.

import { readLut } from '../library.ts';
import { spawn } from 'node:child_process';
import { ImageData, createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas, Image } from '@napi-rs/canvas';
import { FFMPEG } from '../config.ts';
import { PROXY_MAX, proxyFile } from '../media.ts';
import type { Project } from '../store.ts';
import { getFaces, getWords } from '../store.ts';
import type { ID, MediaAsset, ProjectDoc, SourceClip } from '../../shared/types.ts';
import { renderFrame } from '../../shared/draw.ts';
import type { FrameProvider, LayerImage } from '../../shared/draw.ts';
import type { Ctx2D } from '../../shared/graphics.ts';
import { buildCards, timelineWords } from '../../shared/captions.ts';
import { formatTime, layoutMain, sceneAt } from '../../shared/timeline.ts';
import type { MainSeg } from '../../shared/timeline.ts';
import { ensureFonts, planLayer } from './compose.ts';
import type { LayerPlan } from './compose.ts';

function grab(args: string[], size: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      resolve(buf.length >= size ? buf.subarray(0, size) : null);
    });
  });
}

/** One frame of a clip's source, cropped and sized the way the frame needs it. */
async function clipFrame(p: Project, media: MediaAsset, clip: SourceClip, sourceTime: number, W: number, H: number, fps: number): Promise<{ canvas: Canvas; plan: LayerPlan } | null> {
  const plan = planLayer(p, media, clip, W, H, fps, 1);
  const s = Math.min(1, PROXY_MAX / Math.max(media.width, media.height));
  const r = { x: Math.floor(plan.region.x * s), y: Math.floor(plan.region.y * s), w: Math.max(2, Math.floor(plan.region.w * s)), h: Math.max(2, Math.floor(plan.region.h * s)) };
  const t = Math.max(0, Math.min(sourceTime, media.duration - 0.05));
  const args = [
    '-v', 'error', '-nostdin', '-ss', t.toFixed(4), '-i', proxyFile(p, media), '-an', '-frames:v', '1',
    '-vf', `crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${plan.outW}:${plan.outH}:flags=bilinear,format=rgba`,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
  ];
  const buf = await grab(args, plan.outW * plan.outH * 4);
  if (!buf) return null;
  const canvas = createCanvas(plan.outW, plan.outH);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), plan.outW, plan.outH), 0, 0);
  return { canvas, plan };
}

export interface StillOptions {
  /** Width of the rendered frame in pixels; the height follows the project's shape. */
  width?: number;
  /** Leave out captions and graphics. */
  bare?: boolean;
}

/** Render the project as it looks at time `t`. */
export async function renderStill(p: Project, source: ProjectDoc, t: number, opts: StillOptions = {}): Promise<Canvas> {
  ensureFonts();
  const width = Math.round((opts.width ?? 540) / 2) * 2;
  const height = Math.round((width * source.settings.height) / source.settings.width / 2) * 2;
  const doc: ProjectDoc = { ...source, settings: { ...source.settings, width, height } };
  const layout = layoutMain(doc);
  const scene = sceneAt(doc, layout, t);
  const fps = doc.settings.fps;
  const layers = new Map<ID, { canvas: Canvas; plan: LayerPlan }>();
  const images = new Map<ID, Image>();
  let frozen: { seg: MainSeg; layer: { canvas: Canvas; plan: LayerPlan } } | null = null;

  const load = async (clip: SourceClip, sourceTime: number, key: ID) => {
    const m = p.media.get(clip.mediaId);
    if (!m) return;
    if (m.kind === 'image') {
      if (!images.has(m.id)) images.set(m.id, await loadImage(proxyFile(p, m)));
    } else if (m.kind === 'video') {
      const f = await clipFrame(p, m, clip, sourceTime, width, height, fps);
      if (f) layers.set(key, f);
    }
  };
  const jobs: Promise<void>[] = [];
  if (scene.main) jobs.push(load(scene.main.clip, scene.main.sourceTime, scene.main.clip.id));
  for (const o of scene.overlays) jobs.push(load(o.clip, o.sourceTime, o.clip.id));
  if (scene.transition && scene.transition.from.clip.kind === 'media') {
    const from = scene.transition.from;
    const c = from.clip as SourceClip;
    jobs.push(
      (async () => {
        const m = p.media.get(c.mediaId);
        if (m?.kind === 'video') {
          const f = await clipFrame(p, m, c, Math.max(c.in, c.out - c.speed / fps), width, height, fps);
          if (f) frozen = { seg: from, layer: f };
        } else if (m?.kind === 'image' && !images.has(m.id)) images.set(m.id, await loadImage(proxyFile(p, m)));
      })(),
    );
  }
  for (const g of scene.graphics) {
    const id = String(g.props.mediaId ?? '');
    const m = g.template === 'image' ? p.media.get(id) : undefined;
    if (m?.kind === 'image') jobs.push(loadImage(proxyFile(p, m)).then((img) => void images.set(m.id, img)));
  }
  await Promise.all(jobs);

  const asLayer = (l: { canvas: Canvas; plan: LayerPlan }): LayerImage => ({ image: l.canvas, region: l.plan.region, k: l.plan.outW / l.plan.region.w });
  const stillLayer = (m: MediaAsset): LayerImage | undefined => {
    const img = images.get(m.id);
    return img ? { image: img, region: { x: 0, y: 0, w: m.width, h: m.height }, k: img.width / m.width } : undefined;
  };
  const scratch = new Map<string, { canvas: Canvas; ctx: Ctx2D }>();
  const provider: FrameProvider = {
    mediaSize: (id) => {
      const m = p.media.get(id);
      return m ? { width: m.width, height: m.height } : undefined;
    },
    layer: (ref) => {
      const m = p.media.get(ref.clip.mediaId);
      if (!m) return undefined;
      if (m.kind === 'image') return stillLayer(m);
      const l = layers.get(ref.clip.id);
      return l ? asLayer(l) : undefined;
    },
    frozen: (seg) => {
      const f = frozen as { seg: MainSeg; layer: { canvas: Canvas; plan: LayerPlan } } | null;
      if (f && f.seg.clip.id === seg.clip.id) return asLayer(f.layer);
      const m = seg.clip.kind === 'media' ? p.media.get(seg.clip.mediaId) : undefined;
      return m?.kind === 'image' ? stillLayer(m) : undefined;
    },
    face: (id) => getFaces(p, id),
    image: (id) => {
      const img = images.get(id);
      return img ? { image: img, width: img.width, height: img.height } : undefined;
    },
    lut: (name) => readLut(name),
    scratch: (w, h) => {
      const key = `${w}x${h}`;
      let s = scratch.get(key);
      if (!s) {
        const canvas = createCanvas(w, h);
        s = { canvas, ctx: canvas.getContext('2d') as unknown as Ctx2D };
        scratch.set(key, s);
      }
      return s;
    },
  };
  const canvas = createCanvas(width, height);
  const cards = opts.bare ? undefined : buildCards(timelineWords(doc, layout, (id) => getWords(p, id)), doc.captions);
  renderFrame(canvas.getContext('2d') as unknown as Ctx2D, doc, layout, t, { provider, cards, pixelScale: 1, bare: opts.bare });
  return canvas;
}

/** A frame straight from a media file, uncropped (to see what a clip contains). */
export async function mediaStill(p: Project, media: MediaAsset, t: number, width: number): Promise<Canvas | null> {
  if (media.kind === 'audio') return null;
  const w = Math.round(width / 2) * 2;
  const h = Math.max(2, Math.round((w * media.height) / media.width / 2) * 2);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (media.kind === 'image') {
    ctx.drawImage(await loadImage(proxyFile(p, media)), 0, 0, w, h);
    return canvas;
  }
  const buf = await grab(
    ['-v', 'error', '-nostdin', '-ss', Math.max(0, Math.min(t, media.duration - 0.05)).toFixed(3), '-i', proxyFile(p, media), '-an', '-frames:v', '1',
      '-vf', `scale=${w}:${h}:flags=bilinear,format=rgba`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    w * h * 4,
  );
  if (!buf) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), w, h), 0, 0);
  return canvas;
}

/** Lay frames out in a grid, each stamped with a label, as one JPEG. */
export function contactSheet(frames: { canvas: Canvas; label: string }[], columns?: number): Buffer {
  ensureFonts();
  if (!frames.length) return Buffer.alloc(0);
  const fw = frames[0].canvas.width;
  const fh = frames[0].canvas.height;
  const cols = columns ?? Math.min(frames.length, fw > fh ? 3 : 6);
  const rows = Math.ceil(frames.length / cols);
  const gap = 6;
  const sheet = createCanvas(cols * fw + (cols + 1) * gap, rows * fh + (rows + 1) * gap);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#101114';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  const px = Math.max(13, Math.round(fw / 16));
  ctx.font = `700 ${px}px Inter, sans-serif`;
  ctx.textBaseline = 'top';
  frames.forEach((f, i) => {
    const x = gap + (i % cols) * (fw + gap);
    const y = gap + Math.floor(i / cols) * (fh + gap);
    ctx.drawImage(f.canvas, x, y);
    const w = ctx.measureText(f.label).width + px * 0.8;
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fillRect(x, y, w, px * 1.5);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(f.label, x + px * 0.4, y + px * 0.25);
  });
  return sheet.toBuffer('image/jpeg', 82);
}

export const stamp = (t: number): string => `${formatTime(t)}.${String(Math.floor((t % 1) * 10))}`;
