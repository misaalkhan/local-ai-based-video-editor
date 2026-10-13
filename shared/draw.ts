// Draws one finished frame onto a 2D canvas context. The browser preview and
// the Node exporter both call renderFrame; each only supplies the pictures
// (video frames, stills) through a FrameProvider. That is why an export looks
// like what was on screen.

import type { CaptionSettings, CaptionStyle, CardAnimation, ChromaKey, ClipFx, FaceTrack, GraphicItem, ID, MainClip, MotionTrack, ObjectTrack, OverlayClip, ProjectDoc, Transform } from './types.ts';
import { rng } from './vfx.ts';
import type { CaptionCard } from './captions.ts';
import { cardAt, displayWord } from './captions.ts';
import { applyBaked, bakeGrade, needsGrade } from './color.ts';
import type { Lut3D } from './color.ts';
import type { MainSeg, Rect, Scene, VisualRef } from './timeline.ts';
import { clamp, clipGeometry, faceAt, followPlacement, framingAt, layerGeometry, objectAt, sceneAt, sourceAt, srcDuration } from './timeline.ts';
import { fontString } from './fonts.ts';
import type { Ctx2D, DrawableImage } from './graphics.ts';
import { clearShadow, drawGraphic, easeInOut, easeOutBack, easeOutCubic, isRTL, refSize, roundRect, setShadow } from './graphics.ts';

/** A picture for one layer, possibly covering only part of the media and at any resolution. */
export interface LayerImage {
  image: unknown;
  /** The part of the media (in media pixels) that the image holds. */
  region: Rect;
  /** Image pixels per media pixel. */
  k: number;
}

export interface FrameProvider {
  /** Display size of a media file. */
  mediaSize(mediaId: ID): { width: number; height: number } | undefined;
  /** The frame a clip should be showing right now. */
  layer(ref: VisualRef): LayerImage | undefined;
  /** The last frame of the clip a transition is coming from. */
  frozen?(seg: MainSeg): LayerImage | undefined;
  face?(mediaId: ID): FaceTrack | undefined;
  /** The measured camera path of a video, for stabilising; undefined until analysed. */
  stability?(mediaId: ID): MotionTrack | undefined;
  /** Objects tracked through a video, for graphics that follow them. */
  objects?(mediaId: ID): ObjectTrack[] | undefined;
  /** A still image, for image graphics. */
  image?(mediaId: ID): DrawableImage | undefined;
  /** A small offscreen canvas for effects, reused between frames. */
  scratch?(w: number, h: number, slot?: string): { canvas: unknown; ctx: Ctx2D } | undefined;
  /** A 3D LUT from the library by name: null when missing, undefined while it loads. */
  lut?(name: string): Lut3D | null | undefined;
}

export interface RenderOptions {
  provider: FrameProvider;
  /** Caption cards for the whole timeline, see buildCards. */
  cards?: CaptionCard[];
  /**
   * Canvas pixels per output pixel. Canvas shadows ignore the current
   * transform, so they have to be scaled by hand to look the same at any size.
   */
  pixelScale: number;
  /** Leave out captions and graphics, to look at the footage alone. */
  bare?: boolean;
  /** A graphic to show at rest, see GraphicEnv.settled. */
  settled?: ID;
  /** Draw this clip without its colour and effects, to compare before and after. */
  bypass?: ID;
}

function fxFilter(fx: ClipFx | undefined, W: number): string {
  if (!fx) return '';
  const parts: string[] = [];
  if (fx.brightness !== undefined && fx.brightness !== 1) parts.push(`brightness(${fx.brightness.toFixed(3)})`);
  if (fx.contrast !== undefined && fx.contrast !== 1) parts.push(`contrast(${fx.contrast.toFixed(3)})`);
  if (fx.saturation !== undefined && fx.saturation !== 1) parts.push(`saturate(${fx.saturation.toFixed(3)})`);
  if (fx.grayscale) parts.push(`grayscale(${clamp(fx.grayscale, 0, 1).toFixed(3)})`);
  if (fx.blur) parts.push(`blur(${(fx.blur * W).toFixed(2)}px)`);
  if (fx.sepia) parts.push(`sepia(${clamp(fx.sepia, 0, 1).toFixed(3)})`);
  return parts.join(' ');
}

/**
 * Film grain: a tile of seeded noise laid over the picture. The seed comes
 * from the frame time, so the preview and the export show the same grain and
 * it still changes from frame to frame.
 */
function drawGrain(env: Env, amount: number, t: number, dst: Rect, alpha: number): void {
  const { ctx, o } = env;
  const size = 96;
  const sc = o.provider.scratch?.(size, size);
  if (!sc) return;
  const sctx = sc.ctx as Ctx2D & { createImageData(w: number, h: number): { data: Uint8ClampedArray }; putImageData(d: unknown, x: number, y: number): void };
  if (typeof sctx.createImageData !== 'function') return;
  const img = sctx.createImageData(size, size);
  let x = (Math.floor(t * 24) * 2654435761 + 12345) >>> 0;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const v = 96 + (x >>> 24) / 2;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = alpha * clamp(amount, 0, 1) * 0.8;
  const pattern = ctx.createPattern(sc.canvas, 'repeat');
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.fillRect(dst.x, dst.y, dst.w, dst.h);
  }
  ctx.restore();
}

interface Env {
  ctx: Ctx2D;
  W: number;
  H: number;
  o: RenderOptions;
  /** Timeline time of the frame being drawn. */
  t: number;
}

/**
 * The colour grade that a CSS filter cannot do: draw the picture into a
 * scratch canvas at output resolution, run the baked grade over its pixels,
 * and hand the canvas back to be drawn in place of the picture.
 */
function gradeInto(env: Env, fx: ClipFx, img: LayerImage, s: Rect, dst: Rect, filter: string, flip: boolean): { canvas: unknown; w: number; h: number } | null {
  const { o } = env;
  const w = Math.max(1, Math.round(dst.w * o.pixelScale));
  const h = Math.max(1, Math.round(dst.h * o.pixelScale));
  const sc = o.provider.scratch?.(w, h);
  if (!sc) return null;
  const c = sc.ctx as Ctx2D & { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray }; putImageData(d: unknown, x: number, y: number): void };
  if (typeof c.getImageData !== 'function' || typeof c.putImageData !== 'function') return null;
  c.save();
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'copy';
  if (filter && 'filter' in c) c.filter = filter;
  if (flip) {
    c.translate(w, 0);
    c.scale(-1, 1);
  }
  c.drawImage(img.image, s.x, s.y, s.w, s.h, 0, 0, w, h);
  c.restore();
  if ('filter' in c) c.filter = 'none';
  const lut = fx.lut ? o.provider.lut?.(fx.lut) : null;
  const id = c.getImageData(0, 0, w, h);
  applyBaked(id.data, bakeGrade(fx, lut ?? null));
  c.putImageData(id, 0, 0);
  return { canvas: sc.canvas, w, h };
}

