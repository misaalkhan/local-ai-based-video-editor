// Word timings from the sound itself.
//
// Whisper says what was spoken but is vague about when. Here its text is
// lined up against the audio with a second, smaller network (wav2vec2) that
// labels every 20 ms of sound with a letter, a word break or "nothing". The
// best path of the known text through those labels gives each word a place
// (the method WhisperX uses). The labels come as narrow peaks inside each
// word, so the word edges are then moved out to where the sound starts and
// stops, using the loudness envelope.

import fs from 'node:fs';
import type { InferenceSession } from 'onnxruntime-node';
import { ALIGN_MODEL, ALIGN_VOCAB } from './config.ts';
import { ANALYSIS_RATE } from './analyze.ts';
import type { Range } from '../shared/types.ts';
import { ENVELOPE_HOP, autoThresholdDb } from '../shared/silence.ts';

/** One alignment model per language. Add a row to support another language. */
const MODELS: Record<string, { model: string; vocab: string; blank: string; separator: string }> = {
  en: { model: ALIGN_MODEL, vocab: ALIGN_VOCAB, blank: '<pad>', separator: '|' },
};

/** Seconds of audio per output frame of the model. */
export const FRAME = 0.02;

/** Stands for a stretch of text the model cannot spell: digits, symbols, other scripts. */
export const WILDCARD = -1;

export interface AlignVocab {
  /** Index of each letter in the model output. */
  letters: Map<string, number>;
  /** The "nothing here" label of CTC. */
  blank: number;
  /** The label the model puts between words. */
  separator: number;
  /** Whether the letters are upper case. */
  upper: boolean;
  size: number;
}

export function parseVocab(table: Record<string, number>, blank = '<pad>', separator = '|'): AlignVocab {
  const letters = new Map<string, number>();
  let size = 0;
  for (const [sym, id] of Object.entries(table)) {
    size = Math.max(size, id + 1);
    // Multi-character entries are markers such as <unk>, never text.
    if ([...sym].length === 1 && sym !== separator) letters.set(sym, id);
  }
  if (table[blank] === undefined || table[separator] === undefined) throw new Error('alignment vocabulary lacks the blank or separator symbol');
  const upper = [...letters.keys()].some((c) => c !== c.toLowerCase());
  return { letters, blank: table[blank], separator: table[separator], upper, size };
}

/** Punctuation that is read aloud ("50%", "R&D"), so it cannot be dropped from the edge of a word. */
const SPOKEN_PUNCT = new Set(['%', '&', '@', '#']);
const EDGE = /[\p{P}\p{Z}\p{C}]/u;

/**
 * Spell a word the way the model writes: its own letters only. Anything it has
 * no letter for becomes one WILDCARD per stretch. Quotes, commas and the like
 * around the word are silent and are dropped.
 */
