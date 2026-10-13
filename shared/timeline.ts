// Read-only queries over a project: where clips sit, what is on screen at a
// given time, how loud each clip is. The preview and the exporter both call
// these, which is what keeps the two in agreement.

import type {
  AudioClip,
  FaceTrack,
  Framing,
  GraphicItem,
  MainClip,
  OverlayClip,
  ProjectDoc,
  Range,
  SourceClip,
  Transform,
  TransitionType,
  MotionKeyframe,
  Ease,
  SpeedKeyframe,
} from './types.ts';

export const EPS = 1e-6;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function toFrames(t: number, fps: number): number {
  return Math.round(t * fps + 1e-7);
}

/** Round a time to the project's frame grid. */
export function snap(t: number, fps: number): number {
  return toFrames(t, fps) / fps;
}

// ---------------------------------------------------------------------------
// Time mapping: where a moment of a clip falls in its source file. Constant
// speed is a straight line; a ramp is a speed curve, straight between its
// points (in source seconds), so the time to play a stretch is the integral
// of 1/speed, which has a closed form on every piece; a reversed clip walks
// the same curve from `out` back to `in`.

export const MIN_SPEED = 0.05;
export const MAX_SPEED = 16;

/** The ramp's points in order, with sane speeds; empty when the clip has a plain speed. */
export function rampPoints(c: Pick<SourceClip, 'ramp'>): SpeedKeyframe[] {
  if (!c.ramp?.length) return [];
  return c.ramp
    .filter((k) => Number.isFinite(k.t) && Number.isFinite(k.speed))
    .map((k) => ({ t: k.t, speed: clamp(k.speed, MIN_SPEED, MAX_SPEED) }))
    .sort((a, b) => a.t - b.t);
}

export function isRemapped(c: Pick<SourceClip, 'ramp' | 'reverse'>): boolean {
  return !!c.reverse || !!c.ramp?.length;
}

/** Speed (always positive, direction aside) at source time `s`. */
export function speedAt(c: SourceClip, s: number): number {
  const pts = rampPoints(c);
  if (!pts.length) return clamp(c.speed || 1, MIN_SPEED, MAX_SPEED);
  if (s <= pts[0].t) return pts[0].speed;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (s <= b.t) return b.t - a.t < EPS ? b.speed : a.speed + ((b.speed - a.speed) * (s - a.t)) / (b.t - a.t);
  }
  return pts[pts.length - 1].speed;
}

/** Seconds it takes to play the source from `a` to `b` (negative when b < a). */
function travel(c: SourceClip, a: number, b: number): number {
  const pts = rampPoints(c);
  if (!pts.length) return (b - a) / speedAt(c, 0);
  // Cumulative play time at each point, measured from the first.
  const cum: number[] = [0];
  for (let i = 0; i + 1 < pts.length; i++) cum.push(cum[i] + piece(pts[i], pts[i + 1], pts[i + 1].t));
  const at = (x: number): number => {
    if (x <= pts[0].t) return (x - pts[0].t) / pts[0].speed;
    for (let i = 0; i + 1 < pts.length; i++) if (x <= pts[i + 1].t) return cum[i] + piece(pts[i], pts[i + 1], x);
    const last = pts.length - 1;
    return cum[last] + (x - pts[last].t) / pts[last].speed;
  };
  return at(b) - at(a);
}

/** Play time from point `a` to source time `x` on the straight piece a→b. */
function piece(a: SpeedKeyframe, b: SpeedKeyframe, x: number): number {
  const len = b.t - a.t;
  if (len < EPS) return 0;
  const slope = (b.speed - a.speed) / len;
  if (Math.abs(slope) < 1e-9) return (x - a.t) / a.speed;
  return Math.log((a.speed + slope * (x - a.t)) / a.speed) / slope;
}

