// Edit operations. Each one takes a project and returns a new one, leaving the
// input untouched, so undo is just "keep the previous document".
//
// The main track is magnetic, so anything that changes its length ripples:
// b-roll, graphics, zooms and voice clips that come later move with the picture.

import type {
  AnimKind,
  AudioClip,
  AudioRole,
  CaptionSettings,
  CaptionStyle,
  Framing,
  GraphicItem,
  GraphicTemplate,
  ID,
  ItemMeta,
  MainClip,
  MediaAsset,
  MediaMainClip,
  OverlayClip,
  ProjectDoc,
  ProjectSettings,
  Range,
  Selection,
  SelectionKind,
  SourceClip,
  TakeGroup,
  Transition,
  Word,
  ZoomItem,
  MotionKeyframe,
  Keyframe,
  SpeedKeyframe,
  CardAnimation,
  Marker,
} from './types.ts';
import { ASPECTS } from './types.ts';
import {
  DEFAULT_FRAMING,
  EPS,
  clamp,
  contentDuration,
  framingAt,
  layoutMain,
  mainClipDuration,
  localAt,
  mainDuration,
  maxExtend,
  rampPoints,
  snap,
  sourceAt,
  sourceRange,
  srcDuration,
  toFrames,
  MIN_SPEED,
  MAX_SPEED,
} from './timeline.ts';
import type { MainSeg } from './timeline.ts';
import { normalizeWord } from './captions.ts';
import type { TLWord } from './captions.ts';
import { GRAPHIC_PRESETS } from './graphics.ts';

export type MediaLike = Pick<MediaAsset, 'id' | 'kind' | 'duration'>;

const AUDIO_PRESET_IDS: string[] = ['voice', 'podcast', 'warm', 'bright', 'bass', 'radio', 'phone', 'muffled', 'big'];
export type TimedKind = Exclude<SelectionKind, 'main'>;

export function uid(prefix = 'c'): string {
  const bytes = new Uint8Array(7);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += (b % 36).toString(36);
  return prefix + s;
}

export function cloneDoc<T>(v: T): T {
  return structuredClone(v);
}

function notNull<T>(v: T | null): v is T {
  return v !== null;
}

// ---------------------------------------------------------------------------
// Defaults

export const CAPTION_PRESETS: Record<CaptionStyle, Omit<CaptionSettings, 'enabled' | 'edits' | 'y' | 'size' | 'font'>> = {
  clean: { style: 'clean', maxWords: 6, uppercase: false, punctuation: true, color: '#FFFFFF', accent: '#FFFFFF' },
  pop: { style: 'pop', maxWords: 3, uppercase: true, punctuation: false, color: '#FFFFFF', accent: '#FFE14D' },
  highlight: { style: 'highlight', maxWords: 4, uppercase: false, punctuation: false, color: '#FFFFFF', accent: '#7C5CFF' },
  boxed: { style: 'boxed', maxWords: 6, uppercase: false, punctuation: true, color: '#FFFFFF', accent: '#FFE14D' },
  karaoke: { style: 'karaoke', maxWords: 4, uppercase: true, punctuation: false, color: '#FFFFFF', accent: '#3DDC84' },
  outline: { style: 'outline', maxWords: 3, uppercase: true, punctuation: false, color: '#FFFFFF', accent: '#FFE14D' },
  oneword: { style: 'oneword', maxWords: 4, uppercase: true, punctuation: false, color: '#FFFFFF', accent: '#FFE14D' },
  glow: { style: 'glow', maxWords: 4, uppercase: false, punctuation: false, color: '#FFFFFF', accent: '#FF3CAC' },
  glass: { style: 'glass', maxWords: 6, uppercase: false, punctuation: true, color: '#FFFFFF', accent: '#9DE1FF' },
  typewriter: { style: 'typewriter', maxWords: 7, uppercase: false, punctuation: true, color: '#E8FFE8', accent: '#3DDC84' },
  band: { style: 'band', maxWords: 5, uppercase: true, punctuation: false, color: '#FFFFFF', accent: '#E63946' },
  underline: { style: 'underline', maxWords: 5, uppercase: false, punctuation: true, color: '#FFFFFF', accent: '#FFB703' },
  retro: { style: 'retro', maxWords: 3, uppercase: true, punctuation: false, color: '#FFF4D6', accent: '#FF6B35' },
  comic: { style: 'comic', maxWords: 3, uppercase: true, punctuation: false, color: '#FFE600', accent: '#FFFFFF' },
};

export const DEFAULT_CAPTIONS: CaptionSettings = {
  enabled: false,
  y: 0.7,
  size: 1,
  edits: {},
  ...CAPTION_PRESETS.pop,
};

export const DEFAULT_SETTINGS: ProjectSettings = {
  width: 1080,
  height: 1920,
  fps: 30,
  background: '#000000',
  audio: { normalize: true, targetLufs: -14, denoise: false, enhance: false },
};

export function createDoc(id: ID, name: string, aspect = '9:16'): ProjectDoc {
  const a = ASPECTS[aspect] ?? ASPECTS['9:16'];
  const now = Date.now();
  return {
    version: 2,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    settings: { ...DEFAULT_SETTINGS, width: a.width, height: a.height, audio: { ...DEFAULT_SETTINGS.audio } },
    main: [],
    overlays: [],
    audio: [],
    graphics: [],
    zooms: [],
    captions: { ...DEFAULT_CAPTIONS, edits: {} },
    takes: [],
  };
}

// ---------------------------------------------------------------------------
// Clip construction

/**
 * Make a clip's length a whole number of frames and keep it inside its media.
 * Pass no `mediaDur` for stills, which have no natural length.
 */
export function fitClip<T extends SourceClip>(c: T, fps: number, mediaDur?: number): T {
  const speed = c.speed > 0 ? c.speed : 1;
  const bounded = mediaDur !== undefined && mediaDur > 0;
  const inn = bounded ? clamp(c.in, 0, Math.max(0, mediaDur - speed / fps)) : Math.max(0, c.in);
  // The source end that gives the clip n frames (its ramp decides how far that is).
  const forward: T = { ...c, speed, in: inn, reverse: false };
  const endFor = (n: number) => sourceAt(forward, n / fps);
  let n = Math.max(1, toFrames(srcDuration(forward), fps));
  if (bounded) while (n > 1 && endFor(n) > mediaDur + 1e-4) n--;
  return { ...c, speed, in: inn, out: endFor(n) };
}

export function makeClip(
  media: MediaLike,
  fps: number,
  opts: { in?: number; out?: number; duration?: number; speed?: number; volume?: number } = {},
): SourceClip {
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  if (media.kind === 'image') {
    const dur = Math.max(1 / fps, opts.duration ?? (opts.out !== undefined ? opts.out - (opts.in ?? 0) : 3));
    return fitClip({ id: uid(), mediaId: media.id, in: 0, out: dur, speed: 1, volume: 1 }, fps);
  }
  const inn = snap(clamp(opts.in ?? 0, 0, Math.max(0, media.duration - 1 / fps)), fps);
  let out = opts.out ?? (opts.duration !== undefined ? inn + opts.duration * speed : media.duration);
  out = clamp(out, inn + speed / fps, Math.max(inn + speed / fps, media.duration));
  return fitClip(
    { id: uid(), mediaId: media.id, in: inn, out, speed, volume: opts.volume ?? 1 },
    fps,
    media.duration,
  );
}

// ---------------------------------------------------------------------------
// Ripple machinery

