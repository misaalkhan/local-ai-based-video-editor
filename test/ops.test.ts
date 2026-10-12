import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addAudio,
  addGraphic,
  addOverlay,
  addText,
  addTitleCard,
  addZoom,
  chooseTake,
  createDoc,
  dropScraps,
  duplicateItem,
  fillerCutRanges,
  insertMain,
  keepPassages,
  makeClip,
  moveMain,
  moveMainRange,
  removeItem,
  removeSourceSpans,
  reorderMain,
  restoreSourceSpan,
  rippleDelete,
  setTransition,
  silenceCutRanges,
  splitAt,
  stutterCutRanges,
  trimMain,
  trimTimed,
  updateClip,
  updateGraphic,
  wordSpan,
  wordsKept,
} from '../shared/ops.ts';
import { contentDuration, faceAt, framingAt, layoutMain, mainDuration, sceneAt, srcDuration, zoomAt, layerGeometry } from '../shared/timeline.ts';
import { transformAt } from '../shared/graphics.ts';
import { buildCards, cardAt, timelineWords, toLines } from '../shared/captions.ts';
import { autoThresholdDb, detectSilences } from '../shared/silence.ts';
import type { MediaMainClip, ProjectDoc, Word } from '../shared/types.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const talk = { id: 'talk', kind: 'video' as const, duration: 20 };
const broll = { id: 'broll', kind: 'video' as const, duration: 8 };
const song = { id: 'song', kind: 'audio' as const, duration: 120 };

function base(): ProjectDoc {
  let d = createDoc('p', 'Test');
  d = insertMain(d, { kind: 'media', ...makeClip(talk, 30) });
  return d;
}

test('main clips are packed back to back on whole frames', () => {
  let d = base();
  d = insertMain(d, { kind: 'media', ...makeClip(broll, 30, { in: 1, duration: 2.5 }) });
  const l = layoutMain(d);
  assert.equal(l.length, 2);
  near(l[0].end, 20);
  near(l[1].start, 20);
  near(l[1].end, 22.5);
  near(mainDuration(d), 22.5);
});

test('ripple delete splits the main clip and keeps source times', () => {
  const d = rippleDelete(base(), [{ start: 5, end: 7 }]);
  assert.equal(d.main.length, 2);
  const [a, b] = d.main as MediaMainClip[];
  near(a.in, 0);
  near(a.out, 5);
  near(b.in, 7);
  near(b.out, 20);
  near(mainDuration(d), 18);
  assert.notEqual(a.id, b.id);
});

test('ripple delete merges overlapping ranges and handles several cuts', () => {
  const d = rippleDelete(base(), [{ start: 9, end: 10 }, { start: 2, end: 3 }, { start: 2.5, end: 4 }]);
  assert.equal(d.main.length, 3);
  near(mainDuration(d), 20 - 2 - 1);
  const clips = d.main as MediaMainClip[];
  near(clips[1].in, 4);
  near(clips[1].out, 9);
  near(clips[2].in, 10);
});

test('later items move with the cut, earlier ones stay', () => {
  let d = base();
  d = addOverlay(d, broll, { start: 10, duration: 3 }).doc;
  d = addText(d, { text: 'early', start: 1, duration: 2 }).doc;
  d = addText(d, { text: 'late', start: 12, duration: 2 }).doc;
  d = addZoom(d, { start: 15, duration: 1 }).doc;
  d = rippleDelete(d, [{ start: 5, end: 7 }]);
  near(d.overlays[0].start, 8);
  near(srcDuration(d.overlays[0]), 3);
  near(d.graphics[0].start, 1);
  near(d.graphics[1].start, 10);
  near(d.zooms[0].start, 13);
});

test('a cut inside b-roll shortens its tail instead of making it jump', () => {
  let d = base();
  d = addOverlay(d, broll, { start: 4, duration: 6 }).doc;
  d = rippleDelete(d, [{ start: 5, end: 7 }]);
  const o = d.overlays[0];
  near(o.start, 4);
  near(o.in, 0);
  near(srcDuration(o), 4);
});

