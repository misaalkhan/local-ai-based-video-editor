// Shared plumbing for the editing tools: looking things up, describing the
// project in text, and committing changes.

import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../store.ts';
import { commitDoc, getEnvelope, getFaces, getWords, logHistory } from '../store.ts';
import { importMedia } from '../media.ts';
import { listLibrary } from '../library.ts';
import type { GraphicItem, ID, MediaAsset, ProjectDoc, Range, SourceClip, Word } from '../../shared/types.ts';
import { aspectOf } from '../../shared/types.ts';
import { buildCards, timelineWords } from '../../shared/captions.ts';
import type { TLWord } from '../../shared/captions.ts';
import { clamp, contentDuration, layoutMain, srcDuration } from '../../shared/timeline.ts';
import { wordSpan, wordsKept } from '../../shared/ops.ts';
import type { MainSeg } from '../../shared/timeline.ts';
import { buildScript, sentences } from '../../shared/transcript.ts';
import { UNSAFE_VERTICAL, faceInFrame } from '../../shared/lint.ts';
import type { LintContext } from '../../shared/lint.ts';
import { ENVELOPE_HOP } from '../../shared/silence.ts';

export interface ToolCtx {
  p: Project;
  by: 'agent' | 'user';
  /** Chat message this call belongs to, for per-message undo and the edit log. */
  messageId?: string;
  signal?: AbortSignal;
}

export interface ToolImage {
  data: Buffer;
  mime: string;
}

export interface ToolResult {
  text: string;
  images?: ToolImage[];
}

/** A problem with how a tool was called; the message is shown to the caller as is. */
export class ToolError extends Error {}

export function bad(message: string): never {
  throw new ToolError(message);
}

export type Args = Record<string, unknown>;

export const sec = (t: number) => (Math.round(t * 100) / 100).toFixed(2);

export function num(v: unknown, name: string, fallback?: number): number {
  if (v === undefined || v === null || v === '') {
    if (fallback !== undefined) return fallback;
    bad(`"${name}" is required.`);
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) bad(`"${name}" must be a number, got ${JSON.stringify(v)}.`);
  return n;
}

export const optNum = (v: unknown, name: string): number | undefined => (v === undefined || v === null || v === '' ? undefined : num(v, name));
export const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => (g <= 0 ? -60 : 20 * Math.log10(g));

export interface View {
  doc: ProjectDoc;
  layout: MainSeg[];
  words: TLWord[];
  duration: number;
}

export function view(p: Project): View {
  const doc = p.doc;
  const layout = layoutMain(doc);
  return { doc, layout, words: timelineWords(doc, layout, (id) => getWords(p, id)), duration: contentDuration(doc) };
}

/** Save a new version of the project and record why. */
export function save(ctx: ToolCtx, doc: ProjectDoc, op: string, explain: string): void {
  commitDoc(ctx.p, doc, { source: ctx.by === 'agent' ? 'agent' : 'op', messageId: ctx.messageId, label: op });
  logHistory(ctx.p, { by: ctx.by, messageId: ctx.messageId, op, explain: explain.slice(0, 300) });
}

export function lintContext(p: Project, v: View = view(p)): LintContext {
  return {
    layout: v.layout,
    cards: buildCards(v.words, v.doc.captions),
    mediaSize: (id) => {
      const m = p.media.get(id);
      return m ? { width: m.width, height: m.height } : undefined;
    },
    faces: (id) => getFaces(p, id),
  };
}

// ---------------------------------------------------------------------------
// Looking things up

const userMedia = (p: Project) => [...p.media.values()].sort((a, b) => a.addedAt - b.addedAt);

