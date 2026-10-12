import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropInvented, dropLoops, tokensToWords, type RawWord } from '../server/transcribe.ts';

const words = (s: string): RawWord[] =>
  s.split(' ').map((t) => {
    const [text, end, p] = t.split('@');
    return { text, end: Number(end), p: Number(p ?? 1), chunk: 0 };
  });

test('a confident sentence where hardly any voice was heard is dropped', () => {
  // Real output on an 11 s clip of laughter and noise: 19 words, 1.6 s of voice.
  const raw = words("I'm@0.5@0.94 going@0.5@0.79 to@0.7 go@0.7@0.92 I'm@3.6@0.92 going@3.8 to@5.7 go@5.8 to@6.4 the@6.6 hospital@6.6 and@7.0@0.9 I'm@7.3@0.8 going@7.7 to@8.0 go@8.4 to@8.7 the@9.1 hospital.@9.4");
  assert.deepEqual(dropInvented(raw, [{ start: 5.5, end: 7.1 }]), []);
});

test('a sentence that the voice detector only half heard survives', () => {
  const raw = words('we@1.0 went@1.4 to@1.7 the@1.9 market@2.3 and@2.6 bought@3.0 mangoes@3.5');
  const kept = dropInvented(raw, [{ start: 0.8, end: 2.0 }]);
  assert.equal(kept.length, 8);
});

test('a looping phrase that started without confidence is dropped', () => {
  // Real output on a clip of laughter: "I love it, and" six times, confidence rising as the loop feeds itself.
  const raw = words('I@8.3@0.04 love@8.4@0.09 it,@8.5@0.23 and@9.0@0.05 I@11.3@0.44 love@11.3@0.38 it,@11.5@0.86 and@12.0@0.49 I@12.1@0.74 love@12.1@0.77 it,@12.5@0.94 and@13.0@0.67 I@13.1@0.85 love@13.3@0.91 it,@13.5@0.96 and@13.7@0.78 I@13.8@0.87 love@13.8@0.95 it,@14.1@0.98 and@14.4@0.84 I@14.7@0.89 love@15.1@0.96 it.@15.4@0.98');
  const speech = [{ start: 0.7, end: 2.7 }, { start: 6.8, end: 7.6 }, { start: 8.3, end: 9.6 }, { start: 10.5, end: 11.7 }, { start: 11.9, end: 16.1 }];
  assert.deepEqual(dropLoops(raw, speech), []);
});

test('a chant said with confidence where a voice was heard is kept', () => {
  const raw = words("let's@1.0 go@1.3 let's@1.6 go@1.9 let's@2.2 go@2.5 let's@2.8 go!@3.1 come@4.0 on@4.3");
  assert.equal(dropLoops(raw, [{ start: 0.8, end: 4.5 }]).length, 10);
});

test('words after a dropped loop stay', () => {
  const raw = words('no@1.0@0.2 no@1.2@0.3 no@1.4@0.3 no@1.6@0.4 then@5.0 we@5.3 left@5.6');
  assert.deepEqual(dropLoops(raw, [{ start: 4.8, end: 6 }]).map((w) => w.text), ['then', 'we', 'left']);
});

test('a word or two alone where no voice was heard are dropped', () => {
  const raw = words('-Penis-@3.0@0.9 we@10.0 are@10.3 here@10.6');
  assert.deepEqual(dropInvented(raw, [{ start: 9.5, end: 11 }]).map((w) => w.text), ['we', 'are', 'here']);
});

test('one word repeated with nothing else in its chunk is dropped even when heard', () => {
  const raw = words('jhaal@1.0 jhaal@2.0 jhaal@3.0 jhaal@4.0 jhaal@5.0');
  assert.deepEqual(dropLoops(raw, [{ start: 0.5, end: 6 }]), []);
  const chant = words('go@1.0 go@1.3 go@1.6 go@1.9 team@2.5');
  assert.equal(dropLoops(chant, [{ start: 0.5, end: 3 }]).length, 5);
});

test('a dialogue dash before a word is not part of it', () => {
  const tokens = [
    { text: ' -', offsets: { from: 0, to: 100 }, p: 0.9 },
    { text: 'Aha', offsets: { from: 100, to: 400 }, p: 0.9 },
    { text: ' well', offsets: { from: 500, to: 800 }, p: 0.9 },
    { text: '-', offsets: { from: 800, to: 850 }, p: 0.9 },
    { text: 'known', offsets: { from: 850, to: 1200 }, p: 0.9 },
  ];
  assert.deepEqual(tokensToWords(tokens, false).map((w) => w.text), ['Aha', 'well-known']);
});
