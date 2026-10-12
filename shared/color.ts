// Colour grading beyond what a CSS filter can do: exposure, highlights and
// shadows, whites and blacks, temperature and tint, vibrance, tone curves,
// HSL by hue range, and 3D LUTs (.cube). Everything channel-separable is
// folded into three 256-entry tables once per frame; the rest runs per pixel.
// The same code grades the preview and the export.

import type { ClipFx } from './types.ts';

export type CurvePoint = [number, number];

export interface Curves {
  rgb?: CurvePoint[];
  r?: CurvePoint[];
  g?: CurvePoint[];
  b?: CurvePoint[];
}

/** Per hue range: shift of hue (-1..1 = ±30°), saturation and luminance (-1..1). */
export interface HslBand {
  hue?: number;
  sat?: number;
  lum?: number;
}

export const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export type HslBandName = (typeof HSL_BANDS)[number];
/** Centre of each band on the hue circle, in degrees. */
export const HSL_CENTRES: Record<HslBandName, number> = { red: 0, orange: 30, yellow: 60, green: 120, aqua: 180, blue: 240, purple: 275, magenta: 315 };

export interface Lut3D {
  size: number;
  /** size³ RGB triples, 0..1, red fastest. */
  data: Float32Array;
}

export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Does this clip need the per-pixel pass, or does a CSS filter cover it? */
export function needsGrade(fx: ClipFx | undefined): boolean {
  if (!fx) return false;
  if (fx.exposure || fx.highlights || fx.shadows || fx.whites || fx.blacks || fx.temperature || fx.tint || fx.vibrance) return true;
  if (fx.curves && Object.values(fx.curves).some((c) => c && c.length >= 2 && !isIdentityCurve(c))) return true;
  if (fx.hsl && Object.values(fx.hsl).some((b) => b && (b.hue || b.sat || b.lum))) return true;
  if (fx.lut && (fx.lutAmount ?? 1) > 0) return true;
  return false;
}

function isIdentityCurve(c: CurvePoint[]): boolean {
  return c.every(([x, y]) => Math.abs(x - y) < 1e-6);
}

/**
 * A smooth curve through the points (monotone cubic, so it never overshoots
 * or dips between points), sampled at 256 inputs. Points are (in, out) in 0..1.
 */
export function sampleCurve(points: CurvePoint[] | undefined): Float32Array {
  const out = new Float32Array(256);
  const pts = (points && points.length >= 2 ? [...points] : [[0, 0], [1, 1]] as CurvePoint[]).sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const xs = pts.map((p) => clamp01(p[0]));
  const ys = pts.map((p) => clamp01(p[1]));
  // Fritsch–Carlson tangents.
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  const m: number[] = new Array(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    if (x <= xs[0]) {
      out[k] = ys[0];
      continue;
    }
    if (x >= xs[n - 1]) {
      out[k] = ys[n - 1];
      continue;
    }
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = Math.max(1e-6, xs[i + 1] - xs[i]);
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    out[k] = clamp01(h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1]);
  }
  return out;
}

export interface GradeTables {
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
}

/**
 * The channel-separable part of the grade as three lookup tables: exposure,
 * whites and blacks (a levels stretch), temperature and tint (channel gains),
 * then the curves.
 */
export function gradeTables(fx: ClipFx): GradeTables {
  const exposure = Math.pow(2, fx.exposure ?? 0);
  // Whites raise or lower the top of the range, blacks the bottom.
  const black = -(fx.blacks ?? 0) * 0.15;
  const white = 1 + (fx.whites ?? 0) * 0.2;
  // Warm pushes red up and blue down; tint pushes magenta (red+blue) against green.
  const temp = (fx.temperature ?? 0) * 0.18;
  const tint = (fx.tint ?? 0) * 0.12;
  const gains = [1 + temp + tint * 0.5, 1 - tint, 1 - temp + tint * 0.5];
  const master = sampleCurve(fx.curves?.rgb);
  const per = [sampleCurve(fx.curves?.r), sampleCurve(fx.curves?.g), sampleCurve(fx.curves?.b)];
  const tables = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < 256; i++) {
      let v = (i / 255) * exposure * gains[c];
      v = (v - black) / Math.max(1e-3, white - black);
      v = clamp01(v);
      v = master[Math.round(v * 255)];
      v = per[c][Math.round(v * 255)];
      tables[c][i] = Math.round(v * 255);
    }
  }
  return { r: tables[0], g: tables[1], b: tables[2] };
}

