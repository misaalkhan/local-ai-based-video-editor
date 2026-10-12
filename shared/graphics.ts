// Motion-graphic templates for the Graphic track: text, pop-up cards, comment
// bubbles, lower thirds, callouts, counters, lists and so on.
//
// Each template is a plain drawing function over a 2D canvas context, used
// unchanged by the browser preview and the exporter. Sizes are written in
// "design pixels" of a 1080-wide vertical frame and scaled by `u`.

import type { AnimKind, Ease, GraphicItem, GraphicTemplate, Keyframe, Transform } from './types.ts';
import { clamp } from './timeline.ts';
import { fontString } from './fonts.ts';

/** The subset of CanvasRenderingContext2D used for drawing; satisfied by the DOM and by @napi-rs/canvas. */
export interface Ctx2D {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  rotate(angle: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(rule?: any): void;
  stroke(): void;
  clip(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  setLineDash(segments: number[]): void;
  drawImage(image: any, ...rest: number[]): void;
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): { addColorStop(offset: number, color: string): void };
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): { addColorStop(offset: number, color: string): void };
  createPattern(image: any, repetition: string): unknown;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  globalCompositeOperation: any;
  font: string;
  fillStyle: any;
  strokeStyle: any;
  lineWidth: number;
  lineJoin: any;
  lineCap: any;
  textAlign: any;
  textBaseline: any;
  globalAlpha: number;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  filter?: string;
}

export interface DrawableImage {
  image: unknown;
  width: number;
  height: number;
}

export interface GraphicEnv {
  W: number;
  H: number;
  /** Canvas pixels per output pixel; canvas shadows ignore transforms and must be scaled by hand. */
  pixelScale: number;
  getImage?: (mediaId: string) => DrawableImage | undefined;
  /** An item to draw as it looks at rest, without its entrance or exit: the one being edited. */
  settled?: string;
}

/** Text and graphics are sized against this so they read the same in vertical, square and landscape frames. */
export function refSize(W: number, H: number): number {
  return Math.min(W, H * 0.75);
}

// ---------------------------------------------------------------------------
// Small helpers

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v == null ? d : String(v));
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const flag = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d);

