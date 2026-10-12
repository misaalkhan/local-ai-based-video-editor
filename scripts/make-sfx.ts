// Builds the built-in sound-effect set in assets/sfx.
//
// Every sound is synthesised here from sines and filtered noise, so the set is
// free of licensing questions and can be regenerated at any time:
//
//   node scripts/make-sfx.ts
//
// Sounds keep most of their energy between a few hundred hertz and a few
// kilohertz. Pure low-frequency thuds vanish on phone speakers.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 48000;
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sfx');

/** Small seeded generator so the noise-based sounds come out the same every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const buffer = (seconds: number) => new Float64Array(Math.round(seconds * SR));
const TAU = Math.PI * 2;
const expo = (a: number, b: number, x: number) => a * Math.pow(b / a, Math.min(1, Math.max(0, x)));

/** Add a sine whose pitch and level follow functions of time. */
function sine(out: Float64Array, at: number, dur: number, freq: (t: number) => number, amp: (t: number) => number): void {
  let phase = 0;
  const start = Math.round(at * SR);
  const n = Math.round(dur * SR);
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / SR;
    phase += (TAU * freq(t)) / SR;
    out[start + i] += Math.sin(phase) * amp(t);
  }
}

/** Add noise through a band-pass filter whose centre moves over time. */
function noiseBand(
  out: Float64Array,
  at: number,
  dur: number,
  centre: (t: number) => number,
  q: number,
  amp: (t: number) => number,
  seed: number,
  mode: 'band' | 'low' | 'high' = 'band',
): void {
  const rand = rng(seed);
  let low = 0;
  let band = 0;
  const start = Math.round(at * SR);
  const n = Math.round(dur * SR);
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / SR;
    const f = 2 * Math.sin((Math.PI * Math.min(7600, centre(t))) / SR);
    const x = rand() * 2 - 1;
    low += f * band;
    const high = x - low - band / q;
    band += f * high;
    out[start + i] += (mode === 'band' ? band : mode === 'low' ? low : high) * amp(t);
  }
}

function bell(out: Float64Array, at: number, f: number, dur: number, level = 1): void {
  const partials: [number, number, number][] = [
    [1, 1, 4.5],
    [2.76, 0.45, 6.5],
    [5.4, 0.22, 9],
    [8.93, 0.1, 13],
  ];
  for (const [ratio, a, decay] of partials) {
    sine(out, at, dur, () => f * ratio, (t) => level * a * Math.min(1, t / 0.002) * Math.exp(-t * decay));
  }
}

function click(out: Float64Array, at: number, pitch: number, level: number, seed: number): void {
  noiseBand(out, at, 0.006, () => 5200, 0.9, (t) => level * 0.9 * Math.exp(-t * 700), seed, 'high');
  sine(out, at, 0.04, () => pitch, (t) => level * 0.7 * Math.exp(-t * 190));
}

interface Sound {
  id: string;
  name: string;
  tags: string[];
  /** What it is for, which decides how loud it sits against the voice. */
  role: 'ui' | 'whoosh' | 'impact' | 'riser' | 'tone';
  make: () => Float64Array;
}