/** The source time reached `local` seconds after playing forward from source time `from`. */
function arrive(c: SourceClip, from: number, local: number): number {
  const pts = rampPoints(c);
  if (!pts.length) return from + local * speedAt(c, 0);
  // Walk the pieces, spending play time until it runs out.
  let s = from;
  let left = local;
  const dir = left >= 0 ? 1 : -1;
  for (let guard = 0; guard < pts.length + 2 && Math.abs(left) > 1e-12; guard++) {
    // The piece `s` is on, and where it ends in the direction of travel.
    let i = pts.findIndex((p, k) => k + 1 < pts.length && s >= p.t - EPS && s < pts[k + 1].t - EPS);
    if (dir < 0) i = pts.findIndex((p, k) => k + 1 < pts.length && s > p.t + EPS && s <= pts[k + 1].t + EPS);
    if (i < 0) {
      // Before the first point or after the last: constant speed, no end.
      const v = speedAt(c, s);
      const edge = dir > 0 ? (s < pts[0].t - EPS ? pts[0].t : Infinity) : s > pts[pts.length - 1].t + EPS ? pts[pts.length - 1].t : -Infinity;
      const need = (edge - s) / v;
      if (!Number.isFinite(edge) || Math.abs(need) >= Math.abs(left)) return s + left * v;
      s = edge;
      left -= need;
      continue;
    }
    const a = pts[i];
    const b = pts[i + 1];
    const end = dir > 0 ? b.t : a.t;
    const need = piece(a, b, end) - piece(a, b, s);
    if (Math.abs(need) >= Math.abs(left) - 1e-12) {
      // Lands on this piece: invert its closed form.
      const slope = (b.speed - a.speed) / (b.t - a.t);
      const v0 = a.speed + slope * (s - a.t);
      return Math.abs(slope) < 1e-9 ? s + left * v0 : s + (v0 * (Math.exp(slope * left) - 1)) / slope;
    }
    s = end;
    left -= need;
  }
  return s;
}

/** How long the clip plays for. */
export function srcDuration(c: SourceClip): number {
  return Math.max(0, travel(c, c.in, c.out));
}

/**
 * The source time showing `local` seconds into the clip. Beyond the clip's
 * ends it keeps going at the end speeds, which is what trims and extensions
 * need. Exact at 0 and at the clip's length.
 */
export function sourceAt(c: SourceClip, local: number): number {
  const dur = srcDuration(c);
  if (Math.abs(local) < EPS) return c.reverse ? c.out : c.in;
  if (Math.abs(local - dur) < EPS) return c.reverse ? c.in : c.out;
  return c.reverse ? arrive(c, c.out, -local) : arrive(c, c.in, local);
}

/** Seconds into the clip at which source time `s` shows. */
export function localAt(c: SourceClip, s: number): number {
  return c.reverse ? travel(c, s, c.out) : travel(c, c.in, s);
}

/** The stretch of the source played between two moments of the clip. */
export function sourceRange(c: SourceClip, localA: number, localB: number): { in: number; out: number } {
  const a = sourceAt(c, localA);
  const b = sourceAt(c, localB);
  return { in: Math.min(a, b), out: Math.max(a, b) };
}

/** Seconds the clip could grow at one end before running out of source. */
export function maxExtend(c: SourceClip, edge: 'head' | 'tail', mediaDur: number): number {
  const toFront = travel(c, 0, c.in);
  const toBack = travel(c, c.out, mediaDur);
  const head = c.reverse ? toBack : toFront;
  return Math.max(0, edge === 'head' ? head : c.reverse ? toFront : toBack);
}

export function mainClipDuration(c: MainClip): number {
  return c.kind === 'color' ? c.duration : srcDuration(c);
}

export interface MainSeg {
  clip: MainClip;
  index: number;
  start: number;
  end: number;
  startFrame: number;
  endFrame: number;
}

/** Positions of the main-track clips, packed back to back on whole frames. */
export function layoutMain(doc: ProjectDoc): MainSeg[] {
  const fps = doc.settings.fps;
  const out: MainSeg[] = [];
  let f = 0;
  doc.main.forEach((clip, index) => {
    const n = Math.max(1, toFrames(mainClipDuration(clip), fps));
    out.push({ clip, index, startFrame: f, endFrame: f + n, start: f / fps, end: (f + n) / fps });
    f += n;
  });
  return out;
}

export function mainDuration(doc: ProjectDoc): number {
  const l = layoutMain(doc);
  return l.length ? l[l.length - 1].end : 0;
}

/**
 * Length of the finished video. Music does not extend it: a song longer than
 * the picture is simply cut off (with a fade) where the picture ends.
 */
export function contentDuration(doc: ProjectDoc): number {
  let d = mainDuration(doc);
  for (const o of doc.overlays) d = Math.max(d, o.start + srcDuration(o));
  for (const g of doc.graphics) d = Math.max(d, g.start + g.duration);
  for (const a of doc.audio) if (a.role !== 'music') d = Math.max(d, a.start + srcDuration(a));
  if (d <= EPS) for (const a of doc.audio) d = Math.max(d, a.start + srcDuration(a));
  return snap(d, doc.settings.fps);
}