/** Writes [h (degrees), s, l] into out; no allocation, since this runs per pixel. */
function rgbToHsl(r: number, g: number, b: number, out: Float32Array): void {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    out[0] = 0;
    out[1] = 0;
    out[2] = l;
    return;
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  out[0] = h * 60;
  out[1] = s;
  out[2] = l;
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number, out: Float32Array): void {
  if (s <= 0) {
    out[0] = l;
    out[1] = l;
    out[2] = l;
    return;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hh = (((h % 360) + 360) % 360) / 360;
  out[0] = hue2rgb(p, q, hh + 1 / 3);
  out[1] = hue2rgb(p, q, hh);
  out[2] = hue2rgb(p, q, hh - 1 / 3);
}

/** Weight of a hue (degrees) in each band: a soft triangle around the band centre. */
function bandWeights(h: number, out: Float32Array): void {
  for (let i = 0; i < HSL_BANDS.length; i++) {
    const c = HSL_CENTRES[HSL_BANDS[i]];
    let d = Math.abs(h - c);
    if (d > 180) d = 360 - d;
    out[i] = d >= 45 ? 0 : 1 - d / 45;
  }
}

/** Parse a .cube file (Adobe/Resolve format). */
export function parseCube(text: string): Lut3D {
  let size = 0;
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^LUT_3D_SIZE\s+(\d+)/i.exec(line);
    if (m) {
      size = Number(m[1]);
      continue;
    }
    if (/^[A-Z_]/i.test(line)) continue;
    const parts = line.split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.every((v) => Number.isFinite(v))) values.push(parts[0], parts[1], parts[2]);
  }
  if (!size || values.length < size * size * size * 3) throw new Error('not a 3D .cube file');
  return { size, data: Float32Array.from(values.slice(0, size * size * size * 3)) };
}

/** Trilinear lookup into a 3D LUT. r, g, b in 0..1; writes into out. */
function lutLookup(lut: Lut3D, r: number, g: number, b: number, out: Float32Array): void {
  const n = lut.size;
  const max = n - 1;
  const fr = r * max;
  const fg = g * max;
  const fb = b * max;
  const r0 = Math.min(max - 1, Math.floor(fr));
  const g0 = Math.min(max - 1, Math.floor(fg));
  const b0 = Math.min(max - 1, Math.floor(fb));
  const tr = fr - r0;
  const tg = fg - g0;
  const tb = fb - b0;
  const d = lut.data;
  const at = (ri: number, gi: number, bi: number) => 3 * (ri + n * (gi + n * bi));
  for (let c = 0; c < 3; c++) {
    const c000 = d[at(r0, g0, b0) + c];
    const c100 = d[at(r0 + 1, g0, b0) + c];
    const c010 = d[at(r0, g0 + 1, b0) + c];
    const c110 = d[at(r0 + 1, g0 + 1, b0) + c];
    const c001 = d[at(r0, g0, b0 + 1) + c];
    const c101 = d[at(r0 + 1, g0, b0 + 1) + c];
    const c011 = d[at(r0, g0 + 1, b0 + 1) + c];
    const c111 = d[at(r0 + 1, g0 + 1, b0 + 1) + c];
    const c00 = c000 + (c100 - c000) * tr;
    const c10 = c010 + (c110 - c010) * tr;
    const c01 = c001 + (c101 - c001) * tr;
    const c11 = c011 + (c111 - c011) * tr;
    const c0 = c00 + (c10 - c00) * tg;
    const c1 = c01 + (c11 - c01) * tg;
    out[c] = c0 + (c1 - c0) * tb;
  }
}

/**
 * Grade pixels in place. `lut` is the 3D LUT the clip names, when loaded.
 */
export function gradePixels(data: Uint8ClampedArray, fx: ClipFx, lut?: Lut3D | null): void {
  const t = gradeTables(fx);
  const highlights = fx.highlights ?? 0;
  const shadows = fx.shadows ?? 0;
  const vibrance = fx.vibrance ?? 0;
  const bands = fx.hsl && HSL_BANDS.map((name) => fx.hsl![name]).some((b) => b && (b.hue || b.sat || b.lum)) ? HSL_BANDS.map((name) => fx.hsl![name] ?? {}) : null;
  const useLut = lut && (fx.lutAmount ?? 1) > 0 ? lut : null;
  const lutAmount = useLut ? clamp01(fx.lutAmount ?? 1) : 0;
  const w = new Float32Array(HSL_BANDS.length);
  const tmp = new Float32Array(3);
  const hsl = new Float32Array(3);
  const tone = highlights !== 0 || shadows !== 0;
  const perPixel = tone || vibrance !== 0 || bands || useLut;
  for (let i = 0; i < data.length; i += 4) {
    let r = t.r[data[i]] / 255;
    let g = t.g[data[i + 1]] / 255;
    let b = t.b[data[i + 2]] / 255;
    if (!perPixel) {
      data[i] = Math.round(r * 255);
      data[i + 1] = Math.round(g * 255);
      data[i + 2] = Math.round(b * 255);
      continue;
    }
    if (tone) {
      // Highlights act on the bright part of the range, shadows on the dark part, each with a soft mask.
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const hiMask = lum * lum;
      const loMask = (1 - lum) * (1 - lum);
      const k = 1 - highlights * 0.5 * hiMask + shadows * 0.5 * loMask;
      r = clamp01(lum + (r - lum) + (k - 1) * lum);
      g = clamp01(lum + (g - lum) + (k - 1) * lum);
      b = clamp01(lum + (b - lum) + (k - 1) * lum);
    }
    if (vibrance !== 0) {
      // Vibrance saturates the muted colours more than the already vivid ones.
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max - min;
      const avg = (r + g + b) / 3;
      const k = 1 + vibrance * (1 - sat) * 0.9;
      r = clamp01(avg + (r - avg) * k);
      g = clamp01(avg + (g - avg) * k);
      b = clamp01(avg + (b - avg) * k);
    }
    if (bands) {
      rgbToHsl(r, g, b, hsl);
      const h = hsl[0];
      const s = hsl[1];
      const l = hsl[2];
      if (s > 0.02) {
        bandWeights(h, w);
        let dh = 0;
        let ds = 0;
        let dl = 0;
        for (let k = 0; k < bands.length; k++) {
          if (!w[k]) continue;
          dh += w[k] * (bands[k].hue ?? 0) * 30;
          ds += w[k] * (bands[k].sat ?? 0);
          dl += w[k] * (bands[k].lum ?? 0);
        }
        if (dh || ds || dl) {
          const s2 = clamp01(s * (1 + ds));
          const l2 = clamp01(l + dl * 0.25 * (dl > 0 ? 1 - l : l) * 2);
          hslToRgb(h + dh, s2, l2, tmp);
          r = tmp[0];
          g = tmp[1];
          b = tmp[2];
        }
      }
    }
    if (useLut) {
      lutLookup(useLut, r, g, b, tmp);
      r = r + (clamp01(tmp[0]) - r) * lutAmount;
      g = g + (clamp01(tmp[1]) - g) * lutAmount;
      b = b + (clamp01(tmp[2]) - b) * lutAmount;
    }
    data[i] = Math.round(r * 255);
    data[i + 1] = Math.round(g * 255);
    data[i + 2] = Math.round(b * 255);
  }
}