function normalizeRanges(ranges: Range[], fps: number): Range[] {
  const rs = ranges
    .map((r) => ({
      start: snap(Math.max(0, Math.min(r.start, r.end)), fps),
      end: snap(Math.max(0, Math.max(r.start, r.end)), fps),
    }))
    .filter((r) => r.end - r.start > EPS)
    .sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

function removedBefore(ranges: Range[], t: number): number {
  let sum = 0;
  for (const r of ranges) {
    if (t <= r.start) break;
    sum += Math.min(t, r.end) - r.start;
  }
  return sum;
}

function subtract(span: Range, ranges: Range[]): Range[] {
  const out: Range[] = [];
  let cur = span.start;
  for (const r of ranges) {
    if (r.end <= span.start + EPS) continue;
    if (r.start >= span.end - EPS) break;
    if (r.start > cur + EPS) out.push({ start: cur, end: Math.min(r.start, span.end) });
    cur = Math.max(cur, r.end);
  }
  if (cur < span.end - EPS) out.push({ start: cur, end: span.end });
  return out;
}

/** Close the given ranges for everything that is not on the main track. */
function remapTimed(d: ProjectDoc, ranges: Range[]): void {
  const fps = d.settings.fps;
  const minDur = 1 / fps - EPS;
  const map = (t: number) => snap(t - removedBefore(ranges, t), fps);
  const headCut = (start: number, end: number) => {
    for (const r of ranges) {
      if (start >= r.start - EPS && start < r.end - EPS) return Math.min(r.end, end) - start;
    }
    return 0;
  };
  const remapSource = <T extends SourceClip & { start: number }>(c: T, keepLength: boolean): T | null => {
    const end = c.start + srcDuration(c);
    const ns = map(c.start);
    // Music keeps playing through a cut; only its starting point moves.
    if (keepLength) return { ...c, start: ns };
    const ne = map(end);
    if (ne - ns < minDur) return null;
    // A cut in the middle of b-roll shortens its tail rather than making the
    // b-roll itself jump.
    const head = headCut(c.start, end);
    return { ...c, start: ns, ...sourceRange(c, head, head + (ne - ns)) };
  };
  const remapSpan = <T extends { start: number; duration: number }>(x: T): T | null => {
    const ns = map(x.start);
    const ne = map(x.start + x.duration);
    return ne - ns < minDur ? null : { ...x, start: ns, duration: ne - ns };
  };
  d.overlays = d.overlays.map((o) => remapSource(o, false)).filter(notNull);
  d.audio = d.audio.map((a) => remapSource(a, a.role === 'music')).filter(notNull);
  d.graphics = d.graphics.map(remapSpan).filter(notNull);
  d.zooms = d.zooms.map(remapSpan).filter(notNull);
  if (d.markers) d.markers = d.markers.filter((m) => !ranges.some((r) => m.t >= r.start - EPS && m.t < r.end - EPS)).map((m) => ({ ...m, t: map(m.t) }));
}

/** Push everything that starts at or after `at` later by `delta` seconds. */
function shiftTimed(d: ProjectDoc, at: number, delta: number): void {
  const fps = d.settings.fps;
  const mv = <T extends { start: number }>(x: T): T =>
    x.start >= at - EPS ? { ...x, start: Math.max(0, snap(x.start + delta, fps)) } : x;
  d.overlays = d.overlays.map(mv);
  d.audio = d.audio.map(mv);
  d.graphics = d.graphics.map(mv);
  d.zooms = d.zooms.map(mv);
  if (d.markers) d.markers = d.markers.map((m) => (m.t >= at - EPS ? { ...m, t: Math.max(0, snap(m.t + delta, fps)) } : m));
}

/**
 * Remove time ranges from the whole timeline and close the gaps.
 * Ranges are in timeline seconds and may overlap or come in any order.
 */
export function rippleDelete(doc: ProjectDoc, rangesIn: Range[]): ProjectDoc {
  const d = cloneDoc(doc);
  const fps = d.settings.fps;
  const ranges = normalizeRanges(rangesIn, fps);
  if (!ranges.length) return d;
  const minDur = 1 / fps - EPS;
  const main: MainClip[] = [];
  for (const seg of layoutMain(d)) {
    const keeps = subtract({ start: seg.start, end: seg.end }, ranges).filter((k) => k.end - k.start >= minDur);
    if (!keeps.length) continue;
    if (seg.clip.kind === 'color') {
      const dur = keeps.reduce((s, k) => s + (k.end - k.start), 0);
      main.push({ ...seg.clip, duration: snap(dur, fps) });
      continue;
    }
    const c = seg.clip;
    keeps.forEach((k, i) => {
      // Reuse the exact endpoints where a piece reaches the clip's own edge so
      // repeated cuts do not accumulate rounding error.
      const piece: MediaMainClip = { ...c, id: i === 0 ? c.id : uid(), ...sourceRange(c, k.start - seg.start, k.end - seg.start) };
      if (k.start > seg.start + EPS) {
        delete piece.fadeIn;
        delete piece.transition;
      }
      if (k.end < seg.end - EPS) delete piece.fadeOut;
      main.push(piece);
    });
  }
  d.main = main;
  remapTimed(d, ranges);
  return d;
}

// ---------------------------------------------------------------------------
// Main track

export function insertMain(doc: ProjectDoc, clip: MainClip, index?: number): ProjectDoc {
  const d = cloneDoc(doc);
  const fps = d.settings.fps;
  const layout = layoutMain(d);
  const i = clamp(index ?? layout.length, 0, layout.length);
  const at = i < layout.length ? layout[i].start : mainDuration(d);
  const dur = Math.max(1, toFrames(mainClipDuration(clip), fps)) / fps;
  if (i < layout.length) shiftTimed(d, at, dur);
  d.main.splice(i, 0, clip);
  return d;
}

export function moveMain(doc: ProjectDoc, id: ID, toIndex: number): ProjectDoc {
  const d = cloneDoc(doc);
  const from = d.main.findIndex((c) => c.id === id);
  if (from < 0) return d;
  const [clip] = d.main.splice(from, 1);
  d.main.splice(clamp(toIndex, 0, d.main.length), 0, clip);
  return reanchorTimed(doc, d);
}

/** Put the main clips in the given order. Clips that are not listed keep their relative order at the end. */
export function reorderMain(doc: ProjectDoc, ids: ID[]): ProjectDoc {
  const d = cloneDoc(doc);
  const byId = new Map(d.main.map((c) => [c.id, c]));
  const out: MainClip[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (c) {
      out.push(c);
      byId.delete(id);
    }
  }
  for (const c of d.main) if (byId.has(c.id)) out.push(c);
  d.main = out;
  return reanchorTimed(doc, d);
}

/**
 * Move a stretch of the main track so that it starts where `to` is now. `to`
 * is a timeline time outside the stretch (0 brings it to the front). Used to
 * open on a line that was said later, or to swap two thoughts.
 */
export function moveMainRange(doc: ProjectDoc, start: number, end: number, to: number): ProjectDoc {
  if (end - start <= EPS || (to > start - EPS && to < end + EPS)) return cloneDoc(doc);
  let d = splitAt(doc, start);
  d = splitAt(d, end);
  d = splitAt(d, to);
  const fps = d.settings.fps;
  const a = snap(start, fps);
  const b = snap(end, fps);
  const at = snap(to, fps);
  const layout = layoutMain(d);
  const moving = layout.filter((seg) => seg.start >= a - EPS && seg.end <= b + EPS);
  if (!moving.length) return cloneDoc(doc);
  const ids = new Set(moving.map((seg) => seg.clip.id));
  const rest = layout.filter((seg) => !ids.has(seg.clip.id));
  const index = rest.filter((seg) => seg.start < at - EPS).length;
  const order = [...rest.slice(0, index), ...moving, ...rest.slice(index)].map((seg) => seg.clip.id);
  // A transition belongs to the pair of clips it joined; the pairs have changed.
  for (const c of d.main) if (ids.has(c.id)) delete c.transition;
  return reorderMain(d, order);
}

/**
 * After the main track has been rearranged, move the items on the other
 * tracks so each stays over the footage it was placed on. Music is left
 * alone. With `dropOrphans`, items whose footage is no longer in the video
 * are removed; otherwise they stay where they were.
 */
export function reanchorTimed(before: ProjectDoc, after: ProjectDoc, dropOrphans = false): ProjectDoc {
  const d = cloneDoc(after);
  const fps = d.settings.fps;
  const frame = 1 / fps;
  const oldLayout = layoutMain(before);
  const newLayout = layoutMain(d);
  const byId = new Map(newLayout.map((seg) => [seg.clip.id, seg]));
  const inSource = (seg: MainSeg, mediaId: ID, src: number) =>
    seg.clip.kind === 'media' && seg.clip.mediaId === mediaId && src >= seg.clip.in - EPS && src < seg.clip.out - EPS;
  /** Where the footage under old time `t` plays now, with the segment it is in. */
  const map = (t: number): { t: number; seg: MainSeg } | null => {
    const old = oldLayout.find((x) => t >= x.start - EPS && t < x.end - EPS);
    if (!old) return null;
    const same = byId.get(old.clip.id);
    if (old.clip.kind !== 'media') return same ? { t: same.start + Math.min(t - old.start, same.end - same.start - frame), seg: same } : null;
    const src = sourceAt(old.clip, t - old.start);
    const mediaId = old.clip.mediaId;
    const hit = same && inSource(same, mediaId, src) ? same : newLayout.find((x) => inSource(x, mediaId, src));
    if (!hit || hit.clip.kind !== 'media') return null;
    return { t: hit.start + localAt(hit.clip, src), seg: hit };
  };
  const moveClip = <T extends SourceClip & { start: number }>(c: T): T | null => {
    const m = map(c.start);
    if (!m) return dropOrphans ? null : c;
    return { ...c, start: Math.max(0, snap(m.t, fps)) };
  };
  const moveSpan = <T extends { start: number; duration: number }>(x: T): T | null => {
    const m = map(x.start);
    if (!m) return dropOrphans ? null : x;
    const start = Math.max(0, snap(m.t, fps));
    // Follow the footage under the item's last frame too, so an item shrinks with a cut inside it.
    const last = map(x.start + x.duration - frame);
    const mappedEnd = last ? last.t + frame : -1;
    const sane = mappedEnd > start + frame && mappedEnd <= start + x.duration + frame;
    const duration = sane ? mappedEnd - start : Math.min(x.duration, m.seg.end - start);
    return duration < 2 * frame - EPS ? null : { ...x, start, duration: snap(duration, fps) };
  };
  d.overlays = d.overlays.map(moveClip).filter(notNull);
  d.audio = d.audio.map((a) => (a.role === 'music' ? a : moveClip(a))).filter(notNull);
  d.graphics = d.graphics.map(moveSpan).filter(notNull);
  d.zooms = d.zooms.map(moveSpan).filter(notNull);
  if (d.markers) d.markers = d.markers.map((m) => { const hit = map(m.t); return hit ? { ...m, t: snap(hit.t, fps) } : null; }).filter(notNull);
  return d;
}

/**
 * Drag an edge of a main clip to a new timeline position. Shortening closes
 * the gap; lengthening reveals more of the source and pushes later items out.
 */
export function trimMain(
  doc: ProjectDoc,
  id: ID,
  edge: 'start' | 'end',
  time: number,
  mediaDur?: number,
): ProjectDoc {
  const fps = doc.settings.fps;
  const seg = layoutMain(doc).find((s) => s.clip.id === id);
  if (!seg) return cloneDoc(doc);
  const t = snap(time, fps);
  const frame = 1 / fps;
  if (edge === 'end') {
    const delta = t - seg.end;
    if (delta < -EPS) return rippleDelete(doc, [{ start: Math.max(t, seg.start + frame), end: seg.end }]);
    if (delta < EPS) return cloneDoc(doc);
    const d = cloneDoc(doc);
    const c = d.main[seg.index];
    let ext = delta;
    if (c.kind === 'color') c.duration = snap(c.duration + ext, fps);
    else {
      if (mediaDur && mediaDur > 0) ext = Math.min(ext, Math.floor(maxExtend(c, 'tail', mediaDur) * fps + 1e-4) / fps);
      if (ext < frame - EPS) return d;
      Object.assign(c, sourceRange(c, 0, srcDuration(c) + ext));
    }
    shiftTimed(d, seg.end, ext);
    return d;
  }
  const delta = t - seg.start;
  if (delta > EPS) return rippleDelete(doc, [{ start: seg.start, end: Math.min(t, seg.end - frame) }]);
  if (delta > -EPS) return cloneDoc(doc);
  const d = cloneDoc(doc);
  const c = d.main[seg.index];
  let ext = -delta;
  if (c.kind === 'color') c.duration = snap(c.duration + ext, fps);
  else {
    const bounded = mediaDur !== undefined && mediaDur > 0;
    if (bounded) ext = Math.min(ext, Math.floor(maxExtend(c, 'head', mediaDur) * fps + 1e-4) / fps);
    if (ext < frame - EPS) return d;
    // A still has no earlier picture to reveal, so it grows at the far end instead.
    Object.assign(c, bounded ? sourceRange(c, -ext, srcDuration(c)) : sourceRange(c, 0, srcDuration(c) + ext));
  }
  shiftTimed(d, seg.start + frame / 2, ext);
  return d;
}

export function setTransition(doc: ProjectDoc, id: ID, transition: Transition | null): ProjectDoc {
  const d = cloneDoc(doc);
  const c = d.main.find((x) => x.id === id);
  if (!c) return d;
  if (transition && transition.duration > 0) c.transition = { type: transition.type, duration: clamp(transition.duration, 0.1, 2) };
  else delete c.transition;
  return d;
}

// ---------------------------------------------------------------------------
// Items with their own start time

function listOf(d: ProjectDoc, kind: TimedKind): { id: ID; start: number }[] {
  return kind === 'overlay' ? d.overlays : kind === 'audio' ? d.audio : kind === 'graphic' ? d.graphics : d.zooms;
}

export function moveTimed(doc: ProjectDoc, kind: TimedKind, id: ID, start: number): ProjectDoc {
  const d = cloneDoc(doc);
  const item = listOf(d, kind).find((x) => x.id === id);
  if (item) item.start = Math.max(0, snap(start, d.settings.fps));
  return d;
}

export function trimTimed(
  doc: ProjectDoc,
  kind: TimedKind,
  id: ID,
  edge: 'start' | 'end',
  time: number,
  mediaDur?: number,
): ProjectDoc {
  const d = cloneDoc(doc);
  const fps = d.settings.fps;
  const frame = 1 / fps;
  const t = snap(Math.max(0, time), fps);
  if (kind === 'graphic' || kind === 'zoom') {
    const x = (kind === 'graphic' ? d.graphics : d.zooms).find((i) => i.id === id);
    if (!x) return d;
    const end = x.start + x.duration;
    if (edge === 'start') {
      const ns = Math.min(t, end - 2 * frame);
      x.duration = snap(end - ns, fps);
      x.start = ns;
    } else x.duration = snap(Math.max(t, x.start + 2 * frame) - x.start, fps);
    return d;
  }
  const c = (kind === 'overlay' ? d.overlays : d.audio).find((i) => i.id === id);
  if (!c) return d;
  const bounded = mediaDur !== undefined && mediaDur > 0;
  const end = c.start + srcDuration(c);
  const dur = srcDuration(c);
  if (edge === 'start') {
    let ns = Math.min(t, end - frame);
    if (bounded) ns = Math.max(ns, Math.ceil((c.start - maxExtend(c, 'head', mediaDur)) * fps - 1e-4) / fps);
    ns = Math.max(0, ns);
    const delta = ns - c.start;
    Object.assign(c, bounded ? sourceRange(c, delta, dur) : sourceRange(c, 0, dur - delta));
    c.start = ns;
  } else {
    let ne = Math.max(t, c.start + frame);
    if (bounded) ne = Math.min(ne, Math.floor((c.start + dur + maxExtend(c, 'tail', mediaDur)) * fps + 1e-4) / fps);
    Object.assign(c, sourceRange(c, 0, ne - c.start));
  }
  return d;
}

// ---------------------------------------------------------------------------
// Split / delete / duplicate

function splitSource<T extends SourceClip>(c: T, clipStart: number, t: number, fps: number): [T, T] | null {
  const local = t - clipStart;
  const dur = srcDuration(c);
  if (local < 1 / fps - EPS || local > dur - 1 / fps + EPS) return null;
  const a = { ...c, ...sourceRange(c, 0, local) };
  const b = { ...c, id: uid(), ...sourceRange(c, local, dur) };
  delete a.fadeOut;
  delete b.fadeIn;
  return [a, b];
}

/** Split the selected item at `t`, or the main clip under `t` when nothing timed is selected. */
export function splitAt(doc: ProjectDoc, time: number, sel?: Selection): ProjectDoc {
  const d = cloneDoc(doc);
  const fps = d.settings.fps;
  const t = snap(time, fps);
  if (sel && (sel.kind === 'overlay' || sel.kind === 'audio')) {
    const list: (OverlayClip | AudioClip)[] = sel.kind === 'overlay' ? d.overlays : d.audio;
    const i = list.findIndex((c) => c.id === sel.id);
    if (i >= 0) {
      const parts = splitSource(list[i], list[i].start, t, fps);
      if (parts) {
        parts[1].start = t;
        list.splice(i, 1, parts[0], parts[1]);
        return d;
      }
    }
  }
  if (sel && (sel.kind === 'graphic' || sel.kind === 'zoom')) {
    const list: (GraphicItem | ZoomItem)[] = sel.kind === 'graphic' ? d.graphics : d.zooms;
    const i = list.findIndex((c) => c.id === sel.id);
    if (i >= 0) {
      const x = list[i];
      const end = x.start + x.duration;
      if (t > x.start + 1 / fps - EPS && t < end - 1 / fps + EPS) {
        list.splice(i, 1, { ...x, duration: t - x.start }, { ...x, id: uid(), start: t, duration: end - t });
        return d;
      }
    }
  }
  const seg = layoutMain(d).find((s) => t > s.start + EPS && t < s.end - EPS);
  if (!seg) return d;
  if (seg.clip.kind === 'color') {
    const a: MainClip = { ...seg.clip, duration: t - seg.start };
    const b: MainClip = { ...seg.clip, id: uid(), duration: seg.end - t };
    delete b.transition;
    d.main.splice(seg.index, 1, a, b);
    return d;
  }
  const parts = splitSource(seg.clip, seg.start, t, fps);
  if (parts) {
    delete parts[1].transition;
    d.main.splice(seg.index, 1, parts[0], parts[1]);
  }
  return d;
}

export function removeItem(doc: ProjectDoc, sel: NonNullable<Selection>, ripple = true): ProjectDoc {
  if (sel.kind === 'main') {
    const seg = layoutMain(doc).find((s) => s.clip.id === sel.id);
    if (!seg) return cloneDoc(doc);
    if (ripple) return rippleDelete(doc, [{ start: seg.start, end: seg.end }]);
    const d = cloneDoc(doc);
    d.main.splice(seg.index, 1);
    return d;
  }
  const d = cloneDoc(doc);
  if (sel.kind === 'overlay') d.overlays = d.overlays.filter((x) => x.id !== sel.id);
  else if (sel.kind === 'audio') d.audio = d.audio.filter((x) => x.id !== sel.id);
  else if (sel.kind === 'graphic') d.graphics = d.graphics.filter((x) => x.id !== sel.id);
  else if (sel.kind === 'zoom') d.zooms = d.zooms.filter((x) => x.id !== sel.id);
  return d;
}

/** Copy an item. Main clips are inserted right after the original; everything else lands straight after it in time. */
export function duplicateItem(doc: ProjectDoc, sel: NonNullable<Selection>): { doc: ProjectDoc; id: ID | null } {
  if (sel.kind === 'main') {
    const i = doc.main.findIndex((c) => c.id === sel.id);
    if (i < 0) return { doc: cloneDoc(doc), id: null };
    const copy: MainClip = { ...cloneDoc(doc.main[i]), id: uid() };
    delete copy.transition;
    return { doc: insertMain(doc, copy, i + 1), id: copy.id };
  }
  const d = cloneDoc(doc);
  const id = uid();
  if (sel.kind === 'overlay' || sel.kind === 'audio') {
    const list: (OverlayClip | AudioClip)[] = sel.kind === 'overlay' ? d.overlays : d.audio;
    const src = list.find((c) => c.id === sel.id);
    if (!src) return { doc: d, id: null };
    list.push({ ...cloneDoc(src), id, start: snap(src.start + srcDuration(src), d.settings.fps) });
    return { doc: d, id };
  }
  if (sel.kind === 'graphic' || sel.kind === 'zoom') {
    const list: (GraphicItem | ZoomItem)[] = sel.kind === 'graphic' ? d.graphics : d.zooms;
    const src = list.find((c) => c.id === sel.id);
    if (!src) return { doc: d, id: null };
    list.push({ ...cloneDoc(src), id, start: snap(src.start + src.duration, d.settings.fps) });
    return { doc: d, id };
  }
  return { doc: d, id: null };
}

// ---------------------------------------------------------------------------
// Adding things

export function addOverlay(
  doc: ProjectDoc,
  media: MediaLike,
  opts: { start: number; duration?: number; in?: number; framing?: Framing; muted?: boolean } & ItemMeta,
): { doc: ProjectDoc; clip: OverlayClip } {
  const d = cloneDoc(doc);
  const fps = d.settings.fps;
  const base = makeClip(media, fps, { in: opts.in, duration: opts.duration });
  const clip: OverlayClip = { ...base, start: Math.max(0, snap(opts.start, fps)), muted: opts.muted ?? true };
  if (opts.framing) clip.framing = opts.framing;
  if (opts.name) clip.name = opts.name;
  if (opts.createdBy) clip.createdBy = opts.createdBy;
  d.overlays.push(clip);
  return { doc: d, clip };
}

export function addAudio(
  doc: ProjectDoc,
  media: MediaLike,
  opts: { start: number; role: AudioRole; in?: number; duration?: number; volume?: number; duck?: boolean } & ItemMeta,
): { doc: ProjectDoc; clip: AudioClip } {
  const d = cloneDoc(doc);
  const fps = d.settings.fps;
  const base = makeClip(media, fps, { in: opts.in, duration: opts.duration, volume: opts.volume });
  const clip: AudioClip = { ...base, start: Math.max(0, snap(opts.start, fps)), role: opts.role };
  if (opts.role === 'music') clip.duck = opts.duck ?? true;
  if (opts.name) clip.name = opts.name;
  if (opts.createdBy) clip.createdBy = opts.createdBy;
  d.audio.push(clip);
  return { doc: d, clip };
}

export interface GraphicInput extends ItemMeta {
  /** Name of an entry in GRAPHIC_PRESETS; sets the template, look and placement. */
  preset?: string;
  template?: GraphicTemplate;
  props?: Record<string, unknown>;
  start: number;
  duration?: number;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
  animIn?: AnimKind;
  animOut?: AnimKind;
}

/** Where a new graphic sits when nothing says otherwise: the template's own place, moved clear of the captions and of app buttons in vertical video. */
function defaultY(d: ProjectDoc, preset: { template: GraphicTemplate; y: number }): number {
  if (preset.template !== 'lower-third' || d.settings.height / d.settings.width <= 1.5) return preset.y;
  return d.captions.enabled ? clamp(d.captions.y - 0.14, 0.3, 0.64) : 0.64;
}

export function addGraphic(doc: ProjectDoc, opts: GraphicInput): { doc: ProjectDoc; item: GraphicItem } {
  const d = cloneDoc(doc);
  const fps = d.settings.fps;
  const preset =
    (opts.preset ? GRAPHIC_PRESETS[opts.preset] : undefined) ??
    Object.values(GRAPHIC_PRESETS).find((p) => p.template === opts.template) ??
    GRAPHIC_PRESETS.hook;
  const item: GraphicItem = {
    id: uid('g'),
    template: opts.template ?? preset.template,
    props: { ...cloneDoc(preset.props), ...(opts.props ?? {}) },
    start: Math.max(0, snap(opts.start, fps)),
    duration: Math.max(2 / fps, snap(opts.duration ?? preset.duration, fps)),
    x: clamp(opts.x ?? preset.x, -0.5, 1.5),
    y: clamp(opts.y ?? defaultY(d, preset), -0.5, 1.5),
    scale: opts.scale ?? 1,
    rotation: opts.rotation ?? preset.rotation ?? 0,
    opacity: opts.opacity ?? 1,
    animIn: opts.animIn ?? preset.animIn,
    animOut: opts.animOut ?? preset.animOut,
  };
  if (opts.name) item.name = opts.name;
  if (opts.createdBy) item.createdBy = opts.createdBy;
  d.graphics.push(item);
  return { doc: d, item };
}

/** Shorthand for a text graphic. */
export function addText(
  doc: ProjectDoc,
  opts: { text: string; start: number; duration: number; preset?: string; props?: Record<string, unknown> } & ItemMeta,
): { doc: ProjectDoc; item: GraphicItem } {
  const preset = opts.preset && GRAPHIC_PRESETS[opts.preset]?.template === 'text' ? opts.preset : 'hook';
  return addGraphic(doc, {
    preset,
    props: { ...(opts.props ?? {}), text: opts.text },
    start: opts.start,
    duration: opts.duration,
    name: opts.name,
    createdBy: opts.createdBy,
  });
}

export function addZoom(
  doc: ProjectDoc,
  opts: {
    start: number;
    duration: number;
    scale?: number;
    toScale?: number;
    focusX?: number;
    focusY?: number;
    ease?: 'cut' | 'smooth';
    shake?: number;
  } & ItemMeta,
): { doc: ProjectDoc; item: ZoomItem } {
  const d = cloneDoc(doc);
  const fps = d.settings.fps;
  const item: ZoomItem = {
    id: uid('z'),
    start: Math.max(0, snap(opts.start, fps)),
    duration: Math.max(2 / fps, snap(opts.duration, fps)),
    scale: clamp(opts.scale ?? 1.25, 1, 4),
    focusX: clamp(opts.focusX ?? 0.5, 0, 1),
    focusY: clamp(opts.focusY ?? 0.4, 0, 1),
    ease: opts.ease ?? 'cut',
  };
  if (opts.toScale !== undefined) item.toScale = clamp(opts.toScale, 1, 4);
  if (opts.shake) item.shake = clamp(opts.shake, 0, 1);
  if (opts.name) item.name = opts.name;
  if (opts.createdBy) item.createdBy = opts.createdBy;
  d.zooms.push(item);
  return { doc: d, item };
}

/** A solid-colour card on the main track with centred text over it. */
export function addTitleCard(
  doc: ProjectDoc,
  opts: { text: string; duration?: number; index?: number; color?: string; textColor?: string; animated?: CardAnimation; accent?: string } & ItemMeta,
): ProjectDoc {
  const fps = doc.settings.fps;
  const duration = Math.max(0.5, snap(opts.duration ?? 3, fps));
  const index = clamp(opts.index ?? 0, 0, doc.main.length);
  const card: MainClip = { kind: 'color', id: uid(), duration, color: opts.color ?? '#000000', name: opts.name ?? 'Title card' };
  if (opts.animated) {
    card.animated = opts.animated;
    if (opts.accent) card.accent = opts.accent;
  }
  if (opts.createdBy) card.createdBy = opts.createdBy;
  const d = insertMain(doc, card, index);
  const start = layoutMain(d)[index].start;
  return addText(d, {
    text: opts.text,
    start,
    duration,
    preset: 'card',
    props: { color: opts.textColor ?? '#FFFFFF' },
    name: opts.name ?? 'Title card text',
    createdBy: opts.createdBy,
  }).doc;
}

// ---------------------------------------------------------------------------
// Property edits

export function updateClip(
  doc: ProjectDoc,
  kind: 'main' | 'overlay' | 'audio',
  id: ID,
  patch: Partial<SourceClip & OverlayClip & AudioClip & { color: string; duration: number; animated: CardAnimation | undefined; accent: string }>,
  mediaDur?: number,
): ProjectDoc {
  const d = cloneDoc(doc);
  const fps = d.settings.fps;
  if (kind === 'main') {
    const before = layoutMain(d).find((s) => s.clip.id === id);
    if (!before) return d;
    const c = d.main[before.index];
    if (c.kind === 'color') {
      if (patch.color) c.color = patch.color;
      if (patch.duration) c.duration = Math.max(1 / fps, snap(patch.duration, fps));
      if (patch.name !== undefined) c.name = patch.name;
      if ('animated' in patch) c.animated = patch.animated || undefined;
      if (patch.accent !== undefined) c.accent = patch.accent;
    } else {
      // A plain speed replaces a ramp.
      if (patch.speed !== undefined && patch.ramp === undefined) delete c.ramp;
      Object.assign(c, patch);
      d.main[before.index] = fitClip(c, fps, mediaDur);
    }
    const after = layoutMain(d)[before.index];
    const delta = after.end - before.end;
    if (Math.abs(delta) > EPS) shiftTimed(d, before.end, delta);
    return d;
  }
  const list: (OverlayClip | AudioClip)[] = kind === 'overlay' ? d.overlays : d.audio;
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return d;
  const cur = { ...list[i] };
  if (patch.speed !== undefined && patch.ramp === undefined) delete cur.ramp;
  list[i] = fitClip({ ...cur, ...patch }, fps, mediaDur);
  return d;
}

// ---------------------------------------------------------------------------
// Markers

/** Add a marker at `t`, or rename the one already within a frame of it. */
export function addMarker(doc: ProjectDoc, t: number, label = '', color?: string): ProjectDoc {
  const d = cloneDoc(doc);
  const fps = d.settings.fps;
  const at = Math.max(0, snap(t, fps));
  const list = d.markers ?? [];
  const same = list.find((m) => Math.abs(m.t - at) <= 0.5 / fps);
  if (same) {
    same.label = label || same.label;
    if (color) same.color = color;
  } else list.push({ id: uid('k'), t: at, label, ...(color ? { color } : {}) });
  d.markers = list.sort((a, b) => a.t - b.t);
  return d;
}

export function updateMarker(doc: ProjectDoc, id: ID, patch: Partial<Marker>): ProjectDoc {
  const d = cloneDoc(doc);
  d.markers = (d.markers ?? []).map((m) => (m.id === id ? { ...m, ...patch, id: m.id, t: patch.t !== undefined ? Math.max(0, snap(patch.t, d.settings.fps)) : m.t } : m)).sort((a, b) => a.t - b.t);
  return d;
}

export function removeMarker(doc: ProjectDoc, id: ID): ProjectDoc {
  const d = cloneDoc(doc);
  d.markers = (d.markers ?? []).filter((m) => m.id !== id);
  if (!d.markers.length) delete d.markers;
  return d;
}

/**
 * Roll the cut between main clip `index` and the next one by `delta` seconds:
 * one grows at the cut by what the other gives up, so nothing else moves.
 */
export function rollCut(doc: ProjectDoc, index: number, delta: number, mediaDurOf: (id: ID) => number | undefined): ProjectDoc {
  const d = cloneDoc(doc);
  const fps = d.settings.fps;
  const a = d.main[index];
  const b = d.main[index + 1];
  if (!a || !b) return doc;
  const frame = 1 / fps;
  let dt = snap(delta, fps);
  // How far each side can go: a clip keeps at least a frame, and media clips stay inside their files.
  const room = (c: MainClip, edge: 'head' | 'tail'): number => {
    if (c.kind === 'color') return Infinity;
    const md = mediaDurOf(c.mediaId);
    return md && md > 0 ? maxExtend(c, edge, md) : Infinity;
  };
  const lenA = mainClipDuration(a);
  const lenB = mainClipDuration(b);
  if (dt > 0) dt = Math.min(dt, Math.floor(Math.min(room(a, 'tail'), lenB - frame) * fps + 1e-4) / fps);
  else dt = -Math.min(-dt, Math.floor(Math.min(room(b, 'head'), lenA - frame) * fps + 1e-4) / fps);
  if (Math.abs(dt) < frame - EPS) return doc;
  const grow = (c: MainClip, edge: 'head' | 'tail', by: number): MainClip => {
    if (c.kind === 'color') return { ...c, duration: snap(c.duration + by, fps) };
    const dur = srcDuration(c);
    return { ...c, ...(edge === 'tail' ? sourceRange(c, 0, dur + by) : sourceRange(c, -by, dur)) };
  };
  d.main[index] = grow(a, 'tail', dt);
  d.main[index + 1] = grow(b, 'head', -dt);
  return d;
}

// ---------------------------------------------------------------------------
// Speed

export type RampPreset = 'slow-moment' | 'hero' | 'ramp-in' | 'ramp-out' | 'burst';

export const RAMP_PRESETS: { id: RampPreset; label: string; hint: string }[] = [
  { id: 'slow-moment', label: 'Slow moment', hint: 'Normal speed, eases into slow motion around the playhead, then back.' },
  { id: 'hero', label: 'Hero', hint: 'Fast in, slow motion at the playhead, fast out.' },
  { id: 'ramp-in', label: 'Ramp in', hint: 'Starts fast and settles to normal speed.' },
  { id: 'ramp-out', label: 'Ramp out', hint: 'Normal speed, then speeds away at the end.' },
  { id: 'burst', label: 'Burst', hint: 'A quick fast-forward from the playhead.' },
];

/**
 * A ready-made speed ramp for a clip, built around a source moment `at` (seconds
 * in the file; the clip's own range decides what is reachable). `base` is the
 * clip's normal speed.
 */
export function rampPreset(c: SourceClip, at: number, preset: RampPreset, slow = 0.3): SpeedKeyframe[] {
  const base = c.speed > 0 ? c.speed : 1;
  const fast = Math.min(MAX_SPEED, base * 4);
  const lo = Math.max(MIN_SPEED, Math.min(slow, base));
  const pts: SpeedKeyframe[] = (() => {
    switch (preset) {
      case 'slow-moment':
        return [
          { t: at - 0.45, speed: base },
          { t: at - 0.15, speed: lo },
          { t: at + 0.15, speed: lo },
          { t: at + 0.45, speed: base },
        ];
      case 'hero':
        return [
          { t: at - 0.9, speed: Math.min(MAX_SPEED, base * 2) },
          { t: at - 0.2, speed: lo },
          { t: at + 0.2, speed: lo },
          { t: at + 0.9, speed: Math.min(MAX_SPEED, base * 2) },
        ];
      case 'ramp-in':
        return [
          { t: c.in, speed: fast },
          { t: Math.min(c.out, c.in + 1.5), speed: base },
        ];
      case 'ramp-out':
        return [
          { t: Math.max(c.in, c.out - 1.5), speed: base },
          { t: c.out, speed: fast },
        ];
      case 'burst':
        return [
          { t: at - 0.08, speed: base },
          { t: at, speed: fast },
          { t: at + 1, speed: fast },
          { t: at + 1.08, speed: base },
        ];
    }
  })();
  // Keep the points inside the clip: where several land on the same edge, the one nearest the moment wins.
  const inside = pts.map((k) => ({ t: snapSource(clamp(k.t, c.in, c.out)), speed: k.speed }));
  const out: SpeedKeyframe[] = [];
  for (const k of inside) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.t - k.t) < 1e-9) {
      if (k.t < c.out - 1e-9) out[out.length - 1] = k;
    } else out.push(k);
  }
  return out;
}

