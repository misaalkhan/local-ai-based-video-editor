// Captions are never stored as timed text. They are derived from each media
// file's transcript and the current cut, so they follow every later edit.

import type { CaptionSettings, ID, ProjectDoc, Range, SourceClip, Word } from './types.ts';
import type { MainSeg } from './timeline.ts';
import { localAt } from './timeline.ts';

export type GetWords = (mediaId: ID) => Word[] | undefined;

/** A transcript word placed on the timeline. */
export interface TLWord {
  /** `${mediaId}:${index}`, stable across edits. */
  key: string;
  mediaId: ID;
  index: number;
  clipId: ID;
  text: string;
  start: number;
  end: number;
}

export interface CaptionCard {
  id: string;
  start: number;
  end: number;
  words: TLWord[];
}

function firstWordAfter(words: Word[], t: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((words[mid].t0 + words[mid].t1) / 2 < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Every spoken word that survives the current cut, in timeline order. */
export function timelineWords(doc: ProjectDoc, layout: MainSeg[], getWords: GetWords): TLWord[] {
  const out: TLWord[] = [];
  const add = (clip: SourceClip, clipStart: number) => {
    if (clip.muted) return;
    const words = getWords(clip.mediaId);
    if (!words || !words.length) return;
    for (let i = firstWordAfter(words, clip.in); i < words.length; i++) {
      const w = words[i];
      if ((w.t0 + w.t1) / 2 >= clip.out) break;
      const key = `${clip.mediaId}:${i}`;
      const edit = doc.captions.edits[key];
      // On a reversed clip the words run backwards; keep each span the right way round.
      const [ws, we] = [localAt(clip, Math.max(w.t0, clip.in)), localAt(clip, Math.min(w.t1, clip.out))].sort((a, b) => a - b);
      const start = clipStart + ws;
      const end = clipStart + we;
      out.push({
        key,
        mediaId: clip.mediaId,
        index: i,
        clipId: clip.id,
        text: edit ?? w.text,
        start,
        end: Math.max(end, start + 0.02),
      });
    }
  };
  for (const seg of layout) if (seg.clip.kind === 'media') add(seg.clip, seg.start);
  for (const a of doc.audio) if (a.role === 'voice') add(a, a.start);
  out.sort((a, b) => a.start - b.start);
  return out;
}

const SENTENCE_END = /[.!?…]["')\]]?$/;

/** Group words into the short cards that are shown on screen one at a time. */
export function buildCards(words: TLWord[], s: CaptionSettings): CaptionCard[] {
  const maxWords = Math.max(1, Math.round(s.maxWords));
  const maxChars = Math.max(12, maxWords * 9);
  const cards: CaptionCard[] = [];
  let cur: TLWord[] = [];
  let chars = 0;
  const flush = () => {
    if (!cur.length) return;
    cards.push({ id: cur[0].key, start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
    chars = 0;
  };
  for (const w of words) {
    if (!w.text.trim()) continue;
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = w.start - prev.end;
      if (
        cur.length >= maxWords ||
        chars + w.text.length + 1 > maxChars ||
        gap > 0.6 ||
        (SENTENCE_END.test(prev.text) && cur.length >= Math.min(2, maxWords))
      ) {
        flush();
      }
    }
    cur.push(w);
    chars += w.text.length + 1;
  }
  flush();
  // Hold each card until the next one arrives so the caption does not flicker
  // off between words, but let it clear during real pauses.
  for (let i = 0; i < cards.length; i++) {
    const next = cards[i + 1];
    const c = cards[i];
    if (next && next.start - c.end < 0.5) c.end = next.start;
    else c.end = c.end + 0.25;
  }
  return cards;
}

export function cardAt(cards: CaptionCard[], t: number): CaptionCard | undefined {
  let lo = 0;
  let hi = cards.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cards[mid];
    if (t < c.start) hi = mid - 1;
    else if (t >= c.end) lo = mid + 1;
    else return c;
  }
  return undefined;
}

/** Text of a caption word as it is drawn. */
export function displayWord(text: string, s: CaptionSettings): string {
  let out = text.trim();
  if (!s.punctuation) out = out.replace(/[.,;:!?…"“”')\]]+$/g, '').replace(/^["“”'(\[]+/g, '');
  if (s.uppercase) out = out.toUpperCase();
  return out;
}

/** Stretches of the timeline where someone is talking. */
export function speechSpans(words: TLWord[], joinGap = 0.6): Range[] {
  const out: Range[] = [];
  for (const w of words) {
    const last = out[out.length - 1];
    if (last && w.start - last.end <= joinGap) last.end = Math.max(last.end, w.end);
    else out.push({ start: w.start, end: w.end });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plain-text views of a transcript (for the chat agent and the transcript tab)

export interface TranscriptLine {
  start: number;
  end: number;
  text: string;
  words: { text: string; start: number; end: number; key?: string }[];
  /** Silence before this line, when it is long enough to matter. */
  pauseBefore?: number;
}

export function toLines(
  words: { text: string; start: number; end: number; key?: string }[],
  maxChars = 90,
  pause = 0.7,
): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let cur: TranscriptLine | null = null;
  for (const w of words) {
    const text = w.text.trim();
    if (!text) continue;
    const gap = cur ? w.start - cur.end : 0;
    const prevText = cur ? cur.words[cur.words.length - 1].text.trim() : '';
    const breakHere =
      !cur ||
      gap >= pause ||
      cur.text.length + text.length + 1 > maxChars ||
      (SENTENCE_END.test(prevText) && cur.text.length > 24);
    if (breakHere) {
      const line: TranscriptLine = { start: w.start, end: w.end, text, words: [w] };
      if (cur && gap >= pause) line.pauseBefore = gap;
      lines.push(line);
      cur = line;
    } else if (cur) {
      cur.text += ' ' + text;
      cur.end = w.end;
      cur.words.push(w);
    }
  }
  return lines;
}

export function normalizeWord(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, '')
    .trim();
}
