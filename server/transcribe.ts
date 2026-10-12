// Speech-to-text with word timings, using whisper.cpp.
//
// Three things are done here on top of plain whisper, all found necessary on
// real footage:
//
//  * The audio is cut into pieces at pauses before it is transcribed. Whisper
//    works in 30-second windows; when a window ends mid-sentence the words at
//    the seam get wrong times or are repeated.
//  * Word times come from whisper's DTW alignment, which gives a reliable end
//    time per token. Its ordinary token timestamps drift by seconds across
//    pauses.
//  * Words are then fitted onto the stretches of the audio that actually
//    contain sound, so no word starts in the middle of a pause.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VAD_MODEL, WHISPER, WHISPER_MODEL, WHISPER_VAD } from './config.ts';
import { run } from './proc.ts';
import { ANALYSIS_RATE, writeWav } from './analyze.ts';
import type { Range, Transcript, Word } from '../shared/types.ts';
import { clamp } from '../shared/timeline.ts';
import { detectSilences } from '../shared/silence.ts';
import { placeWords } from './align.ts';
import { romanizeDevanagari } from '../shared/romanize.ts';

/** Nudges whisper toward a verbatim transcript: punctuation, capitals, and the "um"s it would otherwise skip. */
const ENGLISH_PROMPT = 'Hello, everyone. Um, this is a verbatim transcript, uh, with punctuation and capital letters.';
/**
 * Hindi and Hinglish run in whisper's Hindi mode: English mode translates the
 * Hindi into English or garbles it, while Hindi mode hears it and still writes
 * the English parts in English. Without a prompt, though, Hindi mode babbles
 * on plain English speech; a Hinglish prompt in Latin letters stops that and
 * keeps mixed passages in Latin letters, while plain Hindi still comes out in
 * Devanagari (romanised later when the profile wants Latin captions).
 */
const HINGLISH_PROMPT = 'Haan toh guys, aaj hum yeh video bana rahe hain, matlab Hinglish mein baat kar rahe hain, thoda English thoda Hindi.';

/**
 * How Hindi speech is written, from the profile's languages: Latin letters
 * (Hinglish, when English is listed first) or Devanagari (Hindi first).
 * Null when Hindi is not among the languages.
 */
export function hindiScript(languages: string[] | undefined): 'latin' | 'devanagari' | null {
  const list = (languages ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean);
  if (!list.includes('hi')) return null;
  return list[0] === 'hi' ? 'devanagari' : 'latin';
}

/** Languages written without spaces, where every token is treated as its own word. */
const UNSPACED = new Set(['zh', 'ja', 'th', 'lo', 'my', 'km', 'yue']);

/** Longest piece handed to whisper; its window is 30 s. */
const MAX_CHUNK = 28;
const MIN_CHUNK = 12;

export function transcriptionAvailable(): boolean {
  return !!WHISPER && fs.existsSync(WHISPER_MODEL);
}

/** The DTW preset has to match the model architecture. */
function dtwPreset(modelPath: string): string | null {
  const name = path.basename(modelPath).toLowerCase();
  const m = /ggml-(tiny|base|small|medium|large-v1|large-v2|large-v3-turbo|large-v3)(\.en)?/.exec(name);
  if (!m) return null;
  return m[1].replace(/-/g, '.') + (m[2] ?? '');
}

interface RawToken {
  text: string;
  offsets: { from: number; to: number };
  p?: number;
  t_dtw?: number;
}

interface RawSegment {
  text?: string;
  offsets?: { from: number; to: number };
  tokens?: RawToken[];
}

export interface RawWord {
  text: string;
  end: number;
  p: number;
  /** Index of the piece of audio (see planChunks) the word was heard in. */
  chunk?: number;
}

const PUNCT_ONLY = /^[\s\p{P}\p{S}]+$/u;
const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * whisper.cpp writes token text as raw bytes, and a multi-byte character can be
 * split across two tokens. Reading the file as latin1 keeps every byte intact
 * so the pieces can be joined before decoding as UTF-8.
 */
function fromBytes(latin1: string): string {
  return Buffer.from(latin1, 'latin1').toString('utf8');
}