/**
 * A graphic that follows something in the main clip under it: its position
 * becomes the followed box's place in the frame (plus its offset), and any
 * position keyframes give way. When nothing is being followed right now it
 * stays where it was put.
 */
function followed(env: Env, scene: Scene, g: GraphicItem): GraphicItem {
  const ref = scene.main;
  const f = g.follow!;
  if (!ref) return g;
  const { W, H, o } = env;
  const size = o.provider.mediaSize(ref.clip.mediaId);
  if (!size || !size.width || !size.height) return g;
  let box: { x: number; y: number; w: number; h: number } | null = null;
  if (f.target === 'face') box = faceAt(o.provider.face?.(ref.clip.mediaId), ref.sourceTime);
  else {
    const track = o.provider.objects?.(ref.clip.mediaId)?.find((tr) => tr.id === f.trackId);
    if (track) box = objectAt(track, ref.sourceTime);
  }
  if (!box) return g;
  const framing = framingAt(ref.clip.framing, o.provider.face?.(ref.clip.mediaId), ref.sourceTime, ref.clip.motion, env.t - ref.clipStart);
  const geom = clipGeometry(size.width, size.height, W, H, framing, stabOf(env, ref));
  const { x, y } = followPlacement(f, box, size.width, size.height, geom, W, H);
  return { ...g, x, y, keyframes: g.keyframes?.map((k) => ({ ...k, x: undefined, y: undefined })) };
}

/** What a clip's stabilising needs at this moment, when it is on and the camera path is known. */
function stabOf(env: Env, ref: VisualRef): { track: MotionTrack; t: number; strength: number } | undefined {
  const strength = ref.clip.fx?.stabilize ?? 0;
  if (!(strength > 0)) return undefined;
  const track = env.o.provider.stability?.(ref.clip.mediaId);
  return track ? { track, t: ref.sourceTime, strength } : undefined;
}

/** The picture again, as a copy on a scratch canvas sized to its area (halved for blur-heavy effects). */
function pictureCopy(env: Env, img: LayerImage, s: Rect, dst: Rect, slot: string, flip: boolean, filter: string, shrink = 1): { canvas: unknown; w: number; h: number } | null {
  const w = Math.max(2, Math.round(dst.w / shrink));
  const h = Math.max(2, Math.round(dst.h / shrink));
  const sc = env.o.provider.scratch?.(w, h, slot);
  if (!sc) return null;
  const c = sc.ctx;
  c.save();
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  if ('filter' in c) c.filter = filter || 'none';
  if (c.clearRect) c.clearRect(0, 0, w, h);
  if (flip) {
    c.translate(w, 0);
    c.scale(-1, 1);
  }
  c.drawImage(img.image, s.x, s.y, s.w, s.h, 0, 0, w, h);
  c.restore();
  return { canvas: sc.canvas, w, h };
}

/** Glow: a blurred, brightened copy of the picture added over it, so highlights bleed. */
function drawBloom(env: Env, img: LayerImage, s: Rect, dst: Rect, amount: number, alpha: number, filter: string, flip: boolean): void {
  const { ctx, W, o } = env;
  const k = clamp(amount, 0, 1);
  const radius = Math.round(0.018 * W * o.pixelScale);
  // Blur the picture at quarter size, pushing the midtones down so only the bright parts remain.
  // Contrast first pushes everything but the highlights to black; the blur then spreads what is left.
  const copy = pictureCopy(env, img, s, dst, 'bloom', flip, `${filter ? `${filter} ` : ''}contrast(4) brightness(${(0.45 + 0.25 * k).toFixed(2)}) blur(${Math.max(1, radius / 2)}px)`, 2);
  if (!copy) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha * (0.15 + 0.45 * k);
  ctx.drawImage(copy.canvas as never, 0, 0, copy.w, copy.h, dst.x, dst.y, dst.w, dst.h);
  ctx.restore();
}

/** Chromatic fringe: the red and blue channels pulled to either side. */
function drawRgbSplit(env: Env, img: LayerImage, s: Rect, dst: Rect, amount: number, alpha: number, flip: boolean): void {
  const { ctx, W } = env;
  const shift = clamp(amount, 0, 0.05) * W;
  const copy = pictureCopy(env, img, s, dst, 'split', flip, '');
  if (!copy) return;
  // Each side carries one channel only, added over the picture; the picture's own channel underneath is darkened to keep the sum right.
  const sides: { dx: number; keep: string; cut: string }[] = [
    { dx: -shift, keep: '#FF0000', cut: 'rgba(255,0,0,1)' },
    { dx: shift, keep: '#0000FF', cut: 'rgba(0,0,255,1)' },
  ];
  ctx.save();
  ctx.beginPath();
  ctx.rect(dst.x, dst.y, dst.w, dst.h);
  ctx.clip();
  for (const side of sides) {
    // Remove this channel from the picture where it sits, then add the shifted copy of that channel.
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = side.keep === '#FF0000' ? '#00FFFF' : '#FFFF00';
    ctx.fillRect(dst.x, dst.y, dst.w, dst.h);
    const sc = env.o.provider.scratch?.(copy.w, copy.h, 'split-channel');
    if (!sc) break;
    const c = sc.ctx;
    c.save();
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    if (c.clearRect) c.clearRect(0, 0, copy.w, copy.h);
    c.drawImage(copy.canvas as never, 0, 0);
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = side.keep;
    c.fillRect(0, 0, copy.w, copy.h);
    c.restore();
    ctx.globalCompositeOperation = 'lighter';
    // Stretched by the shift so the far edge is not left without this channel.
    ctx.drawImage(sc.canvas as never, 0, 0, copy.w, copy.h, dst.x + Math.min(0, side.dx), dst.y, dst.w + Math.abs(side.dx), dst.h);
  }
  ctx.restore();
}