/** Source times are kept to the millisecond so saved documents stay tidy. */
export function snapSource(t: number): number {
  return Math.round(t * 1000) / 1000;
}

/**
 * Hold the frame under `time` for `duration` seconds: the main clip is split
 * there and a still of that frame (already extracted as `still`) goes between
 * the halves, framed and graded like the clip. Everything after moves along.
 */
export function freezeFrame(doc: ProjectDoc, time: number, still: MediaLike, duration: number, name?: string): ProjectDoc {
  const fps = doc.settings.fps;
  const t = snap(time, fps);
  const seg = layoutMain(doc).find((s) => t >= s.start - EPS && t < s.end - EPS);
  if (!seg || seg.clip.kind !== 'media') return doc;
  const src = seg.clip;
  const local = t - seg.start;
  const framing = src.motion?.length ? { ...DEFAULT_FRAMING, ...framingAt(src.framing, undefined, sourceAt(src, local), src.motion, local) } : src.framing;
  const d = splitAt(doc, t, { kind: 'main', id: src.id });
  const layout = layoutMain(d);
  // The still goes after whichever piece ends at the split, or before the clip when the split fell on its head.
  const ending = layout.find((s) => Math.abs(s.end - t) < EPS);
  const own = layout.find((s) => s.clip.id === src.id);
  const index = ending ? ending.index + 1 : own ? own.index + (t > seg.end - 1 / fps - EPS ? 1 : 0) : 0;
  const clip: MediaMainClip = fitClip(
    { kind: 'media', id: uid(), mediaId: still.id, in: 0, out: Math.max(1 / fps, duration), speed: 1, volume: 1, muted: true, name: name ?? 'Freeze frame' },
    fps,
  );
  if (framing) clip.framing = { ...framing, track: false };
  if (src.fx) clip.fx = { ...src.fx };
  d.main.splice(index, 0, clip);
  shiftTimed(d, t, srcDuration(clip));
  return d;
}

