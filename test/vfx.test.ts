import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { drawFlare, drawLightLeak, drawParticles, rng } from '../shared/vfx.ts';
import type { Ctx2D } from '../shared/graphics.ts';

test('the seeded random source repeats exactly and differs by seed', () => {
  const a = rng(7);
  const b = rng(7);
  const c = rng(8);
  const xs = [a(), a(), a()];
  assert.deepEqual([b(), b(), b()], xs);
  assert.notDeepEqual([c(), c(), c()], xs);
  assert.ok(xs.every((v) => v >= 0 && v < 1));
});

test('effects draw the same pixels for the same time and seed, and change with time', () => {
  const render = (fn: typeof drawParticles, props: Record<string, unknown>, local: number) => {
    const c = createCanvas(160, 284);
    const ctx = c.getContext('2d') as unknown as Ctx2D;
    ctx.fillStyle = '#202020';
    ctx.fillRect(0, 0, 160, 284);
    fn({ ctx, props, local, frame: { x: 0, y: 0, w: 160, h: 284 }, u: 160 / 1080 });
    return Buffer.from((ctx as unknown as CanvasRenderingContext2D).getImageData(0, 0, 160, 284).data);
  };
  for (const [fn, props] of [
    [drawParticles, { kind: 'confetti', seed: 3 }],
    [drawParticles, { kind: 'sparks', seed: 1 }],
    [drawLightLeak, { hue: 30, intensity: 1 }],
    [drawFlare, { intensity: 1 }],
  ] as const) {
    const a = render(fn as typeof drawParticles, props, 1.2);
    const b = render(fn as typeof drawParticles, props, 1.2);
    const later = render(fn as typeof drawParticles, props, 2.4);
    assert.ok(a.equals(b), 'same input, same frame');
    assert.ok(!a.equals(later), 'time moves the effect');
    assert.ok(a.some((v, i) => i % 4 !== 3 && v !== 0x20), 'something was drawn');
  }
});