export function spell(text: string, vocab: AlignVocab): number[] {
  const chars = [...text.normalize('NFC').replace(/[‘’ʼ′`´]/g, "'")];
  const silent = (c: string) => EDGE.test(c) && !SPOKEN_PUNCT.has(c);
  let a = 0;
  let b = chars.length;
  while (a < b && silent(chars[a])) a++;
  while (b > a && silent(chars[b - 1])) b--;
  const out: number[] = [];
  const recase = (s: string) => (vocab.upper ? s.toUpperCase() : s.toLowerCase());
  for (let i = a; i < b; i++) {
    // Try the character as written, then without its accent: "é" is "E" to an English model.
    let ids: number[] | null = null;
    for (const form of [recase(chars[i]), recase(chars[i].normalize('NFKD').replace(/\p{M}+/gu, ''))]) {
      const found = [...form].map((c) => vocab.letters.get(c));
      if (form && found.every((id) => id !== undefined)) {
        ids = found as number[];
        break;
      }
    }
    if (ids) out.push(...ids);
    else if (out[out.length - 1] !== WILDCARD) out.push(WILDCARD);
  }
  return out;
}

export interface AlignTarget {
  /** Model labels in speaking order: letters, WILDCARD, and the separator between words. */
  tokens: number[];
  /** Which word each token belongs to; -1 for separators. */
  wordOf: number[];
}

export function buildTarget(words: string[], vocab: AlignVocab): AlignTarget {
  const tokens: number[] = [];
  const wordOf: number[] = [];
  words.forEach((text, w) => {
    const ids = spell(text, vocab);
    if (!ids.length) return;
    if (tokens.length) {
      tokens.push(vocab.separator);
      wordOf.push(-1);
    }
    for (const id of ids) {
      tokens.push(id);
      wordOf.push(w);
    }
  });
  return { tokens, wordOf };
}

/** Turn raw network outputs into log-probabilities, in place. */
export function logSoftmax(logits: Float32Array, frames: number, size: number): Float32Array {
  for (let t = 0; t < frames; t++) {
    const o = t * size;
    let max = -Infinity;
    for (let k = 0; k < size; k++) if (logits[o + k] > max) max = logits[o + k];
    let sum = 0;
    for (let k = 0; k < size; k++) sum += Math.exp(logits[o + k] - max);
    const lse = max + Math.log(sum);
    for (let k = 0; k < size; k++) logits[o + k] -= lse;
  }
  return logits;
}

export interface CtcAlignment {
  /** First frame of each token. */
  start: Int32Array;
  /** One past the last frame of each token. */
  end: Int32Array;
  /** Mean log-probability of each token over its frames. */
  score: Float32Array;
}

/**
 * The most likely way to speak `tokens` across the frames (Viterbi over the
 * CTC lattice). Between two tokens there may be any number of blank frames, a
 * token may last several frames, and a WILDCARD takes whatever is there.
 * Returns null when the text cannot fit into the frames.
 */
export function ctcAlign(
  logp: Float32Array,
  frames: number,
  size: number,
  tokens: number[],
  blank: number,
  /** Per token, the first frame and one past the last frame it may occupy. Keeps the path near where whisper heard each word. */
  window?: { lo: Int32Array; hi: Int32Array },
): CtcAlignment | null {
  const m = tokens.length;
  const states = 2 * m + 1;
  if (!m || frames < 1) return null;
  // What a wildcard scores: the best label of the frame, whichever it is.
  const wild = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    let max = -Infinity;
    for (let k = 0; k < size; k++) if (logp[t * size + k] > max) max = logp[t * size + k];
    wild[t] = max;
  }
  const emit = (t: number, s: number) => {
    if (!(s & 1)) return logp[t * size + blank];
    const j = s >> 1;
    if (window && (t < window.lo[j] || t >= window.hi[j])) return -Infinity;
    const tok = tokens[j];
    return tok === WILDCARD ? wild[t] : logp[t * size + tok];
  };
  // A blank between two tokens may be skipped, except between the same letter
  // twice: without a blank CTC reads "LL" as one "L".
  const skip = new Uint8Array(m);
  for (let j = 1; j < m; j++) skip[j] = tokens[j] !== tokens[j - 1] || tokens[j] === WILDCARD ? 1 : 0;

  let prev = new Float64Array(states).fill(-Infinity);
  let cur = new Float64Array(states).fill(-Infinity);
  const back = new Uint8Array(frames * states);
  prev[0] = emit(0, 0);
  prev[1] = emit(0, 1);
  for (let t = 1; t < frames; t++) {
    // Only states that can still reach the end, and that could have been reached by now.
    const lo = Math.max(0, states - 2 * (frames - t));
    const hi = Math.min(states - 1, 2 * t + 1);
    cur.fill(-Infinity);
    for (let s = lo; s <= hi; s++) {
      let best = prev[s];
      let from = 0;
      if (s >= 1 && prev[s - 1] > best) {
        best = prev[s - 1];
        from = 1;
      }
      if (s & 1 && s >= 3 && skip[s >> 1] && prev[s - 2] > best) {
        best = prev[s - 2];
        from = 2;
      }
      if (best === -Infinity) continue;
      cur[s] = best + emit(t, s);
      back[t * states + s] = from;
    }
    [prev, cur] = [cur, prev];
  }
  let s = prev[states - 1] >= prev[states - 2] ? states - 1 : states - 2;
  if (prev[s] === -Infinity) return null;

  const start = new Int32Array(m).fill(-1);
  const end = new Int32Array(m).fill(-1);
  const score = new Float32Array(m);
  for (let t = frames - 1; t >= 0; t--) {
    if (s & 1) {
      const j = s >> 1;
      if (end[j] < 0) end[j] = t + 1;
      start[j] = t;
      score[j] += emit(t, s);
    }
    s -= back[t * states + s];
  }
  for (let j = 0; j < m; j++) {
    if (start[j] < 0) return null;
    score[j] /= end[j] - start[j];
  }
  return { start, end, score };
}

// ---------------------------------------------------------------------------
// The model

interface Aligner {
  session: InferenceSession;
  vocab: AlignVocab;
  tensor: (data: Float32Array) => InferenceSession.FeedsType;
}

const loading = new Map<string, Promise<Aligner | null>>();

export function alignerInstalled(language: string): boolean {
  const m = MODELS[language];
  return !!m && fs.existsSync(m.model) && fs.existsSync(m.vocab);
}

/** Load the model for a language once. Null when it, or the runtime, is not there. */
function aligner(language: string): Promise<Aligner | null> {
  let p = loading.get(language);
  if (!p) {
    p = (async () => {
      const m = MODELS[language];
      if (!m || !fs.existsSync(m.model) || !fs.existsSync(m.vocab)) return null;
      try {
        const ort = await import('onnxruntime-node');
        const vocab = parseVocab(JSON.parse(fs.readFileSync(m.vocab, 'utf8')) as Record<string, number>, m.blank, m.separator);
        const session = await ort.InferenceSession.create(m.model);
        const input = session.inputNames[0];
        return { session, vocab, tensor: (data) => ({ [input]: new ort.Tensor('float32', data, [1, data.length]) }) };
      } catch (err) {
        console.error('[align] could not load the alignment model:', (err as Error).message);
        return null;
      }
    })();
    loading.set(language, p);
  }
  return p;
}

export interface Emissions {
  /** Log-probability of every label in every frame, frame after frame. */
  logp: Float32Array;
  frames: number;
  size: number;
}

/** Run the model over 16-bit mono samples at the analysis rate. */
async function emissions(a: Aligner, pcm: Buffer): Promise<Emissions | null> {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  // Less than the model's receptive field gives no frames at all.
  if (samples.length < ANALYSIS_RATE / 10) return null;
  // The model was trained on audio scaled to zero mean and unit variance.
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length;
  let variance = 0;
  for (let i = 0; i < samples.length; i++) variance += (samples[i] - mean) ** 2;
  const sd = Math.sqrt(variance / samples.length) || 1;
  const x = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) x[i] = (samples[i] - mean) / sd;
  const out = await a.session.run(a.tensor(x));
  const logits = out[a.session.outputNames[0]];
  const [, frames, size] = logits.dims as number[];
  return { logp: logSoftmax(logits.data as Float32Array, frames, size), frames, size };
}

// ---------------------------------------------------------------------------
// From frames to word times

/** A word as whisper hands it over: its text, when it ends, and which chunk of audio it came from. */
export interface SpokenWord {
  text: string;
  end: number;
  chunk?: number;
}

/**
 * Fit the edges of aligned words to the sound. The model marks a narrow peak
 * inside each word, so a word is grown outwards until the audio goes quiet,
 * and two words spoken without a pause meet at the quietest moment between
 * their peaks.
 */
export function fitEdges(spans: Range[], env: Uint8Array, lo: number, hi: number, thresholdDb = autoThresholdDb(env), letters?: number[]): Range[] {
  const quietLevel = thresholdDb + 100;
  // The least a word can last: fast speech still spends about 35 ms on a letter.
  const least = (i: number) => Math.max(0.06, 0.035 * (letters?.[i] ?? 3));
  const level = (t: number) => env[Math.min(env.length - 1, Math.max(0, Math.round(t / ENVELOPE_HOP)))] ?? 0;
  const quiet = (t: number) => level(t) < quietLevel;
  const reach = 0.35;
  const out = spans.map((r) => ({ ...r }));
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    // Start: back to where the sound begins, but never into the word before.
    const floor = i > 0 ? out[i - 1].end : lo;
    let t = w.start;
    while (t - ENVELOPE_HOP >= floor && w.start - t < reach && !quiet(t - ENVELOPE_HOP)) t -= ENVELOPE_HOP;
    w.start = t;
    // End: forward to where it stops, or to the next word's peak at most.
    const ceil = i + 1 < out.length ? out[i + 1].start : hi;
    t = w.end;
    while (t + ENVELOPE_HOP <= ceil && t - w.end < reach && !quiet(t)) t += ENVELOPE_HOP;
    w.end = t;
    if (i + 1 < out.length) {
      const next = out[i + 1];
      if (w.end >= next.start - ENVELOPE_HOP / 2) {
        // No pause between the two: part them at the quietest moment between their
        // peaks, but leave each of them room to have been said at all.
        let best = w.end;
        let bestLevel = Infinity;
        for (let x = spans[i].end; x <= next.start + 1e-9; x += ENVELOPE_HOP) {
          const l = level(x);
          if (l < bestLevel) {
            bestLevel = l;
            best = x;
          }
        }
        best = Math.max(best, Math.min(w.start + least(i), spans[i + 1].start));
        best = Math.min(best, Math.max(spans[i + 1].end - least(i + 1), spans[i].end));
        w.end = best;
        next.start = best;
      }
    }
  }
  // A word still shorter than it could possibly be spoken takes free time next to it.
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    const need = least(i) - (w.end - w.start);
    if (need <= 0) continue;
    const after = Math.max(0, (i + 1 < out.length ? out[i + 1].start : hi) - w.end);
    const grow = Math.min(need, after);
    w.end += grow;
    const before = Math.max(0, w.start - (i > 0 ? out[i - 1].end : lo));
    w.start -= Math.min(need - grow, before);
  }
  for (const w of out) {
    w.start = Math.round(w.start * 1000) / 1000;
    w.end = Math.round(Math.max(w.end, w.start + 0.02) * 1000) / 1000;
  }
  return out;
}

/** Tokens aligned so badly that the text is probably not what was said, or not in this chunk. */
const POOR_SCORE = -4;
/** How far from whisper's end time a word may be placed: earlier (it is an end time) and later. */
const BEFORE = 2.5;
const AFTER = 1.0;

/** Frames where no voice was heard get the blank label, so no word can be placed on music or noise. */
export function maskSilence(em: Emissions, speech: Range[], chunkStart: number, margin = 0.3): void {
  for (let t = 0; t < em.frames; t++) {
    const at = chunkStart + (t + 0.5) * FRAME;
    if (speech.some((r) => at >= r.start - margin && at <= r.end + margin)) continue;
    const o = t * em.size;
    for (let k = 0; k < em.size; k++) em.logp[o + k] = -20;
    em.logp[o + 0] = 0;
  }
}

/**
 * Place words on the audio with the alignment model. Returns null when there
 * is no model for the language. Otherwise one entry per word: its span, or
 * null when its chunk could not be aligned and the caller must place it some
 * other way.
 */
export async function placeWords(language: string, words: SpokenWord[], pcm: Buffer, chunks: Range[], env: Uint8Array, speech?: Range[] | null): Promise<(Range | null)[] | null> {
  const a = await aligner(language);
  if (!a) return null;
  const out: (Range | null)[] = words.map(() => null);
  const threshold = autoThresholdDb(env);
  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];
    const idx = words.map((w, i) => i).filter((i) => words[i].chunk === ci);
    if (!idx.length) continue;
    try {
      const from = Math.floor(c.start * ANALYSIS_RATE) * 2;
      const to = Math.min(pcm.length, Math.floor(c.end * ANALYSIS_RATE) * 2);
      const em = await emissions(a, pcm.subarray(from, to));
      if (!em) continue;
      if (speech) maskSilence(em, speech, c.start);
      const target = buildTarget(idx.map((i) => words[i].text), a.vocab);
      if (!target.tokens.length) continue;
      // Each word may only land near where whisper heard it; a separator may sit anywhere between its neighbours.
      const frameOf = (t: number) => Math.round((t - c.start) / FRAME);
      const lo = new Int32Array(target.tokens.length);
      const hi = new Int32Array(target.tokens.length);
      target.wordOf.forEach((w, j) => {
        const prevWord = w >= 0 ? w : target.wordOf[j - 1];
        const nextWord = w >= 0 ? w : target.wordOf[j + 1];
        lo[j] = Math.max(0, frameOf(words[idx[prevWord]].end - BEFORE));
        hi[j] = Math.min(em.frames, frameOf(words[idx[nextWord]].end + AFTER));
      });
      const al = ctcAlign(em.logp, em.frames, em.size, target.tokens, a.vocab.blank, { lo, hi }) ?? ctcAlign(em.logp, em.frames, em.size, target.tokens, a.vocab.blank);
      if (!al) continue;
      const scores = Array.from(al.score).filter((_, j) => target.tokens[j] !== WILDCARD && target.wordOf[j] >= 0).sort((x, y) => x - y);
      if (scores.length && scores[scores.length >> 1] < POOR_SCORE) continue;
      // Each word spans from its first letter's first frame to its last letter's last frame.
      const spans: Range[] = idx.map(() => ({ start: -1, end: -1 }));
      target.wordOf.forEach((w, j) => {
        if (w < 0) return;
        const s = c.start + al.start[j] * FRAME;
        const e = c.start + al.end[j] * FRAME;
        if (spans[w].start < 0 || s < spans[w].start) spans[w].start = s;
        if (e > spans[w].end) spans[w].end = e;
      });
      // A word the model could not spell at all sits between its neighbours.
      for (let k = 0; k < spans.length; k++) {
        if (spans[k].start >= 0) continue;
        const prev = spans[k - 1]?.end ?? c.start;
        const next = spans.slice(k + 1).find((x) => x.start >= 0)?.start ?? c.end;
        spans[k] = { start: prev, end: Math.max(prev, Math.min(next, prev + 0.2)) };
      }
      const fitted = fitEdges(spans, env, c.start, c.end, threshold, idx.map((i) => Math.max(1, spell(words[i].text, a.vocab).length)));
      idx.forEach((i, k) => {
        out[i] = fitted[k];
      });
    } catch (err) {
      console.error(`[align] chunk ${ci} failed:`, (err as Error).message);
    }
  }
  return out;
}

export { aligner as loadAligner, emissions as computeEmissions };
