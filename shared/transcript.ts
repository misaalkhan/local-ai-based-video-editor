// The transcript as an editing surface: every word of every file on the main
// track, in the order the video plays, with the words that have been cut still
// in place so they can be shown struck through and restored.

import type { ID, ProjectDoc, Range, Word } from './types.ts';
import type { MainSeg } from './timeline.ts';

export interface ScriptWord {
  /** `${mediaId}:${index}` */
  key: string;
  mediaId: ID;
  index: number;
  text: string;
  /** False when the word has been cut from the video. */
  kept: boolean;
  /** Timeline position; -1 for cut words. */
  time: number;
  end: number;
  /** Whisper was not confident about this word. */
  unsure: boolean;
  speaker?: number;
}

function firstAtOrAfter(words: Word[], t: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((words[mid].t0 + words[mid].t1) / 2 < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function buildScript(doc: ProjectDoc, layout: MainSeg[], getWords: (id: ID) => Word[] | undefined): ScriptWord[] {
  const cover: Record<ID, Range[]> = {};
  for (const seg of layout) {
    if (seg.clip.kind === 'media') (cover[seg.clip.mediaId] ??= []).push({ start: seg.clip.in, end: seg.clip.out });
  }
  const out: ScriptWord[] = [];
  const push = (mediaId: ID, i: number, w: Word, kept: boolean, time: number, end: number) => {
    const key = `${mediaId}:${i}`;
    out.push({ key, mediaId, index: i, text: doc.captions.edits[key] || w.text, kept, time, end, unsure: (w.p ?? 1) < 0.5, speaker: w.s });
  };
  for (const seg of layout) {
    const c = seg.clip;
    if (c.kind !== 'media') continue;
    const ws = getWords(c.mediaId);
    if (!ws?.length) continue;
    const spans = cover[c.mediaId];
    // Words cut from just before this clip: back to the previous surviving piece of the same file.
    let lower = 0;
    for (const r of spans) if (r.end <= c.in + 1e-6 && r.end > lower) lower = r.end;
    for (let i = firstAtOrAfter(ws, lower); i < ws.length; i++) {
      if ((ws[i].t0 + ws[i].t1) / 2 >= c.in) break;
      push(c.mediaId, i, ws[i], false, -1, -1);
    }
    for (let i = firstAtOrAfter(ws, c.in); i < ws.length; i++) {
      const w = ws[i];
      if ((w.t0 + w.t1) / 2 >= c.out) break;
      push(c.mediaId, i, w, true, seg.start + (Math.max(w.t0, c.in) - c.in) / c.speed, seg.start + (Math.min(w.t1, c.out) - c.in) / c.speed);
    }
    // Words cut from after the last piece of this file.
    if (!spans.some((r) => r.start >= c.out - 1e-6)) {
      for (let i = firstAtOrAfter(ws, c.out); i < ws.length; i++) push(c.mediaId, i, ws[i], false, -1, -1);
    }
  }
  return out;
}

const SENTENCE_END = /[.!?…]["')\]]?$/;

export interface Sentence {
  words: ScriptWord[];
  kept: boolean;
  /** Pause before this sentence on the timeline, when both sides are in the video. */
  gapBefore: number;
}

/** Group the script into sentences. A sentence is all kept or all cut. */
export function sentences(script: ScriptWord[], maxWords = 40): Sentence[] {
  const out: Sentence[] = [];
  let cur: Sentence | null = null;
  let lastKeptEnd = -1;
  for (const w of script) {
    const prev = cur?.words[cur.words.length - 1];
    const gap = w.kept && lastKeptEnd >= 0 ? w.time - lastKeptEnd : 0;
    const breakHere =
      !cur ||
      !prev ||
      prev.kept !== w.kept ||
      prev.mediaId !== w.mediaId ||
      w.index !== prev.index + 1 ||
      SENTENCE_END.test(prev.text) ||
      gap >= 0.7 ||
      cur.words.length >= maxWords;
    if (breakHere) {
      cur = { words: [], kept: w.kept, gapBefore: w.kept && lastKeptEnd >= 0 ? Math.max(0, gap) : 0 };
      out.push(cur);
    }
    cur!.words.push(w);
    if (w.kept) lastKeptEnd = w.end;
  }
  return out;
}