test('items entirely inside a cut are removed; ones cut at the head are trimmed', () => {
  let d = base();
  d = addText(d, { text: 'gone', start: 5.2, duration: 1 }).doc;
  d = addOverlay(d, broll, { start: 6, duration: 3 }).doc;
  d = rippleDelete(d, [{ start: 5, end: 7 }]);
  assert.equal(d.graphics.length, 0);
  const o = d.overlays[0];
  near(o.start, 5);
  near(o.in, 1);
  near(srcDuration(o), 2);
});

test('music keeps its length through a cut and does not extend the video', () => {
  let d = base();
  d = addAudio(d, song, { start: 0, role: 'music' }).doc;
  d = rippleDelete(d, [{ start: 5, end: 7 }]);
  near(srcDuration(d.audio[0]), 120);
  near(contentDuration(d), 18);
});

test('trimming a main clip ripples everything after it', () => {
  let d = base();
  d = insertMain(d, { kind: 'media', ...makeClip(broll, 30) });
  d = addText(d, { text: 'x', start: 21, duration: 2 }).doc;
  const first = d.main[0].id;
  const shorter = trimMain(d, first, 'end', 15, 20);
  near(layoutMain(shorter)[0].end, 15);
  near(shorter.graphics[0].start, 16);
  const longer = trimMain(shorter, first, 'end', 18, 20);
  near(layoutMain(longer)[0].end, 18);
  near(longer.graphics[0].start, 19);
  // Cannot extend past the end of the source.
  const capped = trimMain(longer, first, 'end', 40, 20);
  near(layoutMain(capped)[0].end, 20);
  const head = trimMain(d, first, 'start', 3, 20);
  near((head.main[0] as MediaMainClip).in, 3);
  near(layoutMain(head)[0].end, 17);
  assert.equal(head.main[0].id, first);
});

test('split and reorder', () => {
  let d = splitAt(base(), 8);
  assert.equal(d.main.length, 2);
  near((d.main[1] as MediaMainClip).in, 8);
  d = moveMain(d, d.main[1].id, 0);
  near((d.main[0] as MediaMainClip).in, 8);
  near(mainDuration(d), 20);
  // Splitting on a clip boundary does nothing.
  assert.equal(splitAt(d, 12).main.length, 2);
});

test('removing a main clip closes the gap', () => {
  let d = splitAt(base(), 8);
  d = removeItem(d, { kind: 'main', id: d.main[0].id });
  assert.equal(d.main.length, 1);
  near(mainDuration(d), 12);
});

test('title card pushes the timeline later', () => {
  let d = base();
  d = addText(d, { text: 'hello', start: 2, duration: 2 }).doc;
  d = addTitleCard(d, { text: 'HOOK', duration: 3 });
  assert.equal(d.main[0].kind, 'color');
  near(mainDuration(d), 23);
  near(d.graphics[0].start, 5);
  near(d.graphics[1].start, 0);
  near(d.graphics[1].duration, 3);
});

test('speed change refits the clip to whole frames and ripples', () => {
  let d = base();
  d = addText(d, { text: 'after', start: 20, duration: 1 }).doc;
  d = updateClip(d, 'main', d.main[0].id, { speed: 2 }, 20);
  near(mainDuration(d), 10);
  near(d.graphics[0].start, 10);
});

test('trim timed clip respects source bounds', () => {
  let d = base();
  d = addOverlay(d, broll, { start: 5, in: 2, duration: 3 }).doc;
  const id = d.overlays[0].id;
  let t = trimTimed(d, 'overlay', id, 'end', 30, 8);
  near(srcDuration(t.overlays[0]), 6);
  t = trimTimed(d, 'overlay', id, 'start', 0, 8);
  near(t.overlays[0].start, 3);
  near(t.overlays[0].in, 0);
});

