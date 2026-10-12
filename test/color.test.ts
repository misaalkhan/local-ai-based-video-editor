import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradePixels, gradeTables, needsGrade, parseCube, sampleCurve } from '../shared/color.ts';

test('no settings means an identity grade', () => {
  const t = gradeTables({});
  for (let i = 0; i < 256; i++) assert.equal(t.r[i], i);
  assert.equal(needsGrade({ brightness: 1.1 }), false);
  assert.equal(needsGrade({ exposure: 0.3 }), true);
});

test('a curve passes through its points and never overshoots', () => {
  const c = sampleCurve([[0, 0], [0.25, 0.1], [0.75, 0.9], [1, 1]]);
  assert.equal(c[0], 0);
  assert.equal(c[255], 1);
  assert.ok(Math.abs(c[64] - 0.1) < 0.02);
  for (let i = 1; i < 256; i++) assert.ok(c[i] >= c[i - 1] - 1e-6, 'monotone');
});

test('exposure brightens and temperature warms', () => {
  const px = new Uint8ClampedArray([100, 100, 100, 255]);
  gradePixels(px, { exposure: 1 });
  assert.ok(px[0] > 180 && px[0] === px[1] && px[1] === px[2]);
  const warm = new Uint8ClampedArray([128, 128, 128, 255]);
  gradePixels(warm, { temperature: 1 });
  assert.ok(warm[0] > warm[2], 'red above blue');
});

test('a .cube LUT parses and an identity cube changes nothing', () => {
  const n = 2;
  let text = `TITLE "id"\nLUT_3D_SIZE ${n}\n`;
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) text += `${r / (n - 1)} ${g / (n - 1)} ${b / (n - 1)}\n`;
  const lut = parseCube(text);
  assert.equal(lut.size, 2);
  const px = new Uint8ClampedArray([30, 200, 90, 255]);
  gradePixels(px, { lut: 'id' }, lut);
  assert.deepEqual([...px], [30, 200, 90, 255]);
});

test('HSL on a band shifts only that band', () => {
  const red = new Uint8ClampedArray([220, 40, 40, 255]);
  const blue = new Uint8ClampedArray([40, 40, 220, 255]);
  const fx = { hsl: { red: { sat: -1 } } };
  gradePixels(red, fx);
  gradePixels(blue, fx);
  assert.ok(Math.abs(red[0] - red[1]) < 30, 'red desaturated');
  assert.ok(blue[2] - blue[0] > 150, 'blue untouched');
});