// ---------------------------------------------------------------------------
// Baking: the whole grade as one 3D table, so a frame costs one trilinear
// lookup per pixel whatever the settings are. Baked once per distinct grade.

const BAKE_SIZE = 33;
const baked = new Map<string, Lut3D>();

/** A key for the grade's pixel-pass settings (the CSS filter part is not in it). */
export function gradeKey(fx: ClipFx, lutName?: string): string {
  return JSON.stringify([fx.exposure, fx.highlights, fx.shadows, fx.whites, fx.blacks, fx.temperature, fx.tint, fx.vibrance, fx.curves, fx.hsl, lutName ?? fx.lut, fx.lutAmount]);
}

export function bakeGrade(fx: ClipFx, lut?: Lut3D | null): Lut3D {
  const key = gradeKey(fx, lut ? fx.lut : '');
  const hit = baked.get(key);
  if (hit) return hit;
  const n = BAKE_SIZE;
  const px = new Uint8ClampedArray(n * n * n * 4);
  let i = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        px[i] = Math.round((r / (n - 1)) * 255);
        px[i + 1] = Math.round((g / (n - 1)) * 255);
        px[i + 2] = Math.round((b / (n - 1)) * 255);
        px[i + 3] = 255;
        i += 4;
      }
    }
  }
  gradePixels(px, fx, lut);
  const data = new Float32Array(n * n * n * 3);
  for (let k = 0, j = 0; k < px.length; k += 4, j += 3) {
    data[j] = px[k] / 255;
    data[j + 1] = px[k + 1] / 255;
    data[j + 2] = px[k + 2] / 255;
  }
  const out = { size: n, data };
  if (baked.size > 12) baked.delete(baked.keys().next().value!);
  baked.set(key, out);
  return out;
}

/** Apply a baked grade to pixels in place (trilinear). */
export function applyBaked(data: Uint8ClampedArray, lut: Lut3D): void {
  const n = lut.size;
  const max = n - 1;
  const d = lut.data;
  const sg = 3 * n;
  const sb = 3 * n * n;
  const k = max / 255;
  for (let i = 0; i < data.length; i += 4) {
    const fr = data[i] * k;
    const fg = data[i + 1] * k;
    const fb = data[i + 2] * k;
    let r0 = fr | 0;
    let g0 = fg | 0;
    let b0 = fb | 0;
    if (r0 >= max) r0 = max - 1;
    if (g0 >= max) g0 = max - 1;
    if (b0 >= max) b0 = max - 1;
    const tr = fr - r0;
    const tg = fg - g0;
    const tb = fb - b0;
    const base = 3 * r0 + sg * g0 + sb * b0;
    for (let c = 0; c < 3; c++) {
      const o = base + c;
      const c00 = d[o] + (d[o + 3] - d[o]) * tr;
      const c10 = d[o + sg] + (d[o + sg + 3] - d[o + sg]) * tr;
      const c01 = d[o + sb] + (d[o + sb + 3] - d[o + sb]) * tr;
      const c11 = d[o + sb + sg] + (d[o + sb + sg + 3] - d[o + sb + sg]) * tr;
      const c0 = c00 + (c10 - c00) * tg;
      const c1 = c01 + (c11 - c01) * tg;
      data[i + c] = (c0 + (c1 - c0) * tb) * 255 + 0.5;
    }
  }
}