export const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
export const easeInCubic = (x: number) => x * x * x;
export const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
export const easeOutBack = (x: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

function ease(kind: Ease | undefined, x: number): number {
  switch (kind) {
    case 'linear':
      return x;
    case 'in':
      return easeInCubic(x);
    case 'out':
      return easeOutCubic(x);
    case 'back':
      return easeOutBack(x);
    default:
      return easeInOut(x);
  }
}

/** Accepts #RGB, #RRGGBB and #RRGGBBAA; anything else is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!m) return color;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return `rgba(${r},${g},${b},${(a * alpha).toFixed(3)})`;
}

/** Whether a hex colour is light enough that dark text belongs on it. */
export function isLight(color: string): boolean {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!m) return false;
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
/** Whether a line reads right to left: decided by its first letter, the way text engines do, so a lone Arabic word inside Hindi or English does not flip the line. */
export const isRTL = (text: string) => {
  for (const ch of text) {
    if (RTL.test(ch)) return true;
    if (/\p{L}/u.test(ch)) return false;
  }
  return false;
};

export function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function setShadow(ctx: Ctx2D, color: string, blur: number, offsetY: number, pixelScale: number): void {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * pixelScale;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = offsetY * pixelScale;
}

export function clearShadow(ctx: Ctx2D): void {
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

interface Tok {
  text: string;
  accent: boolean;
  w: number;
}

interface TextLayout {
  lines: { toks: Tok[]; width: number }[];
  width: number;
  space: number;
}

/**
 * Word-wrap text to `maxW`. Words wrapped in *asterisks* are flagged as
 * accented so a template can colour them differently.
 */
export function layoutText(ctx: Ctx2D, text: string, maxW: number, uppercase = false): TextLayout {
  const space = ctx.measureText(' ').width;
  const lines: TextLayout['lines'] = [];
  let accent = false;
  for (const para of (uppercase ? text.toUpperCase() : text).split('\n')) {
    let line: { toks: Tok[]; width: number } = { toks: [], width: 0 };
    const parts = para.split('*');
    parts.forEach((part, pi) => {
      if (pi > 0) accent = !accent;
      for (const word of part.split(/\s+/).filter(Boolean)) {
        const w = ctx.measureText(word).width;
        if (line.toks.length && line.width + space + w > maxW) {
          lines.push(line);
          line = { toks: [], width: 0 };
        }
        line.width += (line.toks.length ? space : 0) + w;
        line.toks.push({ text: word, accent, w });
      }
    });
    lines.push(line);
    // An unclosed asterisk should not colour the rest of the text.
    if (parts.length % 2 === 0) accent = false;
  }
  return { lines, width: Math.max(1, ...lines.map((l) => l.width)), space };
}

/** Draw laid-out text with its top-left block corner at (x, y). Returns the block height. */
function paintText(
  ctx: Ctx2D,
  layout: TextLayout,
  x: number,
  y: number,
  px: number,
  opts: { color: string; accent?: string; align?: 'left' | 'center' | 'right'; lineHeight?: number; stroke?: boolean },
): number {
  const lineH = px * (opts.lineHeight ?? 1.2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  layout.lines.forEach((line, i) => {
    let lx = x;
    if (opts.align === 'center') lx = x + (layout.width - line.width) / 2;
    else if (opts.align === 'right') lx = x + layout.width - line.width;
    const by = y + lineH * i + lineH / 2 + px * 0.35;
    const whole = line.toks.map((t) => t.text).join(' ');
    // Right-to-left scripts are shaped as one run so the browser/Skia orders the words.
    if (isRTL(whole)) {
      ctx.fillStyle = opts.color;
      if (opts.stroke) ctx.strokeText(whole, lx, by);
      else ctx.fillText(whole, lx, by);
      return;
    }
    for (const tok of line.toks) {
      if (opts.stroke) ctx.strokeText(tok.text, lx, by);
      else {
        ctx.fillStyle = tok.accent && opts.accent ? opts.accent : opts.color;
        ctx.fillText(tok.text, lx, by);
      }
      lx += tok.w + layout.space;
    }
  });
  return lineH * layout.lines.length;
}

// ---------------------------------------------------------------------------
// Transform, keyframes and entrance/exit animation

const TRANSFORM_KEYS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;

/** Value of a transform `t` seconds into an element's life, after applying its keyframes. */
export function transformAt(base: Transform, keyframes: Keyframe[] | undefined, t: number): Transform {
  const out: Transform = { ...base };
  if (!keyframes || !keyframes.length) return out;
  for (const key of TRANSFORM_KEYS) {
    let prev: Keyframe | undefined;
    let next: Keyframe | undefined;
    for (const k of keyframes) {
      if (k[key] === undefined) continue;
      if (k.t <= t) {
        if (!prev || k.t >= prev.t) prev = k;
      } else if (!next || k.t < next.t) next = k;
    }
    if (prev && next) {
      const span = Math.max(1e-6, next.t - prev.t);
      const p = ease(next.ease, clamp((t - prev.t) / span, 0, 1));
      out[key] = (prev[key] as number) + ((next[key] as number) - (prev[key] as number)) * p;
    } else if (prev) out[key] = prev[key] as number;
    else if (next) out[key] = next[key] as number;
  }
  return out;
}

interface AnimState {
  alpha: number;
  scale: number;
  dx: number;
  dy: number;
}

/** `p` runs 0 → 1 as the element arrives (and 1 → 0 as it leaves). */
function animState(kind: AnimKind, p: number, leaving: boolean, dist: number): AnimState {
  const s: AnimState = { alpha: 1, scale: 1, dx: 0, dy: 0 };
  if (kind === 'none' || p >= 1) return s;
  const e = easeOutCubic(p);
  switch (kind) {
    case 'fade':
      s.alpha = p;
      break;
    case 'pop':
      s.scale = leaving ? 0.8 + 0.2 * e : 0.6 + 0.4 * easeOutBack(p);
      s.alpha = Math.min(1, p * 2.5);
      break;
    case 'bounce': {
      // Drops in from above and overshoots, like a sticker slapped on.
      const k = leaving ? e : easeOutBack(p);
      s.scale = leaving ? 0.7 + 0.3 * e : 0.3 + 0.7 * k;
      s.dy = leaving ? 0 : -(1 - k) * dist * 0.6;
      s.alpha = Math.min(1, p * 3);
      break;
    }
    case 'zoom':
      // Flies in from very large, as if thrown at the camera.
      s.scale = leaving ? 1 + 0.8 * (1 - e) : 1 + 1.2 * (1 - e);
      s.alpha = Math.min(1, p * 2.5);
      break;
    case 'typewriter':
      // The text template types the letters itself; nothing moves.
      break;
    case 'slide-up':
      s.dy = (1 - e) * dist;
      s.alpha = Math.min(1, p * 2);
      break;
    case 'slide-down':
      s.dy = -(1 - e) * dist;
      s.alpha = Math.min(1, p * 2);
      break;
    case 'slide-left':
      s.dx = (1 - e) * dist;
      s.alpha = Math.min(1, p * 2);
      break;
    case 'slide-right':
      s.dx = -(1 - e) * dist;
      s.alpha = Math.min(1, p * 2);
      break;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Templates

interface TCtx {
  ctx: Ctx2D;
  props: Record<string, unknown>;
  /** Design-pixel scale. */
  u: number;
  W: number;
  H: number;
  /** Seconds since the item started, and its total length. */
  local: number;
  duration: number;
  animIn: AnimKind;
  env: GraphicEnv;
  /** Convert a point in frame coordinates (0..1) to this item's local space. */
  toLocal: (fx: number, fy: number) => { x: number; y: number };
}

/** Cards are drawn larger than their design size so they read on a phone. */
const CARD_SCALE = 1.4;

interface Theme {
  bg: string;
  fg: string;
  sub: string;
  accent: string;
}

function themeOf(props: Record<string, unknown>): Theme {
  const dark = str(props.theme, 'light') === 'dark';
  return {
    bg: str(props.background, dark ? '#16181D' : '#FFFFFF'),
    fg: str(props.color, dark ? '#FFFFFF' : '#111318'),
    sub: dark ? '#A9AFBC' : '#5B6170',
    accent: str(props.accent, '#7C5CFF'),
  };
}

function card(t: TCtx, x: number, y: number, w: number, h: number, r: number, bg: string): void {
  const { ctx, u, env } = t;
  setShadow(ctx, 'rgba(0,0,0,0.30)', 28 * u, 10 * u, env.pixelScale);
  ctx.fillStyle = bg;
  roundRect(ctx, x, y, w, h, r);
  ctx.fill();
  clearShadow(ctx);
}

/** Seconds per letter when text types itself in. */
const TYPE_RATE = 0.045;

function drawTextTemplate(t: TCtx): void {
  const { ctx, props, W, H, env, local } = t;
  let text = str(props.text);
  if (!text.trim()) return;
  if (flag(props.quote)) text = `\u201C${text}\u201D`;
  // Typewriter entrance: the letters arrive one by one, with a cursor while they do.
  let typing = false;
  if (t.animIn === 'typewriter') {
    const shown = Math.floor(local / TYPE_RATE);
    const chars = Array.from(text);
    if (shown < chars.length) {
      text = chars.slice(0, shown).join('');
      typing = true;
    }
    if (typing || local < chars.length * TYPE_RATE + 0.6) {
      // A blinking block cursor, on for the first half of each 0.7 s.
      const on = ((local / 0.7) % 1) < 0.5 || typing;
      if (on) text += '\u258C';
    }
    if (!text) return;
  }
  const px = num(props.size, 0.07) * refSize(W, H);
  ctx.font = fontString(str(props.font, 'Montserrat'), num(props.weight, 800), px);
  const layout = layoutText(ctx, text, num(props.maxWidth, 0.84) * W, flag(props.uppercase));
  const lineHeight = num(props.lineHeight, 1.16);
  const blockH = px * lineHeight * layout.lines.length;
  const align = str(props.align, 'center') as 'left' | 'center' | 'right';
  const x = -layout.width / 2;
  const y = -blockH / 2;
  const background = str(props.background);
  if (background) {
    const pad = num(props.padding, 0.38) * px;
    const r = num(props.radius, 0.28) * px;
    setShadow(ctx, 'rgba(0,0,0,0.25)', px * 0.3, px * 0.08, env.pixelScale);
    ctx.fillStyle = background;
    roundRect(ctx, x - pad, y - pad * 0.62, layout.width + 2 * pad, blockH + pad * 1.24, r);
    ctx.fill();
    clearShadow(ctx);
    const border = str(props.border);
    if (border) {
      ctx.lineWidth = num(props.borderWidth, 0.08) * px;
      ctx.strokeStyle = border;
      roundRect(ctx, x - pad, y - pad * 0.62, layout.width + 2 * pad, blockH + pad * 1.24, r);
      ctx.stroke();
    }
  }
  // A highlighter stroke behind each line, a little askew like a real marker.
  const highlighter = str(props.highlighter);
  if (highlighter) {
    const lineH = px * lineHeight;
    ctx.save();
    ctx.fillStyle = highlighter;
    ctx.globalAlpha *= 0.92;
    layout.lines.forEach((line, i) => {
      let lx = x;
      if (align === 'center') lx = x + (layout.width - line.width) / 2;
      else if (align === 'right') lx = x + layout.width - line.width;
      const top = y + lineH * i + lineH * 0.12;
      ctx.save();
      ctx.translate(lx + line.width / 2, top + lineH * 0.42);
      ctx.rotate(-0.012);
      ctx.transform(1, 0, -0.08, 1, 0, 0);
      roundRect(ctx, -line.width / 2 - px * 0.18, -lineH * 0.42, line.width + px * 0.36, lineH * 0.86, px * 0.08);
      ctx.fill();
      ctx.restore();
    });
    ctx.restore();
  }
  const paint = (color: unknown, dx = 0, dy = 0) => {
    ctx.save();
    ctx.translate(dx, dy);
    paintText(ctx, layout, x, y, px, { color: color as string, accent: str(props.accent, defaultColor('text', 'accent', props)), align, lineHeight });
    ctx.restore();
  };
  // A hard offset shadow gives the letters depth (the retro poster look).
  const offsetShadow = str(props.offsetShadow);
  if (offsetShadow) {
    const depth = num(props.offsetDepth, 0.06) * px;
    const steps = Math.max(1, Math.round(depth / Math.max(1, px * 0.012)));
    for (let i = steps; i >= 1; i--) paint(offsetShadow, (depth * i) / steps, (depth * i) / steps);
  }
  // Glitch: a cyan and a magenta copy pushed apart, flickering with time.
  if (flag(props.glitch)) {
    const wob = 1 + 0.6 * Math.sin(local * 41) * Math.sin(local * 7);
    const off = px * 0.06 * wob;
    ctx.save();
    ctx.globalAlpha *= 0.85;
    paint('#00E5FF', -off, -off * 0.3);
    paint('#FF2BD6', off, off * 0.3);
    ctx.restore();
  }
  const stroke = str(props.stroke);
  const strokeWidth = num(props.strokeWidth, 0);
  if (stroke && strokeWidth > 0) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = strokeWidth * px * 2;
    ctx.strokeStyle = stroke;
    paintText(ctx, layout, x, y, px, { color: stroke, align, lineHeight, stroke: true });
  }
  const glow = str(props.glow);
  if (glow) {
    // Two passes of glow: a wide soft halo and a tighter bright core.
    setShadow(ctx, glow, px * 0.9, 0, env.pixelScale);
    paint(glow);
    setShadow(ctx, glow, px * 0.35, 0, env.pixelScale);
    paint(str(props.color, '#FFFFFF'));
    clearShadow(ctx);
  }
  if (flag(props.shadow)) setShadow(ctx, 'rgba(0,0,0,0.6)', px * 0.16, px * 0.04, env.pixelScale);
  let fill: unknown = str(props.color, '#FFFFFF');
  const gradient = str(props.gradient);
  if (gradient) {
    const g = ctx.createLinearGradient(0, y, 0, y + blockH);
    g.addColorStop(0, str(props.color, '#FFFFFF'));
    g.addColorStop(1, gradient);
    fill = g;
  }
  paint(fill);
  clearShadow(ctx);
}

function drawPopup(t: TCtx): void {
  const { ctx, props, u: u0 } = t;
  const u = u0 * CARD_SCALE;
  const th = themeOf(props);
  const emoji = str(props.emoji);
  const title = str(props.title, str(props.text));
  const subtitle = str(props.subtitle);
  const pad = 26 * u;
  const badge = emoji ? 78 * u : 0;
  const gap = emoji ? 20 * u : 0;
  const maxW = 560 * u;
  const titlePx = 38 * u;
  const subPx = 27 * u;
  ctx.font = fontString('Inter', 800, titlePx);
  const tl = layoutText(ctx, title, maxW);
  ctx.font = fontString('Inter', 500, subPx);
  const sl = subtitle ? layoutText(ctx, subtitle, maxW) : null;
  const textW = Math.max(tl.width, sl?.width ?? 0);
  const titleH = titlePx * 1.2 * tl.lines.length;
  const subH = sl ? subPx * 1.25 * sl.lines.length + 4 * u : 0;
  const textH = titleH + subH;
  const w = pad * 2 + badge + gap + textW;
  const h = pad * 2 + Math.max(badge, textH);
  card(t, -w / 2, -h / 2, w, h, 30 * u, th.bg);
  if (emoji) {
    const cx = -w / 2 + pad + badge / 2;
    ctx.fillStyle = withAlpha(th.accent, 0.16);
    ctx.beginPath();
    ctx.arc(cx, 0, badge / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = fontString('Inter', 500, 42 * u);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = th.fg;
    ctx.fillText(emoji, cx, 2 * u);
  }
  const tx = -w / 2 + pad + badge + gap;
  let ty = -textH / 2;
  ctx.font = fontString('Inter', 800, titlePx);
  ty += paintText(ctx, tl, tx, ty, titlePx, { color: th.fg, accent: th.accent });
  if (sl) {
    ctx.font = fontString('Inter', 500, subPx);
    paintText(ctx, sl, tx, ty + 4 * u, subPx, { color: th.sub, lineHeight: 1.25 });
  }
}

function drawComment(t: TCtx): void {
  const { ctx, props, u: u0 } = t;
  const u = u0 * CARD_SCALE;
  const th = themeOf(props);
  const author = str(props.author, 'user');
  const text = str(props.text);
  const meta = str(props.meta, str(props.likes) ? `♥ ${str(props.likes)}` : '');
  const pad = 24 * u;
  const avatar = 66 * u;
  const gap = 18 * u;
  const namePx = 26 * u;
  const textPx = 31 * u;
  const metaPx = 22 * u;
  ctx.font = fontString('Inter', 500, textPx);
  const tl = layoutText(ctx, text, 540 * u);
  ctx.font = fontString('Inter', 700, namePx);
  const nameW = ctx.measureText(author).width;
  const textW = Math.max(tl.width, nameW);
  const textH = namePx * 1.3 + textPx * 1.25 * tl.lines.length + (meta ? metaPx * 1.6 : 0);
  const w = pad * 2 + avatar + gap + textW;
  const h = pad * 2 + Math.max(avatar, textH);
  card(t, -w / 2, -h / 2, w, h, 32 * u, th.bg);
  const ax = -w / 2 + pad + avatar / 2;
  const ay = -h / 2 + pad + avatar / 2;
  ctx.fillStyle = th.accent;
  ctx.beginPath();
  ctx.arc(ax, ay, avatar / 2, 0, Math.PI * 2);
  ctx.fill();
  const glyph = str(props.avatar, author.replace(/^@/, '').charAt(0).toUpperCase() || '?');
  ctx.font = fontString('Inter', 700, 32 * u);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(glyph, ax, ay + 2 * u);
  const tx = -w / 2 + pad + avatar + gap;
  let ty = -h / 2 + pad;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = fontString('Inter', 700, namePx);
  ctx.fillStyle = th.sub;
  ctx.fillText(author, tx, ty + namePx);
  ty += namePx * 1.3;
  ctx.font = fontString('Inter', 500, textPx);
  ty += paintText(ctx, tl, tx, ty, textPx, { color: th.fg, accent: th.accent, lineHeight: 1.25 });
  if (meta) {
    ctx.font = fontString('Inter', 600, metaPx);
    ctx.fillStyle = th.sub;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(meta, tx, ty + metaPx * 1.3);
  }
}

function drawHeadline(t: TCtx): void {
  const { ctx, props, u: u0 } = t;
  const u = u0 * CARD_SCALE;
  const th = themeOf(props);
  const source = str(props.source, 'NEWS').toUpperCase();
  const title = str(props.title, str(props.text));
  const sub = str(props.subtitle, str(props.date));
  const pad = 28 * u;
  const tagPx = 20 * u;
  const titlePx = 40 * u;
  const subPx = 23 * u;
  ctx.font = fontString('Playfair Display', 900, titlePx);
  const tl = layoutText(ctx, title, 600 * u);
  ctx.font = fontString('Inter', 800, tagPx);
  const tagW = ctx.measureText(source).width + 24 * u;
  const tagH = tagPx * 1.9;
  const w = pad * 2 + Math.max(tl.width, tagW);
  const h = pad * 2 + tagH + 16 * u + titlePx * 1.18 * tl.lines.length + (sub ? subPx * 1.7 : 0);
  card(t, -w / 2, -h / 2, w, h, 20 * u, th.bg);
  let y = -h / 2 + pad;
  const x = -w / 2 + pad;
  ctx.fillStyle = th.accent;
  roundRect(ctx, x, y, tagW, tagH, 8 * u);
  ctx.fill();
  ctx.font = fontString('Inter', 800, tagPx);
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(source, x + 12 * u, y + tagH / 2 + 1 * u);
  y += tagH + 16 * u;
  ctx.font = fontString('Playfair Display', 900, titlePx);
  y += paintText(ctx, tl, x, y, titlePx, { color: th.fg, accent: th.accent, lineHeight: 1.18 });
  if (sub) {
    ctx.font = fontString('Inter', 500, subPx);
    ctx.fillStyle = th.sub;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(sub, x, y + subPx * 1.35);
  }
}

function drawLowerThird(t: TCtx): void {
  const { ctx, props, u: u0 } = t;
  const u = u0 * CARD_SCALE;
  const th = themeOf({ theme: 'dark', ...props });
  const title = str(props.title, str(props.text));
  const subtitle = str(props.subtitle);
  const titlePx = 40 * u;
  const subPx = 26 * u;
  const pad = 22 * u;
  const bar = 9 * u;
  ctx.font = fontString('Inter', 800, titlePx);
  const titleW = ctx.measureText(title).width;
  ctx.font = fontString('Inter', 500, subPx);
  const subW = subtitle ? ctx.measureText(subtitle).width : 0;
  const w = bar + pad * 2 + Math.max(titleW, subW);
  const h = pad * 2 + titlePx * 1.1 + (subtitle ? subPx * 1.4 : 0);
  card(t, -w / 2, -h / 2, w, h, 14 * u, withAlpha(th.bg, 0.94));
  ctx.fillStyle = th.accent;
  roundRect(ctx, -w / 2, -h / 2, bar, h, 4 * u);
  ctx.fill();
  const x = -w / 2 + bar + pad;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = fontString('Inter', 800, titlePx);
  ctx.fillStyle = th.fg;
  ctx.fillText(title, x, -h / 2 + pad + titlePx * 0.88);
  if (subtitle) {
    ctx.font = fontString('Inter', 500, subPx);
    ctx.fillStyle = th.sub;
    ctx.fillText(subtitle, x, -h / 2 + pad + titlePx * 1.1 + subPx * 1.05);
  }
}

function drawCallout(t: TCtx): void {
  const { ctx, props, u: u0, local, toLocal } = t;
  const u = u0 * CARD_SCALE;
  const th = themeOf(props);
  const text = str(props.text);
  const px = 30 * u;
  ctx.font = fontString('Inter', 700, px);
  const w = ctx.measureText(text).width + 44 * u;
  const h = px * 2;
  if (props.targetX !== undefined && props.targetY !== undefined) {
    const target = toLocal(num(props.targetX, 0.5), num(props.targetY, 0.5));
    const p = easeOutCubic(clamp(local / 0.3, 0, 1));
    ctx.strokeStyle = th.accent;
    ctx.lineWidth = 5 * u;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(target.x * p, target.y * p);
    ctx.stroke();
    if (p > 0.95) {
      ctx.fillStyle = th.accent;
      ctx.beginPath();
      ctx.arc(target.x, target.y, 10 * u, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  card(t, -w / 2, -h / 2, w, h, h / 2, th.accent);
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 1 * u);
}

function drawCounter(t: TCtx): void {
  const { ctx, props, u, local, duration, env } = t;
  const from = num(props.from, 0);
  const to = num(props.to, 100);
  const decimals = Math.round(num(props.decimals, 0));
  const p = easeOutCubic(clamp(local / Math.max(0.3, duration * 0.6), 0, 1));
  const value = from + (to - from) * p;
  const shown = value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const text = str(props.prefix) + shown + str(props.suffix);
  const px = num(props.size, 150) * u;
  ctx.font = fontString(str(props.font, 'Montserrat'), 900, px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineWidth = px * 0.14;
  ctx.strokeStyle = '#000000';
  ctx.strokeText(text, 0, px * 0.3);
  ctx.fillStyle = str(props.color, '#FFFFFF');
  ctx.fillText(text, 0, px * 0.3);
  const label = str(props.label);
  if (label) {
    const lp = 36 * u;
    ctx.font = fontString('Inter', 700, lp);
    setShadow(ctx, 'rgba(0,0,0,0.7)', 12 * u, 3 * u, env.pixelScale);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(label, 0, px * 0.3 + lp * 1.6);
    clearShadow(ctx);
  }
}

function drawList(t: TCtx): void {
  const { ctx, props, u: u0, local, duration } = t;
  const u = u0 * CARD_SCALE;
  const th = themeOf(props);
  const items = Array.isArray(props.items) ? props.items.map((i) => str(i)).filter(Boolean) : [];
  const title = str(props.title);
  const numbered = flag(props.numbered, true);
  const pad = 28 * u;
  const badge = 46 * u;
  const gap = 16 * u;
  const itemPx = 31 * u;
  const titlePx = 34 * u;
  const rowGap = 16 * u;
  ctx.font = fontString('Inter', 600, itemPx);
  const layouts = items.map((it) => layoutText(ctx, it, 500 * u));
  ctx.font = fontString('Inter', 800, titlePx);
  const titleW = title ? ctx.measureText(title).width : 0;
  const rowH = (l: TextLayout) => Math.max(badge, itemPx * 1.25 * l.lines.length);
  const bodyW = Math.max(titleW, ...layouts.map((l) => badge + gap + l.width), 10);
  const bodyH =
    (title ? titlePx * 1.5 : 0) + layouts.reduce((s, l) => s + rowH(l), 0) + rowGap * Math.max(0, layouts.length - 1);
  const w = bodyW + pad * 2;
  const h = bodyH + pad * 2;
  card(t, -w / 2, -h / 2, w, h, 28 * u, th.bg);
  const x = -w / 2 + pad;
  let y = -h / 2 + pad;
  ctx.textAlign = 'left';
  if (title) {
    ctx.font = fontString('Inter', 800, titlePx);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = th.fg;
    ctx.fillText(title, x, y + titlePx * 0.95);
    y += titlePx * 1.5;
  }
  // Items arrive one after another across the first part of the item's life.
  const stagger = Math.min(0.6, Math.max(0.15, (duration - 1) / Math.max(1, items.length)));
  const baseAlpha = ctx.globalAlpha;
  layouts.forEach((l, i) => {
    const p = clamp((local - 0.25 - i * stagger) / 0.25, 0, 1);
    const rh = rowH(l);
    if (p > 0) {
      ctx.globalAlpha = baseAlpha * p;
      const dx = (1 - easeOutCubic(p)) * 24 * u;
      ctx.fillStyle = numbered ? th.accent : withAlpha(th.accent, 0.16);
      ctx.beginPath();
      ctx.arc(x + badge / 2 + dx, y + rh / 2, badge / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = fontString('Inter', 800, 24 * u);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = numbered ? '#FFFFFF' : th.accent;
      ctx.fillText(numbered ? String(i + 1) : '✓', x + badge / 2 + dx, y + rh / 2 + 1 * u);
      ctx.font = fontString('Inter', 600, itemPx);
      const th2 = itemPx * 1.25 * l.lines.length;
      paintText(ctx, l, x + badge + gap + dx, y + (rh - th2) / 2, itemPx, { color: th.fg, accent: th.accent, lineHeight: 1.25 });
    }
    y += rh + rowGap;
  });
  ctx.globalAlpha = baseAlpha;
}

function drawImageTemplate(t: TCtx): void {
  const { ctx, props, u, W, env } = t;
  const img = env.getImage?.(str(props.mediaId));
  if (!img || !img.width) return;
  const w = num(props.width, 0.5) * W;
  const h = (w * img.height) / img.width;
  const r = num(props.radius, 0.04) * w;
  if (flag(props.shadow, true)) {
    setShadow(ctx, 'rgba(0,0,0,0.35)', 30 * u, 12 * u, env.pixelScale);
    ctx.fillStyle = '#000000';
    roundRect(ctx, -w / 2, -h / 2, w, h, r);
    ctx.fill();
    clearShadow(ctx);
  }
  ctx.save();
  roundRect(ctx, -w / 2, -h / 2, w, h, r);
  ctx.clip();
  ctx.drawImage(img.image, 0, 0, img.width, img.height, -w / 2, -h / 2, w, h);
  ctx.restore();
  const border = num(props.border, 0);
  if (border > 0) {
    ctx.lineWidth = border * u;
    ctx.strokeStyle = str(props.borderColor, '#FFFFFF');
    roundRect(ctx, -w / 2, -h / 2, w, h, r);
    ctx.stroke();
  }
}

function drawHighlight(t: TCtx): void {
  const { ctx, props, u, W, H, local, toLocal } = t;
  const w = num(props.w, 0.4) * W;
  const h = num(props.h, 0.1) * H;
  const color = str(props.accent, str(props.color, '#FFE14D'));
  const shape = str(props.shape, 'box');
  const p = easeOutCubic(clamp(local / 0.35, 0, 1));
  if (flag(props.spotlight)) {
    // Dim everything except the highlighted region.
    const a = toLocal(0, 0);
    const b = toLocal(1, 1);
    ctx.fillStyle = `rgba(0,0,0,${(0.55 * p).toFixed(3)})`;
    ctx.beginPath();
    ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.rect(-w / 2, -h / 2, w, h);
    ctx.fill('evenodd');
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = num(props.thickness, 8) * u;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (shape === 'underline') {
    ctx.beginPath();
    ctx.moveTo(-w / 2, h / 2);
    ctx.lineTo(-w / 2 + w * p, h / 2);
    ctx.stroke();
    return;
  }
  // Draw the outline on progressively, like a marker pen.
  const perimeter = shape === 'ellipse' ? Math.PI * (w + h) * 0.75 : 2 * (w + h);
  ctx.setLineDash([perimeter * p, perimeter]);
  if (shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else roundRect(ctx, -w / 2, -h / 2, w, h, 14 * u);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawEmoji(t: TCtx): void {
  const { ctx, props, W, H } = t;
  const px = num(props.size, 0.22) * refSize(W, H);
  ctx.font = fontString('Inter', 500, px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(str(props.emoji, '🔥'), 0, 0);
}

const TEMPLATES: Record<Exclude<GraphicTemplate, 'progress'>, (t: TCtx) => void> = {
  text: drawTextTemplate,
  popup: drawPopup,
  comment: drawComment,
  headline: drawHeadline,
  'lower-third': drawLowerThird,
  callout: drawCallout,
  counter: drawCounter,
  list: drawList,
  image: drawImageTemplate,
  highlight: drawHighlight,
  emoji: drawEmoji,
};

export const GRAPHIC_TEMPLATES = [...Object.keys(TEMPLATES), 'progress'] as GraphicTemplate[];

export function drawGraphic(ctx: Ctx2D, g: GraphicItem, t: number, env: GraphicEnv): void {
  const local = t - g.start;
  if (local < 0 || local >= g.duration) return;
  const { W, H } = env;
  const u = refSize(W, H) / 1080;

  if (g.template === 'progress') {
    // A bar across the edge of the frame that fills over the item's length.
    const h = num(g.props.height, 12) * u;
    const y = str(g.props.position, 'top') === 'bottom' ? H - h : 0;
    ctx.save();
    ctx.globalAlpha = g.opacity;
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(0, y, W, h);
    ctx.fillStyle = str(g.props.accent, '#FFE14D');
    ctx.fillRect(0, y, W * clamp(local / g.duration, 0, 1), h);
    ctx.restore();
    return;
  }

  const tr = transformAt(g, g.keyframes, local);
  const inDur = Math.min(0.32, g.duration / 3);
  const outDur = Math.min(0.22, g.duration / 3);
  const dist = 0.06 * H;
  const rest = env.settled === g.id;
  const a = animState(g.animIn, rest ? 1 : clamp(local / inDur, 0, 1), false, dist);
  const b = animState(g.animOut, rest ? 1 : clamp((g.duration - local) / outDur, 0, 1), true, dist);
  const alpha = clamp(tr.opacity * a.alpha * b.alpha, 0, 1);
  if (alpha <= 0.002) return;
  const scale = tr.scale * a.scale * b.scale;
  const ox = tr.x * W + a.dx + b.dx;
  const oy = tr.y * H + a.dy + b.dy;
  ctx.save();
  ctx.translate(ox, oy);
  if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.globalAlpha = alpha;
  clearShadow(ctx);
  TEMPLATES[g.template]?.({
    ctx,
    props: g.props ?? {},
    u,
    W,
    H,
    local,
    duration: g.duration,
    animIn: g.animIn,
    env,
    toLocal: (fx, fy) => ({ x: (fx * W - ox) / scale, y: (fy * H - oy) / scale }),
  });
  ctx.restore();
}

/** The colour a template uses when the item does not set one, so the editing panel can show what is on screen. */
export function defaultColor(template: GraphicTemplate, key: string, props: Record<string, unknown>): string {
  if (key === 'accent') {
    if (template === 'text') return str(props.background) && isLight(str(props.background)) ? '#6C3BFF' : '#FFE14D';
    if (template === 'highlight' || template === 'progress') return '#FFE14D';
    return '#7C5CFF';
  }
  return '#FFFFFF';
}

// ---------------------------------------------------------------------------
// Defaults for new items

export interface GraphicPreset {
  template: GraphicTemplate;
  label: string;
  props: Record<string, unknown>;
  x: number;
  y: number;
  /** Degrees; a tilt gives stickers and handwriting their casual look. */
  rotation?: number;
  animIn: AnimKind;
  animOut: AnimKind;
  duration: number;
}

export const GRAPHIC_PRESETS: Record<string, GraphicPreset> = {
  hook: {
    template: 'text', label: 'Hook', x: 0.5, y: 0.2, animIn: 'pop', animOut: 'fade', duration: 3,
    props: { text: 'Your hook here', font: 'Montserrat', weight: 900, size: 0.074, color: '#111111', background: '#FFFFFF', padding: 0.42, radius: 0.3, maxWidth: 0.8 },
  },
  title: {
    template: 'text', label: 'Big title', x: 0.5, y: 0.4, animIn: 'pop', animOut: 'fade', duration: 3,
    props: { text: 'BIG TITLE', font: 'Anton', weight: 400, size: 0.14, color: '#FFFFFF', stroke: '#000000', strokeWidth: 0.08, uppercase: true, maxWidth: 0.88 },
  },
  subtitle: {
    template: 'text', label: 'Subtitle', x: 0.5, y: 0.3, animIn: 'fade', animOut: 'fade', duration: 3,
    props: { text: 'A line of supporting text', font: 'Inter', weight: 600, size: 0.05, color: '#FFFFFF', shadow: true, maxWidth: 0.84 },
  },
  label: {
    template: 'text', label: 'Label', x: 0.5, y: 0.12, animIn: 'fade', animOut: 'fade', duration: 3,
    props: { text: 'Label', font: 'Inter', weight: 700, size: 0.04, color: '#FFFFFF', background: '#000000CC', padding: 0.5, radius: 0.6, maxWidth: 0.8 },
  },
  card: {
    template: 'text', label: 'Title card text', x: 0.5, y: 0.5, animIn: 'fade', animOut: 'fade', duration: 3,
    props: { text: 'Title', font: 'Montserrat', weight: 800, size: 0.09, color: '#FFFFFF', maxWidth: 0.82 },
  },
  serif: {
    template: 'text', label: 'Elegant', x: 0.5, y: 0.35, animIn: 'fade', animOut: 'fade', duration: 3,
    props: { text: 'Something elegant', font: 'Playfair Display', weight: 900, size: 0.085, color: '#FFFFFF', shadow: true, maxWidth: 0.84 },
  },
  meme: {
    template: 'text', label: 'Meme', x: 0.5, y: 0.1, animIn: 'none', animOut: 'none', duration: 3,
    props: { text: 'WHEN THE REEL FINALLY WORKS', font: 'Anton', weight: 400, size: 0.08, color: '#FFFFFF', stroke: '#000000', strokeWidth: 0.09, uppercase: true, maxWidth: 0.9, lineHeight: 1.08 },
  },
  neon: {
    template: 'text', label: 'Neon', x: 0.5, y: 0.35, animIn: 'fade', animOut: 'fade', duration: 3,
    props: { text: 'open late', font: 'Pacifico', weight: 400, size: 0.095, color: '#FFFFFF', glow: '#FF3CAC', maxWidth: 0.84 },
  },
  handwritten: {
    template: 'text', label: 'Handwritten', x: 0.5, y: 0.3, rotation: -4, animIn: 'fade', animOut: 'fade', duration: 3,
    props: { text: 'this one is my favourite', font: 'Caveat', weight: 700, size: 0.1, color: '#FFFFFF', shadow: true, maxWidth: 0.84 },
  },
  sticker: {
    template: 'text', label: 'Sticker', x: 0.5, y: 0.25, rotation: -6, animIn: 'bounce', animOut: 'pop', duration: 2.5,
    props: { text: 'NEW', font: 'Fredoka', weight: 700, size: 0.07, color: '#111111', background: '#FFE600', border: '#111111', borderWidth: 0.1, padding: 0.5, radius: 0.22, uppercase: true, maxWidth: 0.8 },
  },
  marker: {
    template: 'text', label: 'Marker', x: 0.5, y: 0.3, animIn: 'fade', animOut: 'fade', duration: 3,
    props: { text: 'the part nobody tells you', font: 'Permanent Marker', weight: 400, size: 0.07, color: '#111111', highlighter: '#FFE600', maxWidth: 0.84, lineHeight: 1.3 },
  },
  quote: {
    template: 'text', label: 'Quote', x: 0.5, y: 0.4, animIn: 'fade', animOut: 'fade', duration: 4,
    props: { text: 'Pulling someone down will never take you to great heights.', font: 'Cormorant Garamond', weight: 700, size: 0.07, color: '#FFFFFF', shadow: true, quote: true, maxWidth: 0.78, lineHeight: 1.22 },
  },
  comic: {
    template: 'text', label: 'Comic', x: 0.5, y: 0.3, rotation: -3, animIn: 'pop', animOut: 'pop', duration: 2,
    props: { text: 'BOOM!', font: 'Bangers', weight: 400, size: 0.13, color: '#FFE600', stroke: '#000000', strokeWidth: 0.07, offsetShadow: '#000000', offsetDepth: 0.07, uppercase: true, maxWidth: 0.88 },
  },
  glitch: {
    template: 'text', label: 'Glitch', x: 0.5, y: 0.4, animIn: 'none', animOut: 'none', duration: 2.5,
    props: { text: 'SYSTEM ERROR', font: 'Archivo Black', weight: 400, size: 0.09, color: '#FFFFFF', glitch: true, uppercase: true, maxWidth: 0.88 },
  },
  gradient: {
    template: 'text', label: 'Gradient', x: 0.5, y: 0.35, animIn: 'zoom', animOut: 'fade', duration: 3,
    props: { text: 'LEVEL UP', font: 'Bungee', weight: 400, size: 0.1, color: '#FFD93D', gradient: '#FF4E50', shadow: true, uppercase: true, maxWidth: 0.88 },
  },
  typewriter: {
    template: 'text', label: 'Typewriter', x: 0.5, y: 0.3, animIn: 'typewriter', animOut: 'fade', duration: 4,
    props: { text: 'Day 1 of learning to edit.', font: 'Space Mono', weight: 700, size: 0.052, color: '#FFFFFF', background: '#111111E0', padding: 0.5, radius: 0.12, maxWidth: 0.84, align: 'left' },
  },
  popup: {
    template: 'popup', label: 'Pop-up card', x: 0.5, y: 0.24, animIn: 'pop', animOut: 'fade', duration: 3,
    props: { emoji: '💡', title: 'Pop-up title', subtitle: 'A short supporting line' },
  },
  comment: {
    template: 'comment', label: 'Comment bubble', x: 0.5, y: 0.24, animIn: 'pop', animOut: 'fade', duration: 3.5,
    props: { author: '@viewer', text: 'Wait, how did you do that?', likes: '1.2K' },
  },
  headline: {
    template: 'headline', label: 'Headline card', x: 0.5, y: 0.24, animIn: 'slide-up', animOut: 'fade', duration: 3.5,
    props: { source: 'News', title: 'Headline goes here', subtitle: '' },
  },
  'lower-third': {
    template: 'lower-third', label: 'Lower third', x: 0.36, y: 0.78, animIn: 'slide-right', animOut: 'fade', duration: 4,
    props: { title: 'Your Name', subtitle: 'What you do' },
  },
  callout: {
    template: 'callout', label: 'Callout', x: 0.3, y: 0.3, animIn: 'pop', animOut: 'fade', duration: 3,
    props: { text: 'Look here', targetX: 0.55, targetY: 0.45 },
  },
  counter: {
    template: 'counter', label: 'Counter', x: 0.5, y: 0.3, animIn: 'pop', animOut: 'fade', duration: 3,
    props: { from: 0, to: 10000, suffix: '+', label: 'followers' },
  },
  list: {
    template: 'list', label: 'List', x: 0.5, y: 0.3, animIn: 'slide-up', animOut: 'fade', duration: 5,
    props: { title: '', items: ['First point', 'Second point', 'Third point'] },
  },
  highlight: {
    template: 'highlight', label: 'Highlight box', x: 0.5, y: 0.5, animIn: 'none', animOut: 'fade', duration: 2.5,
    props: { w: 0.5, h: 0.1, shape: 'box' },
  },
  emoji: {
    template: 'emoji', label: 'Emoji', x: 0.5, y: 0.3, animIn: 'pop', animOut: 'pop', duration: 1.5,
    props: { emoji: '🔥' },
  },
  progress: {
    template: 'progress', label: 'Progress bar', x: 0.5, y: 0, animIn: 'none', animOut: 'none', duration: 10,
    props: { position: 'top' },
  },
};