export function segAt(layout: MainSeg[], t: number): MainSeg | undefined {
  let lo = 0;
  let hi = layout.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = layout[mid];
    if (t < s.start - EPS) hi = mid - 1;
    else if (t >= s.end - EPS) lo = mid + 1;
    else return s;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Geometry

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const DEFAULT_FRAMING: Framing = { fit: 'cover', focusX: 0.5, focusY: 0.5, scale: 1 };

/**
 * Which part of a `mw`×`mh` source is shown (`src`, in source pixels) and where
 * it lands in the `W`×`H` output (`dst`).
 */
export function layerGeometry(
  mw: number,
  mh: number,
  W: number,
  H: number,
  framing: Framing = DEFAULT_FRAMING,
): { src: Rect; dst: Rect } {
  const base = framing.fit === 'contain' ? Math.min(W / mw, H / mh) : Math.max(W / mw, H / mh);
  const s = base * Math.max(0.1, framing.scale || 1);
  const sw = Math.min(mw, W / s);
  const sh = Math.min(mh, H / s);
  const sx = clamp(framing.focusX * mw - sw / 2, 0, mw - sw);
  const sy = clamp(framing.focusY * mh - sh / 2, 0, mh - sh);
  const dw = sw * s;
  const dh = sh * s;
  return { src: { x: sx, y: sy, w: sw, h: sh }, dst: { x: (W - dw) / 2, y: (H - dh) / 2, w: dw, h: dh } };
}

/** Centre of the subject's face `t` seconds into a clip's source, or null when no face was seen nearby. */
export function faceAt(track: FaceTrack | undefined, t: number): { x: number; y: number; w: number; h: number } | null {
  if (!track || !track.boxes.length) return null;
  const pos = clamp(t / track.interval, 0, track.boxes.length - 1);
  const i = Math.floor(pos);
  const a = track.boxes[i];
  const b = track.boxes[Math.min(track.boxes.length - 1, i + 1)];
  if (a && b) {
    const k = pos - i;
    return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, w: a[2] + (b[2] - a[2]) * k, h: a[3] + (b[3] - a[3]) * k };
  }
  const one = a ?? b;
  return one ? { x: one[0], y: one[1], w: one[2], h: one[3] } : null;
}

/** The framing actually used at a moment: follows the face when tracking is on and a face is known. */
export function framingAt(framing: Framing | undefined, track: FaceTrack | undefined, sourceTime: number, motion?: MotionKeyframe[], local = 0): Framing {
  let f = framing ?? DEFAULT_FRAMING;
  if (motion?.length) f = motionAt(f, motion, local);
  if (!f.track) return f;
  const face = faceAt(track, sourceTime);
  if (!face) return f;
  return { ...f, focusX: face.x, focusY: face.y };
}

const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
const easeInCubic = (x: number) => x * x * x;
const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
function eased(kind: Ease | undefined, x: number): number {
  switch (kind) {
    case 'linear':
      return x;
    case 'in':
      return easeInCubic(x);
    case 'out':
      return easeOutCubic(x);
    case 'back': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    }
    default:
      return easeInOut(x);
  }
}

/** The framing `local` seconds into a clip with motion keyframes: each value eases between the keyframes that set it. */
export function motionAt(base: Framing, motion: MotionKeyframe[], local: number): Framing {
  const out = { ...base };
  for (const key of ['scale', 'focusX', 'focusY'] as const) {
    let prev: MotionKeyframe | undefined;
    let next: MotionKeyframe | undefined;
    for (const k of motion) {
      if (k[key] === undefined) continue;
      if (k.t <= local) {
        if (!prev || k.t >= prev.t) prev = k;
      } else if (!next || k.t < next.t) next = k;
    }
    if (prev && next) {
      const p = eased(next.ease, clamp((local - prev.t) / Math.max(1e-6, next.t - prev.t), 0, 1));
      out[key] = (prev[key] as number) + ((next[key] as number) - (prev[key] as number)) * p;
    } else if (prev) out[key] = prev[key] as number;
    else if (next) out[key] = next[key] as number;
  }
  return out;
}

export interface ZoomState {
  scale: number;
  focusX: number;
  focusY: number;
  /** Shake offset as a fraction of the frame, 0 when still. */
  dx: number;
  dy: number;
}