test('silence ranges keep padding around speech and drop tiny fragments', () => {
  const d = base();
  const layout = layoutMain(d);
  const silences = { talk: [{ start: 0, end: 1.2 }, { start: 4, end: 6 }, { start: 6.1, end: 8 }, { start: 19, end: 20 }] };
  // By default the 0.1 s sound between the two silences is kept, with its padding.
  assert.equal(silenceCutRanges(layout, (id) => silences[id as 'talk']).length, 4);
  const ranges = silenceCutRanges(layout, (id) => silences[id as 'talk'], { minKeep: 0.5 });
  // Leading silence: cut from 0, keep 0.1 s before speech.
  near(ranges[0].start, 0);
  near(ranges[0].end, 1.1);
  // With a larger minKeep the fragment between the two silences is swallowed.
  near(ranges[1].start, 4.15);
  near(ranges[1].end, 7.9);
  // Trailing silence runs to the end of the clip.
  near(ranges[2].start, 19.15);
  near(ranges[2].end, 20);
  const cut = rippleDelete(d, ranges);
  near(mainDuration(cut), 20 - 1.1 - 3.75 - 0.85, 0.05);
});

const words: Word[] = [
  { t0: 1.0, t1: 1.4, text: 'Hello' },
  { t0: 1.4, t1: 1.9, text: 'everyone.' },
  { t0: 3.0, t1: 3.3, text: 'Um,' },
  { t0: 3.3, t1: 3.6, text: 'this' },
  { t0: 3.6, t1: 3.8, text: 'is' },
  { t0: 3.8, t1: 4.2, text: 'you' },
  { t0: 4.2, t1: 4.5, text: 'know' },
  { t0: 4.5, t1: 5.0, text: 'great.' },
];

test('captions follow the cut', () => {
  let d = base();
  const get = (id: string) => (id === 'talk' ? words : undefined);
  let tl = timelineWords(d, layoutMain(d), get);
  assert.equal(tl.length, 8);
  near(tl[0].start, 1.0);
  d = rippleDelete(d, [{ start: 0, end: 0.9 }, { start: 2, end: 2.9 }]);
  tl = timelineWords(d, layoutMain(d), get);
  assert.equal(tl.length, 8);
  near(tl[0].start, 0.1);
  near(tl[2].start, 1.2);
  // Cutting the words themselves removes them from the captions.
  d = rippleDelete(d, [{ start: 1.2, end: 1.5 }]);
  tl = timelineWords(d, layoutMain(d), get);
  assert.deepEqual(tl.map((w) => w.text).slice(0, 3), ['Hello', 'everyone.', 'this']);
});

test('filler detection matches single words and phrases', () => {
  const d = base();
  const tl = timelineWords(d, layoutMain(d), () => words);
  const { ranges, matched, runs } = fillerCutRanges(tl, ['um', 'you know']);
  assert.deepEqual(matched, ['Um,', 'you know']);
  near(ranges[0].start, 3.0);
  near(ranges[0].end, 3.3);
  near(ranges[1].start, 3.8);
  near(ranges[1].end, 4.5);
  assert.deepEqual(runs, [{ mediaId: 'talk', from: 2, to: 2 }, { mediaId: 'talk', from: 5, to: 6 }]);
});

test('caption cards group words and never overlap', () => {
  const d = base();
  d.captions.maxWords = 3;
  const tl = timelineWords(d, layoutMain(d), () => words);
  const cards = buildCards(tl, d.captions);
  assert.ok(cards.length >= 3);
  for (let i = 1; i < cards.length; i++) assert.ok(cards[i].start >= cards[i - 1].end - 1e-9);
  assert.equal(cardAt(cards, 1.5)?.words[0].text, 'Hello');
  assert.equal(cardAt(cards, 2.6), undefined);
  const lines = toLines(tl);
  assert.equal(lines[1].pauseBefore !== undefined, true);
});

test('hidden and corrected caption words', () => {
  const d = base();
  d.captions.edits['talk:2'] = '';
  d.captions.edits['talk:0'] = 'Hi';
  const tl = timelineWords(d, layoutMain(d), () => words);
  const cards = buildCards(tl, d.captions);
  const all = cards.flatMap((c) => c.words.map((w) => w.text));
  assert.equal(all[0], 'Hi');
  assert.ok(!all.includes('Um,'));
});