/** `props` in the patch are merged into the existing ones rather than replacing them. */
// ---------------------------------------------------------------------------
// Keyframes: motion (framing) on clips, transform on overlays and graphics.

/** Add or replace the keyframe at `t` (within a frame) in a list, keeping it sorted. */
export function upsertKeyframe<K extends { t: number }>(list: K[] | undefined, kf: K, fps: number): K[] {
  const tol = 0.5 / fps;
  const out = (list ?? []).filter((k) => Math.abs(k.t - kf.t) > tol);
  const same = (list ?? []).find((k) => Math.abs(k.t - kf.t) <= tol);
  out.push({ ...(same ?? {}), ...kf, t: kf.t } as K);
  out.sort((a, b) => a.t - b.t);
  return out;
}

export function removeKeyframe<K extends { t: number }>(list: K[] | undefined, t: number, fps: number): K[] | undefined {
  const out = (list ?? []).filter((k) => Math.abs(k.t - t) > 0.5 / fps);
  return out.length ? out : undefined;
}

/** Set the whole motion of a clip (framing keyframes), or clear it. */
export function setMotion(doc: ProjectDoc, kind: 'main' | 'overlay', id: ID, motion: MotionKeyframe[] | undefined): ProjectDoc {
  const d = cloneDoc(doc);
  const clip = kind === 'main' ? d.main.find((c) => c.id === id && c.kind === 'media') : d.overlays.find((o) => o.id === id);
  if (!clip) return doc;
  const list = motion?.filter((k) => Number.isFinite(k.t)).sort((a, b) => a.t - b.t);
  (clip as SourceClip).motion = list && list.length ? list : undefined;
  return d;
}

