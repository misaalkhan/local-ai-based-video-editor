// Silence detection over a loudness envelope.
//
// The envelope is one byte per 10 ms of audio: RMS level in dB, offset by 100
// (so 100 = full scale, 40 = -60 dB, 0 = digital silence).

import type { Range } from './types.ts';
import { clamp } from './timeline.ts';

export const ENVELOPE_HOP = 0.01;

function percentile(hist: Uint32Array, total: number, p: number): number {
  let acc = 0;
  const target = p * total;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i - 100;
  }
  return 0;
}

/**
 * Pick a threshold between the room tone and the speech level of this
 * particular recording, so quiet and noisy clips are both handled.
 */
export function autoThresholdDb(env: Uint8Array): number {
  if (!env.length) return -40;
  const hist = new Uint32Array(101);
  for (let i = 0; i < env.length; i++) hist[Math.min(100, env[i])]++;
  const floor = percentile(hist, env.length, 0.05);
  const loud = percentile(hist, env.length, 0.98);
  // Nearly constant level (music, a fan, pure silence): there is nothing to tell apart.
  if (loud - floor < 10) return floor - 6;
  return clamp(floor + 0.35 * (loud - floor), -62, -30);
}

export interface SilenceOptions {
  /** Level below which audio counts as quiet. Omit to adapt to the recording. */
  thresholdDb?: number;
  /** Shortest quiet stretch worth reporting, seconds. */
  minSilence?: number;
}

export function detectSilences(env: Uint8Array, opts: SilenceOptions = {}): Range[] {
  const threshold = (opts.thresholdDb ?? autoThresholdDb(env)) + 100;
  const minFrames = Math.max(1, Math.round((opts.minSilence ?? 0.3) / ENVELOPE_HOP));
  const n = env.length;
  const quiet = new Uint8Array(n);
  for (let i = 0; i < n; i++) quiet[i] = env[i] < threshold ? 1 : 0;
  // A click or lip smack shorter than 50 ms does not end a silence.
  const maxBlip = 5;
  let i = 0;
  while (i < n) {
    if (quiet[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !quiet[j]) j++;
    if (j - i <= maxBlip && i > 0 && j < n) for (let k = i; k < j; k++) quiet[k] = 1;
    i = j;
  }
  const out: Range[] = [];
  i = 0;
  while (i < n) {
    if (!quiet[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && quiet[j]) j++;
    if (j - i >= minFrames) out.push({ start: i * ENVELOPE_HOP, end: j * ENVELOPE_HOP });
    i = j;
  }
  return out;
}

/** Fraction of the envelope that is above the threshold, a rough "how much sound is there". */
export function activeRatio(env: Uint8Array, thresholdDb?: number): number {
  if (!env.length) return 0;
  const threshold = (thresholdDb ?? autoThresholdDb(env)) + 100;
  let n = 0;
  for (let i = 0; i < env.length; i++) if (env[i] >= threshold) n++;
  return n / env.length;
}
