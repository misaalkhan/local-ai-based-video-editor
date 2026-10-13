// Sound presets and the filter chains that make them, in two dialects: ffmpeg
// filters for the export and Web Audio nodes for the preview. Both are built
// from the same description so the two sound alike.

import type { AudioFx, AudioPreset } from './types.ts';

export interface AudioStage {
  kind: 'highpass' | 'lowpass' | 'lowshelf' | 'highshelf' | 'peaking' | 'compressor';
  /** Hz for filters. */
  f?: number;
  /** dB gain for shelves and the peak; threshold dB for the compressor. */
  g?: number;
  /** Q for the peak, ratio for the compressor. */
  q?: number;
}

export const AUDIO_PRESETS: { id: AudioPreset; label: string; hint: string; stages: AudioStage[] }[] = [
  { id: 'voice', label: 'Clear voice', hint: 'Rumble out, presence up, a little levelling.', stages: [{ kind: 'highpass', f: 80 }, { kind: 'peaking', f: 250, g: -2, q: 1.2 }, { kind: 'peaking', f: 3200, g: 3, q: 1 }, { kind: 'compressor', g: -18, q: 2.5 }] },
  { id: 'podcast', label: 'Podcast', hint: 'Full, close and even, like a studio mic.', stages: [{ kind: 'highpass', f: 70 }, { kind: 'lowshelf', f: 150, g: 2 }, { kind: 'peaking', f: 2500, g: 2, q: 1 }, { kind: 'highshelf', f: 9000, g: 1.5 }, { kind: 'compressor', g: -20, q: 3 }] },
  { id: 'warm', label: 'Warm', hint: 'Softer top, rounder bottom.', stages: [{ kind: 'lowshelf', f: 200, g: 3 }, { kind: 'highshelf', f: 6000, g: -3 }] },
  { id: 'bright', label: 'Bright', hint: 'Crisper, more air.', stages: [{ kind: 'highshelf', f: 5000, g: 4 }, { kind: 'peaking', f: 300, g: -1.5, q: 1 }] },
  { id: 'bass', label: 'Bass boost', hint: 'More low end, for music.', stages: [{ kind: 'lowshelf', f: 120, g: 6 }] },
  { id: 'radio', label: 'Radio', hint: 'Narrow and punchy, like an old broadcast.', stages: [{ kind: 'highpass', f: 300 }, { kind: 'lowpass', f: 3400 }, { kind: 'peaking', f: 1800, g: 4, q: 1 }, { kind: 'compressor', g: -24, q: 6 }] },
  { id: 'phone', label: 'Phone', hint: 'Thin and boxy, a voice down the line.', stages: [{ kind: 'highpass', f: 500 }, { kind: 'lowpass', f: 2800 }, { kind: 'peaking', f: 1200, g: 5, q: 1.5 }] },
  { id: 'muffled', label: 'Muffled', hint: 'Through a wall or under water.', stages: [{ kind: 'lowpass', f: 700 }, { kind: 'lowshelf', f: 200, g: 2 }] },
  { id: 'big', label: 'Big', hint: 'Loud and dense: squashed hard, bass and top lifted.', stages: [{ kind: 'lowshelf', f: 100, g: 4 }, { kind: 'highshelf', f: 7000, g: 3 }, { kind: 'compressor', g: -26, q: 8 }] },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The stages a clip's sound goes through: the preset's, then the user's shelves, mid and compression. */
export function audioStages(fx: AudioFx | undefined): AudioStage[] {
  if (!fx) return [];
  const out: AudioStage[] = [...(AUDIO_PRESETS.find((p) => p.id === fx.preset)?.stages ?? [])];
  if (fx.low) out.push({ kind: 'lowshelf', f: 150, g: clamp(fx.low, -12, 12) });
  if (fx.mid) out.push({ kind: 'peaking', f: 1200, g: clamp(fx.mid, -12, 12), q: 1 });
  if (fx.high) out.push({ kind: 'highshelf', f: 6000, g: clamp(fx.high, -12, 12) });
  if (fx.compress) {
    const c = clamp(fx.compress, 0, 1);
    out.push({ kind: 'compressor', g: -12 - 18 * c, q: 1.5 + 6.5 * c });
  }
  return out;
}

/** Make-up gain for a compressor, so levelling does not just make things quieter. */
export function compressorMakeup(threshold: number, ratio: number): number {
  // A signal peaking at -3 dB lands at threshold + (-3 - threshold) / ratio; lift it most of the way back.
  const out = threshold + (-3 - threshold) / ratio;
  return clamp((-3 - out) * 0.7, 0, 18);
}

/** The ffmpeg filters for a clip's sound stages. */
export function ffmpegAudioFilters(fx: AudioFx | undefined): string[] {
  const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
  return audioStages(fx).map((s) => {
    switch (s.kind) {
      case 'highpass':
        return `highpass=f=${n(s.f!)}:p=2`;
      case 'lowpass':
        return `lowpass=f=${n(s.f!)}:p=2`;
      case 'lowshelf':
        return `lowshelf=f=${n(s.f!)}:g=${n(s.g!)}`;
      case 'highshelf':
        return `highshelf=f=${n(s.f!)}:g=${n(s.g!)}`;
      case 'peaking':
        return `equalizer=f=${n(s.f!)}:t=q:w=${n(s.q ?? 1)}:g=${n(s.g!)}`;
      case 'compressor':
        return `acompressor=threshold=${n(s.g!)}dB:ratio=${n(s.q!)}:attack=8:release=120:makeup=${n(compressorMakeup(s.g!, s.q!))}dB`;
    }
  });
}

/** A stable key for a clip's sound chain, to know when the preview must rebuild it. */
export function audioFxKey(fx: AudioFx | undefined): string {
  return fx ? JSON.stringify(audioStages(fx)) : '';
}