/** Set the whole transform animation of an overlay or graphic, or clear it. */
export function setKeyframes(doc: ProjectDoc, kind: 'overlay' | 'graphic', id: ID, keyframes: Keyframe[] | undefined): ProjectDoc {
  const d = cloneDoc(doc);
  const item = kind === 'overlay' ? d.overlays.find((o) => o.id === id) : d.graphics.find((g) => g.id === id);
  if (!item) return doc;
  const list = keyframes?.filter((k) => Number.isFinite(k.t)).sort((a, b) => a.t - b.t);
  item.keyframes = list && list.length ? list : undefined;
  return d;
}

/** Ready-made motions over a clip's life: two keyframes from the current framing. */
export function motionPreset(framing: Framing | undefined, length: number, preset: 'push-in' | 'pull-out' | 'pan-left' | 'pan-right' | 'drift' | 'tilt-up' | 'tilt-down', amount = 0.2): MotionKeyframe[] {
  const f = { ...DEFAULT_FRAMING, ...(framing ?? {}) };
  const end = Math.max(0.2, length);
  const z = Math.max(1, f.scale);
  switch (preset) {
    case 'push-in':
      return [{ t: 0, scale: z }, { t: end, scale: z * (1 + amount), ease: 'inout' }];
    case 'pull-out':
      return [{ t: 0, scale: z * (1 + amount) }, { t: end, scale: z, ease: 'inout' }];
    case 'pan-left':
      return [{ t: 0, scale: Math.max(z, 1.15), focusX: Math.min(1, f.focusX + amount) }, { t: end, scale: Math.max(z, 1.15), focusX: Math.max(0, f.focusX - amount), ease: 'linear' }];
    case 'pan-right':
      return [{ t: 0, scale: Math.max(z, 1.15), focusX: Math.max(0, f.focusX - amount) }, { t: end, scale: Math.max(z, 1.15), focusX: Math.min(1, f.focusX + amount), ease: 'linear' }];
    case 'tilt-up':
      return [{ t: 0, scale: Math.max(z, 1.15), focusY: Math.min(1, f.focusY + amount) }, { t: end, scale: Math.max(z, 1.15), focusY: Math.max(0, f.focusY - amount), ease: 'linear' }];
    case 'tilt-down':
      return [{ t: 0, scale: Math.max(z, 1.15), focusY: Math.max(0, f.focusY - amount) }, { t: end, scale: Math.max(z, 1.15), focusY: Math.min(1, f.focusY + amount), ease: 'linear' }];
    case 'drift':
      // Ken Burns: a slow zoom with a gentle sideways move.
      return [{ t: 0, scale: z, focusX: Math.max(0, f.focusX - amount / 3) }, { t: end, scale: z * (1 + amount), focusX: Math.min(1, f.focusX + amount / 3), ease: 'inout' }];
  }
}