export function zoomAt(doc: ProjectDoc, t: number): ZoomState {
  let best: ProjectDoc['zooms'][number] | undefined;
  for (const z of doc.zooms) {
    if (t >= z.start - EPS && t < z.start + z.duration - EPS) {
      if (!best || z.start >= best.start) best = z;
    }
  }
  if (!best) return { scale: 1, focusX: 0.5, focusY: 0.5, dx: 0, dy: 0 };
  const p = clamp((t - best.start) / best.duration, 0, 1);
  const target = best.toScale !== undefined ? best.scale + (best.toScale - best.scale) * p : best.scale;
  let k = 1;
  if (best.ease === 'smooth') {
    const ramp = Math.min(0.4, best.duration / 3);
    const a = (t - best.start) / ramp;
    const b = (best.start + best.duration - t) / ramp;
    k = easeInOut(clamp(Math.min(a, b), 0, 1));
  }
  let scale = 1 + (target - 1) * k;
  let dx = 0;
  let dy = 0;
  if (best.shake) {
    // A new random nudge 30 times a second, fading out over the item; the
    // picture is held a little larger so the edges never show.
    const amp = clamp(best.shake, 0, 1) * 0.03 * (1 - p * 0.7);
    let r = (Math.floor(t * 30) * 2654435761 + 7) >>> 0;
    const rnd = () => {
      r = (Math.imul(r, 1664525) + 1013904223) >>> 0;
      return r / 4294967296 - 0.5;
    };
    dx = rnd() * 2 * amp;
    dy = rnd() * 2 * amp * 0.7;
    scale = Math.max(scale, 1 + amp * 2.2);
  }
  return { scale, focusX: best.focusX, focusY: best.focusY, dx, dy };
}

/** Largest zoom applied anywhere inside a time span (1 when there is none). */
export function maxZoomIn(doc: ProjectDoc, start: number, end: number): number {
  let m = 1;
  for (const z of doc.zooms) {
    if (z.start < end && z.start + z.duration > start) m = Math.max(m, z.scale, z.toScale ?? 1);
  }
  return m;
}

// ---------------------------------------------------------------------------
// What is on screen at time t

export interface VisualRef {
  clip: SourceClip;
  role: 'main' | 'overlay';
  /** Timeline time the clip starts at. */
  clipStart: number;
  /** Seconds into the source file. */
  sourceTime: number;
  opacity: number;
  /** Overlays only: placement of the layer in the frame. */
  transform?: Transform;
  radius?: number;
}

export interface Scene {
  t: number;
  /** Set when the main track shows a colour card (or nothing). */
  mainColor?: string;
  main?: VisualRef;
  /** Set while the current main clip is still arriving from the previous one. */
  transition?: { type: TransitionType; p: number; from: MainSeg };
  /** Bottom to top. */
  overlays: VisualRef[];
  zoom: ZoomState;
  graphics: GraphicItem[];
}

export function fadeFactor(local: number, dur: number, fadeIn = 0, fadeOut = 0): number {
  let k = 1;
  if (fadeIn > 0 && local < fadeIn) k = Math.min(k, clamp(local / fadeIn, 0, 1));
  if (fadeOut > 0 && local > dur - fadeOut) k = Math.min(k, clamp((dur - local) / fadeOut, 0, 1));
  return k;
}

export function overlaysAt(doc: ProjectDoc, t: number): OverlayClip[] {
  const out: OverlayClip[] = [];
  for (const o of doc.overlays) {
    if (t >= o.start - EPS && t < o.start + srcDuration(o) - EPS) out.push(o);
  }
  return out;
}

export const IDENTITY: Transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 };

function interpolate(base: Transform, keyframes: OverlayClip['keyframes'], t: number): Transform {
  const out = { ...base };
  if (!keyframes?.length) return out;
  for (const key of ['x', 'y', 'scale', 'rotation', 'opacity'] as const) {
    let prev: (typeof keyframes)[number] | undefined;
    let next: (typeof keyframes)[number] | undefined;
    for (const k of keyframes) {
      if (k[key] === undefined) continue;
      if (k.t <= t) {
        if (!prev || k.t >= prev.t) prev = k;
      } else if (!next || k.t < next.t) next = k;
    }
    if (prev && next) {
      const p = eased(next.ease, clamp((t - prev.t) / Math.max(1e-6, next.t - prev.t), 0, 1));
      out[key] = (prev[key] as number) + ((next[key] as number) - (prev[key] as number)) * p;
    } else if (prev) out[key] = prev[key] as number;
    else if (next) out[key] = next[key] as number;
  }
  return out;
}

/** Length of the transition into a main clip, limited so it never outlasts either neighbour. */
export function transitionLength(layout: MainSeg[], index: number): number {
  const seg = layout[index];
  const prev = layout[index - 1];
  const tr = seg?.clip.transition;
  if (!seg || !prev || !tr || tr.duration <= 0) return 0;
  return Math.min(tr.duration, (seg.end - seg.start) / 2, prev.end - prev.start);
}

