// Who is speaking when. A segmentation network finds the stretches of speech
// and a speaker-embedding network tells the voices apart; both run through
// sherpa-onnx. Words then get the speaker whose stretch covers them most.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { DIARIZE_EMBEDDING, DIARIZE_SEGMENTATION } from './config.ts';
import { ANALYSIS_RATE } from './analyze.ts';
import type { Word } from '../shared/types.ts';

export interface SpeechTurn {
  start: number;
  end: number;
  speaker: number;
}

export function diarizerInstalled(): boolean {
  return fs.existsSync(DIARIZE_SEGMENTATION) && fs.existsSync(DIARIZE_EMBEDDING);
}

interface Diarizer {
  process(samples: Float32Array): SpeechTurn[];
}

let loading: Promise<Diarizer | null> | null = null;

/** Load the models once; null when they, or the package, are missing. */
function diarizer(): Promise<Diarizer | null> {
  if (!loading) {
    loading = (async () => {
      if (!diarizerInstalled()) return null;
      try {
        const require = createRequire(import.meta.url);
        const sherpa = require('sherpa-onnx-node') as { OfflineSpeakerDiarization: new (config: unknown) => Diarizer };
        return new sherpa.OfflineSpeakerDiarization({
          segmentation: { pyannote: { model: DIARIZE_SEGMENTATION }, numThreads: 2 },
          embedding: { model: DIARIZE_EMBEDDING, numThreads: 2 },
          // The number of speakers is not known in advance; voices closer than the threshold are the same person.
          clustering: { numClusters: -1, threshold: 0.6 },
          minDurationOn: 0.3,
          minDurationOff: 0.5,
        });
      } catch (err) {
        console.error('[diarize] could not load the speaker models:', (err as Error).message);
        return null;
      }
    })();
  }
  return loading;
}

/** Speaker turns for 16 kHz mono 16-bit audio, or null when speakers cannot be told apart here. */
export async function diarize(pcm: Buffer): Promise<SpeechTurn[] | null> {
  const d = await diarizer();
  if (!d) return null;
  const n = Math.floor(pcm.length / 2);
  // Under two seconds of audio has no turns worth the name.
  if (n < 2 * ANALYSIS_RATE) return null;
  const i16 = new Int16Array(pcm.buffer, pcm.byteOffset, n);
  const f32 = new Float32Array(n);
  for (let i = 0; i < n; i++) f32[i] = i16[i] / 32768;
  try {
    return d.process(f32).map((t) => ({ start: t.start, end: t.end, speaker: t.speaker }));
  } catch (err) {
    console.error('[diarize] failed:', (err as Error).message);
    return null;
  }
}

/**
 * Give each word the speaker whose turn covers most of it, numbered from 1 in
 * order of first appearance. Returns the number of speakers; with one speaker
 * the words are left unmarked, since a label would only be noise.
 */
export function assignSpeakers(words: Word[], turns: SpeechTurn[]): number {
  if (!turns.length || !words.length) return 0;
  const order = new Map<number, number>();
  const labelled: number[] = [];
  for (const w of words) {
    let best = -1;
    let cover = 0;
    for (const t of turns) {
      const o = Math.min(w.t1, t.end) - Math.max(w.t0, t.start);
      if (o > cover) {
        cover = o;
        best = t.speaker;
      }
    }
    if (best < 0) {
      // A word outside every turn (a short interjection the segmenter missed) belongs to the nearest turn.
      let near = Infinity;
      for (const t of turns) {
        const dist = w.t0 > t.end ? w.t0 - t.end : t.start - w.t1;
        if (dist < near) {
          near = dist;
          best = t.speaker;
        }
      }
    }
    labelled.push(best);
  }
  // A voice heard for under two seconds in all (an outro line, a laugh) is folded into the speaker around it.
  const time = new Map<number, number>();
  words.forEach((w, i) => time.set(labelled[i], (time.get(labelled[i]) ?? 0) + (w.t1 - w.t0)));
  for (let i = 0; i < labelled.length; i++) {
    if ((time.get(labelled[i]) ?? 0) >= 2) continue;
    let j = i - 1;
    while (j >= 0 && (time.get(labelled[j]) ?? 0) < 2) j--;
    if (j < 0) {
      j = i + 1;
      while (j < labelled.length && (time.get(labelled[j]) ?? 0) < 2) j++;
    }
    if (j >= 0 && j < labelled.length) labelled[i] = labelled[j];
  }
  for (const l of labelled) if (!order.has(l)) order.set(l, order.size + 1);
  for (let i = 0; i < labelled.length; i++) labelled[i] = order.get(labelled[i])!;
  if (order.size < 2) {
    for (const w of words) delete w.s;
    return order.size;
  }
  words.forEach((w, i) => {
    w.s = labelled[i];
  });
  return order.size;
}
