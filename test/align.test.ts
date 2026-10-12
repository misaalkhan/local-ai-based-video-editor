import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTarget, ctcAlign, fitEdges, logSoftmax, parseVocab, spell, WILDCARD } from '../server/align.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const vocab = parseVocab({ '<pad>': 0, '|': 4, A: 7, B: 24, T: 6, E: 5, "'": 27, '<unk>': 3 });

test('words are spelled with the letters the model knows', () => {
  assert.deepEqual(spell('"Beat,"', vocab), [24, 5, 7, 6]);
  // Accents fall back to the plain letter; a run of unknown signs becomes one wildcard.
  assert.deepEqual(spell('bête', vocab), [24, 5, 6, 5]);
  assert.deepEqual(spell('2024', vocab), [WILDCARD]);
  assert.deepEqual(spell("'tat'", vocab), [6, 7, 6]);
  const t = buildTarget(['Beat', 'a', 'tab'], vocab);
  assert.deepEqual(t.tokens, [24, 5, 7, 6, 4, 7, 4, 6, 7, 24]);
  assert.deepEqual(t.wordOf, [0, 0, 0, 0, -1, 1, -1, 2, 2, 2]);
});

test('the best path through the frames finds each letter where it is loudest', () => {
  // 12 frames, 5 labels: blank 0, | 1, A 2, B 3, T 4. "AB T" spoken as A at 1-2, B at 4, gap, T at 9.
  const size = 5;
  const frames = 12;
  const logits = new Float32Array(frames * size).fill(-3);
  const hit = (t: number, k: number) => (logits[t * size + k] = 3);
  for (let t = 0; t < frames; t++) logits[t * size] = 1;
  hit(1, 2);
  hit(2, 2);
  hit(4, 3);
  hit(6, 1);
  hit(9, 4);
  const logp = logSoftmax(logits, frames, size);
  const r = ctcAlign(logp, frames, size, [2, 3, 1, 4], 0)!;
  assert.ok(r);
  assert.deepEqual(Array.from(r.start), [1, 4, 6, 9]);
  assert.deepEqual(Array.from(r.end), [3, 5, 7, 10]);
  // A wildcard in place of the T takes the frames that are left for it.
  const w = ctcAlign(logp, frames, size, [2, 3, 1, WILDCARD], 0)!;
  assert.ok(w.start[3] >= 7);
  // Too many letters for the frames: no path.
  assert.equal(ctcAlign(logp, 2, size, [2, 3, 1, 4], 0), null);
  // A window keeps a letter where whisper heard it.
  const lo = new Int32Array([0, 0, 0, 0]);
  const hi = new Int32Array([frames, frames, frames, 8]);
  const boxed = ctcAlign(logp, frames, size, [2, 3, 1, 4], 0, { lo, hi })!;
  assert.ok(boxed.end[3] <= 8);
});

test('word edges grow out to the sound and meet at the dip between words', () => {
  // Envelope in 10 ms steps: quiet 0-0.2, loud 0.2-0.5, dip at 0.5, loud 0.51-0.8, quiet after.
  const env = new Uint8Array(100).fill(40);
  for (let i = 20; i < 80; i++) env[i] = 80;
  env[50] = 55;
  const spans = [{ start: 0.3, end: 0.36 }, { start: 0.6, end: 0.7 }];
  const out = fitEdges(spans, env, 0, 1, -40);
  near(out[0].start, 0.2, 0.011);
  near(out[0].end, 0.5, 0.011);
  near(out[1].start, 0.5, 0.011);
  near(out[1].end, 0.8, 0.011);
  // A word squeezed to nothing takes free time beside it.
  const tiny = fitEdges([{ start: 0.3, end: 0.31 }], new Uint8Array(100).fill(40), 0, 1, -40, [1]);
  assert.ok(tiny[0].end - tiny[0].start >= 0.06 - 1e-6);
});