test('scene resolution and zoom', () => {
  let d = base();
  d = addOverlay(d, broll, { start: 2, duration: 2 }).doc;
  d = addZoom(d, { start: 5, duration: 2, scale: 1.3 }).doc;
  const layout = layoutMain(d);
  const s = sceneAt(d, layout, 3);
  near(s.main!.sourceTime, 3);
  assert.equal(s.overlays.length, 1);
  near(s.overlays[0].sourceTime, 1);
  near(zoomAt(d, 6).scale, 1.3);
  near(zoomAt(d, 7.5).scale, 1);
  assert.equal(sceneAt(d, layout, 25).mainColor, '#000000');
});

test('cover and contain geometry', () => {
  // Landscape source into a vertical frame: crop the sides.
  const cover = layerGeometry(1920, 1080, 1080, 1920);
  near(cover.src.h, 1080);
  near(cover.src.w, 607.5);
  near(cover.src.x, (1920 - 607.5) / 2);
  near(cover.dst.w, 1080);
  const left = layerGeometry(1920, 1080, 1080, 1920, { fit: 'cover', focusX: 0, focusY: 0.5, scale: 1 });
  near(left.src.x, 0);
  const contain = layerGeometry(1920, 1080, 1080, 1920, { fit: 'contain', focusX: 0.5, focusY: 0.5, scale: 1 });
  near(contain.dst.w, 1080);
  near(contain.dst.h, 607.5);
  near(contain.dst.y, (1920 - 607.5) / 2);
});

test('silence detection adapts to the recording', () => {
  // 3 s: speech (-18 dB), 1 s room tone (-55 dB), speech, with a 30 ms click in the quiet part.
  const env = new Uint8Array(300);
  for (let i = 0; i < 300; i++) env[i] = i >= 100 && i < 200 ? 45 : 82;
  env[150] = 80;
  env[151] = 80;
  const th = autoThresholdDb(env);
  assert.ok(th > -55 && th < -30, `threshold ${th}`);
  const s = detectSilences(env, { minSilence: 0.4 });
  assert.equal(s.length, 1);
  near(s[0].start, 1.0);
  near(s[0].end, 2.0);
  // Constant level: nothing is silence.
  assert.equal(detectSilences(new Uint8Array(300).fill(70)).length, 0);
});

test('removing and restoring words by source span', () => {
  let d = base();
  // "Um," is word 2 (3.0-3.3); it follows a pause, so the cut is just the word.
  const span = wordSpan(words, 2, 2, 20);
  near(span.start, 3.0);
  near(span.end, 3.3);
  d = removeSourceSpans(d, 'talk', [span]);
  assert.equal(d.main.length, 2);
  near(mainDuration(d), 19.7);
  assert.deepEqual(wordsKept(d, 'talk', words).slice(0, 4), [true, true, false, true]);
  // Restoring joins the two pieces back into one clip.
  d = restoreSourceSpan(d, talk, { start: 3.0, end: 3.3 });
  assert.equal(d.main.length, 1);
  near(mainDuration(d), 20);
  assert.ok(wordsKept(d, 'talk', words).every(Boolean));
});

test('restore keeps later items in step and handles a span between two clips', () => {
  let d = base();
  d = addText(d, { text: 'late', start: 10, duration: 1 }).doc;
  d = removeSourceSpans(d, 'talk', [{ start: 2, end: 6 }]);
  near(d.graphics[0].start, 6);
  // Bring back only the middle of the hole: it becomes its own clip between the two.
  d = restoreSourceSpan(d, talk, { start: 3, end: 4 });
  assert.equal(d.main.length, 3);
  const ins = (d.main as MediaMainClip[]).map((c) => c.in);
  near(ins[0], 0);
  near(ins[1], 3);
  near(ins[2], 6);
  near(mainDuration(d), 17);
  near(d.graphics[0].start, 7);
  // Fill the rest: everything merges back.
  d = restoreSourceSpan(d, talk, { start: 2, end: 6 });
  assert.equal(d.main.length, 1);
  near(d.graphics[0].start, 10);
});

