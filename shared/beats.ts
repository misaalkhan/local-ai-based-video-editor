// Beat tracking on the loudness envelope: where the music hits, so cuts can
// land on them. Onsets are rises in level; the tempo is the lag at which the
// onsets repeat most; the beats are the comb of that period that lines up
// best with the onsets, each nudged to the nearest onset.

import { ENVELOPE_HOP } from './silence.ts';

export interface Beats {
  bpm: number;
  /** Beat times in seconds. */
  times: number[];
  /** How clearly the beat came through, 0..1. */
  confidence: number;
}

/** Positive rises in level, in dB per hop, lightly smoothed. */
function onsets(env: Uint8Array): Float32Array {
  const n = env.length;
  const out = new Float32Array(n);
  for (let i = 2; i < n; i++) {
    const rise = env[i] - Math.max(env[i - 1], env[i - 2]);
    out[i] = rise > 0 ? rise : 0;
  }
  // A 30 ms smoothing keeps a single hit from splitting into two onsets.
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) sm[i] = (out[Math.max(0, i - 1)] + out[i] + out[Math.min(n - 1, i + 1)]) / 3;
  return sm;
}

export function findBeats(env: Uint8Array, opts: { minBpm?: number; maxBpm?: number } = {}): Beats {
  const minBpm = opts.minBpm ?? 60;
  const maxBpm = opts.maxBpm ?? 190;
  const o = onsets(env);
  const n = o.length;
  if (n < 400) return { bpm: 0, times: [], confidence: 0 };
  // Tempo: the lag with the strongest self-similarity of the onset curve.
  const minLag = Math.round(60 / maxBpm / ENVELOPE_HOP);
  const maxLag = Math.round(60 / minBpm / ENVELOPE_HOP);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += o[i];
  mean /= n;
  let bestLag = minLag;
  let best = -Infinity;
  let total = 0;
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += (o[i] - mean) * (o[i - lag] - mean);
    s /= n - lag;
    // Dance music sits around 90 to 130 bpm; a gentle pull keeps double and half tempos from winning ties.
    const bpm = 60 / (lag * ENVELOPE_HOP);
    const prior = Math.exp(-((Math.log(bpm / 110)) ** 2) / 0.5);
    const score = s * (0.7 + 0.3 * prior);
    scores.push(score);
    total += Math.max(0, score);
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  const period = bestLag * ENVELOPE_HOP;
  const bpm = Math.round((60 / period) * 10) / 10;
  const confidence = total > 0 ? Math.min(1, (best / total) * 6) : 0;
  // Phase: the offset at which a comb of beats catches the most onset energy.
  let bestPhase = 0;
  let phaseScore = -Infinity;
  for (let ph = 0; ph < bestLag; ph++) {
    let s = 0;
    for (let i = ph; i < n; i += bestLag) s += o[i] + 0.5 * (o[i - 1] ?? 0) + 0.5 * (o[i + 1] ?? 0);
    if (s > phaseScore) {
      phaseScore = s;
      bestPhase = ph;
    }
  }
  // Each beat moves to the strongest onset within 60 ms, so cuts land on the hit itself.
  const times: number[] = [];
  const reach = Math.round(0.06 / ENVELOPE_HOP);
  for (let i = bestPhase; i < n; i += bestLag) {
    let at = i;
    let strongest = -1;
    for (let k = Math.max(0, i - reach); k <= Math.min(n - 1, i + reach); k++) {
      if (o[k] > strongest) {
        strongest = o[k];
        at = k;
      }
    }
    times.push(Math.round(at * ENVELOPE_HOP * 1000) / 1000);
  }
  return { bpm, times, confidence: Math.round(confidence * 100) / 100 };
}
