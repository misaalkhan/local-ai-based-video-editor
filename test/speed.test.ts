import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, freezeFrame, insertMain, makeClip, rampPreset, rippleDelete, splitAt, updateClip } from '../shared/ops.ts';
import { layoutMain, localAt, maxExtend, sceneAt, sourceAt, sourceRange, speedAt, srcDuration } from '../shared/timeline.ts';
import { tempoPieces } from '../server/export/audio.ts';
import type { SourceClip } from '../shared/types.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const talk = { id: 'talk', kind: 'video' as const, duration: 20 };

const plain: SourceClip = { id: 'a', mediaId: 'talk', in: 2, out: 6, speed: 2, volume: 1 };
const ramped: SourceClip = {
  id: 'b',
  mediaId: 'talk',
  in: 2,
  out: 8,
  speed: 1,
  volume: 1,
  ramp: [
    { t: 3, speed: 1 },
    { t: 4, speed: 0.25 },
    { t: 5, speed: 0.25 },
    { t: 7, speed: 2 },
  ],
};

test('plain speed maps time as before', () => {
  near(srcDuration(plain), 2);
  near(sourceAt(plain, 0.5), 3);
  near(localAt(plain, 5), 1.5);
  near(speedAt(plain, 4), 2);
});

test('a ramp integrates 1/speed and inverts exactly', () => {
  // 2-3 at 1x (1 s), 3-4 from 1x to 0.25x (ln(0.25)/-0.75 = 1.848 s), 4-5 at 0.25x (4 s), 5-7 from 0.25x to 2x (ln(8)/0.875 = 2.376 s), 7-8 at 2x (0.5 s).
  const expected = 1 + Math.log(0.25) / -0.75 + 4 + Math.log(8) / 0.875 + 0.5;
  near(srcDuration(ramped), expected, 1e-9);
  for (const s of [2, 2.5, 3, 3.3, 4, 4.7, 5, 6.1, 7, 7.9, 8]) near(sourceAt(ramped, localAt(ramped, s)), s, 1e-9);
  for (const l of [0, 0.3, 1, 2.5, 4, 6, 8, expected]) near(localAt(ramped, sourceAt(ramped, l)), l, 1e-9);
  near(speedAt(ramped, 3.5), 0.625);
  near(speedAt(ramped, 1), 1);
  near(speedAt(ramped, 9), 2);
  // Beyond the ends the end speeds carry on.
  near(sourceAt(ramped, -1), 1);
  near(sourceAt(ramped, expected + 1), 10);
  near(maxExtend(ramped, 'head', 20), 2);
  near(maxExtend(ramped, 'tail', 20), 6);
});

test('reverse walks the same curve backwards', () => {
  const r = { ...ramped, reverse: true };
  const d = srcDuration(r);
  near(d, srcDuration(ramped));
  near(sourceAt(r, 0), 8);
  near(sourceAt(r, d), 2);
  near(sourceAt(r, 0.25), 7.5);
  near(localAt(r, 7.5), 0.25);
  near(localAt(r, sourceAt(r, 3)), 3, 1e-9);
  const range = sourceRange(r, 0, 0.5);
  near(range.in, 7);
  near(range.out, 8);
  near(maxExtend(r, 'head', 20), 6);
  near(maxExtend(r, 'tail', 20), 2);
});

test('ramp presets sit around the moment and sanitise through updateClip', () => {
  const clip = makeClip(talk, 30, { in: 1, duration: 6 });
  const ramp = rampPreset(clip, 4, 'slow-moment');
  assert.deepEqual(ramp.map((k) => k.t), [3.55, 3.85, 4.15, 4.45]);
  assert.deepEqual(ramp.map((k) => k.speed), [1, 0.3, 0.3, 1]);
  let d = createDoc('p', 'Test');
  d = insertMain(d, { kind: 'media', ...clip });
  d = updateClip(d, 'main', clip.id, { ramp }, talk.duration);
  const c = d.main[0] as SourceClip;
  assert.equal(c.ramp?.length, 4);
  // Longer than 6 s now, and still a whole number of frames.
  const dur = srcDuration(c);
  assert.ok(dur > 6.5 && dur < 8, `${dur}`);
  near(dur * 30, Math.round(dur * 30), 1e-6);
  // A plain speed replaces the ramp.
  d = updateClip(d, 'main', clip.id, { speed: 2 }, talk.duration);
  assert.equal((d.main[0] as SourceClip).ramp, undefined);
  near(srcDuration(d.main[0] as SourceClip), 3);
});

