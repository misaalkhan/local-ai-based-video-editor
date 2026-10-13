// Visual effects drawn by the graphics pass: particle systems (confetti,
// snow, sparks, bokeh, rain, petals), light leaks and lens flares. Every
// effect is a pure function of the item's local time and a seed, with no
// state between frames, which is what keeps the preview and the export
// identical and lets any frame be drawn on its own.

import type { Ctx2D } from './graphics.ts';

export type ParticleKind = 'confetti' | 'snow' | 'sparks' | 'bokeh' | 'rain' | 'petals';

export const PARTICLE_KINDS: { id: ParticleKind; label: string; hint: string }[] = [
  { id: 'confetti', label: 'Confetti', hint: 'A celebration: coloured paper falling and tumbling.' },
  { id: 'snow', label: 'Snow', hint: 'Soft flakes drifting down, near and far.' },
  { id: 'sparks', label: 'Sparks', hint: 'Embers rising and fading, for fire, energy and hype.' },
  { id: 'bokeh', label: 'Bokeh', hint: 'Big soft lights drifting slowly, dreamy and warm.' },
  { id: 'rain', label: 'Rain', hint: 'Streaks of rain falling at a slant.' },
  { id: 'petals', label: 'Petals', hint: 'Pink petals swaying down.' },
];

const CONFETTI = ['#FF3B6B', '#FFD166', '#06D6A0', '#4CC9F0', '#F7B801', '#FF8FAB', '#9B5DE5', '#FFFFFF'];

/** A small, fast, seeded random source (mulberry32). */
export function rng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap = (v: number, lo: number, hi: number) => lo + ((((v - lo) % (hi - lo)) + (hi - lo)) % (hi - lo));

export interface VfxFrame {
  ctx: Ctx2D;
  props: Record<string, unknown>;
  /** Seconds since the item started. */
  local: number;
  /** The frame's rectangle in the drawing space. */
  frame: { x: number; y: number; w: number; h: number };
  /** Pixels per design pixel. */
  u: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  phase: number;
  spin: number;
  color: string;
  depth: number;
}

const BASE_COUNT: Record<ParticleKind, number> = { confetti: 110, snow: 140, sparks: 90, bokeh: 28, rain: 220, petals: 55 };

/** The particles of an item, decided once by its seed. */
function particles(kind: ParticleKind, seed: number, density: number, color: string | null): Particle[] {
  const r = rng(seed * 7919 + 17);
  const n = Math.round(BASE_COUNT[kind] * clamp(density, 0.05, 3));
  const out: Particle[] = [];
  for (let i = 0; i < n; i++) {
    const depth = 0.35 + r() * 0.65;
    const base: Particle = { x: r(), y: r(), vx: 0, vy: 0, size: 1, phase: r() * Math.PI * 2, spin: (r() - 0.5) * 6, color: color ?? '#FFFFFF', depth };
    switch (kind) {
      case 'confetti':
        out.push({ ...base, vx: (r() - 0.5) * 0.08, vy: 0.18 + r() * 0.22, size: 0.6 + r() * 0.8, color: color ?? CONFETTI[i % CONFETTI.length] });
        break;
      case 'snow':
        out.push({ ...base, vx: (r() - 0.5) * 0.02, vy: 0.05 + depth * 0.1, size: 0.3 + depth * 1.2 });
        break;
      case 'sparks':
        out.push({ ...base, vx: (r() - 0.5) * 0.1, vy: -(0.15 + r() * 0.35), size: 0.4 + r() * 0.9, color: color ?? (r() < 0.6 ? '#FFB347' : '#FFE8A3') });
        break;
      case 'bokeh':
        out.push({ ...base, vx: (r() - 0.5) * 0.015, vy: -(0.005 + r() * 0.02), size: 0.5 + r() * 1.5, color: color ?? ['#FFD9A0', '#FFC2C2', '#C2E8FF', '#FFFFFF'][i % 4] });
        break;
      case 'rain':
        out.push({ ...base, vx: 0.12, vy: 1.6 + r() * 0.8, size: 0.6 + depth * 0.8, color: color ?? '#DCEBFF' });
        break;
      case 'petals':
        out.push({ ...base, vx: (r() - 0.5) * 0.05, vy: 0.08 + r() * 0.1, size: 0.7 + r() * 0.8, color: color ?? ['#FFB7C5', '#FF9EBB', '#FFD1DC'][i % 3] });
        break;
    }
  }
  return out;
}

const cache = new Map<string, Particle[]>();