export function tokensToWords(tokens: RawToken[], perToken: boolean): RawWord[] {
  const words: RawWord[] = [];
  let cur: { bytes: string; end: number; p: number; n: number } | null = null;
  const flush = () => {
    if (!cur) return;
    // Whisper marks a change of speaker with a dash in some languages ("-Aha"); it is not part of the word.
    const text = fromBytes(cur.bytes).trim().replace(/^[-\u2013\u2014]+(?=\p{L})/u, '');
    if (text && !PUNCT_ONLY.test(text)) words.push({ text, end: cur.end, p: cur.n ? cur.p / cur.n : 0 });
    else if (text && words.length) words[words.length - 1].text += text;
    cur = null;
  };
  for (const tok of tokens) {
    if (tok.text.startsWith('[_')) continue;
    const punct = PUNCT_ONLY.test(fromBytes(tok.text));
    // A leading space starts a new word, even for an opening quote or bracket,
    // which then belongs to the word that follows it rather than the one before.
    if (tok.text.startsWith(' ') || perToken) flush();
    if (!cur) cur = { bytes: '', end: 0, p: 0, n: 0 };
    cur.bytes += tok.text;
    if (!punct) {
      const dtw = typeof tok.t_dtw === 'number' && tok.t_dtw >= 0 ? tok.t_dtw / 100 : tok.offsets.to / 1000;
      cur.end = Math.max(cur.end, dtw);
      cur.p += tok.p ?? 0;
      cur.n++;
    }
  }
  flush();
  return words;
}

/**
 * Whisper sometimes says a whole sentence twice at the end of the audio,
 * squeezed into a second or so. A repeat that has no room to have been spoken
 * is dropped; a genuine second take, which takes as long as the first, is kept.
 */
export function dropRepeatedSegments(segments: RawSegment[]): RawSegment[] {
  const out: RawSegment[] = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    const text = plain(fromBytes(seg.text ?? ''));
    const count = text ? text.split(' ').length : 0;
    const dur = seg.offsets ? (seg.offsets.to - seg.offsets.from) / 1000 : Infinity;
    if (prev && count >= 4 && text === plain(fromBytes(prev.text ?? '')) && dur / count < 0.12) continue;
    out.push(seg);
  }
  return out;
}

/**
 * Several words given the same end time means the alignment ran out of room
 * (whisper closed the segment too early). If a voice was heard there and there
 * is time for the words before the next one, they are spread across it;
 * otherwise they were never said.
 */