export function updateGraphic(doc: ProjectDoc, id: ID, patch: Partial<GraphicItem>): ProjectDoc {
  const d = cloneDoc(doc);
  const i = d.graphics.findIndex((t) => t.id === id);
  if (i < 0) return d;
  const cur = d.graphics[i];
  d.graphics[i] = { ...cur, ...patch, id, props: { ...cur.props, ...(patch.props ?? {}) } };
  return d;
}

export function updateZoom(doc: ProjectDoc, id: ID, patch: Partial<ZoomItem>): ProjectDoc {
  const d = cloneDoc(doc);
  const i = d.zooms.findIndex((z) => z.id === id);
  if (i >= 0) d.zooms[i] = { ...d.zooms[i], ...patch, id };
  return d;
}

export function setCaptions(doc: ProjectDoc, patch: Partial<CaptionSettings>): ProjectDoc {
  const d = cloneDoc(doc);
  const styleChanged = patch.style && patch.style !== d.captions.style;
  d.captions = {
    ...d.captions,
    ...(styleChanged && patch.style ? CAPTION_PRESETS[patch.style] : {}),
    ...patch,
    edits: { ...d.captions.edits, ...(patch.edits ?? {}) },
  };
  return d;
}

export function setSettings(doc: ProjectDoc, patch: Partial<ProjectSettings>): ProjectDoc {
  const d = cloneDoc(doc);
  d.settings = { ...d.settings, ...patch, audio: { ...d.settings.audio, ...(patch.audio ?? {}) } };
  return d;
}

// ---------------------------------------------------------------------------
// Editing by transcript: the words are the timeline

/** Timeline ranges where a span of a media file's source currently plays on the main track. */
export function sourceSpanOnTimeline(layout: MainSeg[], mediaId: ID, span: Range): Range[] {
  const out: Range[] = [];
  for (const seg of layout) {
    const c = seg.clip;
    if (c.kind !== 'media' || c.mediaId !== mediaId) continue;
    const a = Math.max(span.start, c.in);
    const b = Math.min(span.end, c.out);
    if (b - a <= EPS) continue;
    const [x, y] = [localAt(c, a), localAt(c, b)].sort((u, v) => u - v);
    out.push({ start: seg.start + x, end: seg.start + y });
  }
  return out;
}

/** For each word of a media file, whether it is currently part of the main track. */
export function wordsKept(doc: ProjectDoc, mediaId: ID, words: Word[]): boolean[] {
  const spans = doc.main
    .filter((c): c is MediaMainClip => c.kind === 'media' && c.mediaId === mediaId)
    .map((c) => ({ start: c.in, end: c.out }))
    .sort((a, b) => a.start - b.start);
  return words.map((w) => {
    const mid = (w.t0 + w.t1) / 2;
    return spans.some((s) => mid >= s.start && mid < s.end);
  });
}

/** A gap longer than this is not a pause to tidy but part of the programme: an intro, a reaction, a demonstration. */
export const LONG_PAUSE = 1.2;
/** Quiet always left against a kept word, so a soft consonant at its edge survives. */
const EDGE_GUARD = 0.04;

export interface WordCutOptions {
  /** Which words are in the video now. Cut neighbours are folded into the span, so no scrap is left between two cuts. */
  kept?: boolean[];
  /** The quietest moment between two source times, for an edge that falls between words spoken without a pause. */
  quietest?: (lo: number, hi: number) => number;
}

/**
 * The source span to cut when removing words `from`..`to` (inclusive).
 *
 * The shorter of the two pauses around the words goes with them, so removing
 * a false start does not leave two pauses back to back, and the longer pause
 * stays as it was.
 */
export function wordSpan(words: Word[], fromIn: number, toIn: number, mediaDur: number, opts: WordCutOptions = {}): Range {
  let from = clamp(Math.min(fromIn, toIn), 0, words.length - 1);
  let to = clamp(Math.max(fromIn, toIn), 0, words.length - 1);
  const kept = opts.kept;
  if (kept) {
    while (from > 0 && !kept[from - 1] && words[from].t0 - words[from - 1].t1 <= LONG_PAUSE) from--;
    while (to < words.length - 1 && !kept[to + 1] && words[to + 1].t0 - words[to].t1 <= LONG_PAUSE) to++;
  }
  const t0 = words[from].t0;
  const t1 = words[to].t1;
  const prev = from > 0 ? words[from - 1] : null;
  const next = to < words.length - 1 ? words[to + 1] : null;
  const pauseBefore = Math.max(0, t0 - (prev ? prev.t1 : 0));
  const pauseAfter = Math.max(0, (next ? next.t0 : mediaDur) - t1);
  let start = t0;
  let end = t1;
  if (pauseAfter <= pauseBefore) {
    if (pauseAfter <= LONG_PAUSE) end = t1 + Math.max(0, pauseAfter - EDGE_GUARD);
  } else if (pauseBefore <= LONG_PAUSE) start = t0 - Math.max(0, pauseBefore - EDGE_GUARD);
  if (opts.quietest) {
    // Where the cut meets a kept word with no pause between them, land on the
    // dip between the two sounds, moving only a little way into either word.
    const reach = (w: Word) => Math.min(0.04, (w.t1 - w.t0) * 0.2);
    if (prev && pauseBefore < 0.02) start = opts.quietest(t0 - reach(prev), t0 + reach(words[from]));
    if (next && pauseAfter < 0.02) end = opts.quietest(t1 - reach(words[to]), t1 + reach(next));
  }
  start = Math.max(0, start);
  return { start, end: Math.min(mediaDur, Math.max(end, start)) };
}

/** The source span to bring back when restoring words: the words and a breath on either side. */
export function wordRestoreSpan(words: Word[], fromIn: number, toIn: number, mediaDur: number): Range {
  const from = clamp(Math.min(fromIn, toIn), 0, words.length - 1);
  const to = clamp(Math.max(fromIn, toIn), 0, words.length - 1);
  const before = words[from].t0 - (from > 0 ? words[from - 1].t1 : 0);
  const after = (to < words.length - 1 ? words[to + 1].t0 : mediaDur) - words[to].t1;
  return { start: words[from].t0 - clamp(before, 0, 0.2), end: words[to].t1 + clamp(after, 0, 0.2) };
}

/** Cut source spans of a media file out of the main track. */
export function removeSourceSpans(doc: ProjectDoc, mediaId: ID, spans: Range[]): ProjectDoc {
  const layout = layoutMain(doc);
  return rippleDelete(doc, spans.flatMap((s) => sourceSpanOnTimeline(layout, mediaId, s)));
}

/**
 * Bring a cut span of a media file back onto the main track, next to the
 * surviving pieces of the same file, joining with them where they touch.
 */