/** Particles falling, rising or drifting over the whole frame. */
export function drawParticles(f: VfxFrame): void {
  const { ctx, props, local, frame, u } = f;
  const kind = (PARTICLE_KINDS.some((k) => k.id === props.kind) ? props.kind : 'confetti') as ParticleKind;
  const seed = num(props.seed, 1);
  const density = num(props.density, 1);
  const speed = num(props.speed, 1);
  const sizeMul = num(props.size, 1);
  const wind = num(props.wind, 0);
  const color = typeof props.color === 'string' && props.color ? props.color : null;
  const key = `${kind}:${seed}:${density}:${color ?? ''}`;
  let list = cache.get(key);
  if (!list) {
    list = particles(kind, seed, density, color);
    if (cache.size > 64) cache.clear();
    cache.set(key, list);
  }
  const t = local * speed;
  const { x: fx, y: fy, w: W, h: H } = frame;
  const unit = Math.min(W, H * 0.75) / 1080;
  ctx.save();
  ctx.beginPath();
  ctx.rect(fx, fy, W, H);
  ctx.clip();
  if (kind === 'sparks' || kind === 'bokeh') ctx.globalCompositeOperation = 'lighter';
  const baseAlpha = ctx.globalAlpha;
  for (const p of list) {
    // Position as a pure function of time; wrapped so the stream never ends.
    const sway = kind === 'rain' ? 0 : Math.sin(t * (0.8 + p.depth) + p.phase) * (kind === 'petals' ? 0.05 : kind === 'confetti' ? 0.03 : 0.015);
    const x = wrap(p.x + (p.vx + wind * 0.1) * t + sway, -0.1, 1.1);
    const y = wrap(p.y + p.vy * t, -0.12, 1.12);
    const px = fx + x * W;
    const py = fy + y * H;
    const s = p.size * sizeMul * unit;
    ctx.fillStyle = p.color;
    switch (kind) {
      case 'confetti': {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(p.phase + p.spin * t);
        // A tumbling strip: its apparent width breathes as it turns.
        const w = 22 * s;
        const h = 14 * s * Math.abs(Math.cos(t * 3 + p.phase));
        ctx.globalAlpha = baseAlpha * 0.95;
        ctx.fillRect(-w / 2, -h / 2, w, Math.max(1.5 * u, h));
        ctx.restore();
        break;
      }
      case 'snow': {
        const r = 4.5 * s;
        const g = ctx.createRadialGradient(px, py, 0, px, py, r);
        g.addColorStop(0, 'rgba(255,255,255,0.95)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.globalAlpha = baseAlpha * (0.5 + p.depth * 0.5);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'sparks': {
        // Fade over each rise and glow around a hot core.
        const life = wrap(p.y + p.vy * t, -0.12, 1.12);
        const fade = clamp(1.3 - Math.abs(0.5 - life) * 2, 0.15, 1);
        const r = 3.2 * s;
        const g = ctx.createRadialGradient(px, py, 0, px, py, r * 2.2);
        g.addColorStop(0, p.color);
        g.addColorStop(0.35, p.color);
        g.addColorStop(1, 'rgba(255,120,0,0)');
        ctx.fillStyle = g;
        ctx.globalAlpha = baseAlpha * fade;
        ctx.beginPath();
        ctx.arc(px, py, r * 2.2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'bokeh': {
        const r = 70 * s;
        const pulse = 0.55 + 0.45 * Math.sin(t * 0.7 + p.phase);
        const g = ctx.createRadialGradient(px, py, r * 0.6, px, py, r);
        g.addColorStop(0, p.color);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.globalAlpha = baseAlpha * 0.16 * pulse;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'rain': {
        const len = 70 * s;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1, 1.6 * s);
        ctx.globalAlpha = baseAlpha * (0.25 + p.depth * 0.35);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - len * 0.075, py - len);
        ctx.stroke();
        break;
      }
      case 'petals': {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(p.phase + p.spin * 0.4 * t);
        ctx.globalAlpha = baseAlpha * 0.9;
        ctx.beginPath();
        ctx.ellipse(0, 0, 16 * s, 9.5 * s * (0.4 + 0.6 * Math.abs(Math.sin(t * 2 + p.phase))), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        break;
      }
    }
  }
  ctx.restore();
}

/** Warm (or any hue) washes of light drifting across the frame, like film exposed at the edges. */
export function drawLightLeak(f: VfxFrame): void {
  const { ctx, props, local, frame } = f;
  const hue = num(props.hue, 28);
  const intensity = clamp(num(props.intensity, 0.7), 0, 2);
  const seed = num(props.seed, 1);
  const r = rng(seed * 131 + 7);
  const { x: fx, y: fy, w: W, h: H } = frame;
  const R = Math.max(W, H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(fx, fy, W, H);
  ctx.clip();
  ctx.globalCompositeOperation = 'screen';
  const base = ctx.globalAlpha;
  for (let i = 0; i < 3; i++) {
    const ax = r();
    const ay = r();
    const sp = 0.05 + r() * 0.08;
    const ph = r() * Math.PI * 2;
    const size = (0.45 + r() * 0.5) * R;
    const h = hue + (i - 1) * 18;
    const cx = fx + W * (ax + 0.35 * Math.sin(local * sp * 6 + ph));
    const cy = fy + H * (ay + 0.25 * Math.cos(local * sp * 4 + ph));
    const flicker = 0.85 + 0.15 * Math.sin(local * 9 + ph * 3);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size);
    g.addColorStop(0, `hsla(${h}, 100%, 62%, ${(0.55 * intensity * flicker).toFixed(3)})`);
    g.addColorStop(0.45, `hsla(${h + 10}, 100%, 55%, ${(0.22 * intensity * flicker).toFixed(3)})`);
    g.addColorStop(1, `hsla(${h}, 100%, 50%, 0)`);
    ctx.fillStyle = g;
    ctx.globalAlpha = base;
    ctx.fillRect(fx, fy, W, H);
  }
  ctx.restore();
}

/** A lens flare from a light at the item's position: a hot core, a streak and ghosts along the line through the centre. */
export function drawFlare(f: VfxFrame): void {
  const { ctx, props, local, frame, u } = f;
  const intensity = clamp(num(props.intensity, 0.8), 0, 2);
  const color = str(props.color, '#FFE2B0');
  const anamorphic = props.anamorphic !== false;
  const { x: fx, y: fy, w: W, h: H } = frame;
  const R = Math.min(W, H);
  // The item's origin is the light; the frame's centre decides where the ghosts go.
  const cx = fx + W / 2;
  const cy = fy + H / 2;
  const flicker = 0.9 + 0.1 * Math.sin(local * 7.3) * Math.sin(local * 2.1);
  ctx.save();
  ctx.beginPath();
  ctx.rect(fx, fy, W, H);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';
  const base = ctx.globalAlpha * intensity * flicker;
  // Core.
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.22);
  core.addColorStop(0, 'rgba(255,255,255,0.95)');
  core.addColorStop(0.18, color);
  core.addColorStop(1, 'rgba(255,200,120,0)');
  ctx.fillStyle = core;
  ctx.globalAlpha = base * 0.9;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.22, 0, Math.PI * 2);
  ctx.fill();
  // Streak.
  if (anamorphic) {
    const streak = ctx.createLinearGradient(-W, 0, W, 0);
    streak.addColorStop(0, 'rgba(120,180,255,0)');
    streak.addColorStop(0.5, 'rgba(170,210,255,0.85)');
    streak.addColorStop(1, 'rgba(120,180,255,0)');
    ctx.fillStyle = streak;
    ctx.globalAlpha = base * 0.55;
    ctx.beginPath();
    ctx.ellipse(0, 0, W * 0.9, Math.max(2 * u, R * 0.012), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Ghosts: discs and rings stepping away from the light through the centre.
  const dx = cx - 0;
  const dy = cy - 0;
  const ghosts = [
    { k: 0.35, r: 0.05, a: 0.35, ring: false, c: 'rgba(255,170,90,1)' },
    { k: 0.6, r: 0.09, a: 0.22, ring: true, c: 'rgba(140,220,255,1)' },
    { k: 0.95, r: 0.035, a: 0.4, ring: false, c: 'rgba(255,220,160,1)' },
    { k: 1.3, r: 0.14, a: 0.16, ring: true, c: 'rgba(255,120,120,1)' },
    { k: 1.7, r: 0.06, a: 0.28, ring: false, c: 'rgba(170,255,200,1)' },
  ];
  for (const g of ghosts) {
    const gx = dx * g.k;
    const gy = dy * g.k;
    const rad = g.r * R;
    const grad = ctx.createRadialGradient(gx, gy, g.ring ? rad * 0.7 : 0, gx, gy, rad);
    grad.addColorStop(0, g.ring ? 'rgba(0,0,0,0)' : g.c);
    grad.addColorStop(g.ring ? 0.85 : 0.6, g.c);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.globalAlpha = base * g.a;
    ctx.beginPath();
    ctx.arc(gx, gy, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