/** Draw a media clip's picture into the frame. Returns false when the picture is not available. */
function drawClip(env: Env, ref: VisualRef, img: LayerImage | undefined, alpha: number): boolean {
  const { ctx, W, H, o } = env;
  if (!img || alpha <= 0.001) return !!img;
  const size = o.provider.mediaSize(ref.clip.mediaId);
  if (!size || !size.width || !size.height) return false;
  const framing = framingAt(ref.clip.framing, o.provider.face?.(ref.clip.mediaId), ref.sourceTime, ref.clip.motion, env.t - ref.clipStart);
  const { src, dst } = clipGeometry(size.width, size.height, W, H, framing, stabOf(env, ref));
  const toImage = (r: Rect): Rect => ({
    x: (r.x - img.region.x) * img.k,
    y: (r.y - img.region.y) * img.k,
    w: r.w * img.k,
    h: r.h * img.k,
  });

  if (framing.fit === 'contain' && framing.blurFill) {
    // Fill the bars with a soft, darkened copy: draw tiny, then stretch.
    const sw = Math.max(8, Math.round(W / 14));
    const sh = Math.max(8, Math.round(H / 14));
    const sc = o.provider.scratch?.(sw, sh);
    if (sc) {
      const cover = layerGeometry(size.width, size.height, W, H, { ...framing, fit: 'cover', scale: 1.15 });
      const s = toImage(cover.src);
      sc.ctx.save();
      if ('filter' in sc.ctx) sc.ctx.filter = 'blur(2px) brightness(0.55)';
      sc.ctx.drawImage(img.image, s.x, s.y, s.w, s.h, 0, 0, sw, sh);
      sc.ctx.restore();
      ctx.globalAlpha = alpha;
      ctx.drawImage(sc.canvas, 1, 1, sw - 2, sh - 2, 0, 0, W, H);
    }
  }
  const s = toImage(src);
  const fx = o.bypass === ref.clip.id ? undefined : ref.clip.fx;
  const filter = fxFilter(fx, W * o.pixelScale);
  ctx.globalAlpha = alpha;
  const graded = fx && needsGrade(fx) ? gradeInto(env, fx, img, s, dst, filter, !!fx.flip) : null;
  if (graded) {
    ctx.drawImage(graded.canvas, 0, 0, graded.w, graded.h, dst.x, dst.y, dst.w, dst.h);
  } else {
    if (filter && 'filter' in ctx) ctx.filter = filter;
    if (fx?.flip) {
      // Mirror within the picture's own area.
      ctx.save();
      ctx.translate(2 * dst.x + dst.w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img.image, s.x, s.y, s.w, s.h, dst.x, dst.y, dst.w, dst.h);
      ctx.restore();
    } else ctx.drawImage(img.image, s.x, s.y, s.w, s.h, dst.x, dst.y, dst.w, dst.h);
    if (filter && 'filter' in ctx) ctx.filter = 'none';
  }
  // Warmth tints the picture towards orange or blue; a vignette darkens the edges. Both are drawn over the clip's own area.
  if (fx?.warmth) {
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = alpha * Math.min(1, Math.abs(fx.warmth)) * 0.9;
    ctx.fillStyle = fx.warmth > 0 ? '#ff9a3c' : '#3c8cff';
    ctx.fillRect(dst.x, dst.y, dst.w, dst.h);
    ctx.restore();
  }
  if (fx?.vignette) {
    ctx.save();
    const cx = dst.x + dst.w / 2;
    const cy = dst.y + dst.h / 2;
    const r = Math.hypot(dst.w, dst.h) / 2;
    const g = ctx.createRadialGradient(cx, cy, r * 0.45, cx, cy, r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${Math.min(1, fx.vignette) * 0.75})`);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.fillRect(dst.x, dst.y, dst.w, dst.h);
    ctx.restore();
  }
  if (fx?.bloom) drawBloom(env, img, s, dst, fx.bloom, alpha, filter, !!fx.flip);
  if (fx?.rgbSplit) drawRgbSplit(env, img, s, dst, fx.rgbSplit, alpha, !!fx.flip);
  if (fx?.grain) drawGrain(env, fx.grain, env.t, dst, alpha);
  if (fx?.letterbox) {
    // Cinema bars: across the whole frame for the main picture, within the picture for an overlay.
    const area = ref.role === 'main' ? { x: 0, y: 0, w: W, h: H } : dst;
    const bar = clamp(fx.letterbox, 0, 0.4) * area.h;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#000000';
    ctx.fillRect(area.x, area.y, area.w, bar);
    ctx.fillRect(area.x, area.y + area.h - bar, area.w, bar);
  }
  ctx.globalAlpha = 1;
  return true;
}

/** Ready-made colour looks, as the settings they stand for. */
export const LOOKS: Record<string, { label: string; fx: ClipFx }> = {
  warm: { label: 'Warm', fx: { brightness: 1.03, contrast: 1.05, saturation: 1.1, warmth: 0.5 } },
  cool: { label: 'Cool', fx: { contrast: 1.05, saturation: 0.95, warmth: -0.5 } },
  vivid: { label: 'Vivid', fx: { contrast: 1.1, saturation: 1.35 } },
  faded: { label: 'Faded', fx: { brightness: 1.06, contrast: 0.88, saturation: 0.85 } },
  vintage: { label: 'Vintage', fx: { contrast: 0.92, saturation: 0.8, warmth: 0.4, vignette: 0.5 } },
  moody: { label: 'Moody', fx: { brightness: 0.92, contrast: 1.15, saturation: 0.85, warmth: -0.2, vignette: 0.6 } },
  cinematic: { label: 'Cinematic', fx: { contrast: 1.12, saturation: 0.9, warmth: 0.15, vignette: 0.35 } },
  bw: { label: 'Black and white', fx: { grayscale: 1, contrast: 1.1 } },
  golden: { label: 'Golden hour', fx: { brightness: 1.04, contrast: 1.04, saturation: 1.15, warmth: 0.75, vignette: 0.25 } },
  teal: { label: 'Teal and orange', fx: { contrast: 1.12, saturation: 1.2, warmth: 0.3, vignette: 0.2 } },
  pastel: { label: 'Pastel', fx: { brightness: 1.08, contrast: 0.85, saturation: 0.75, warmth: 0.2 } },
  punchy: { label: 'Punchy', fx: { contrast: 1.2, saturation: 1.45, vignette: 0.15 } },
  noir: { label: 'Noir', fx: { grayscale: 1, contrast: 1.3, brightness: 0.95, vignette: 0.65, grain: 0.35 } },
  film: { label: 'Film', fx: { contrast: 1.06, saturation: 0.92, warmth: 0.2, grain: 0.4, vignette: 0.3 } },
  sepia: { label: 'Sepia', fx: { sepia: 0.85, contrast: 1.05, vignette: 0.35 } },
  dreamy: { label: 'Dreamy', fx: { brightness: 1.07, contrast: 0.9, saturation: 0.95, warmth: 0.25, blur: 0.0015 } },
  bleach: { label: 'Bleach', fx: { brightness: 1.1, contrast: 1.22, saturation: 0.55 } },
  cinema: { label: 'Widescreen', fx: { contrast: 1.1, saturation: 0.92, warmth: 0.1, letterbox: 0.12, vignette: 0.3 } },
};

function drawMainSeg(env: Env, seg: MainSeg, ref: VisualRef | undefined, img: LayerImage | undefined, alpha: number): void {
  const { ctx, W, H } = env;
  if (seg.clip.kind === 'color') {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = seg.clip.color;
    ctx.fillRect(0, 0, W, H);
    if (seg.clip.animated) drawAnimatedCard(ctx, seg.clip.animated, seg.clip.color, seg.clip.accent, env.t - seg.start, W, H);
    ctx.globalAlpha = 1;
  } else if (ref) drawClip(env, ref, img, alpha);
}

/** Moving backgrounds for title cards, from the card's colour and an accent. */
function drawAnimatedCard(ctx: Ctx2D, kind: CardAnimation, color: string, accent: string | undefined, t: number, W: number, H: number): void {
  const acc = accent || '#FFFFFF';
  const R = Math.max(W, H);
  ctx.save();
  switch (kind) {
    case 'flow': {
      // Two broad colour blobs circling slowly.
      for (let i = 0; i < 2; i++) {
        const cx = W * (0.5 + 0.35 * Math.sin(t * 0.35 + i * 2.1));
        const cy = H * (0.5 + 0.3 * Math.cos(t * 0.27 + i * 1.3));
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.6);
        g.addColorStop(0, acc);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
      break;
    }
    case 'aurora': {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 4; i++) {
        const y = H * (0.2 + i * 0.18 + 0.06 * Math.sin(t * 0.6 + i));
        const g = ctx.createLinearGradient(0, y - H * 0.18, 0, y + H * 0.18);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(0.5, acc);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 0.16 + 0.08 * Math.sin(t * 0.9 + i * 1.7);
        ctx.fillStyle = g;
        ctx.save();
        ctx.translate(W / 2, y);
        ctx.rotate(0.08 * Math.sin(t * 0.3 + i));
        ctx.fillRect(-W, -H * 0.18, 2 * W, H * 0.36);
        ctx.restore();
      }
      break;
    }
    case 'rays': {
      ctx.translate(W / 2, H / 2);
      ctx.rotate(t * 0.12);
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = acc;
      for (let i = 0; i < 14; i++) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        const a0 = (i / 14) * Math.PI * 2;
        ctx.arc(0, 0, R * 1.2, a0, a0 + Math.PI / 14);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'bokeh': {
      ctx.globalCompositeOperation = 'lighter';
      const r = rng(5);
      for (let i = 0; i < 18; i++) {
        const x = W * ((r() + 0.04 * t * (0.5 + r())) % 1);
        const y = H * ((r() - 0.02 * t * (0.5 + r()) + 10) % 1);
        const rad = R * (0.03 + 0.08 * r());
        const g = ctx.createRadialGradient(x, y, rad * 0.5, x, y, rad);
        g.addColorStop(0, acc);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = 0.12 + 0.1 * r();
        ctx.fillStyle = g;
        ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
      break;
    }
    case 'grid': {
      const step = R / 12;
      const off = (t * step * 0.25) % step;
      ctx.strokeStyle = acc;
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = Math.max(1, R / 900);
      ctx.beginPath();
      for (let x = -step + off; x < W + step; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      }
      for (let y = -step + off; y < H + step; y += step) {
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

/** The frozen last frame of a main clip, as something drawClip understands. */
function lastFrameRef(seg: MainSeg, fps: number): VisualRef | undefined {
  const c: MainClip = seg.clip;
  if (c.kind !== 'media') return undefined;
  return { clip: c, role: 'main', clipStart: seg.start, sourceTime: sourceAt(c, Math.max(0, srcDuration(c) - 1 / fps)), opacity: 1 };
}

function drawMain(env: Env, scene: Scene, layout: MainSeg[], fps: number): void {
  const { ctx, W, H, o } = env;
  const cur = layout.find((s) => scene.t >= s.start - 1e-6 && scene.t < s.end - 1e-6);
  const drawCurrent = (alpha = 1) => {
    if (cur) drawMainSeg(env, cur, scene.main, scene.main ? o.provider.layer(scene.main) : undefined, alpha);
  };
  const tr = scene.transition;
  if (!tr || !cur) {
    drawCurrent();
    return;
  }
  const fromRef = lastFrameRef(tr.from, fps);
  const drawFrom = (alpha = 1) => drawMainSeg(env, tr.from, fromRef, o.provider.frozen?.(tr.from), alpha);
  const p = easeOutCubic(tr.p);
  switch (tr.type) {
    case 'burn': {
      // Film burn: the outgoing picture flares up from one corner in hot orange and white, then the new one is left behind.
      if (tr.p < 0.55) drawFrom();
      else drawCurrent();
      const k = Math.sin(clamp(tr.p, 0, 1) * Math.PI);
      const reach = Math.hypot(W, H) * (0.2 + 1.3 * easeOutCubic(tr.p));
      const g = ctx.createRadialGradient(W * 1.05, H * 0.95, 0, W * 1.05, H * 0.95, reach);
      g.addColorStop(0, `rgba(255,255,240,${(0.95 * k).toFixed(3)})`);
      g.addColorStop(0.45, `rgba(255,160,40,${(0.85 * k).toFixed(3)})`);
      g.addColorStop(0.8, `rgba(200,40,0,${(0.35 * k).toFixed(3)})`);
      g.addColorStop(1, 'rgba(120,0,0,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      ctx.globalAlpha = 1;
      break;
    }
    case 'dip':
    case 'flash': {
      // Out to black (or white) over the first half, back in over the second.
      if (tr.p < 0.5) drawFrom();
      else drawCurrent();
      const k = 1 - Math.abs(tr.p - 0.5) * 2;
      ctx.globalAlpha = tr.type === 'flash' ? Math.pow(k, 0.6) : k;
      ctx.fillStyle = tr.type === 'flash' ? '#FFFFFF' : '#000000';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      break;
    }
    case 'slide-left':
    case 'slide-right':
    case 'slide-up':
    case 'whip': {
      const dx = tr.type === 'slide-left' || tr.type === 'whip' ? -1 : tr.type === 'slide-right' ? 1 : 0;
      const dy = tr.type === 'slide-up' ? -1 : 0;
      // A whip pan: both pictures streak sideways, blurred most at the middle of the move.
      const whip = tr.type === 'whip';
      const q = whip ? easeInOut(tr.p) : p;
      const streak = whip ? Math.sin(tr.p * Math.PI) : 0;
      // Blur radii follow the same convention as fxFilter: canvas pixels in the browser, frame units in the exporter.
      const blur = streak > 0.05 && 'filter' in ctx ? `blur(${(streak * W * o.pixelScale * 0.03).toFixed(1)}px)` : '';
      ctx.save();
      if (blur) ctx.filter = blur;
      ctx.translate(dx * q * W, dy * q * H);
      drawFrom();
      ctx.restore();
      ctx.save();
      if (blur) ctx.filter = blur;
      ctx.translate(-dx * (1 - q) * W, -dy * (1 - q) * H);
      drawCurrent();
      ctx.restore();
      break;
    }
    case 'blur': {
      // The old picture blurs away while the new one sharpens into place.
      const k = easeInOut(tr.p);
      const can = 'filter' in ctx;
      const r = W * o.pixelScale * 0.02;
      ctx.save();
      if (can && k < 1) ctx.filter = `blur(${((1 - k) * r).toFixed(1)}px)`;
      drawCurrent();
      ctx.restore();
      ctx.save();
      if (can && k > 0) ctx.filter = `blur(${(k * r).toFixed(1)}px)`;
      drawFrom(1 - k);
      ctx.restore();
      break;
    }
    case 'glitch': {
      // Horizontal bands of the two pictures shoved sideways, settling on the new one.
      const seed = Math.floor(tr.p * 14);
      let r = (seed * 2654435761 + 97) >>> 0;
      const rnd = () => {
        r = (Math.imul(r, 1664525) + 1013904223) >>> 0;
        return r / 4294967296;
      };
      const strength = Math.sin(tr.p * Math.PI);
      drawCurrent();
      const bands = 7;
      for (let i = 0; i < bands; i++) {
        const y0 = (i / bands) * H;
        const h = H / bands;
        const useFrom = rnd() > tr.p;
        const shift = (rnd() - 0.5) * W * 0.18 * strength;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, y0, W, h);
        ctx.clip();
        ctx.translate(shift, 0);
        if (useFrom) drawFrom();
        else drawCurrent();
        ctx.restore();
      }
      // A thin colour fringe while it tears.
      if (strength > 0.2) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.18 * strength;
        ctx.fillStyle = '#00E5FF';
        ctx.fillRect((rnd() - 0.5) * W * 0.04, 0, W, H);
        ctx.restore();
      }
      break;
    }
    case 'zoom': {
      drawCurrent();
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(1 + 0.5 * p, 1 + 0.5 * p);
      ctx.translate(-W / 2, -H / 2);
      drawFrom(1 - tr.p);
      ctx.restore();
      break;
    }
    default:
      drawCurrent();
      drawFrom(1 - tr.p);
  }
}

/** Hex colour to 0..255 channels. */
function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 255, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Green-screen keying in place: pixels whose chroma sits near the key colour
 * turn transparent, with a soft edge, and the key's tint is pulled out of the
 * pixels along that edge (spill).
 */
export function chromaKey(data: Uint8ClampedArray, key: ChromaKey): void {
  const [kr, kg, kb] = hexRgb(key.color);
  const kcb = -0.1687 * kr - 0.3313 * kg + 0.5 * kb;
  const kcr = 0.5 * kr - 0.4187 * kg - 0.0813 * kb;
  // Similarity 0..1 spans chroma distances 0..~120 (of a possible ~180).
  const lo = clamp(key.similarity, 0, 1) * 120;
  const hi = lo + clamp(key.smoothness, 0, 1) * 80 + 1;
  const spill = clamp(key.spill, 0, 1);
  const keyMax = Math.max(kr, kg, kb);
  const keyChannel = keyMax === kg ? 1 : keyMax === kb ? 2 : 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const cb = -0.1687 * r - 0.3313 * g + 0.5 * b;
    const cr = 0.5 * r - 0.4187 * g - 0.0813 * b;
    const d = Math.hypot(cb - kcb, cr - kcr);
    let a = d <= lo ? 0 : d >= hi ? 1 : (d - lo) / (hi - lo);
    a = a * a * (3 - 2 * a);
    if (a < 1 && spill > 0) {
      // Pull the key channel down to the other two, by how close the pixel is to the key.
      const others = keyChannel === 1 ? (r + b) / 2 : keyChannel === 2 ? (r + g) / 2 : (g + b) / 2;
      const v = data[i + keyChannel];
      if (v > others) data[i + keyChannel] = Math.round(v - (v - others) * spill * (1 - a * 0.5));
    }
    if (a < 1) data[i + 3] = Math.round(data[i + 3] * a);
  }
}

/** Mask, blend mode or green screen: the layer is built on a scratch canvas, shaped, keyed, then composited. */
function drawShapedOverlay(env: Env, ref: VisualRef, img: LayerImage): void {
  const { ctx, W, H, o } = env;
  const clip = ref.clip as OverlayClip;
  const k = o.pixelScale;
  const sw = Math.max(1, Math.round(W * k));
  const sh = Math.max(1, Math.round(H * k));
  const layer = o.provider.scratch?.(sw, sh, 'layer');
  if (!layer) return;
  const lc = layer.ctx as Ctx2D & { setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray }; putImageData(d: unknown, x: number, y: number): void };
  lc.save();
  lc.setTransform(1, 0, 0, 1, 0, 0);
  lc.globalCompositeOperation = 'copy';
  lc.globalAlpha = 0;
  lc.fillStyle = '#000';
  lc.fillRect(0, 0, sw, sh);
  lc.globalCompositeOperation = 'source-over';
  lc.globalAlpha = 1;
  lc.setTransform(k, 0, 0, k, 0, 0);
  // The layer itself, placed as it would be in the frame.
  const tr = ref.transform;
  const size = o.provider.mediaSize(ref.clip.mediaId);
  const framing = framingAt(ref.clip.framing, undefined, ref.sourceTime, ref.clip.motion, env.t - ref.clipStart);
  const dst = size ? layerGeometry(size.width, size.height, W, H, framing).dst : { x: 0, y: 0, w: W, h: H };
  const place = (c: Ctx2D) => {
    if (tr) {
      c.translate(tr.x * W, tr.y * H);
      if (tr.rotation) c.rotate((tr.rotation * Math.PI) / 180);
      c.scale(tr.scale, tr.scale);
      c.translate(-W / 2, -H / 2);
    }
  };
  lc.save();
  place(lc);
  if (ref.radius) {
    roundRect(lc, dst.x, dst.y, dst.w, dst.h, ref.radius * dst.w);
    lc.clip();
  }
  drawClip({ ...env, ctx: lc }, ref, img, 1);
  lc.restore();
  // Green screen.
  if (clip.key && typeof lc.getImageData === 'function') {
    lc.setTransform(1, 0, 0, 1, 0, 0);
    const id = lc.getImageData(0, 0, sw, sh);
    chromaKey(id.data, clip.key);
    lc.putImageData(id, 0, 0);
    lc.setTransform(k, 0, 0, k, 0, 0);
  }
  // Mask: a shape in the picture's own coordinates, softened with a blur, kept (or cut) from the layer.
  const mask = clip.mask;
  if (mask) {
    const m = o.provider.scratch?.(sw, sh, 'mask');
    if (m) {
      const mc = m.ctx as Ctx2D & { setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void };
      mc.save();
      mc.setTransform(1, 0, 0, 1, 0, 0);
      mc.globalCompositeOperation = 'copy';
      mc.globalAlpha = 0;
      mc.fillStyle = '#000';
      mc.fillRect(0, 0, sw, sh);
      mc.globalCompositeOperation = 'source-over';
      mc.globalAlpha = 1;
      mc.setTransform(k, 0, 0, k, 0, 0);
      place(mc);
      const feather = clamp(mask.feather ?? 0, 0, 0.5) * dst.w * k * (tr?.scale ?? 1);
      if (feather > 0.5 && 'filter' in mc) mc.filter = `blur(${feather.toFixed(1)}px)`;
      mc.fillStyle = '#fff';
      const mx = dst.x + mask.x * dst.w;
      const my = dst.y + mask.y * dst.h;
      const mw = Math.max(0.001, mask.w) * dst.w;
      const mh = Math.max(0.001, mask.h) * dst.h;
      mc.beginPath();
      if (mask.shape === 'ellipse') mc.ellipse(mx + mw / 2, my + mh / 2, mw / 2, mh / 2, 0, 0, Math.PI * 2);
      else roundRect(mc, mx, my, mw, mh, (mask.radius ?? 0) * dst.w);
      mc.fill();
      if ('filter' in mc) mc.filter = 'none';
      mc.restore();
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.globalCompositeOperation = mask.invert ? 'destination-out' : 'destination-in';
      lc.drawImage(m.canvas, 0, 0, sw, sh, 0, 0, sw, sh);
      lc.globalCompositeOperation = 'source-over';
      lc.setTransform(k, 0, 0, k, 0, 0);
    }
  }
  lc.restore();
  ctx.save();
  ctx.globalAlpha = ref.opacity;
  if (clip.blend && clip.blend !== 'normal') ctx.globalCompositeOperation = clip.blend;
  ctx.drawImage(layer.canvas, 0, 0, sw, sh, 0, 0, W, H);
  ctx.restore();
}

function drawOverlay(env: Env, ref: VisualRef): void {
  const { ctx, W, H, o } = env;
  const img = o.provider.layer(ref);
  if (!img) return;
  const clip = ref.clip as OverlayClip;
  if (clip.mask || clip.key || (clip.blend && clip.blend !== 'normal')) {
    drawShapedOverlay(env, ref, img);
    return;
  }
  const tr: Transform | undefined = ref.transform;
  const plain = !tr || (tr.x === 0.5 && tr.y === 0.5 && tr.scale === 1 && tr.rotation === 0);
  if (plain && !ref.radius) {
    drawClip(env, ref, img, ref.opacity);
    return;
  }
  ctx.save();
  if (tr) {
    ctx.translate(tr.x * W, tr.y * H);
    if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
    ctx.scale(tr.scale, tr.scale);
    ctx.translate(-W / 2, -H / 2);
  }
  if (ref.radius) {
    const size = o.provider.mediaSize(ref.clip.mediaId);
    const framing = framingAt(ref.clip.framing, undefined, ref.sourceTime, ref.clip.motion, env.t - ref.clipStart);
    const dst = size ? layerGeometry(size.width, size.height, W, H, framing).dst : { x: 0, y: 0, w: W, h: H };
    roundRect(ctx, dst.x, dst.y, dst.w, dst.h, ref.radius * dst.w);
    ctx.clip();
  }
  drawClip(env, ref, img, ref.opacity);
  ctx.restore();
}

/** Draw the frame for timeline time `t`. The context must already be scaled so that one unit is one output pixel. */
export function renderFrame(ctx: Ctx2D, doc: ProjectDoc, layout: MainSeg[], t: number, o: RenderOptions): Scene {
  const W = doc.settings.width;
  const H = doc.settings.height;
  const env: Env = { ctx, W, H, o, t };
  const scene = sceneAt(doc, layout, t);
  ctx.save();
  ctx.globalAlpha = 1;
  clearShadow(ctx);
  ctx.fillStyle = doc.settings.background;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  if (scene.zoom.dx || scene.zoom.dy) ctx.translate(scene.zoom.dx * W, scene.zoom.dy * H);
  if (scene.zoom.scale !== 1) {
    const fx = scene.zoom.focusX * W;
    const fy = scene.zoom.focusY * H;
    ctx.translate(fx, fy);
    ctx.scale(scene.zoom.scale, scene.zoom.scale);
    ctx.translate(-fx, -fy);
  }
  drawMain(env, scene, layout, doc.settings.fps);
  ctx.restore();

  for (const ref of scene.overlays) drawOverlay(env, ref);

  if (!o.bare) {
    const genv = { W, H, pixelScale: o.pixelScale, getImage: o.provider.image ? (id: string) => o.provider.image!(id) : undefined, settled: o.settled };
    for (const g of scene.graphics) drawGraphic(ctx, g.follow ? followed(env, scene, g) : g, t, genv);
    if (doc.captions.enabled && o.cards) {
      const card = cardAt(o.cards, t);
      if (card) drawCaption(ctx, card, t, doc.captions, W, H, o.pixelScale);
    }
  }
  ctx.restore();
  return scene;
}

// ---------------------------------------------------------------------------
// Captions

interface StyleSpec {
  font: string;
  weight: number;
  /** Font size as a fraction of the reference size (see refSize). */
  size: number;
  stroke?: number;
  shadow?: boolean;
  /** The card scales up a little as it arrives and the spoken word grows. */
  pop?: boolean;
  /** Only the word being spoken is on screen. */
  single?: boolean;
  /** Words appear as they are spoken and stay, typed by a cursor. */
  reveal?: boolean;
  /** A backdrop behind the lines. */
  box?: 'dark' | 'glass' | 'band';
  /** How the word being spoken is marked. */
  mark?: 'accent' | 'karaoke' | 'highlight' | 'underline' | 'none';
  /** Soft light around every word, strongest on the spoken one. */
  glow?: boolean;
  /** A hard offset shadow in the accent colour. */
  depth?: boolean;
  /** The spoken word tilts a little as it pops. */
  wobble?: boolean;
}

export const CAPTION_STYLES: Record<CaptionStyle, StyleSpec> = {
  clean: { font: 'Inter', weight: 700, size: 0.05, stroke: 0.045, shadow: true },
  pop: { font: 'Montserrat', weight: 900, size: 0.072, stroke: 0.1, pop: true },
  highlight: { font: 'Poppins', weight: 700, size: 0.058, shadow: true, mark: 'highlight' },
  boxed: { font: 'Inter', weight: 600, size: 0.045, box: 'dark' },
  karaoke: { font: 'Montserrat', weight: 800, size: 0.062, stroke: 0.09, pop: true, mark: 'karaoke' },
  outline: { font: 'Anton', weight: 400, size: 0.084, stroke: 0.13, pop: true },
  oneword: { font: 'Archivo Black', weight: 400, size: 0.12, stroke: 0.1, single: true, pop: true },
  glow: { font: 'Poppins', weight: 700, size: 0.06, glow: true },
  glass: { font: 'Inter', weight: 600, size: 0.047, box: 'glass' },
  typewriter: { font: 'Space Mono', weight: 700, size: 0.046, box: 'dark', reveal: true, mark: 'none' },
  band: { font: 'Oswald', weight: 700, size: 0.056, box: 'band', mark: 'underline' },
  underline: { font: 'Inter', weight: 800, size: 0.056, shadow: true, mark: 'underline' },
  retro: { font: 'Bungee', weight: 400, size: 0.066, depth: true, pop: true, mark: 'none' },
  comic: { font: 'Bangers', weight: 400, size: 0.088, stroke: 0.09, pop: true, wobble: true, mark: 'none' },
};

interface PlacedWord {
  text: string;
  x: number;
  y: number;
  w: number;
  start: number;
  /** Marked for emphasis: stays in the accent colour whether or not it is being spoken. */
  strong: boolean;
}

export function drawCaption(
  ctx: Ctx2D,
  card: CaptionCard,
  t: number,
  s: CaptionSettings,
  W: number,
  H: number,
  pixelScale: number,
): void {
  const spec = CAPTION_STYLES[s.style] ?? CAPTION_STYLES.clean;
  const px = spec.size * (s.size || 1) * refSize(W, H);
  const emphasis = s.emphasis?.length ? new Set(s.emphasis) : null;
  const shown = card.words
    .map((w) => ({ text: displayWord(w.text, s), start: w.start, strong: !!emphasis?.has(w.key) }))
    .filter((w) => w.text);
  if (!shown.length) return;

  ctx.save();
  ctx.font = fontString(s.font || spec.font, spec.weight, px);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  // Outlines thicken every letter, so widen the gap between words to match.
  const space = (ctx.measureText(' ').width || px * 0.28) + (spec.stroke ?? 0) * px * 2;
  const maxW = W * 0.86;
  const lineH = px * 1.24;
  const rtl = isRTL(shown.map((w) => w.text).join(' '));

  // Greedy wrap, then centre every line.
  const lines: { words: { text: string; w: number; start: number; strong: boolean }[]; width: number }[] = [];
  for (const word of shown) {
    const w = ctx.measureText(word.text).width;
    const line = lines[lines.length - 1];
    if (line && line.width + space + w <= maxW && !spec.single) {
      line.words.push({ ...word, w });
      line.width += space + w;
    } else lines.push({ words: [{ ...word, w }], width: w });
  }
  const blockH = spec.single ? lineH : lineH * lines.length;
  const blockW = Math.max(...lines.map((l) => l.width));
  const placed: PlacedWord[] = [];
  lines.forEach((line, li) => {
    const y = spec.single ? px * 0.35 : -blockH / 2 + lineH * (li + 0.5) + px * 0.35;
    // Right-to-left scripts run from the right edge of the line.
    let x = rtl ? line.width / 2 : -line.width / 2;
    for (const word of line.words) {
      if (rtl) x -= word.w;
      placed.push({ text: word.text, x, y, w: word.w, start: word.start, strong: word.strong });
      x += rtl ? -space : word.w + space;
    }
  });
  let active = -1;
  for (let i = 0; i < placed.length; i++) if (placed[i].start <= t + 1e-4) active = i;
  // One word at a time: only the spoken word (or the first, before anyone speaks) is drawn, centred.
  const visible = (i: number): boolean => {
    if (spec.single) return i === Math.max(0, active);
    if (spec.reveal) return i <= Math.max(0, active);
    return true;
  };

  ctx.translate(W / 2, s.y * H);
  // One word too long for the frame: shrink the card rather than run off the edges.
  if (blockW > maxW) ctx.scale(maxW / blockW, maxW / blockW);
  if (spec.pop && !spec.single) {
    const k = clamp((t - card.start) / 0.09, 0, 1);
    const sc = 0.88 + 0.12 * easeOutCubic(k);
    ctx.scale(sc, sc);
  }
  const wordStart = (i: number) => (i === 0 ? Math.min(card.start, placed[0].start) : placed[i].start);

  // Backdrops.
  if (spec.box === 'dark' || spec.box === 'glass') {
    const padX = px * (spec.box === 'glass' ? 0.7 : 0.55);
    const padY = px * (spec.box === 'glass' ? 0.4 : 0.32);
    const r = px * (spec.box === 'glass' ? 0.6 : 0.32);
    // The typed box grows with the text so the cursor never sits in empty space.
    let w = blockW;
    if (spec.reveal) {
      const last = placed.filter((_, i) => visible(i)).pop();
      w = last ? Math.max(px * 2, last.x + last.w + px * 0.7 + blockW / 2) : px * 2;
      if (rtl) w = blockW;
    }
    ctx.fillStyle = spec.box === 'glass' ? 'rgba(16,16,24,0.5)' : 'rgba(0,0,0,0.72)';
    roundRect(ctx, -blockW / 2 - padX, -blockH / 2 - padY, (spec.reveal && !rtl ? w : blockW) + 2 * padX, blockH + 2 * padY, r);
    ctx.fill();
    if (spec.box === 'glass') {
      ctx.lineWidth = Math.max(1, px * 0.03);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      roundRect(ctx, -blockW / 2 - padX, -blockH / 2 - padY, blockW + 2 * padX, blockH + 2 * padY, r);
      ctx.stroke();
    }
  }
  if (spec.box === 'band') {
    const padY = px * 0.45;
    ctx.fillStyle = s.accent;
    ctx.fillRect(-W, -blockH / 2 - padY, 2 * W, blockH + 2 * padY);
  }
  if (spec.mark === 'highlight' && active >= 0) {
    const a = placed[active];
    const padX = px * 0.2;
    ctx.fillStyle = s.accent;
    roundRect(ctx, a.x - padX, a.y - px * 0.92, a.w + 2 * padX, px * 1.22, px * 0.24);
    ctx.fill();
  }

  const colorOf = (i: number): string => {
    if (spec.mark === 'highlight') return placed[i].strong && i !== active ? s.accent : s.color;
    if (placed[i].strong) return spec.box === 'band' ? s.color : s.accent;
    if (spec.mark === 'karaoke') return i <= active ? s.accent : s.color;
    if (spec.mark === 'none' || spec.mark === 'underline') return s.color;
    return i === active ? s.accent : s.color;
  };
  // The word being spoken grows slightly in the popping styles.
  const scaleOf = (i: number): number => {
    if (!spec.pop || i !== active) return 1;
    const k = easeOutBack(clamp((t - wordStart(i)) / 0.12, 0, 1));
    if (spec.single) return 0.7 + 0.3 * k;
    // Grow by a share of the word gap, not of the word: a long word scaled by a
    // fixed ratio would swallow the spaces on both sides of it.
    const grow = Math.min(0.1, (space * 0.5) / Math.max(1, placed[i].w));
    return 1 + grow * k;
  };
  const each = (fn: (p: PlacedWord, i: number) => void) => {
    placed.forEach((p, i) => {
      if (!visible(i)) return;
      const k = scaleOf(i);
      const tilt = spec.wobble && i === active ? -0.06 : 0;
      if (k === 1 && !tilt && !spec.single) return fn(p, i);
      ctx.save();
      const cx = spec.single ? 0 : p.x + p.w / 2;
      const cy = p.y - px * 0.35;
      ctx.translate(cx, cy);
      ctx.scale(k, k);
      if (tilt) ctx.rotate(tilt);
      ctx.translate(-(p.x + p.w / 2), -cy);
      fn(p, i);
      ctx.restore();
    });
  };

  // Depth first, then all outlines, so one word's outline never covers its neighbour's fill.
  if (spec.depth) {
    const d = px * 0.055;
    ctx.fillStyle = s.accent;
    for (let step = 4; step >= 1; step--) each((p) => ctx.fillText(p.text, p.x + (d * step) / 4, p.y + (d * step) / 4));
  }
  if (spec.stroke) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = spec.stroke * px * 2;
    ctx.strokeStyle = s.style === 'clean' ? 'rgba(0,0,0,0.55)' : '#000000';
    each((p) => ctx.strokeText(p.text, p.x, p.y));
  }
  if (spec.glow) {
    // A wide halo under every word; the spoken word gets a second, tighter pass below.
    setShadow(ctx, s.accent, px * 0.7, 0, pixelScale);
    ctx.fillStyle = s.accent;
    each((p) => ctx.fillText(p.text, p.x, p.y));
  }
  if (spec.shadow) setShadow(ctx, 'rgba(0,0,0,0.55)', px * 0.2, px * 0.05, pixelScale);
  each((p, i) => {
    // The highlighted word sits on its own box and needs no shadow.
    const onBox = spec.shadow && spec.mark === 'highlight' && i === active;
    if (onBox) clearShadow(ctx);
    if (spec.glow) setShadow(ctx, s.accent, i === active ? px * 0.3 : px * 0.12, 0, pixelScale);
    ctx.fillStyle = colorOf(i);
    ctx.fillText(p.text, p.x, p.y);
    if (onBox) setShadow(ctx, 'rgba(0,0,0,0.55)', px * 0.2, px * 0.05, pixelScale);
  });
  clearShadow(ctx);
  // A bar under the spoken word, drawn out from its left edge as it starts.
  if (spec.mark === 'underline' && active >= 0) {
    const a = placed[active];
    const k = easeOutCubic(clamp((t - wordStart(active)) / 0.14, 0, 1));
    ctx.fillStyle = spec.box === 'band' ? s.color : s.accent;
    roundRect(ctx, a.x, a.y + px * 0.16, a.w * k, px * 0.1, px * 0.05);
    ctx.fill();
  }
  // The typing cursor, blinking after the last typed word.
  if (spec.reveal && !rtl) {
    const last = placed.filter((_, i) => visible(i)).pop();
    if (last && ((t * 1.6) % 1) < 0.55) {
      ctx.fillStyle = s.accent;
      ctx.fillRect(last.x + last.w + px * 0.15, last.y - px * 0.72, px * 0.48, px * 0.9);
    }
  }
  ctx.restore();
}