test('a false start takes its trailing pause with it', () => {
  const w: Word[] = [
    { t0: 0, t1: 1, text: 'Done.' },
    { t0: 2, t1: 2.5, text: 'I' },
    { t0: 2.5, t1: 3, text: 'want' },
    { t0: 4, t1: 4.5, text: 'I' },
    { t0: 4.5, t1: 5, text: 'want' },
  ];
  const span = wordSpan(w, 1, 2, 10);
  near(span.start, 2);
  near(span.end, 3.96);
});

test('cutting a word never eats into its neighbours', () => {
  // "you know" squeezed between "but," and "I'm" with no pause on the right.
  const w: Word[] = [
    { t0: 0.0, t1: 0.4, text: 'but,' },
    { t0: 0.8, t1: 0.9, text: 'you' },
    { t0: 0.9, t1: 1.0, text: 'know,' },
    { t0: 1.0, t1: 1.1, text: "I'm" },
    { t0: 1.1, t1: 1.4, text: 'sure' },
  ];
  // The quietest point is offered well inside "I'm"; the edge may only move a fifth of the way into a word.
  const span = wordSpan(w, 1, 2, 5, { quietest: (lo, hi) => hi });
  near(span.start, 0.8);
  assert.ok(span.end <= 1.0 + 0.2 * 0.1 + 1e-9);
  // Without loudness data the edges are the word boundaries.
  near(wordSpan(w, 1, 2, 5).end, 1.0);
});

test('a cut next to an earlier cut swallows the scrap between them', () => {
  const w: Word[] = [
    { t0: 0, t1: 1, text: 'One.' },
    { t0: 1.2, t1: 1.5, text: 'uh,' },
    { t0: 1.9, t1: 2.2, text: 'you' },
    { t0: 2.2, t1: 2.6, text: 'know' },
    { t0: 2.6, t1: 3, text: 'two.' },
  ];
  let d = base();
  d = removeSourceSpans(d, 'talk', [wordSpan(w, 1, 1, 20, { kept: wordsKept(d, 'talk', w) })]);
  d = removeSourceSpans(d, 'talk', [wordSpan(w, 2, 3, 20, { kept: wordsKept(d, 'talk', w) })]);
  // One hole from after "One." to "two.", not two holes with a silent piece in between.
  assert.equal(d.main.length, 2);
  assert.deepEqual(wordsKept(d, 'talk', w), [true, false, false, false, true]);
});

test('scraps left between cuts are dropped, deliberate short clips are not', () => {
  let d = base();
  // A wordless 0.2 s piece stranded between two cuts.
  d = rippleDelete(d, [{ start: 1.95, end: 2.4 }, { start: 2.6, end: 2.95 }]);
  assert.equal(d.main.length, 3);
  const tidy = dropScraps(base(), d, () => words);
  assert.equal(tidy.dropped, 1);
  assert.equal(tidy.doc.main.length, 2);
  // The same piece is kept when it was already there before the operation.
  assert.equal(dropScraps(d, d, () => words).dropped, 0);
  // A file with no speech has no scraps.
  assert.equal(dropScraps(base(), d, () => undefined).dropped, 0);
});