const SOUNDS: Sound[] = [
  {
    id: 'whoosh', name: 'Whoosh', role: 'whoosh', tags: ['whoosh', 'swoosh', 'transition', 'swipe', 'fast', 'air'],
    make: () => {
      const o = buffer(0.42);
      noiseBand(o, 0, 0.42, (t) => (t < 0.24 ? expo(350, 4200, t / 0.24) : expo(4200, 700, (t - 0.24) / 0.18)), 1.6, (t) => Math.pow(Math.sin((Math.PI * t) / 0.42), 1.6), 11);
      return o;
    },
  },
  {
    id: 'whoosh-long', name: 'Long whoosh', role: 'whoosh', tags: ['whoosh', 'swoosh', 'transition', 'slow', 'wind', 'pass'],
    make: () => {
      const o = buffer(0.85);
      noiseBand(o, 0, 0.85, (t) => (t < 0.5 ? expo(250, 3200, t / 0.5) : expo(3200, 500, (t - 0.5) / 0.35)), 1.3, (t) => Math.pow(Math.sin((Math.PI * t) / 0.85), 2), 12);
      return o;
    },
  },
  {
    id: 'swish', name: 'Swish', role: 'whoosh', tags: ['swish', 'whoosh', 'quick', 'text', 'slide', 'light'],
    make: () => {
      const o = buffer(0.22);
      noiseBand(o, 0, 0.22, (t) => expo(1500, 6800, t / 0.14), 2.2, (t) => Math.pow(Math.sin((Math.PI * t) / 0.22), 1.3), 13);
      return o;
    },
  },
  {
    id: 'pop', name: 'Pop', role: 'ui', tags: ['pop', 'bubble', 'appear', 'popup', 'caption', 'ui'],
    make: () => {
      const o = buffer(0.16);
      sine(o, 0, 0.16, (t) => 150 + 520 * Math.exp(-t * 34), (t) => Math.min(1, t / 0.0015) * Math.exp(-t * 42));
      sine(o, 0, 0.1, (t) => 2 * (150 + 520 * Math.exp(-t * 34)), (t) => 0.22 * Math.exp(-t * 60));
      return o;
    },
  },
  {
    id: 'blop', name: 'Blop', role: 'ui', tags: ['blop', 'bubble', 'pop', 'soft', 'appear', 'water'],
    make: () => {
      const o = buffer(0.2);
      sine(o, 0, 0.2, (t) => expo(280, 860, t / 0.09), (t) => Math.min(1, t / 0.004) * Math.exp(-t * 26));
      return o;
    },
  },
  {
    id: 'click', name: 'Click', role: 'ui', tags: ['click', 'tap', 'button', 'ui', 'select'],
    make: () => {
      const o = buffer(0.07);
      click(o, 0, 2100, 1, 21);
      return o;
    },
  },
  {
    id: 'tick', name: 'Tick', role: 'ui', tags: ['tick', 'tock', 'clock', 'count', 'ui', 'small'],
    make: () => {
      const o = buffer(0.05);
      sine(o, 0, 0.05, () => 3300, (t) => Math.exp(-t * 330));
      sine(o, 0, 0.05, () => 5100, (t) => 0.4 * Math.exp(-t * 420));
      return o;
    },
  },
  {
    id: 'ding', name: 'Ding', role: 'tone', tags: ['ding', 'bell', 'correct', 'idea', 'point', 'highlight'],
    make: () => {
      const o = buffer(1.1);
      bell(o, 0, 1318.5, 1.1);
      return o;
    },
  },
  {
    id: 'chime', name: 'Chime', role: 'tone', tags: ['chime', 'success', 'win', 'reveal', 'positive', 'bell'],
    make: () => {
      const o = buffer(1.25);
      bell(o, 0, 1046.5, 1.2, 0.8);
      bell(o, 0.09, 1318.5, 1.1, 0.8);
      bell(o, 0.18, 1568, 1.0, 0.9);
      return o;
    },
  },
  {
    id: 'notification', name: 'Notification', role: 'tone', tags: ['notification', 'message', 'alert', 'comment', 'phone'],
    make: () => {
      const o = buffer(0.5);
      for (const [at, f] of [[0, 880], [0.13, 1174.7]] as const) {
        sine(o, at, 0.36, () => f, (t) => Math.min(1, t / 0.004) * Math.exp(-t * 11));
        sine(o, at, 0.36, () => f * 2, (t) => 0.18 * Math.exp(-t * 16));
      }
      return o;
    },
  },
  {
    id: 'impact', name: 'Impact', role: 'impact', tags: ['impact', 'boom', 'hit', 'thud', 'punch', 'drop', 'bass', 'emphasis'],
    make: () => {
      const o = buffer(0.9);
      sine(o, 0, 0.9, (t) => 46 + 120 * Math.exp(-t * 17), (t) => Math.min(1, t / 0.002) * Math.exp(-t * 5));
      // The parts a phone speaker can actually reproduce.
      sine(o, 0, 0.3, (t) => 170 + 150 * Math.exp(-t * 30), (t) => 0.7 * Math.exp(-t * 20));
      noiseBand(o, 0, 0.25, () => 900, 0.8, (t) => 0.9 * Math.exp(-t * 34), 31, 'low');
      noiseBand(o, 0, 0.05, () => 3000, 1, (t) => 0.5 * Math.exp(-t * 120), 32);
      for (let i = 0; i < o.length; i++) o[i] = Math.tanh(o[i] * 1.4);
      return o;
    },
  },
  {
    id: 'riser', name: 'Riser', role: 'riser', tags: ['riser', 'build', 'tension', 'rise', 'sweep', 'anticipation', 'before'],
    make: () => {
      const d = 1.6;
      const o = buffer(d);
      noiseBand(o, 0, d, (t) => expo(300, 7000, t / d), 2.4, (t) => Math.pow(t / d, 2.3), 41);
      sine(o, 0, d, (t) => expo(180, 1500, t / d), (t) => 0.3 * Math.pow(t / d, 2.3));
      const fade = Math.round(0.012 * SR);
      for (let i = 0; i < fade; i++) o[o.length - 1 - i] *= i / fade;
      return o;
    },
  },
  {
    id: 'shutter', name: 'Camera shutter', role: 'ui', tags: ['camera', 'shutter', 'photo', 'snap', 'picture', 'screenshot'],
    make: () => {
      const o = buffer(0.2);
      click(o, 0, 1700, 0.9, 51);
      noiseBand(o, 0.012, 0.05, () => 4200, 1.2, (t) => 0.35 * Math.exp(-t * 60), 52);
      click(o, 0.075, 1250, 1, 53);
      return o;
    },
  },
  {
    id: 'typing', name: 'Typing', role: 'ui', tags: ['typing', 'keyboard', 'type', 'text', 'keys', 'writing'],
    make: () => {
      const o = buffer(0.62);
      const r = rng(61);
      let t = 0;
      for (let i = 0; i < 7; i++) {
        click(o, t, 1500 + r() * 900, 0.7 + r() * 0.3, 62 + i);
        t += 0.065 + r() * 0.045;
      }
      return o;
    },
  },
  {
    id: 'error', name: 'Error buzz', role: 'tone', tags: ['error', 'wrong', 'buzz', 'no', 'fail', 'mistake'],
    make: () => {
      const o = buffer(0.32);
      for (const f of [185, 196]) {
        for (let h = 1; h <= 7; h += 2) sine(o, 0, 0.32, () => f * h, (t) => (0.5 / h) * Math.min(1, t / 0.006) * Math.min(1, (0.32 - t) / 0.03));
      }
      return o;
    },
  },
  {
    id: 'drop', name: 'Drop', role: 'whoosh', tags: ['drop', 'fall', 'down', 'slide', 'descend', 'zoom out'],
    make: () => {
      const o = buffer(0.42);
      sine(o, 0, 0.42, (t) => expo(1500, 190, t / 0.3), (t) => Math.min(1, t / 0.004) * Math.exp(-t * 7));
      return o;
    },
  },
  {
    id: 'sparkle', name: 'Sparkle', role: 'tone', tags: ['sparkle', 'shimmer', 'magic', 'shine', 'glitter', 'reveal'],
    make: () => {
      const o = buffer(0.75);
      const r = rng(71);
      for (let i = 0; i < 11; i++) {
        const f = 2400 + r() * 4200;
        sine(o, r() * 0.45, 0.3, () => f, (t) => 0.5 * Math.min(1, t / 0.002) * Math.exp(-t * 26));
      }
      return o;
    },
  },
];