export function sceneAt(doc: ProjectDoc, layout: MainSeg[], t: number): Scene {
  const scene: Scene = { t, overlays: [], zoom: zoomAt(doc, t), graphics: [] };
  const seg = segAt(layout, t);
  if (!seg) scene.mainColor = doc.settings.background;
  else if (seg.clip.kind === 'color') scene.mainColor = seg.clip.color;
  else {
    scene.main = {
      clip: seg.clip,
      role: 'main',
      clipStart: seg.start,
      sourceTime: sourceAt(seg.clip, t - seg.start),
      opacity: 1,
    };
  }
  if (seg && seg.index > 0) {
    const d = transitionLength(layout, seg.index);
    if (d > 0 && t < seg.start + d - EPS && seg.clip.transition) {
      scene.transition = { type: seg.clip.transition.type, p: clamp((t - seg.start) / d, 0, 1), from: layout[seg.index - 1] };
    }
  }
  for (const o of overlaysAt(doc, t)) {
    const local = t - o.start;
    const dur = srcDuration(o);
    const tr = interpolate({ ...IDENTITY, ...(o.transform ?? {}) }, o.keyframes, local);
    scene.overlays.push({
      clip: o,
      role: 'overlay',
      clipStart: o.start,
      sourceTime: sourceAt(o, local),
      opacity: (o.opacity ?? 1) * tr.opacity * fadeFactor(local, dur, o.fadeIn, o.fadeOut),
      transform: tr,
      radius: o.radius,
    });
  }
  for (const g of doc.graphics) {
    if (t >= g.start - EPS && t < g.start + g.duration - EPS) scene.graphics.push(g);
  }
  return scene;
}

// ---------------------------------------------------------------------------
// Audio levels

/** Gain of music while someone is speaking (about -14 dB). */
export const DUCK_LEVEL = 0.2;
export const DUCK_ATTACK = 0.25;
export const DUCK_RELEASE = 0.6;
/** Music that runs past the end of the picture fades out over this long. */
export const MUSIC_TAIL_FADE = 1.2;

/**
 * Merge speech spans into the intervals music should duck under. Neighbouring
 * intervals are merged whenever their ramps would overlap, so the ramps can be
 * summed instead of maxed (the exporter relies on that).
 */
export function duckIntervals(spans: Range[]): Range[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  const minGap = DUCK_ATTACK + DUCK_RELEASE + 0.3;
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start - last.end < minGap) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

/** 0 = no ducking, 1 = fully ducked. */
export function duckAmountAt(intervals: Range[], t: number): number {
  let amount = 0;
  for (const iv of intervals) {
    if (t < iv.start - DUCK_ATTACK) break;
    if (t > iv.end + DUCK_RELEASE) continue;
    const up = clamp((t - (iv.start - DUCK_ATTACK)) / DUCK_ATTACK, 0, 1);
    const down = clamp((iv.end + DUCK_RELEASE - t) / DUCK_RELEASE, 0, 1);
    amount = Math.max(amount, up * down);
  }
  return amount;
}

/** Gain of an audio-bearing clip at timeline time t (0 when outside the clip). */
export function clipGainAt(
  clip: SourceClip,
  clipStart: number,
  t: number,
  opts: { music?: boolean; duck?: Range[]; contentEnd?: number } = {},
): number {
  if (clip.muted) return 0;
  const dur = srcDuration(clip);
  const local = t - clipStart;
  if (local < -EPS || local > dur + EPS) return 0;
  let g = clip.volume * fadeFactor(local, dur, clip.fadeIn, clip.fadeOut);
  if (opts.music) {
    if (opts.duck) g *= 1 - (1 - DUCK_LEVEL) * duckAmountAt(opts.duck, t);
    if (opts.contentEnd !== undefined && clipStart + dur > opts.contentEnd + EPS) {
      g *= clamp((opts.contentEnd - t) / MUSIC_TAIL_FADE, 0, 1);
    }
  }
  return g;
}

export function audioClipEnd(a: AudioClip): number {
  return a.start + srcDuration(a);
}

// ---------------------------------------------------------------------------
// Formatting

export function formatTime(t: number, withFrames = false, fps = 30): string {
  const neg = t < 0;
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const base = `${neg ? '-' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (!withFrames) return base;
  const f = Math.floor((t - Math.floor(t)) * fps + 1e-6);
  return `${base}.${String(f).padStart(2, '0')}`;
}
