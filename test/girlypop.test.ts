import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { drawParticles, PARTICLE_KINDS } from '../shared/vfx.ts';
import type { Ctx2D } from '../shared/graphics.ts';
import { GRAPHIC_PRESETS } from '../shared/graphics.ts';
import { CAPTION_STYLES, LOOKS, drawCaption } from '../shared/draw.ts';
import { CAPTION_PRESETS } from '../shared/ops.ts';
import { FONT_FILES, FONT_NOTES, FONT_FAMILIES } from '../shared/fonts.ts';
import { CHICK_FLICKS, findQuotes, GIRLY_REACTIONS } from '../shared/chickflicks.ts';
import { BUILT_IN_RECIPES } from '../server/studio.ts';
import type { CaptionStyle } from '../shared/types.ts';

const render = (props: Record<string, unknown>, local: number) => {
  const c = createCanvas(160, 284);
  const ctx = c.getContext('2d') as unknown as Ctx2D;
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, 160, 284);
  drawParticles({ ctx, props, local, frame: { x: 0, y: 0, w: 160, h: 284 }, u: 160 / 1080 });
  return Buffer.from((ctx as unknown as CanvasRenderingContext2D).getImageData(0, 0, 160, 284).data);
};

test('the girlypop particles are deterministic, move with time and draw something', () => {
  for (const kind of ['hearts', 'sparkles', 'bubbles', 'butterflies', 'glitter']) {
    assert.ok(PARTICLE_KINDS.some((k) => k.id === kind), `${kind} listed`);
    const a = render({ kind, seed: 5 }, 1.0);
    const b = render({ kind, seed: 5 }, 1.0);
    const later = render({ kind, seed: 5 }, 2.2);
    assert.ok(a.equals(b), `${kind}: same input, same frame`);
    assert.ok(!a.equals(later), `${kind}: time moves it`);
    assert.ok(a.some((v, i) => i % 4 !== 3 && v !== 0x20), `${kind}: something was drawn`);
    assert.ok(GRAPHIC_PRESETS[kind]?.template === 'particles', `${kind} has a preset`);
  }
  assert.equal(GRAPHIC_PRESETS.pinkleak.template, 'lightleak');
});

test('every caption style has a drawing spec and a preset, and the girly ones render', () => {
  const styles = Object.keys(CAPTION_STYLES) as CaptionStyle[];
  for (const s of styles) assert.ok(CAPTION_PRESETS[s], `preset for ${s}`);
  for (const s of Object.keys(CAPTION_PRESETS)) assert.ok(CAPTION_STYLES[s as CaptionStyle], `spec for ${s}`);
  const card = { start: 0, end: 2, words: [{ text: 'so', start: 0, key: 'a1' }, { text: 'cute', start: 0.6, key: 'a2' }, { text: 'omg', start: 1.2, key: 'a3' }] };
  for (const style of ['bubble', 'coquette', 'sparkle', 'y2k', 'kawaii'] as CaptionStyle[]) {
    const c = createCanvas(360, 640);
    const ctx = c.getContext('2d') as unknown as Ctx2D;
    ctx.fillStyle = '#202020';
    ctx.fillRect(0, 0, 360, 640);
    const s = { enabled: true, y: 0.5, size: 1, edits: {}, ...CAPTION_PRESETS[style] };
    drawCaption(ctx, card as never, 0.8, s, 360, 640, 1);
    const px = (ctx as unknown as CanvasRenderingContext2D).getImageData(0, 0, 360, 640).data;
    assert.ok(px.some((v, i) => i % 4 !== 3 && v !== 0x20), `${style} drew something`);
  }
});

test('the girlypop looks only use known grading fields', () => {
  const known = new Set(['brightness', 'contrast', 'saturation', 'warmth', 'tint', 'temperature', 'bloom', 'vibrance', 'highlights', 'shadows', 'whites', 'blacks', 'grain', 'vignette', 'clarity', 'rgbSplit', 'hsl', 'sepia', 'blur', 'letterbox', 'grayscale']);
  for (const id of ['blush', 'peach', 'cottoncandy', 'barbie', 'vanilla', 'rosy', 'glam', 'y2k']) {
    assert.ok(LOOKS[id], `look ${id}`);
    for (const k of Object.keys(LOOKS[id].fx)) assert.ok(known.has(k), `${id}.${k}`);
  }
});

test('the girlypop text presets use bundled fonts, and the fonts script fetches every bundled file', () => {
  for (const id of ['bubblegum', 'coquette', 'y2k', 'pinkneon', 'burnbook', 'pinksticker', 'lovenote', 'pinkhook', 'princess', 'diary', 'cherry', 'twinkle']) {
    const p = GRAPHIC_PRESETS[id];
    assert.equal(p.template, 'text', id);
    assert.ok(FONT_FAMILIES.includes(String(p.props.font)), `${id} font ${String(p.props.font)}`);
  }
  assert.equal(GRAPHIC_PRESETS.quotecard.template, 'popup');
  const script = fs.readFileSync(new URL('../scripts/fonts.sh', import.meta.url), 'utf8');
  for (const f of FONT_FILES) {
    assert.ok(script.includes(` ${f.file}`), `fonts.sh fetches ${f.file}`);
    assert.ok(FONT_NOTES[f.family], `note for ${f.family}`);
  }
});

test('chick flick quotes are findable by film, by words of the line, or both', () => {
  assert.ok(CHICK_FLICKS.length >= 40);
  assert.ok(GIRLY_REACTIONS.length >= 10);
  for (const f of CHICK_FLICKS) {
    assert.ok(f.quotes.length >= 1 && f.gif && f.emoji && f.year > 1900, f.id);
    assert.equal(new Set(f.quotes).size, f.quotes.length, `${f.id} has no duplicate lines`);
  }
  assert.equal(findQuotes('mean girls fetch')[0].quote, 'That’s so fetch');
  assert.equal(findQuotes("what like it's hard")[0].film.id, 'legally-blonde');
  assert.equal(findQuotes('wednesdays pink')[0].quote, 'On Wednesdays we wear pink');
  assert.equal(findQuotes('xoxo')[0].film.id, 'gossip-girl');
  assert.equal(findQuotes('clueless')[0].film.id, 'clueless');
  assert.equal(findQuotes('zzzz qqqq').length, 0);
});

test('the girlypop and coquette recipes point at real styles', () => {
  for (const id of ['girlypop', 'coquette']) {
    const r = BUILT_IN_RECIPES.find((x) => x.id === id)!;
    assert.ok(r, id);
    assert.ok(CAPTION_STYLES[r.captions.style], `${id} captions`);
    assert.ok(GRAPHIC_PRESETS[r.hookStyle!]?.template === 'text', `${id} hook style`);
    assert.ok(FONT_FAMILIES.includes(r.hookFont!), `${id} hook font`);
    assert.ok(FONT_FAMILIES.includes(r.captions.font!), `${id} caption font`);
  }
});