/** Find a media file by id, letter tag or name. `library:<file>` pulls one in from the shared library. */
export async function findMedia(p: Project, ref: unknown): Promise<MediaAsset> {
  const s = str(ref).trim();
  if (!s) bad('Which media file? Give its id, letter tag or name.');
  const lib = /^library:(.+)$/i.exec(s);
  if (lib) {
    const want = lib[1].trim().toLowerCase();
    const hit = listLibrary().find((f) => f.name.toLowerCase() === want || path.basename(f.name, path.extname(f.name)).toLowerCase() === want);
    if (!hit) bad(`Nothing called "${lib[1]}" in the library. Use list_library to see what is there.`);
    return importMedia(p, hit.file, { origin: 'library' });
  }
  const all = userMedia(p);
  const lower = s.toLowerCase();
  const exact = all.find((m) => m.id === s) ?? all.find((m) => m.tag === lower) ?? all.find((m) => m.name.toLowerCase() === lower) ?? all.find((m) => path.basename(m.name, path.extname(m.name)).toLowerCase() === lower);
  if (exact) return exact;
  const partial = all.filter((m) => m.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  bad(`No media file matches "${s}". Available: ${all.filter((m) => !m.origin).map((m) => `[${m.tag}] ${m.name}`).join(', ') || 'none'}.`);
}

export function mediaByTag(p: Project, tag: string): MediaAsset | undefined {
  return [...p.media.values()].find((m) => m.tag === tag.toLowerCase());
}

export const wordId = (m: MediaAsset | undefined, index: number): string => `${m?.tag ?? '?'}${index}`;

export interface WordRun {
  media: MediaAsset;
  words: Word[];
  from: number;
  to: number;
}

/** Parse word references such as "a12", "a12-a20" or "a12-20" into inclusive ranges per file. */
export function parseWordRefs(p: Project, refs: unknown): WordRun[] {
  const list = Array.isArray(refs) ? refs : typeof refs === 'string' ? refs.split(/[,\s]+/) : [];
  if (!list.length) bad('Give the words as ids from get_transcript, for example ["a12", "a20-a31"].');
  const out: WordRun[] = [];
  for (const raw of list) {
    const s = str(raw).trim().toLowerCase();
    if (!s) continue;
    const m = /^([a-z]+)(\d+)(?:\s*(?:-|–|—|\.\.|to)\s*([a-z]+)?(\d+))?$/.exec(s);
    if (!m) bad(`"${raw}" is not a word id. Ids look like a12, and ranges like a12-a20.`);
    if (m[3] && m[3] !== m[1]) bad(`"${raw}" spans two files. Give one range per file.`);
    const media = mediaByTag(p, m[1]);
    if (!media) bad(`There is no media file with the letter "${m[1]}".`);
    const words = getWords(p, media.id);
    if (!words?.length) bad(`"${media.name}" has no transcript.`);
    const a = Number(m[2]);
    const b = m[4] !== undefined ? Number(m[4]) : a;
    const from = Math.min(a, b);
    const to = Math.max(a, b);
    if (to >= words.length) bad(`"${raw}" is out of range: "${media.name}" has words ${media.tag}0 to ${media.tag}${words.length - 1}.`);
    out.push({ media, words, from, to });
  }
  return out;
}

export type ItemKind = 'main' | 'overlay' | 'audio' | 'graphic' | 'zoom';

export interface Found {
  kind: ItemKind;
  id: ID;
  start: number;
  end: number;
}

export function findItem(v: View, id: unknown): Found {
  const s = str(id).trim();
  if (!s) bad('Which item? Give its id from get_timeline.');
  const seg = v.layout.find((x) => x.clip.id === s);
  if (seg) return { kind: 'main', id: s, start: seg.start, end: seg.end };
  const o = v.doc.overlays.find((x) => x.id === s);
  if (o) return { kind: 'overlay', id: s, start: o.start, end: o.start + srcDuration(o) };
  const a = v.doc.audio.find((x) => x.id === s);
  if (a) return { kind: 'audio', id: s, start: a.start, end: a.start + srcDuration(a) };
  const g = v.doc.graphics.find((x) => x.id === s);
  if (g) return { kind: 'graphic', id: s, start: g.start, end: g.start + g.duration };
  const z = v.doc.zooms.find((x) => x.id === s);
  if (z) return { kind: 'zoom', id: s, start: z.start, end: z.start + z.duration };
  bad(`There is no item with id "${s}". Call get_timeline for current ids.`);
}

/** The media-backed clip behind an item, or null for colour cards, graphics and punch-ins. */
export function sourceClip(doc: ProjectDoc, kind: ItemKind, id: ID): SourceClip | null {
  if (kind === 'main') {
    const c = doc.main.find((x) => x.id === id);
    return c && c.kind === 'media' ? c : null;
  }
  if (kind === 'overlay') return doc.overlays.find((x) => x.id === id) ?? null;
  if (kind === 'audio') return doc.audio.find((x) => x.id === id) ?? null;
  return null;
}

/** When a word is on screen right now, by its id. */
export function wordTime(p: Project, v: View, ref: unknown, edge: 'start' | 'end'): number {
  const [r] = parseWordRefs(p, [ref]);
  const key = `${r.media.id}:${edge === 'start' ? r.from : r.to}`;
  const w = v.words.find((x) => x.key === key);
  if (!w) bad(`Word ${str(ref)} is not in the video right now (it has been cut, or its clip is not on the main track).`);
  return edge === 'start' ? w.start : w.end;
}

/** Schema fields shared by every tool that places something over a stretch of the video. */
export const WHEN = {
  start: { type: 'number', description: 'Timeline seconds.' },
  end: { type: 'number', description: 'Timeline seconds.' },
  duration: { type: 'number', description: 'Alternative to end.' },
  start_word: { type: 'string', description: 'Alternative to start: begin as this word is spoken (a word id such as a41). More exact than a time.' },
  end_word: { type: 'string', description: 'Alternative to end: finish when this word has been spoken.' },
};

/** Start and length of an item, given as times or as the words it should cover. */
export function span(p: Project, a: Args, v: View, fallbackDuration: number): { start: number; duration: number } {
  const start = a.start_word !== undefined && a.start_word !== '' ? wordTime(p, v, a.start_word, 'start') : Math.max(0, num(a.start, 'start (or start_word)'));
  const end = a.end_word !== undefined && a.end_word !== '' ? wordTime(p, v, a.end_word, 'end') : optNum(a.end, 'end');
  const duration = end !== undefined ? end - start : (optNum(a.duration, 'duration') ?? fallbackDuration);
  if (duration <= 0.05) bad(`The item would last ${sec(duration)}s. "end" must come after "start".`);
  if (v.duration > 0 && start >= v.duration + 0.01) bad(`start=${sec(start)}s is after the end of the video (${sec(v.duration)}s).`);
  return { start, duration };
}

// ---------------------------------------------------------------------------
// Placement that keeps clear of the face and of app interfaces

const ANCHORS: Record<string, [number, number]> = {
  top: [0.5, 0.17],
  upper: [0.5, 0.27],
  center: [0.5, 0.5],
  centre: [0.5, 0.5],
  lower: [0.5, 0.62],
  bottom: [0.5, 0.72],
  'top-left': [0.32, 0.17],
  'top-right': [0.62, 0.17],
  left: [0.3, 0.45],
  right: [0.66, 0.45],
  'bottom-left': [0.34, 0.68],
};

/**
 * Turn a position such as "top" or "auto" into frame coordinates. "auto"
 * looks for the speaker's face and puts the item above the head, or below the
 * chin if there is no room, staying out of the zones apps cover.
 */
export function place(p: Project, v: View, position: unknown, at: number, x?: number, y?: number): { x: number; y: number; how: string } {
  if (x !== undefined && y !== undefined) return { x, y, how: 'as given' };
  const name = str(position).trim().toLowerCase().replace(/\s+/g, '-');
  if (name && name !== 'auto' && name !== 'around-subject') {
    const a = ANCHORS[name];
    if (!a) bad(`Unknown position "${position}". Use auto, ${Object.keys(ANCHORS).join(', ')}, or give x and y.`);
    return { x: x ?? a[0], y: y ?? a[1], how: name };
  }
  const vertical = v.doc.settings.height / v.doc.settings.width > 1.5;
  const top = vertical ? UNSAFE_VERTICAL.top + 0.05 : 0.1;
  const bottom = vertical ? 1 - UNSAFE_VERTICAL.bottom - 0.04 : 0.86;
  const face = faceInFrame(v.doc, lintContext(p, v), at);
  const capY = v.doc.captions.enabled ? v.doc.captions.y : null;
  const clearOfCaptions = (yy: number) => capY === null || Math.abs(yy - capY) > 0.12;
  if (face) {
    // The detected box runs from brow to chin; leave room for the hair above it.
    const above = face.y - face.h * 0.8 - 0.06;
    if (above >= top) return { x: x ?? 0.5, y: above, how: 'above the head' };
    const below = face.y + face.h * 0.55 + 0.1;
    if (below <= bottom && clearOfCaptions(below)) return { x: x ?? 0.5, y: below, how: 'below the chin' };
    return { x: x ?? 0.5, y: top, how: 'at the top; the face fills the frame, so it overlaps the head (consider a looser crop)' };
  }
  const guess = vertical ? 0.2 : 0.16;
  return { x: x ?? 0.5, y: clearOfCaptions(guess) ? guess : 0.34, how: 'in the upper third (no face data for this moment)' };
}

/**
 * Widen cut ranges to swallow the scraps they would otherwise leave behind: a
 * wordless sliver of a few frames between a cut and the edge of a clip (or
 * another cut) plays as a flash.
 */
export function absorbSlivers(v: View, ranges: Range[], minLen = 0.3): Range[] {
  const sorted = ranges.map((r) => ({ ...r })).sort((a, b) => a.start - b.start);
  const wordless = (a: number, b: number) => !v.words.some((w) => (w.start + w.end) / 2 >= a && (w.start + w.end) / 2 < b);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const seg = v.layout.find((s) => r.start >= s.start - 1e-6 && r.start < s.end - 1e-6);
    if (!seg) continue;
    const prevEnd = i > 0 ? Math.max(seg.start, sorted[i - 1].end) : seg.start;
    if (r.start - prevEnd > 1e-6 && r.start - prevEnd < minLen && wordless(prevEnd, r.start)) r.start = prevEnd;
    const endSeg = v.layout.find((s) => r.end > s.start + 1e-6 && r.end <= s.end + 1e-6);
    if (!endSeg) continue;
    const nextStart = i + 1 < sorted.length ? Math.min(endSeg.end, sorted[i + 1].start) : endSeg.end;
    if (nextStart - r.end > 1e-6 && nextStart - r.end < minLen && wordless(r.end, nextStart)) r.end = nextStart;
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Audio levels

/** Typical peak level of a file's speech in dBFS, for setting effects against the voice. */
export function voicePeakDb(p: Project, v: View): number {
  for (const seg of v.layout) {
    if (seg.clip.kind !== 'media') continue;
    const m = p.media.get(seg.clip.mediaId);
    if (!m || !(m.wordCount ?? 0)) continue;
    try {
      const peaks = fs.readFileSync(path.join(p.dir, 'media', m.id, 'peaks.bin'));
      const hist = new Uint32Array(256);
      let n = 0;
      for (const b of peaks) {
        if (b > 3) {
          hist[b]++;
          n++;
        }
      }
      if (!n) continue;
      let acc = 0;
      for (let i = 255; i >= 0; i--) {
        acc += hist[i];
        if (acc >= n * 0.05) return 20 * Math.log10(Math.max(1, i) / 255) + 20 * Math.log10(Math.max(0.05, seg.clip.volume));
      }
    } catch {
      // no analysis for this file
    }
  }
  return -6;
}

/** The loudness envelope of a file, waiting a little for a file that is still being analysed (a fresh import). */
export async function envelopeSoon(p: Project, mediaId: ID, signal?: AbortSignal, waitMs = 20000): Promise<Uint8Array | undefined> {
  const until = Date.now() + waitMs;
  for (;;) {
    const env = getEnvelope(p, mediaId);
    if (env || Date.now() > until || signal?.aborted) return env;
    const m = p.media.get(mediaId);
    if (!m || m.analysis === 'error' || m.analysis === 'skipped') return env;
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** How loud a file is where it is making sound: the level it reaches in its louder moments, in dBFS. */
export function loudLevelDb(p: Project, mediaId: ID): number | null {
  const env = getEnvelope(p, mediaId);
  if (!env?.length) return null;
  const hist = new Uint32Array(101);
  let n = 0;
  for (const v of env) {
    // Anything under -55 dBFS is silence between sounds, not part of the level.
    if (v > 45) {
      hist[v]++;
      n++;
    }
  }
  if (!n) return null;
  let acc = 0;
  for (let i = 100; i >= 0; i--) {
    acc += hist[i];
    if (acc >= n * 0.25) return i - 100;
  }
  return null;
}

/** The level of the speech on the main track, in dBFS, or null when there is none. */
export function voiceLevelDb(p: Project, v: View): number | null {
  for (const seg of v.layout) {
    if (seg.clip.kind !== 'media' || seg.clip.muted) continue;
    const m = p.media.get(seg.clip.mediaId);
    if (!m || !(m.wordCount ?? 0)) continue;
    const level = loudLevelDb(p, m.id);
    if (level !== null) return level + gainToDb(Math.max(0.05, seg.clip.volume));
  }
  return null;
}

/** The quietest moment of a file between two of its times; the middle when nothing is known about its sound. */
export function quietestBetween(p: Project, mediaId: ID, lo: number, hi: number): number {
  const env = getEnvelope(p, mediaId);
  const mid = (lo + hi) / 2;
  if (!env || hi - lo < ENVELOPE_HOP) return mid;
  const centre = Math.round(mid / ENVELOPE_HOP);
  const a = Math.max(0, Math.ceil(lo / ENVELOPE_HOP));
  const b = Math.min(env.length - 1, Math.floor(hi / ENVELOPE_HOP));
  let best = centre;
  let bestScore = Infinity;
  for (let i = a; i <= b; i++) {
    const score = env[i] + Math.abs(i - centre) * 0.4;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return clamp(best * ENVELOPE_HOP, lo, hi);
}

/** The source span to cut for words from..to of a file, given what is in the video now. */
export function wordCut(p: Project, doc: ProjectDoc, media: MediaAsset, words: Word[], from: number, to: number): Range {
  return wordSpan(words, from, to, media.duration, {
    kept: wordsKept(doc, media.id, words),
    quietest: (lo, hi) => quietestBetween(p, media.id, lo, hi),
  });
}

// ---------------------------------------------------------------------------
// Describing the project in words

function graphicSummary(g: GraphicItem): string {
  const pr = g.props as Record<string, unknown>;
  const text = str(pr.text ?? pr.title ?? pr.emoji ?? '').replace(/\s+/g, ' ').slice(0, 50);
  return `${g.template}${text ? ` "${text}"` : ''}`;
}

export function describeMedia(m: MediaAsset): string {
  const parts = [`[${m.tag}] ${m.id} "${m.name}" ${m.kind}`];
  if (m.kind !== 'image') parts.push(`${sec(m.duration)}s`);
  if (m.kind !== 'audio') parts.push(`${m.width}x${m.height}`);
  if (m.transcript === 'pending' || m.transcript === 'running') parts.push('(still transcribing)');
  else if ((m.wordCount ?? 0) > 0) parts.push(`speech: ${m.wordCount} words${m.language ? ` (${m.language})` : ''}${(m.speakers ?? 0) > 1 ? `, ${m.speakers} speakers` : ''}`);
  else if (m.hasAudio) parts.push(m.kind === 'audio' ? 'no speech (music or effects)' : 'no speech');
  else if (m.kind === 'video') parts.push('silent');
  if (m.faces === 'done') parts.push('faces tracked');
  if (m.insights) parts.push(`notes: ${m.insights.summary}${m.insights.tags.length ? ` [${m.insights.tags.join(', ')}]` : ''}`);
  return parts.join(', ');
}

export function describeTimeline(p: Project): string {
  const v = view(p);
  const { doc } = v;
  const tagOf = (id: ID) => p.media.get(id)?.tag ?? '?';
  const lines: string[] = [];
  lines.push(`PROJECT "${doc.name}": ${doc.settings.width}x${doc.settings.height} (${aspectOf(doc.settings)}), ${doc.settings.fps} fps, ${sec(v.duration)}s long.`);
  const c = doc.captions;
  lines.push(`CAPTIONS: ${c.enabled ? `on, preset ${c.style}, ${c.maxWords} words at a time, y=${c.y.toFixed(2)}` : 'off'}.`);
  const media = userMedia(p).filter((m) => m.origin !== 'sfx');
  lines.push('', 'MEDIA (refer to a file by its letter):');
  if (!media.length) lines.push('  (none)');
  for (const m of media) lines.push(`  ${describeMedia(m)}`);

  lines.push('', 'MAIN TRACK (segments play back to back):');
  if (!v.layout.length) lines.push('  (empty)');
  v.layout.forEach((seg, i) => {
    const cl = seg.clip;
    if (cl.kind === 'color') {
      lines.push(`  ${i + 1}. ${cl.id}  ${sec(seg.start)}-${sec(seg.end)}  colour card ${cl.color}`);
      return;
    }
    const m = p.media.get(cl.mediaId);
    const ws = getWords(p, cl.mediaId);
    let range = '';
    if (ws?.length) {
      let a = -1;
      let b = -1;
      for (let k = 0; k < ws.length; k++) {
        const mid = (ws[k].t0 + ws[k].t1) / 2;
        if (mid >= cl.in && mid < cl.out) {
          if (a < 0) a = k;
          b = k;
        }
      }
      if (a >= 0) range = `  words ${wordId(m, a)}-${wordId(m, b)}`;
    }
    const extra = [
      cl.ramp?.length ? `speed ramp ${cl.ramp.map((k) => `${k.speed}x`).join('>')}` : cl.speed !== 1 ? `speed ${cl.speed}x` : '',
      cl.reverse ? 'reversed' : '',
      cl.fx?.stabilize ? `stabilised ${Math.round(cl.fx.stabilize * 100)}%` : '',
      cl.interpolate && (cl.ramp?.length ? cl.ramp.some((k) => k.speed < 1) : cl.speed < 1) ? `${cl.interpolate} slow motion` : '',
      cl.muted ? 'muted' : cl.volume !== 1 ? `volume ${gainToDb(cl.volume).toFixed(0)} dB` : '',
      cl.transition ? `arrives with ${cl.transition.type} ${cl.transition.duration}s` : '',
      cl.framing?.track ? 'follows face' : cl.framing?.fit === 'contain' ? 'fit: whole picture' : '',
    ].filter(Boolean);
    lines.push(`  ${i + 1}. ${cl.id}  ${sec(seg.start)}-${sec(seg.end)}  file ${tagOf(cl.mediaId)} source ${sec(cl.in)}-${sec(cl.out)}${range}${extra.length ? `  [${extra.join(', ')}]` : ''}`);
  });

  const timed = <T extends { id: ID; start: number }>(title: string, items: T[], fmt: (x: T) => string) => {
    if (!items.length) return;
    lines.push('', `${title}:`);
    for (const x of [...items].sort((a, b) => a.start - b.start)) lines.push(`  ${fmt(x)}`);
  };
  timed('GRAPHICS', doc.graphics, (g) => `${g.id}  ${sec(g.start)}-${sec(g.start + g.duration)}  ${graphicSummary(g)}  ${g.follow ? `follows the ${g.follow.target}${g.follow.trackId ? ` (track ${g.follow.trackId})` : ''}, ${g.follow.anchor}` : `at x=${g.x.toFixed(2)} y=${g.y.toFixed(2)}`}${g.name ? `  name "${g.name}"` : ''}`);
  timed('B-ROLL', doc.overlays, (o) => `${o.id}  ${sec(o.start)}-${sec(o.start + srcDuration(o))}  file ${tagOf(o.mediaId)} source ${sec(o.in)}-${sec(o.out)}${o.muted ? '' : '  (sound on)'}${o.transform ? '  picture-in-picture' : ''}${o.name ? `  name "${o.name}"` : ''}`);
  timed('PUNCH-INS', doc.zooms, (z) => `${z.id}  ${sec(z.start)}-${sec(z.start + z.duration)}  ${z.scale.toFixed(2)}x${z.toScale ? ` to ${z.toScale.toFixed(2)}x` : ''} ${z.ease}  focus x=${z.focusX.toFixed(2)} y=${z.focusY.toFixed(2)}`);
  timed('AUDIO', doc.audio, (a) => `${a.id}  ${sec(a.start)}-${sec(a.start + srcDuration(a))}  ${a.role} file ${tagOf(a.mediaId)} "${a.name ?? p.media.get(a.mediaId)?.name ?? ''}"  ${gainToDb(a.volume).toFixed(0)} dB${a.role === 'music' ? (a.duck === false ? ', no ducking' : ', ducks under speech') : ''}${a.muted ? ', muted' : ''}`);
  if (doc.takes.length) {
    lines.push('', 'TAKE GROUPS (repeated attempts at one line):');
    for (const t of doc.takes) {
      const m = p.media.get(t.mediaId);
      const ws = getWords(p, t.mediaId) ?? [];
      lines.push(`  ${t.id}  chosen: ${t.chosen === null ? 'none yet' : `take ${t.chosen + 1}`}`);
      t.takes.forEach((tk, i) => lines.push(`    take ${i + 1}  ${wordId(m, tk.from)}-${wordId(m, tk.to)}  "${ws.slice(tk.from, tk.to + 1).map((w) => w.text).join(' ').slice(0, 90)}"`));
    }
  }
  return lines.join('\n');
}

/** The transcript as it currently plays, sentence by sentence, with word ids and pauses. */
export function describeTranscript(p: Project, opts: { start?: number; end?: number; includeCut?: boolean } = {}): string {
  const v = view(p);
  const script = buildScript(v.doc, v.layout, (id) => getWords(p, id));
  if (!script.length) return 'There is no speech on the main track (or it is still being transcribed).';
  const lines: string[] = [];
  let shown = 0;
  let lastEnd = 0;
  for (const s of sentences(script)) {
    const first = s.words[0];
    const last = s.words[s.words.length - 1];
    const m = p.media.get(first.mediaId);
    const ids = first.index === last.index ? wordId(m, first.index) : `${wordId(m, first.index)}-${wordId(m, last.index)}`;
    const text = s.words.map((w) => w.text).join(' ');
    if (!s.kept) {
      if (opts.includeCut) lines.push(`  (cut) ${ids}: ${text}`);
      continue;
    }
    if (opts.end !== undefined && first.time > opts.end) break;
    if (opts.start !== undefined && last.end < opts.start) continue;
    // Long stretches without speech are footage too (an intro, a demonstration), so they are named, not hidden.
    if (shown === 0 && first.time >= 1 && opts.start === undefined) lines.push(`  [no speech 0.00-${sec(first.time)}]`);
    else if (s.gapBefore >= 2 && shown > 0) lines.push(`  [no speech ${sec(first.time - s.gapBefore)}-${sec(first.time)}]`);
    else if (s.gapBefore >= 0.6 && shown > 0) lines.push(`  [pause ${s.gapBefore.toFixed(1)}s]`);
    const who = first.speaker ? `S${first.speaker}: ` : '';
    lines.push(`[${sec(first.time)}-${sec(last.end)}] ${ids}: ${who}${text}`);
    shown++;
    lastEnd = last.end;
  }
  if (shown > 0 && opts.end === undefined && v.duration - lastEnd >= 1) lines.push(`  [no speech ${sec(lastEnd)}-${sec(v.duration)}]`);
  const head = `TRANSCRIPT as the video plays now (times in seconds on the timeline; ${sec(v.duration)}s total). Each line is a sentence with the ids of its first and last word; a word id is the file's letter plus the word's number.`;
  return [head, ...lines].join('\n');
}

/** Every word in a time window with its id, for precise cuts. */
export function describeWords(p: Project, start: number, end: number): string {
  const v = view(p);
  const lines: string[] = [];
  let line: string[] = [];
  let lineStart = 0;
  const flush = () => {
    if (line.length) lines.push(`[${sec(lineStart)}] ${line.join(' ')}`);
    line = [];
  };
  for (const w of v.words) {
    if (w.end < start || w.start > end) continue;
    if (!line.length) lineStart = w.start;
    line.push(`${wordId(p.media.get(w.mediaId), w.index)}|${w.text.trim()}`);
    if (line.length >= 10) flush();
  }
  flush();
  return lines.length ? `WORDS ${sec(start)}-${sec(end)}s (id|word; each line starts at the time shown):\n${lines.join('\n')}` : `No words between ${sec(start)}s and ${sec(end)}s.`;
}

export function rangesTotal(ranges: Range[]): number {
  return ranges.reduce((s, r) => s + Math.max(0, r.end - r.start), 0);
}