export function restoreSourceSpan(doc: ProjectDoc, media: MediaLike, span: Range): ProjectDoc {
  let d = cloneDoc(doc);
  const fps = d.settings.fps;
  const covered = d.main
    .filter((c): c is MediaMainClip => c.kind === 'media' && c.mediaId === media.id)
    .map((c) => ({ start: c.in, end: c.out }))
    .sort((a, b) => a.start - b.start);
  const wanted = { start: clamp(span.start, 0, media.duration), end: clamp(span.end, 0, media.duration) };
  const missing = subtract(wanted, covered).filter((m) => m.end - m.start >= 1 / fps - EPS);
  for (const m of missing) {
    const layout = layoutMain(d);
    const same = layout.filter((s) => s.clip.kind === 'media' && s.clip.mediaId === media.id);
    const next = same.find((s) => (s.clip as MediaMainClip).in >= m.end - 2 / fps);
    const prevCandidates = same.filter((s) => (s.clip as MediaMainClip).out <= m.start + 2 / fps);
    const prev = prevCandidates[prevCandidates.length - 1];
    const model = ((next ?? prev)?.clip as MediaMainClip | undefined) ?? undefined;
    const speed = model?.speed ?? 1;
    const touchesPrev = prev && Math.abs((prev.clip as MediaMainClip).out - m.start) < 2 / fps && prev.clip.kind === 'media';
    const touchesNext = next && Math.abs((next.clip as MediaMainClip).in - m.end) < 2 / fps;
    const adjacent = prev && next && next.index === prev.index + 1;
    if (touchesPrev && prev) {
      const before = prev.end;
      const pc = d.main[prev.index] as MediaMainClip;
      pc.out = touchesNext && adjacent && next ? (next.clip as MediaMainClip).out : m.end;
      d.main[prev.index] = fitClip(pc, fps, media.duration);
      if (touchesNext && adjacent && next) d.main.splice(next.index, 1);
      const grown = layoutMain(d)[prev.index].end - before - (touchesNext && adjacent && next ? next.end - next.start : 0);
      if (grown > EPS) shiftTimed(d, before, grown);
    } else if (touchesNext && next) {
      const nc = d.main[next.index] as MediaMainClip;
      const before = next.end - next.start;
      nc.in = m.start;
      d.main[next.index] = fitClip(nc, fps, media.duration);
      const after = layoutMain(d)[next.index];
      shiftTimed(d, next.start + 0.5 / fps, after.end - after.start - before);
    } else {
      const clip: MediaMainClip = {
        kind: 'media',
        ...fitClip({ id: uid(), mediaId: media.id, in: m.start, out: m.end, speed, volume: model?.volume ?? 1 }, fps, media.duration),
      };
      if (model?.framing) clip.framing = cloneDoc(model.framing);
      if (model?.fx) clip.fx = cloneDoc(model.fx);
      const index = next ? next.index : prev ? prev.index + 1 : d.main.length;
      d = insertMain(d, clip, index);
    }
  }
  return d;
}

/** Keep one take of a repeated line on the timeline and cut the others. */
export function chooseTake(doc: ProjectDoc, group: TakeGroup, index: number, words: Word[], media: MediaLike, reason?: string): ProjectDoc {
  let d = cloneDoc(doc);
  const chosen = clamp(index, 0, group.takes.length - 1);
  group.takes.forEach((take, i) => {
    if (i === chosen || !words[take.from] || !words[take.to]) return;
    d = removeSourceSpans(d, group.mediaId, [wordSpan(words, take.from, take.to, media.duration)]);
  });
  const keep = group.takes[chosen];
  if (keep && words[keep.from] && words[keep.to]) {
    d = restoreSourceSpan(d, media, wordRestoreSpan(words, keep.from, keep.to, media.duration));
  }
  const g = d.takes.find((t) => t.id === group.id);
  if (g) {
    g.chosen = chosen;
    if (reason) g.reason = reason;
  } else d.takes.push({ ...group, chosen, reason });
  return d;
}

/**
 * Remove the scraps a cut can leave behind: a short piece of a talking clip
 * with no word in it, stranded between two cuts, which plays as a flash.
 * Pieces that were already like that before the cut are left alone.
 */
export function dropScraps(
  before: ProjectDoc,
  after: ProjectDoc,
  getWords: (mediaId: ID) => Word[] | undefined,
  maxLen = 0.5,
): { doc: ProjectDoc; dropped: number } {
  const key = (c: MediaMainClip) => `${c.mediaId}:${c.in.toFixed(3)}:${c.out.toFixed(3)}`;
  const had = new Set(before.main.filter((c): c is MediaMainClip => c.kind === 'media').map(key));
  const layout = layoutMain(after);
  const joins = (a: MainClip | undefined, b: MainClip | undefined) =>
    !!a && !!b && a.kind === 'media' && b.kind === 'media' && a.mediaId === b.mediaId && Math.abs(a.out - b.in) < 1e-3;
  const ranges: Range[] = [];
  layout.forEach((seg, i) => {
    const c = seg.clip;
    if (c.kind !== 'media' || seg.end - seg.start >= maxLen || had.has(key(c))) return;
    const ws = getWords(c.mediaId);
    // In a file without speech nothing says a short piece is an accident.
    if (!ws?.length) return;
    if (ws.some((w) => (w.t0 + w.t1) / 2 >= c.in && (w.t0 + w.t1) / 2 < c.out)) return;
    if (joins(layout[i - 1]?.clip, c) || joins(c, layout[i + 1]?.clip)) return;
    ranges.push({ start: seg.start, end: seg.end });
  });
  return ranges.length ? { doc: rippleDelete(after, ranges), dropped: ranges.length } : { doc: after, dropped: 0 };
}

export interface Passage {
  media: MediaLike;
  words: Word[];
  from: number;
  to: number;
}

/**
 * Of what is on the main track now, keep only the given passages, in the given
 * order, and drop everything else. Nothing that is already cut comes back.
 * Items on the other tracks follow the words they sat over; those whose
 * moment is gone are removed.
 */
export function keepPassages(doc: ProjectDoc, passages: Passage[], getWords?: (mediaId: ID) => Word[] | undefined): ProjectDoc {
  const d = cloneDoc(doc);
  const fps = d.settings.fps;
  const minLen = 2 / fps;
  // Passages that continue each other in the recording play as one piece, with their own rhythm.
  const merged: Passage[] = [];
  for (const p of passages) {
    const last = merged[merged.length - 1];
    if (last && last.media.id === p.media.id && p.from === last.to + 1) last.to = p.to;
    else merged.push({ ...p });
  }
  const sources = doc.main.filter((c): c is MediaMainClip => c.kind === 'media');
  const used = new Set<ID>();
  const main: MainClip[] = [];
  for (const p of merged) {
    const span = wordRestoreSpan(p.words, p.from, p.to, p.media.duration);
    for (const c of sources) {
      if (c.mediaId !== p.media.id) continue;
      const a = Math.max(c.in, span.start);
      const b = Math.min(c.out, span.end);
      if (Math.abs(localAt(c, b) - localAt(c, a)) < minLen) continue;
      const piece: MediaMainClip = { ...cloneDoc(c), id: used.has(c.id) ? uid() : c.id, in: a, out: b };
      used.add(c.id);
      delete piece.transition;
      if (a > c.in + EPS) delete piece.fadeIn;
      if (b < c.out - EPS) delete piece.fadeOut;
      main.push({ ...piece, ...fitClip(piece, fps, p.media.duration) });
    }
  }
  d.main = main;
  const moved = reanchorTimed(doc, d, true);
  return getWords ? dropScraps(doc, moved, getWords).doc : moved;
}

// ---------------------------------------------------------------------------
// Finding what to cut

export interface SilenceCutOptions {
  /** Only pauses at least this long are cut. */
  minSilence?: number;
  /** Quiet kept before speech resumes and after it stops, so words are not clipped. */
  padBefore?: number;
  padAfter?: number;
  /** Fragments shorter than this between two cuts are dropped as well. */
  minKeep?: number;
}

/**
 * Timeline ranges of dead air on the main track.
 * `getSilences` returns quiet stretches of a media file in source seconds.
 */
export function silenceCutRanges(
  layout: MainSeg[],
  getSilences: (mediaId: ID) => Range[] | undefined,
  opts: SilenceCutOptions = {},
): Range[] {
  const minSilence = opts.minSilence ?? 0.5;
  const padBefore = opts.padBefore ?? 0.1;
  const padAfter = opts.padAfter ?? 0.15;
  const minKeep = opts.minKeep ?? 0.25;
  const out: Range[] = [];
  for (const seg of layout) {
    if (seg.clip.kind !== 'media' || seg.clip.muted) continue;
    const c = seg.clip;
    const silences = getSilences(c.mediaId);
    if (!silences) continue;
    const cuts: Range[] = [];
    for (const s of silences) {
      if (s.end <= c.in || s.start >= c.out) continue;
      const a = Math.max(s.start, c.in);
      const b = Math.min(s.end, c.out);
      if (b - a < minSilence) continue;
      // No padding where the quiet runs off the edge of the clip: there is no
      // speech on that side to protect.
      const a2 = a <= c.in + EPS ? a : a + padAfter;
      const b2 = b >= c.out - EPS ? b : b - padBefore;
      if (b2 - a2 < 0.1) continue;
      const [x, y] = [localAt(c, a2), localAt(c, b2)].sort((u, v) => u - v);
      cuts.push({ start: seg.start + x, end: seg.start + y });
    }
    for (let i = 0; i < cuts.length - 1; i++) {
      if (cuts[i + 1].start - cuts[i].end < minKeep) {
        cuts[i + 1].start = cuts[i].start;
        cuts[i].end = cuts[i].start;
      }
    }
    for (const r of cuts) if (r.end - r.start > EPS) out.push(r);
  }
  return out;
}