export function fixBursts(words: RawWord[], audioEnd: number, heard: (t: number) => boolean = () => true): RawWord[] {
  const out: RawWord[] = [];
  let i = 0;
  while (i < words.length) {
    let j = i;
    while (j + 1 < words.length && words[j + 1].end - words[j].end < 0.07) j++;
    const len = j - i + 1;
    if (len < 3) {
      out.push(...words.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    const prevEnd = out.length ? out[out.length - 1].end : Math.max(0, words[i].end - 0.3 * len);
    const next = words[j + 1];
    const span = next ? next.end - prevEnd : Math.min(audioEnd - prevEnd, 0.35 * len);
    const count = next ? len + 1 : len;
    if (span / count >= 0.12 && heard(words[i].end)) {
      for (let k = 0; k < len; k++) out.push({ ...words[i + k], end: prevEnd + (span * (k + 1)) / count });
    }
    i = j + 1;
  }
  return out;
}

/**
 * Where a voice-activity model hears speech, in seconds. Returns null when the
 * model is not installed, in which case nothing is filtered.
 */
export async function detectSpeech(wav: string, signal?: AbortSignal): Promise<Range[] | null> {
  if (!WHISPER_VAD || !fs.existsSync(VAD_MODEL)) return null;
  try {
    const r = await run(WHISPER_VAD, ['-vm', VAD_MODEL, '-vt', '0.3', '-f', wav, '-np'], { signal });
    const out: Range[] = [];
    for (const m of (r.stdout + r.stderr).matchAll(/Speech segment \d+: start = ([\d.]+), end = ([\d.]+)/g)) {
      out.push({ start: Number(m[1]) / 100, end: Number(m[2]) / 100 });
    }
    return out;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

/** Phrases whisper is known to make up over music, noise and silence. */
const STOCK_PHRASES = new Set([
  'thank you',
  'thank you very much',
  'thanks for watching',
  'thank you for watching',
  'thank you so much for watching',
  'please subscribe',
  'bye',
  'bye bye',
  'you',
  'okay',
  'so',
  'music',
]);

/**
 * Drop words whisper invented over music, noise or silence.
 *
 * The voice detector alone is not trusted for this: it misses real speech
 * under music or fan noise, and losing real words is worse than keeping a
 * stray one. A word is only dropped when the evidence agrees.
 */
export function dropInvented(raw: RawWord[], speech: Range[] | null): RawWord[] {
  let words = raw;
  // Unsure words where no voice was heard.
  if (speech) {
    const margin = 0.5;
    const heard = (w: RawWord) => speech.some((s) => w.end >= s.start - margin && w.end <= s.end + margin);
    const total = speech.reduce((sum, r) => sum + (r.end - r.start), 0);
    // With no voice anywhere in the file, only confident text survives.
    const floor = total < 1 ? 0.8 : 0.45;
    words = words.filter((w) => heard(w) || w.p >= floor);
  }
  // A lone stock phrase: said without confidence, or where no voice was heard at all.
  const out: RawWord[] = [];
  let i = 0;
  while (i < words.length) {
    let j = i;
    while (j + 1 < words.length && words[j + 1].end - words[j].end < 3 && words[j + 1].chunk === words[j].chunk) j++;
    const run = words.slice(i, j + 1);
    const unheard = !!speech && !speech.some((s) => run[0].end >= s.start - 0.5 && run[run.length - 1].end <= s.end + 0.5);
    let invented = run.length <= 6 && STOCK_PHRASES.has(plain(run.map((w) => w.text).join(' '))) && (run[0].p < 0.6 || unheard);
    // A word or two on their own where no voice was heard at all: a laugh or a
    // cough read as a word, which would be an odd caption.
    if (run.length <= 3 && unheard) invented = true;
    // A confident sentence where there was hardly any voice: more words than
    // the voice heard could hold, and most of them outside it. Noise and
    // laughter bring these out of whisper with full confidence.
    if (!invented && speech && run.length >= 4) {
      const from = run[0].end - 0.5;
      const to = run[run.length - 1].end;
      const heardSeconds = speech.reduce((s, r) => s + Math.max(0, Math.min(to, r.end) - Math.max(from, r.start)), 0);
      const heardWords = run.filter((w) => speech.some((s) => w.end >= s.start - 0.5 && w.end <= s.end + 0.5)).length;
      invented = run.length / Math.max(0.1, heardSeconds) > 7 && heardWords < run.length / 2;
    }
    if (!invented) out.push(...run);
    i = j + 1;
  }
  return out;
}

/**
 * Whisper stuck in a loop: the same short phrase three or more times in a row
 * ("I love it, and I love it, and I love it"). People do repeat themselves, so
 * a loop is only dropped when it started without confidence or where no voice
 * was heard for most of it.
 */
export function dropLoops(words: RawWord[], speech: Range[] | null): RawWord[] {
  const texts = words.map((w) => plain(w.text));
  const heard = (w: RawWord) => !speech || speech.some((s) => w.end >= s.start - 0.5 && w.end <= s.end + 0.5);
  const out: RawWord[] = [];
  let i = 0;
  while (i < words.length) {
    let end = -1;
    for (let n = 1; n <= 6 && end < 0; n++) {
      const same = (at: number) => at + n <= words.length && texts.slice(at, at + n).every((t, k) => t && t === texts[i + k]);
      let reps = 1;
      while (same(i + reps * n)) reps++;
      if (reps < 3) continue;
      let stop = i + reps * n;
      // A trailing part of the phrase belongs to the loop too.
      while (stop < words.length && texts[stop] === texts[i + ((stop - i) % n)]) stop++;
      const run = words.slice(i, stop);
      const start = run.slice(0, 2 * n);
      const unsure = start.reduce((s, w) => s + w.p, 0) / start.length < 0.6;
      const unheard = run.filter(heard).length < run.length / 2;
      // One word over and over with nothing else in its chunk is laughter or noise, not a chant.
      const alone = n === 1 && reps >= 4 && words.filter((w) => w.chunk === run[0].chunk).length === run.length;
      if (unsure || unheard || alone) end = stop;
    }
    if (end > 0) {
      i = end;
      continue;
    }
    out.push(words[i]);
    i++;
  }
  return out;
}

/** Word spans from whisper's end times alone; see placeByEnds. */
export function alignWords(raw: RawWord[], silences: Range[], duration: number): Word[] {
  const out: Word[] = [];
  placeByEnds(raw, silences, duration).forEach((r, i) => {
    if (r) out.push({ t0: r.start, t1: r.end, text: raw[i].text, p: Math.round(raw[i].p * 100) / 100 });
  });
  return out;
}

/**
 * Turn word end times into word spans. Words are laid end to end inside each
 * "island" of sound, so a word never starts in the middle of a pause. One
 * entry per word; null for text that sits far from any sound (whisper
 * inventing words over silence).
 */
export function placeByEnds(raw: RawWord[], silences: Range[], duration: number): (Range | null)[] {
  const islands: Range[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor + 0.02) islands.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (duration > cursor + 0.02) islands.push({ start: cursor, end: duration });
  if (!islands.length) islands.push({ start: 0, end: Math.max(duration, 0.1) });

  const groups: { w: RawWord; i: number }[][] = islands.map(() => []);
  const out: (Range | null)[] = raw.map(() => null);
  let from = 0;
  raw.forEach((w, index) => {
    let best = -1;
    let bestDist = Infinity;
    for (let i = from; i < islands.length; i++) {
      const isl = islands[i];
      // An end time just past an island still belongs to it; one before an
      // island is a weaker match.
      const d = w.end < isl.start ? isl.start - w.end : w.end > isl.end ? (w.end - isl.end) * 0.5 : 0;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
      if (isl.start > w.end + 2) break;
    }
    // Text far away from any sound is whisper inventing words over silence.
    if (best < 0 || bestDist > 0.75) return;
    groups[best].push({ w, i: index });
    from = best;
  });

  const maxLen = (text: string) => Math.max(0.6, 0.4 + 0.12 * text.length);
  islands.forEach((isl, i) => {
    const g = groups[i];
    let t = isl.start;
    g.forEach(({ w, i: index }, j) => {
      const remaining = g.length - 1 - j;
      const last = remaining === 0;
      const end = last ? isl.end : clamp(w.end, t + 0.04, Math.max(t + 0.04, isl.end - 0.04 * remaining));
      let t0 = t;
      let t1 = end;
      // Breaths and room noise at the edge of an island should not stretch a word.
      if (j === 0 && t1 - t0 > maxLen(w.text)) t0 = t1 - maxLen(w.text);
      if (last && t1 - t0 > maxLen(w.text)) t1 = t0 + maxLen(w.text);
      out[index] = { start: Math.round(t0 * 1000) / 1000, end: Math.round(t1 * 1000) / 1000 };
      t = end;
    });
  });
  return out;
}

/** Split the audio at pauses into pieces whisper can take in one window. */
export function planChunks(silences: Range[], duration: number): Range[] {
  const chunks: Range[] = [];
  let start = 0;
  while (duration - start > MAX_CHUNK) {
    // The last pause that still keeps the piece within one window.
    let cut = -1;
    for (const s of silences) {
      const mid = (s.start + s.end) / 2;
      if (mid <= start + MIN_CHUNK) continue;
      if (mid > start + MAX_CHUNK) break;
      cut = mid;
    }
    if (cut < 0) cut = start + MAX_CHUNK;
    chunks.push({ start, end: cut });
    start = cut;
  }
  if (duration - start > 0.05) chunks.push({ start, end: duration });
  return chunks;
}

async function detectLanguage(wav: string, signal?: AbortSignal): Promise<string> {
  try {
    const r = await run(WHISPER!, ['-m', WHISPER_MODEL, '-f', wav, '-dl', '-l', 'auto', '-t', '4'], { signal });
    const m = /auto-detected language:\s*([a-z]{2,3})/.exec(r.stderr + r.stdout);
    return m ? m[1] : 'en';
  } catch (err) {
    if (signal?.aborted) throw err;
    return 'en';
  }
}

export interface TranscribeOptions {
  /** 16 kHz mono 16-bit samples of the whole file. */
  pcm: Buffer;
  /** Loudness envelope of the same audio, see shared/silence.ts. */
  envelope: Uint8Array;
  duration: number;
  /** An empty folder for temporary files. */
  workDir: string;
  /** ISO code to skip auto-detection. */
  language?: string;
  /**
   * Languages the speaker uses. Detection is trusted only when it lands on one
   * of them; otherwise the first is used. Short clips are often mis-detected,
   * and a wrong language yields gibberish.
   */
  languages?: string[];
  /** Replaces the built-in prompt for the language; an empty string means none. */
  prompt?: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface TranscribeResult extends Transcript {
  /** Seconds in which a voice was detected, when the detector is installed. */
  speechSeconds?: number;
  /** Whether the word times come from the alignment model rather than from whisper alone. */
  aligned?: boolean;
}

export interface Recognition {
  language: string;
  /** What was said, with whisper's end time for each word. */
  raw: RawWord[];
  /** The pieces the audio was transcribed in; `RawWord.chunk` points into this. */
  chunks: Range[];
  /** Where the voice detector heard someone, when it is installed. */
  speech: Range[] | null;
  speechSeconds?: number;
}

/** Speech-to-text alone: the words and roughly when each one ends. */
export async function recognize(opts: TranscribeOptions): Promise<Recognition> {
  const whisper = WHISPER;
  if (!whisper) throw new Error('whisper-cli is not installed');
  if (!fs.existsSync(WHISPER_MODEL)) throw new Error('the whisper model file is missing');
  const { pcm, envelope, duration, workDir, signal } = opts;
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const full = path.join(workDir, 'full.wav');
    writeWav(full, pcm);
    const speech = await detectSpeech(full, signal);
    const speechSeconds = speech ? speech.reduce((s, r) => s + (r.end - r.start), 0) : undefined;
    // No voice anywhere (music, ambience, b-roll): there is nothing to
    // transcribe, and whisper would only invent text that then shows up as
    // captions.
    if (speechSeconds !== undefined && speechSeconds < 1) return { language: '', raw: [], chunks: [], speech, speechSeconds };

    const chunks = planChunks(detectSilences(envelope, { minSilence: 0.3 }), duration);
    const files = chunks.map((c, i) => {
      const file = path.join(workDir, `chunk_${String(i).padStart(4, '0')}.wav`);
      const a = Math.floor(c.start * ANALYSIS_RATE) * 2;
      const b = Math.min(pcm.length, Math.floor(c.end * ANALYSIS_RATE) * 2);
      writeWav(file, pcm.subarray(a, b));
      return file;
    });
    if (!files.length) return { language: '', raw: [], chunks: [], speech, speechSeconds };

    // Detect the language where there is the most talking, not at the start,
    // which is often music or room tone. Hindi speakers skip detection: it
    // calls Hinglish English more often than not, and Hindi mode handles both.
    const script = hindiScript(opts.languages);
    let language = opts.language;
    if (!language && script) language = 'hi';
    if (!language) {
      const overlap = (c: Range) => (speech ?? []).reduce((s, r) => s + Math.max(0, Math.min(c.end, r.end) - Math.max(c.start, r.start)), 0);
      let best = 0;
      chunks.forEach((c, i) => {
        if (overlap(c) > overlap(chunks[best])) best = i;
      });
      language = await detectLanguage(files[best], signal);
      const allowed = (opts.languages ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean);
      if (allowed.length && !allowed.includes(language)) language = allowed[0];
    }

    const threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));
    const args = ['-m', WHISPER_MODEL, '-ojf', '-l', language, '-t', threads];
    const preset = dtwPreset(WHISPER_MODEL);
    // DTW token times need flash attention switched off, and without flash
    // attention Hindi mode degenerates into babble on English speech (and
    // loses most Hindi lines), so Hindi runs without DTW: whisper's rough
    // token times then seed the alignment model, which places Latin words.
    if (preset && language !== 'hi') args.push('-dtw', preset, '-nfa');
    let prompt = opts.prompt;
    if (prompt === undefined && language === 'en') prompt = ENGLISH_PROMPT;
    if (prompt === undefined && language === 'hi' && script) prompt = HINGLISH_PROMPT;

    const perToken = UNSPACED.has(language);
    const heard = (t: number) => !speech || speech.some((s) => t >= s.start - 0.5 && t <= s.end + 0.5);
    const parse = (i: number): RawWord[] => {
      const file = files[i] + '.json';
      if (!fs.existsSync(file)) return [];
      const json = JSON.parse(fs.readFileSync(file).toString('latin1')) as { transcription?: RawSegment[] };
      const tokens = dropRepeatedSegments(json.transcription ?? []).flatMap((s) => s.tokens ?? []);
      const words = tokensToWords(tokens, perToken);
      // DTW times are monotonic in practice; enforce it so one bad token cannot reorder words.
      for (let k = 1; k < words.length; k++) words[k].end = Math.max(words[k].end, words[k - 1].end);
      const c = chunks[i];
      return words.map((w) => ({ ...w, end: c.start + Math.min(w.end, c.end - c.start), chunk: i }));
    };
    // Loops go first so a hallucinated stretch cannot drag the real words next to it down with it.
    const clean = (words: RawWord[]) => dropInvented(dropLoops(fixBursts(words, duration, heard), speech), speech);
    let done = 0;
    const decode = async (indices: number[], withPrompt: string | undefined, progress: boolean) => {
      const a = withPrompt ? [...args, '--prompt', withPrompt] : args;
      await run(whisper, [...a, ...indices.map((i) => files[i])], {
        signal,
        onStderrLine: (line) => {
          if (progress && line.includes('output_json: saving output')) opts.onProgress?.(Math.min(1, ++done / files.length));
        },
      });
      return indices.map((i) => clean(parse(i)));
    };
    const all = chunks.map((_, i) => i);
    const perChunk = await decode(all, prompt, true);

    // The Hinglish prompt keeps whisper from babbling on English speech, but
    // on a stretch of plain Hindi under noise it can steer whisper into
    // translating it or looping. A chunk that came back with hardly any words
    // for the voice heard in it is decoded again without the prompt, and the
    // second reading is kept when more of its words land on that voice.
    if (prompt && language === 'hi' && speech) {
      const heardIn = (c: Range) => speech.reduce((s, r) => s + Math.max(0, Math.min(c.end, r.end) - Math.max(c.start, r.start)), 0);
      const onVoice = (words: RawWord[]) => words.filter((w) => heard(w.end)).length;
      const again = all.filter((i) => heardIn(chunks[i]) >= 1.5 && onVoice(perChunk[i]) < 0.8 * heardIn(chunks[i]));
      if (again.length) {
        const second = await decode(again, undefined, false);
        again.forEach((i, k) => {
          if (onVoice(second[k]) > onVoice(perChunk[i])) perChunk[i] = second[k];
        });
      }
    }
    const raw = perChunk.flat();
    return { language, raw, chunks, speech, speechSeconds };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export async function transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
  const { language, raw, chunks, speech, speechSeconds } = await recognize(opts);
  // Hinglish is written in Latin letters, which the English alignment model can also place.
  const latin = language === 'hi' && hindiScript(opts.languages) === 'latin';
  if (latin) for (const w of raw) w.text = romanizeDevanagari(w.text);
  const byEnds = placeByEnds(raw, detectSilences(opts.envelope, { minSilence: 0.2 }), opts.duration);
  // Where the alignment model is installed it places the words on the sound itself;
  // whisper's own times remain the fallback for anything it could not place.
  const byModel = (await placeWords(latin ? 'en' : language, raw, opts.pcm, chunks, opts.envelope, speech).catch((err: Error) => {
    console.error('[align] failed, using whisper times:', err.message);
    return null;
  })) ?? [];
  const words: Word[] = [];
  raw.forEach((w, i) => {
    const r = byModel[i] ?? byEnds[i];
    if (r) words.push({ t0: r.start, t1: r.end, text: w.text, p: Math.round(w.p * 100) / 100 });
  });
  return { language, words, speechSeconds, aligned: byModel.some((r) => r !== null) };
}