test('keeping passages rebuilds the cut and carries graphics with their words', () => {
  let d = base();
  d = addText(d, { text: 'on great', start: 4.6, duration: 0.3 }).doc;
  d = addText(d, { text: 'on hello', start: 1.1, duration: 0.5 }).doc;
  d = addZoom(d, { start: 3.35, duration: 0.2 }).doc;
  d = addAudio(d, song, { start: 0, role: 'music' }).doc;
  // Lead with "great." (word 7), then "Hello everyone." (words 0-1); "this is you know" goes.
  d = keepPassages(d, [
    { media: talk, words, from: 7, to: 7 },
    { media: talk, words, from: 0, to: 1 },
  ]);
  const l = layoutMain(d);
  assert.equal(l.length, 2);
  const [first, second] = d.main as MediaMainClip[];
  near(first.in, 4.5);
  near(second.in, 0.8);
  near(second.out, 2.1, 0.02);
  // "great." now opens the video, and its text moved there with it.
  const great = d.graphics.find((g) => g.props.text === 'on great')!;
  near(great.start, 0.1, 0.02);
  const hello = d.graphics.find((g) => g.props.text === 'on hello')!;
  near(hello.start, l[1].start + 0.3, 0.02);
  // The punch-in sat on "this", which was cut.
  assert.equal(d.zooms.length, 0);
  // Music is not tied to the words.
  assert.equal(d.audio.length, 1);
  near(d.audio[0].start, 0);
});

test('keeping passages does not bring back what was already cut', () => {
  let d = base();
  // "Um," (word 2) was removed earlier.
  d = removeSourceSpans(d, 'talk', [wordSpan(words, 2, 2, 20)]);
  d = keepPassages(d, [{ media: talk, words, from: 1, to: 4 }], () => words);
  assert.deepEqual(wordsKept(d, 'talk', words), [false, true, false, true, true, false, false, false]);
  assert.equal(d.main.length, 2);
});

test('moving a stretch of the main track to the front', () => {
  let d = base();
  d = addText(d, { text: 'on it', start: 13, duration: 1 }).doc;
  // Bring 12-15 s to the very start.
  d = moveMainRange(d, 12, 15, 0);
  const ins = (d.main as MediaMainClip[]).map((c) => [c.in, c.out]);
  assert.deepEqual(ins, [[12, 15], [0, 12], [15, 20]]);
  near(mainDuration(d), 20);
  near(d.graphics[0].start, 1);
  // And back again, after what is now 3-15 s.
  d = moveMainRange(d, 0, 3, 15);
  assert.deepEqual((d.main as MediaMainClip[]).map((c) => [c.in, c.out]), [[0, 12], [12, 15], [15, 20]]);
  near(d.graphics[0].start, 13);
  // A target inside the stretch changes nothing.
  assert.equal(moveMainRange(d, 12, 15, 13).main.length, d.main.length);
});

test('reordering clips moves what sits over them', () => {
  let d = splitAt(base(), 8);
  d = addText(d, { text: 'late', start: 10, duration: 1 }).doc;
  const [a, b] = d.main.map((c) => c.id);
  d = reorderMain(d, [b, a]);
  near(d.graphics[0].start, 2);
  d = moveMain(d, b, 1);
  near(d.graphics[0].start, 10);
});

test('choosing a take cuts the others and can be changed', () => {
  let d = base();
  const group = { id: 'tg1', mediaId: 'talk', takes: [{ from: 0, to: 1 }, { from: 3, to: 4 }], chosen: null };
  d.takes.push(group);
  d = chooseTake(d, group, 1, words, talk, 'cleaner');
  let kept = wordsKept(d, 'talk', words);
  assert.deepEqual(kept.slice(0, 5), [false, false, true, true, true]);
  assert.equal(d.takes[0].chosen, 1);
  d = chooseTake(d, d.takes[0], 0, words, talk);
  kept = wordsKept(d, 'talk', words);
  assert.deepEqual(kept.slice(0, 5), [true, true, true, false, false]);
});