function toWav(samples: Float64Array, peakDb = -1.5): Buffer {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0 ? Math.pow(10, peakDb / 20) / peak : 1;
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] * gain)) * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

fs.mkdirSync(OUT, { recursive: true });
const manifest = SOUNDS.map((s) => {
  const samples = s.make();
  fs.writeFileSync(path.join(OUT, `${s.id}.wav`), toWav(samples));
  // Where the sound "lands": the loudest 5 ms, traced back to where it first comes within 6 dB.
  const win = Math.round(0.005 * SR);
  const env: number[] = [];
  for (let i = 0; i + win <= samples.length; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j++) e += samples[j] * samples[j];
    env.push(Math.sqrt(e / win));
  }
  const max = Math.max(...env);
  let hit = env.indexOf(max);
  while (hit > 0 && env[hit - 1] >= max * 0.5) hit--;
  return { id: s.id, name: s.name, tags: s.tags, role: s.role, file: `${s.id}.wav`, duration: Math.round((samples.length / SR) * 1000) / 1000, hit: Math.round(hit * 0.005 * 1000) / 1000 };
});
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${manifest.length} sound effects to ${OUT}`);
for (const m of manifest) console.log(`  ${m.id.padEnd(14)} ${m.duration.toFixed(2)}s  lands at ${m.hit.toFixed(3)}s  [${m.role}]`);
