// Draws one finished frame onto a 2D canvas context. The browser preview and
// the Node exporter both call renderFrame; each only supplies the pictures
// (video frames, stills) through a FrameProvider. That is why an export looks
// like what was on screen.

import type { CaptionSettings, CaptionStyle, ClipFx, FaceTrack, ID, MainClip, ProjectDoc, Transform } from './types.ts';
import type { CaptionCard } from './captions.ts';
import { cardAt, displayWord } from './captions.ts';
import type { MainSeg, Rect, Scene, VisualRef } from './timeline.ts';
import { clamp, framingAt, layerGeometry, sceneAt } from './timeline.ts';
import { fontString } from './fonts.ts';
import type { Ctx2D, DrawableImage } from './graphics.ts';
import { clearShadow, drawGraphic, easeOutBack, easeOutCubic, isRTL, refSize, roundRect, setShadow } from './graphics.ts';

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
  /** A still image, for image graphics. */
  image?(mediaId: ID): DrawableImage | undefined;
  /** A small offscreen canvas for effects, reused between frames. */
  scratch?(w: number, h: number): { canvas: unknown; ctx: Ctx2D } | undefined;
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
}

function fxFilter(fx: ClipFx | undefined, W: number): string {
  if (!fx) return '';
  const parts: string[] = [];
  if (fx.brightness !== undefined && fx.brightness !== 1) parts.push(`brightness(${fx.brightness.toFixed(3)})`);
  if (fx.contrast !== undefined && fx.contrast !== 1) parts.push(`contrast(${fx.contrast.toFixed(3)})`);
  if (fx.saturation !== undefined && fx.saturation !== 1) parts.push(`saturate(${fx.saturation.toFixed(3)})`);
  if (fx.grayscale) parts.push(`grayscale(${clamp(fx.grayscale, 0, 1).toFixed(3)})`);
  if (fx.blur) parts.push(`blur(${(fx.blur * W).toFixed(2)}px)`);
  return parts.join(' ');
}

interface Env {
  ctx: Ctx2D;
  W: number;
  H: number;
  o: RenderOptions;
}

/** Draw a media clip's picture into the frame. Returns false when the picture is not available. */
function drawClip(env: Env, ref: VisualRef, img: LayerImage | undefined, alpha: number): boolean {
  const { ctx, W, H, o } = env;
  if (!img || alpha <= 0.001) return !!img;
  const size = o.provider.mediaSize(ref.clip.mediaId);
  if (!size || !size.width || !size.height) return false;
  const framing = framingAt(ref.clip.framing, o.provider.face?.(ref.clip.mediaId), ref.sourceTime);
  const { src, dst } = layerGeometry(size.width, size.height, W, H, framing);
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
  const filter = fxFilter(ref.clip.fx, W * o.pixelScale);
  if (filter && 'filter' in ctx) ctx.filter = filter;
  ctx.globalAlpha = alpha;
  ctx.drawImage(img.image, s.x, s.y, s.w, s.h, dst.x, dst.y, dst.w, dst.h);
  if (filter && 'filter' in ctx) ctx.filter = 'none';
  const fx = ref.clip.fx;
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
};

function drawMainSeg(env: Env, seg: MainSeg, ref: VisualRef | undefined, img: LayerImage | undefined, alpha: number): void {
  const { ctx, W, H } = env;
  if (seg.clip.kind === 'color') {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = seg.clip.color;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  } else if (ref) drawClip(env, ref, img, alpha);
}

