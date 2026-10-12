import test from 'node:test';
import assert from 'node:assert/strict';
import { assignSpeakers } from '../server/diarize.ts';
import type { Word } from '../shared/types.ts';

const w = (t0: number, t1: number, text: string): Word => ({ t0, t1, text });

test('words take the speaker whose turn covers them, numbered in order of appearance', () => {
  const words = [w(0, 1, 'hi'), w(1, 2, 'there'), w(5, 6, 'hello'), w(6, 7, 'back'), w(10, 11, 'bye')];
  const n = assignSpeakers(words, [
    { start: 0, end: 2.5, speaker: 7 },
    { start: 4.5, end: 7.5, speaker: 2 },
    { start: 9.5, end: 11.5, speaker: 7 },
  ]);
  assert.equal(n, 2);
  assert.deepEqual(words.map((x) => x.s), [1, 1, 2, 2, 1]);
});

test('a single voice leaves the words unmarked, and a fleeting voice is folded into its neighbour', () => {
  const alone = [w(0, 1, 'a'), w(1, 2, 'b'), w(3, 4, 'c')];
  assert.equal(assignSpeakers(alone, [{ start: 0, end: 4, speaker: 3 }]), 1);
  assert.ok(alone.every((x) => x.s === undefined));
  const words = [w(0, 3, 'long'), w(3, 6, 'talk'), w(6.2, 6.6, 'yeah'), w(7, 10, 'more')];
  const n = assignSpeakers(words, [
    { start: 0, end: 6, speaker: 0 },
    { start: 6.1, end: 6.8, speaker: 1 },
    { start: 6.9, end: 10, speaker: 0 },
  ]);
  assert.equal(n, 1);
  assert.ok(words.every((x) => x.s === undefined));
});
