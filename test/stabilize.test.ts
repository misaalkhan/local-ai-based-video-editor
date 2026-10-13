import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPath, proxyFps } from '../server/stabilize.ts';
import { clipGeometry, layerGeometry, stabMargin, stabShift } from '../shared/timeline.ts';
import type { MotionTrack } from '../shared/types.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('buildPath turns per-frame registration into the content path, one sample per frame', () => {
  // The tool prints times to 4 decimals; that must not merge or double samples.
  const rows = [0, 1, 2, 3, 4, 5].map((k) => ({ t: Number((k / 30).toFixed(4)), dx: k === 0 ? 0 : -12, dy: k === 0 ? 0 : 6 }));
  const track = buildPath(rows, 1200, 600, 30);
  assert.equal(track.path.length, 6);
  near(track.interval, 1 / 30);
  // The picture had to move left 12 px to line up with the frame before: the content moved right by 1% a frame.
  near(track.path[1][0], 0.01);
  near(track.path[5][0], 0.05);
  near(track.path[5][1], -0.05);
});

test('buildPath ignores failed matches and holds the position over dropped frames', () => {
  const rows = [
    { t: 0, dx: 0, dy: 0 },
    { t: 1 / 30, dx: -500, dy: 300 },
    { t: 2 / 30, dx: -12, dy: 0 },
    { t: 5 / 30, dx: -12, dy: 0 },
  ];
  const track = buildPath(rows, 1200, 600, 30);
  assert.equal(track.path.length, 6);
  near(track.path[1][0], 0);
  near(track.path[2][0], 0.01);
  near(track.path[3][0], 0.01);
  near(track.path[5][0], 0.02);
  assert.equal(proxyFps(59.94), 30);
  assert.equal(proxyFps(24), 24);
});

test('the stabilising shift is the shake around the smoothed path, within the margin', () => {
  // A 1% jitter alternating every frame on top of a slow drift.
  const path: [number, number][] = [];
  for (let i = 0; i < 120; i++) path.push([i * 0.0005 + (i % 2 ? 0.01 : -0.01), 0]);
  const track: MotionTrack = { interval: 1 / 30, path };
  const s = stabShift(track, 60 / 30, 0.5);
  near(s.x, -0.01, 0.002);
  near(s.y, 0);
  const s1 = stabShift(track, 61 / 30, 0.5);
  near(s1.x, 0.01, 0.002);
  // A big jump is held to the margin.
  path[80] = [0.5, 0];
  const big = stabShift({ interval: 1 / 30, path }, 80 / 30, 1);
  near(big.x, stabMargin(1));
});

test('clipGeometry zooms by the margin and moves the crop with the content', () => {
  const track: MotionTrack = { interval: 1 / 30, path: [[0, 0], [0.02, -0.01], [0, 0], [0.02, -0.01], [0, 0]] };
  const plain = layerGeometry(1280, 720, 1080, 1920);
  const steady = clipGeometry(1280, 720, 1080, 1920, undefined, { track, t: 1 / 30, strength: 0.5 });
  const m = stabMargin(0.5);
  near(steady.src.w, plain.src.w * (1 - 2 * m), 1e-6);
  // Between frames 0 and 1 the content moves 2% right and 1% up: the window moves with it (the smooth path is the same for both).
  const centred = clipGeometry(1280, 720, 1080, 1920, undefined, { track, t: 0, strength: 0.5 });
  near(steady.src.x - centred.src.x, 0.02 * 1280, 0.5);
  near(steady.src.y - centred.src.y, -0.01 * 720, 0.5);
  // Off means plain geometry.
  assert.deepEqual(clipGeometry(1280, 720, 1080, 1920, undefined, { track, t: 0, strength: 0 }), plain);
});