test('duplicate, reorder and transitions', () => {
  let d = splitAt(base(), 8);
  const [a, b] = d.main.map((c) => c.id);
  d = reorderMain(d, [b, a]);
  assert.deepEqual(d.main.map((c) => c.id), [b, a]);
  d = setTransition(d, a, { type: 'fade', duration: 0.5 });
  const layout = layoutMain(d);
  const s = sceneAt(d, layout, layout[1].start + 0.25);
  assert.equal(s.transition?.type, 'fade');
  near(s.transition!.p, 0.5);
  assert.equal(sceneAt(d, layout, layout[1].start + 0.6).transition, undefined);
  const dup = duplicateItem(d, { kind: 'main', id: b });
  assert.equal(dup.doc.main.length, 3);
  near(mainDuration(dup.doc), 32);
  let g = addGraphic(d, { preset: 'popup', start: 1, duration: 2, name: 'Hook popup', createdBy: 'm1' });
  assert.equal(g.item.template, 'popup');
  assert.equal(g.item.name, 'Hook popup');
  const d2 = updateGraphic(g.doc, g.item.id, { props: { title: 'New' }, y: 0.3 });
  assert.equal(d2.graphics[0].props.title, 'New');
  assert.equal(d2.graphics[0].props.emoji, '💡');
  const copy = duplicateItem(d2, { kind: 'graphic', id: g.item.id });
  near(copy.doc.graphics[1].start, 3);
});

test('stutters and keyframes', () => {
  const d = base();
  const w: Word[] = [
    { t0: 1, t1: 1.2, text: 'I' },
    { t0: 1.3, t1: 1.5, text: 'I' },
    { t0: 1.5, t1: 2, text: 'think' },
  ];
  const tl = timelineWords(d, layoutMain(d), () => w);
  const { ranges } = stutterCutRanges(tl);
  assert.equal(ranges.length, 1);
  near(ranges[0].start, 1);
  near(ranges[0].end, 1.3);
  const baseT = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 };
  const kf = [{ t: 0, scale: 0.5, ease: 'linear' as const }, { t: 1, scale: 1.5, ease: 'linear' as const }];
  near(transformAt(baseT, kf, 0.5).scale, 1);
  near(transformAt(baseT, kf, 2).scale, 1.5);
  near(transformAt(baseT, kf, 0.5).x, 0.5);
});

test('face tracking moves the crop', () => {
  const track = { interval: 0.5, boxes: [[0.3, 0.4, 0.2, 0.3], [0.5, 0.4, 0.2, 0.3], null, [0.7, 0.4, 0.2, 0.3]] as ([number, number, number, number] | null)[] };
  near(faceAt(track, 0.25)!.x, 0.4);
  // A missing sample falls back to its known neighbour.
  near(faceAt(track, 1.0)!.x, 0.7);
  const f = framingAt({ fit: 'cover', focusX: 0.5, focusY: 0.5, scale: 1, track: true }, track, 0);
  near(f.focusX, 0.3);
  const g = layerGeometry(1920, 1080, 1080, 1920, f);
  near(g.src.x, 0.3 * 1920 - 607.5 / 2);
});

test('motion keyframes ease the framing between them', async () => {
  const { motionAt } = await import('../shared/timeline.ts');
  const base = { fit: 'cover' as const, focusX: 0.5, focusY: 0.5, scale: 1 };
  const motion = [{ t: 0, scale: 1 }, { t: 2, scale: 1.5, ease: 'linear' as const }];
  assert.equal(motionAt(base, motion, 0).scale, 1);
  assert.ok(Math.abs(motionAt(base, motion, 1).scale - 1.25) < 1e-6);
  assert.equal(motionAt(base, motion, 3).scale, 1.5);
  assert.equal(motionAt(base, motion, 1).focusX, 0.5);
});

test('keyframe upsert replaces the one at the same frame and keeps order', async () => {
  const { upsertKeyframe, removeKeyframe, motionPreset } = await import('../shared/ops.ts');
  let list = upsertKeyframe([{ t: 1, scale: 1.2 }], { t: 0, scale: 1 }, 30);
  assert.deepEqual(list.map((k) => k.t), [0, 1]);
  list = upsertKeyframe(list, { t: 1.01, scale: 1.4 }, 30);
  assert.equal(list.length, 2);
  assert.equal(list[1].scale, 1.4);
  assert.equal(removeKeyframe(list, 1.01, 30)?.length, 1);
  const push = motionPreset(undefined, 4, 'push-in', 0.2);
  assert.equal(push[1].t, 4);
  assert.ok(Math.abs((push[1].scale ?? 0) - 1.2) < 1e-9);
});