/** Filler words by how aggressively they should be removed: 0 = only hesitation sounds. */
export const FILLER_LEVELS: string[][] = [
  ['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'hmm', 'mm', 'mhm', 'eh'],
  ['you know', 'i mean'],
  ['like', 'basically', 'actually', 'literally', 'sort of', 'kind of', 'so yeah', 'right'],
];

/** Words people double on purpose ("really, really good"); a repeat of these is not a stumble. */
const DELIBERATE_REPEATS = new Set(['really', 'very', 'so', 'no', 'yes', 'yeah', 'way', 'much', 'many', 'long', 'far', 'big', 'super', 'never', 'ever', 'bye', 'ha', 'go', 'wait', 'please', 'okay', 'ok', 'well', 'now', 'more', 'again']);

export function fillersFor(aggressiveness: number): string[] {
  return FILLER_LEVELS.slice(0, clamp(Math.round(aggressiveness), 0, 2) + 1).flat();
}

/** A stretch of consecutive words in one media file. */
export interface WordRun {
  mediaId: ID;
  from: number;
  to: number;
}

export interface WordMatches {
  /** Where the matches play on the timeline. */
  ranges: Range[];
  matched: string[];
  /** The same matches as words of their media files, for cutting by source. */
  runs: WordRun[];
}

/** Filler words in the video. Multi-word fillers ("you know") are matched as sequences. */
export function fillerCutRanges(words: TLWord[], fillers: string[] = FILLER_LEVELS[0]): WordMatches {
  const seqs = fillers.map((f) => f.split(/\s+/).map(normalizeWord).filter(Boolean)).filter((s) => s.length);
  const norm = words.map((w) => normalizeWord(w.text));
  const out: WordMatches = { ranges: [], matched: [], runs: [] };
  // A phrase only counts when its words also follow each other in the recording.
  const adjacent = (i: number, k: number) => words[i + k].mediaId === words[i].mediaId && words[i + k].index === words[i].index + k;
  let i = 0;
  while (i < words.length) {
    let len = 0;
    for (const seq of seqs) {
      if (seq.length > len && seq.every((s, k) => norm[i + k] === s && adjacent(i, k))) len = seq.length;
    }
    if (!len) {
      i++;
      continue;
    }
    const first = words[i];
    const last = words[i + len - 1];
    out.ranges.push({ start: first.start, end: last.end });
    out.matched.push(words.slice(i, i + len).map((w) => w.text.trim()).join(' '));
    out.runs.push({ mediaId: first.mediaId, from: first.index, to: last.index });
    i += len;
  }
  return out;
}

/** A word said twice in a row ("I I think", "the the") is almost always a stumble; cut the first. */
export function stutterCutRanges(words: TLWord[]): WordMatches {
  const out: WordMatches = { ranges: [], matched: [], runs: [] };
  for (let i = 0; i < words.length - 1; i++) {
    const a = normalizeWord(words[i].text);
    if (a && !DELIBERATE_REPEATS.has(a) && a === normalizeWord(words[i + 1].text) && words[i + 1].start - words[i].end < 0.6) {
      out.ranges.push({ start: words[i].start, end: words[i + 1].start });
      out.matched.push(words[i].text.trim());
      out.runs.push({ mediaId: words[i].mediaId, from: words[i].index, to: words[i].index });
    }
  }
  return out;
}

/** Text spoken inside a set of timeline ranges, for reporting what a cut removed. */
export function wordsInRanges(words: TLWord[], ranges: Range[]): string {
  const parts: string[] = [];
  for (const r of ranges) {
    const inside = words.filter((w) => (w.start + w.end) / 2 >= r.start && (w.start + w.end) / 2 < r.end);
    if (inside.length) parts.push(inside.map((w) => w.text.trim()).join(' '));
  }
  return parts.join(' … ');
}

// ---------------------------------------------------------------------------
// Validation

/** Repair a document that may come from an older version or a bad write. */
export function sanitizeDoc(doc: ProjectDoc, hasMedia?: (id: ID) => boolean): ProjectDoc {
  const d = cloneDoc(doc);
  const fps = [24, 25, 30, 50, 60].includes(d.settings?.fps) ? d.settings.fps : 30;
  d.version = 2;
  d.settings = {
    width: Math.round(clamp(d.settings?.width || 1080, 16, 7680) / 2) * 2,
    height: Math.round(clamp(d.settings?.height || 1920, 16, 7680) / 2) * 2,
    fps,
    background: d.settings?.background || '#000000',
    audio: { ...DEFAULT_SETTINGS.audio, ...(d.settings?.audio ?? {}) },
  };
  const ok = (c: SourceClip) =>
    Number.isFinite(c.in) && Number.isFinite(c.out) && c.out > c.in && (!hasMedia || hasMedia(c.mediaId));
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const fix = <T extends SourceClip>(c: T): T => {
    const f: T = { ...c, speed: clamp(num(c.speed, 1), MIN_SPEED, MAX_SPEED), volume: clamp(num(c.volume, 1), 0, 4) };
    const ramp = Array.isArray(c.ramp) ? rampPoints({ ramp: c.ramp.filter((k) => k && typeof k === 'object') }) : [];
    if (ramp.length) f.ramp = ramp;
    else delete f.ramp;
    if (!c.reverse) delete f.reverse;
    if (!c.pitchFollowsSpeed) delete f.pitchFollowsSpeed;
    if (c.interpolate !== 'blend' && c.interpolate !== 'flow') delete f.interpolate;
    const keys = Array.isArray(c.volumeKeys) ? c.volumeKeys.filter((k) => k && Number.isFinite(k.t) && Number.isFinite(k.gain)).map((k) => ({ t: Math.max(0, k.t), gain: clamp(k.gain, 0, 4) })).sort((a, b) => a.t - b.t) : [];
    if (keys.length) f.volumeKeys = keys;
    else delete f.volumeKeys;
    if (c.audioFx && typeof c.audioFx === 'object') {
      const a = c.audioFx;
      const fx: typeof a = {};
      if (AUDIO_PRESET_IDS.includes(a.preset as string)) fx.preset = a.preset;
      for (const key of ['low', 'mid', 'high'] as const) if (typeof a[key] === 'number' && a[key]) fx[key] = clamp(a[key]!, -12, 12);
      if (typeof a.compress === 'number' && a.compress > 0) fx.compress = clamp(a.compress, 0, 1);
      if (Object.keys(fx).length) f.audioFx = fx;
      else delete f.audioFx;
    } else delete f.audioFx;
    return f;
  };
  d.main = (d.main ?? []).filter((c) => (c.kind === 'color' ? c.duration > 0 : ok(c))).map((c) => (c.kind === 'color' ? c : fix(c)));
  d.overlays = (d.overlays ?? []).filter(ok).map((c) => ({ ...fix(c), start: Math.max(0, snap(num(c.start, 0), fps)) }));
  d.audio = (d.audio ?? []).filter(ok).map((c) => ({ ...fix(c), start: Math.max(0, snap(num(c.start, 0), fps)) }));
  d.graphics = (d.graphics ?? [])
    .filter((g) => g && g.duration > 0 && typeof g.template === 'string')
    .map((g) => ({
      ...g,
      props: g.props && typeof g.props === 'object' ? g.props : {},
      x: num(g.x, 0.5),
      y: num(g.y, 0.5),
      scale: num(g.scale, 1),
      rotation: num(g.rotation, 0),
      opacity: num(g.opacity, 1),
      animIn: g.animIn ?? 'fade',
      animOut: g.animOut ?? 'fade',
      ...(g.follow && (g.follow.target === 'face' || g.follow.target === 'object')
        ? { follow: { target: g.follow.target, trackId: g.follow.trackId, anchor: ['centre', 'above', 'below'].includes(g.follow.anchor) ? g.follow.anchor : 'above', offsetX: clamp(num(g.follow.offsetX, 0), -1, 1), offsetY: clamp(num(g.follow.offsetY, 0), -1, 1) } }
        : { follow: undefined }),
    }));
  d.zooms = (d.zooms ?? []).filter((z) => z.duration > 0 && z.scale > 0);
  const markers = (d.markers ?? []).filter((m) => m && typeof m === 'object' && Number.isFinite(m.t) && m.t >= 0).map((m) => ({ id: typeof m.id === 'string' && m.id ? m.id : uid('k'), t: snap(m.t, fps), label: typeof m.label === 'string' ? m.label : '', ...(typeof m.color === 'string' && m.color ? { color: m.color } : {}) }));
  if (markers.length) d.markers = markers.sort((a, b) => a.t - b.t);
  else delete d.markers;
  d.captions = { ...DEFAULT_CAPTIONS, ...(d.captions ?? {}), edits: { ...(d.captions?.edits ?? {}) } };
  d.takes = (d.takes ?? []).filter((t) => Array.isArray(t.takes) && (!hasMedia || hasMedia(t.mediaId)));
  return d;
}

export { contentDuration };