test('split and ripple delete keep a ramped clip on its curve', () => {
  let d = createDoc('p', 'Test');
  d = insertMain(d, { kind: 'media', ...ramped });
  const before = srcDuration(ramped);
  d = splitAt(d, 2, { kind: 'main', id: 'b' });
  assert.equal(d.main.length, 2);
  const [x, y] = d.main as SourceClip[];
  near(x.out, sourceAt(ramped, 2));
  near(y.in, x.out);
  near(srcDuration(x) + srcDuration(y), before, 1e-6);
  near(srcDuration(x), 2, 1e-6);
  // Cutting 1 s out of the slow part removes 0.25 s of source.
  d = rippleDelete(d, [{ start: 3, end: 4 }]);
  const l = layoutMain(d);
  // Pieces are packed on whole frames, so allow a frame of rounding.
  near(l[l.length - 1].end, before - 1, 1 / 30 + 1e-6);
  assert.equal(d.main.length, 3);
  const slow = d.main[2] as SourceClip;
  near(slow.in, sourceAt(ramped, 4), 0.02);
  // The scene reads source times through the ramp.
  const scene = sceneAt(d, l, 3.5);
  near(scene.main!.sourceTime, sourceAt(ramped, 4.5), 0.01);
});

test('a reversed clip splits into two reversed halves that play in order', () => {
  const r = { ...plain, reverse: true };
  let d = createDoc('p', 'Test');
  d = insertMain(d, { kind: 'media', ...r });
  d = splitAt(d, 0.5, { kind: 'main', id: 'a' });
  const [x, y] = d.main as SourceClip[];
  // First on the timeline shows the later source (6 down to 5), then 5 down to 2.
  near(x.in, 5);
  near(x.out, 6);
  near(y.in, 2);
  near(y.out, 5);
  assert.ok(x.reverse && y.reverse);
});

test('a freeze frame splits the clip and holds a still between the halves', () => {
  let d = createDoc('p', 'Test');
  const clip = makeClip(talk, 30, { in: 0, duration: 4 });
  d = insertMain(d, { kind: 'media', ...clip, fx: { look: 'warm' } as SourceClip['fx'] });
  d = freezeFrame(d, 1.5, { id: 'still', kind: 'image', duration: 0 }, 2);
  const l = layoutMain(d);
  assert.equal(l.length, 3);
  const still = l[1].clip as SourceClip;
  assert.equal(still.mediaId, 'still');
  near(l[1].start, 1.5);
  near(l[1].end, 3.5);
  near(l[2].start, 3.5);
  near((l[2].clip as SourceClip).in, 1.5);
  assert.deepEqual(still.fx, { look: 'warm' });
  near(l[2].end, 6);
});

test('ramped audio is cut into tempo pieces that add up to the picture', () => {
  const pieces = tempoPieces(ramped);
  assert.ok(pieces.length >= 6, `${pieces.length}`);
  near(pieces[0].a, 2);
  near(pieces[pieces.length - 1].b, 8);
  for (let i = 0; i + 1 < pieces.length; i++) near(pieces[i].b, pieces[i + 1].a);
  const plays = pieces.reduce((s, p) => s + (p.b - p.a) / p.tempo, 0);
  near(plays, srcDuration(ramped), 1e-6);
  assert.deepEqual(tempoPieces(plain).length, 1);
});

test('preset points stay inside a short clip, nearest to the moment', () => {
  const clip = makeClip(talk, 30, { in: 2, duration: 1 });
  const head = rampPreset(clip, 2.1, 'hero');
  assert.deepEqual(head.map((k) => [k.t, k.speed]), [[2, 0.3], [2.3, 0.3], [3, 2]]);
  const tail = rampPreset(clip, 2.95, 'slow-moment');
  assert.deepEqual(tail.map((k) => [k.t, k.speed]), [[2.5, 1], [2.8, 0.3], [3, 0.3]]);
});

test('volume keyframes shape the gain and become an ffmpeg expression', async () => {
  const { volumeKeyAt, clipGainAt } = await import('../shared/timeline.ts');
  const { volumeKeysExpr } = await import('../server/export/audio.ts');
  const keys = [{ t: 1, gain: 1 }, { t: 2, gain: 0.25 }, { t: 3, gain: 1 }];
  near(volumeKeyAt(keys, 0), 1);
  near(volumeKeyAt(keys, 1.5), 0.625);
  near(volumeKeyAt(keys, 2), 0.25);
  near(volumeKeyAt(keys, 9), 1);
  const clip = { ...plain, speed: 1, volume: 0.8, volumeKeys: keys };
  near(clipGainAt(clip, 10, 12), 0.8 * 0.25);
  const expr = volumeKeysExpr(keys);
  assert.ok(expr.startsWith('if(lt(t,1),1,'));
  assert.ok(expr.includes('(1+(0.25-1)*(t-1)/1)'));
  assert.ok(!/[^0-9a-z(),.+*/\-]/i.test(expr), expr);
});