/** The frozen last frame of a main clip, as something drawClip understands. */
function lastFrameRef(seg: MainSeg, fps: number): VisualRef | undefined {
  const c: MainClip = seg.clip;
  if (c.kind !== 'media') return undefined;
  return { clip: c, role: 'main', clipStart: seg.start, sourceTime: Math.max(c.in, c.out - c.speed / fps), opacity: 1 };
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
    case 'dip': {
      // Out to black over the first half, in from black over the second.
      if (tr.p < 0.5) drawFrom();
      else drawCurrent();
      ctx.globalAlpha = 1 - Math.abs(tr.p - 0.5) * 2;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      break;
    }
    case 'slide-left':
    case 'slide-right':
    case 'slide-up': {
      const dx = tr.type === 'slide-left' ? -1 : tr.type === 'slide-right' ? 1 : 0;
      const dy = tr.type === 'slide-up' ? -1 : 0;
      ctx.save();
      ctx.translate(dx * p * W, dy * p * H);
      drawFrom();
      ctx.restore();
      ctx.save();
      ctx.translate(-dx * (1 - p) * W, -dy * (1 - p) * H);
      drawCurrent();
      ctx.restore();
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

function drawOverlay(env: Env, ref: VisualRef): void {
  const { ctx, W, H, o } = env;
  const img = o.provider.layer(ref);
  if (!img) return;
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
    const framing = framingAt(ref.clip.framing, undefined, ref.sourceTime);
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
  const env: Env = { ctx, W, H, o };
  const scene = sceneAt(doc, layout, t);
  ctx.save();
  ctx.globalAlpha = 1;
  clearShadow(ctx);
  ctx.fillStyle = doc.settings.background;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
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
    for (const g of scene.graphics) drawGraphic(ctx, g, t, genv);
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
}

export const CAPTION_STYLES: Record<CaptionStyle, StyleSpec> = {
  clean: { font: 'Inter', weight: 700, size: 0.05, stroke: 0.045, shadow: true },
  pop: { font: 'Montserrat', weight: 900, size: 0.072, stroke: 0.1 },
  highlight: { font: 'Poppins', weight: 700, size: 0.058, shadow: true },
  boxed: { font: 'Inter', weight: 600, size: 0.045 },
  karaoke: { font: 'Montserrat', weight: 800, size: 0.062, stroke: 0.09 },
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
    if (line && line.width + space + w <= maxW) {
      line.words.push({ ...word, w });
      line.width += space + w;
    } else lines.push({ words: [{ ...word, w }], width: w });
  }
  const blockH = lineH * lines.length;
  const blockW = Math.max(...lines.map((l) => l.width));
  const placed: PlacedWord[] = [];
  lines.forEach((line, li) => {
    const y = -blockH / 2 + lineH * (li + 0.5) + px * 0.35;
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

  ctx.translate(W / 2, s.y * H);
  // One word too long for the frame: shrink the card rather than run off the edges.
  if (blockW > maxW) ctx.scale(maxW / blockW, maxW / blockW);
  if (s.style === 'pop' || s.style === 'karaoke') {
    const k = clamp((t - card.start) / 0.09, 0, 1);
    const sc = 0.88 + 0.12 * easeOutCubic(k);
    ctx.scale(sc, sc);
  }

  if (s.style === 'boxed') {
    const padX = px * 0.55;
    const padY = px * 0.32;
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    roundRect(ctx, -blockW / 2 - padX, -blockH / 2 - padY, blockW + 2 * padX, blockH + 2 * padY, px * 0.32);
    ctx.fill();
  }
  if (s.style === 'highlight' && active >= 0) {
    const a = placed[active];
    const padX = px * 0.2;
    ctx.fillStyle = s.accent;
    roundRect(ctx, a.x - padX, a.y - px * 0.92, a.w + 2 * padX, px * 1.22, px * 0.24);
    ctx.fill();
  }

  const colorOf = (i: number): string => {
    if (s.style === 'highlight') return placed[i].strong && i !== active ? s.accent : s.color;
    if (placed[i].strong) return s.accent;
    if (s.style === 'karaoke') return i <= active ? s.accent : s.color;
    return i === active ? s.accent : s.color;
  };
  // The word being spoken grows slightly in the "pop" style.
  const scaleOf = (i: number): number => {
    if (s.style !== 'pop' || i !== active) return 1;
    // Grow by a share of the word gap, not of the word: a long word scaled by a
    // fixed ratio would swallow the spaces on both sides of it.
    const grow = Math.min(0.1, (space * 0.5) / Math.max(1, placed[i].w));
    return 1 + grow * easeOutBack(clamp((t - placed[i].start) / 0.12, 0, 1));
  };
  const each = (fn: (p: PlacedWord, i: number) => void) => {
    placed.forEach((p, i) => {
      const k = scaleOf(i);
      if (k === 1) return fn(p, i);
      ctx.save();
      ctx.translate(p.x + p.w / 2, p.y - px * 0.35);
      ctx.scale(k, k);
      ctx.translate(-(p.x + p.w / 2), -(p.y - px * 0.35));
      fn(p, i);
      ctx.restore();
    });
  };

  // All outlines first so one word's outline never covers its neighbour's fill.
  if (spec.stroke) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = spec.stroke * px * 2;
    ctx.strokeStyle = s.style === 'clean' ? 'rgba(0,0,0,0.55)' : '#000000';
    each((p) => ctx.strokeText(p.text, p.x, p.y));
  }
  if (spec.shadow) setShadow(ctx, 'rgba(0,0,0,0.55)', px * 0.2, px * 0.05, pixelScale);
  each((p, i) => {
    // The highlighted word sits on its own box and needs no shadow.
    const onBox = spec.shadow && s.style === 'highlight' && i === active;
    if (onBox) clearShadow(ctx);
    ctx.fillStyle = colorOf(i);
    ctx.fillText(p.text, p.x, p.y);
    if (onBox) setShadow(ctx, 'rgba(0,0,0,0.55)', px * 0.2, px * 0.05, pixelScale);
  });
  ctx.restore();
}
