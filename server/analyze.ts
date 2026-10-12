// Audio analysis: decode a file once to 16 kHz mono and derive everything that
// needs raw samples (loudness envelope, waveform peaks, the WAV whisper reads).

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { FFMPEG } from './config.ts';
import { ENVELOPE_HOP } from '../shared/silence.ts';

export const ANALYSIS_RATE = 16000;
const HOP = Math.round(ANALYSIS_RATE * ENVELOPE_HOP);

export interface AudioAnalysis {
  /** RMS level per 10 ms in dB + 100, see shared/silence.ts. */
  envelope: Uint8Array;
  /** Peak amplitude per 10 ms, 0..255, for drawing waveforms. */
  peaks: Uint8Array;
  /** 16-bit mono samples at 16 kHz. */
  pcm: Buffer;
  duration: number;
}

/** Decode the first audio stream to raw PCM, padded so sample 0 is time 0 of the file. */
export function decodePcm(file: string, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-vn',
      '-af', 'aresample=async=1:first_pts=0',
      '-ac', '1', '-ar', String(ANALYSIS_RATE), '-f', 's16le', 'pipe:1',
    ];
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new Error('aborted'));
      else if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`could not decode audio: ${stderr.trim().split('\n').pop() ?? code}`));
    });
  });
}

export function analyzePcm(pcm: Buffer): AudioAnalysis {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const n = Math.ceil(samples.length / HOP);
  const energy = new Float64Array(n);
  const peaks = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const end = Math.min(samples.length, (i + 1) * HOP);
    let sum = 0;
    let peak = 0;
    for (let j = i * HOP; j < end; j++) {
      const v = samples[j];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    energy[i] = sum / Math.max(1, end - i * HOP);
    peaks[i] = Math.min(255, Math.round((peak / 32768) * 255));
  }
  // 30 ms smoothing keeps single-hop dips inside a word from reading as silence.
  const envelope = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const e = (energy[Math.max(0, i - 1)] + energy[i] + energy[Math.min(n - 1, i + 1)]) / 3;
    const db = e > 0 ? 10 * Math.log10(e / (32768 * 32768)) : -100;
    envelope[i] = Math.max(0, Math.min(100, Math.round(db + 100)));
  }
  return { envelope, peaks, pcm, duration: samples.length / ANALYSIS_RATE };
}

export function writeWav(file: string, pcm: Buffer): void {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(ANALYSIS_RATE, 24);
  header.writeUInt32LE(ANALYSIS_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, header);
    fs.writeSync(fd, pcm);
  } finally {
    fs.closeSync(fd);
  }
}
