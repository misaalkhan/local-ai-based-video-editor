// The grading controls on the Effects tab: light and colour sliders, a tone
// curve editor, HSL by hue range, and LUTs from the library.

import { useEffect, useRef, useState } from 'react';
import type { ClipFx } from '../../shared/types.ts';
import { HSL_BANDS, sampleCurve } from '../../shared/color.ts';
import type { CurvePoint, Curves, HslBandName } from '../../shared/color.ts';
import { api, uploadLut } from '../api.ts';
import { fail, toast } from '../store.ts';
import { runTool } from '../actions.ts';
import { player } from '../engine/player.ts';
import { Button, Field, Section, Segmented, Select, Slider } from '../ui.tsx';

const pct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;

interface Props {
  fx: ClipFx;
  /** Live change while a slider moves. */
  set: (patch: Partial<ClipFx>) => void;
  /** Settles the change on the undo stack. */
  commit: (label: string) => void;
  /** The clip being graded, for Auto. */
  clipId?: string;
  /** A change that lands at once (no slider). */
  now: (patch: Partial<ClipFx>, label: string) => void;
}

export function LightAndColour({ fx, set, commit, clipId }: Props) {
  const row = (label: string, key: keyof ClipFx, min: number, max: number, hint?: string, format = pct) => (
    <Field label={label} hint={hint}>
      <Slider value={(fx[key] as number | undefined) ?? 0} min={min} max={max} step={0.01} onChange={(v) => set({ [key]: v || undefined })} onCommit={() => commit(label)} format={format} />
    </Field>
  );
  return (
    <>
      {clipId && (
        <div className="row">
          <Button size="sm" icon="sparkles" onClick={() => void runTool('set_clip_look', { clip_id: clipId, auto: true })}>
            Auto
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="eye"
            title="Hold to see the clip as recorded"
            onPointerDown={() => player.setBypass(clipId)}
            onPointerUp={() => player.setBypass(null)}
            onPointerLeave={() => player.setBypass(null)}
          >
            Before
          </Button>
        </div>
      )}
      {row('Exposure', 'exposure', -2, 2, 'stops', (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`)}
      {row('Highlights', 'highlights', -1, 1)}
      {row('Shadows', 'shadows', -1, 1)}
      {row('Whites', 'whites', -1, 1)}
      {row('Blacks', 'blacks', -1, 1)}
      {row('Temperature', 'temperature', -1, 1, 'blue to amber')}
      {row('Tint', 'tint', -1, 1, 'green to magenta')}
      {row('Vibrance', 'vibrance', -1, 1)}
      {row('Clarity', 'clarity', -1, 1, 'soften to crisp')}
      {row('Sharpen', 'sharpen', 0, 1)}
    </>
  );
}

// ---------------------------------------------------------------------------
// Curves

type Channel = keyof Curves;
const CHANNELS: { value: Channel; label: string }[] = [
  { value: 'rgb', label: 'RGB' },
  { value: 'r', label: 'R' },
  { value: 'g', label: 'G' },
  { value: 'b', label: 'B' },
];
const CHANNEL_COLOUR: Record<Channel, string> = { rgb: '#ffffff', r: '#ff6b6b', g: '#6bff8a', b: '#6ba8ff' };
const IDENTITY: CurvePoint[] = [[0, 0], [1, 1]];

export function CurveEditor({ fx, set, commit, now }: Props) {
  const [channel, setChannel] = useState<Channel>('rgb');
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ index: number } | null>(null);
  const points: CurvePoint[] = fx.curves?.[channel] ?? IDENTITY;
  const size = 200;

  const write = (pts: CurvePoint[], live: boolean) => {
    const curves: Curves = { ...(fx.curves ?? {}) };
    const identity = pts.length === 2 && pts.every(([x, y]) => Math.abs(x - y) < 1e-6);
    if (identity) delete curves[channel];
    else curves[channel] = pts;
    const patch: Partial<ClipFx> = { curves: Object.keys(curves).length ? curves : undefined };
    if (live) set(patch);
    else now(patch, 'Curve');
  };

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#17181c';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo((size * i) / 4, 0);
      ctx.lineTo((size * i) / 4, size);
      ctx.moveTo(0, (size * i) / 4);
      ctx.lineTo(size, (size * i) / 4);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(0, size);
    ctx.lineTo(size, 0);
    ctx.stroke();
    // The other channels, faint, for context.
    for (const ch of CHANNELS) {
      const pts = fx.curves?.[ch.value];
      if (!pts || ch.value === channel) continue;
      const s = sampleCurve(pts);
      ctx.strokeStyle = CHANNEL_COLOUR[ch.value] + '55';
      ctx.beginPath();
      for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * size, size - s[i] * size);
      ctx.stroke();
    }
    const s = sampleCurve(points);
    ctx.strokeStyle = CHANNEL_COLOUR[channel];
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * size, size - s[i] * size);
    ctx.stroke();
    ctx.fillStyle = CHANNEL_COLOUR[channel];
    for (const [x, y] of points) {
      ctx.beginPath();
      ctx.arc(x * size, size - y * size, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [fx.curves, channel, points]);

  const toPoint = (e: React.PointerEvent<HTMLCanvasElement>): CurvePoint => {
    const r = e.currentTarget.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };
  const nearest = (p: CurvePoint): number => {
    let best = -1;
    let dist = 0.06;
    points.forEach(([x, y], i) => {
      const d = Math.hypot(x - p[0], y - p[1]);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    return best;
  };

  return (
    <div className="curve-editor">
      <div className="row">
        <Segmented value={channel} options={CHANNELS} onChange={setChannel} />
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={() => now({ curves: undefined }, 'Reset curves')} disabled={!fx.curves}>
          Reset
        </Button>
      </div>
      <canvas
        ref={ref}
        className="curve-canvas"
        style={{ width: size, height: size }}
        onPointerDown={(e) => {
          const p = toPoint(e);
          let i = nearest(p);
          const pts = [...points];
          if (i < 0) {
            pts.push(p);
            pts.sort((a, b) => a[0] - b[0]);
            i = pts.findIndex((q) => q === p);
            write(pts, true);
          }
          drag.current = { index: i };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const p = toPoint(e);
          const pts = [...points];
          const i = drag.current.index;
          // End points stay on the edges; inner points stay between their neighbours.
          const lo = i === 0 ? 0 : pts[i - 1][0] + 0.01;
          const hi = i === pts.length - 1 ? 1 : pts[i + 1][0] - 0.01;
          pts[i] = [i === 0 ? 0 : i === pts.length - 1 ? 1 : Math.min(hi, Math.max(lo, p[0])), p[1]];
          write(pts, true);
        }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          drag.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
          commit('Curve');
        }}
        onDoubleClick={(e) => {
          // Double-click a point to remove it.
          const r = e.currentTarget.getBoundingClientRect();
          const p: CurvePoint = [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
          const i = nearest(p);
          if (i > 0 && i < points.length - 1) write(points.filter((_, k) => k !== i), false);
        }}
      />
      <div className="hint">Drag the line to shape it; click to add a point, double-click a point to remove it. An S shape adds contrast; lifting the bottom left gives a faded, matte look.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HSL

const BAND_COLOUR: Record<HslBandName, string> = { red: '#e53935', orange: '#fb8c00', yellow: '#fdd835', green: '#43a047', aqua: '#00acc1', blue: '#1e88e5', purple: '#8e24aa', magenta: '#d81b60' };

export function HslControls({ fx, set, commit, now }: Props) {
  const [band, setBand] = useState<HslBandName>('red');
  const cur = fx.hsl?.[band] ?? {};
  const write = (patch: { hue?: number; sat?: number; lum?: number }) => {
    const hsl = { ...(fx.hsl ?? {}) };
    const next = { ...cur, ...patch };
    if (!next.hue && !next.sat && !next.lum) delete hsl[band];
    else hsl[band] = next;
    set({ hsl: Object.keys(hsl).length ? hsl : undefined });
  };
  return (
    <>
      <div className="row">
        <div className="hsl-bands" role="radiogroup" aria-label="Hue range">
          {HSL_BANDS.map((b) => (
            <button key={b} type="button" className={`hsl-band ${band === b ? 'on' : ''} ${fx.hsl?.[b] ? 'set' : ''}`} style={{ background: BAND_COLOUR[b] }} onClick={() => setBand(b)} title={b} aria-label={b} aria-pressed={band === b} />
          ))}
        </div>
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={() => now({ hsl: undefined }, 'Reset HSL')} disabled={!fx.hsl}>
          Reset
        </Button>
      </div>
      <Field label={`${band[0].toUpperCase()}${band.slice(1)} hue`}>
        <Slider value={cur.hue ?? 0} min={-1} max={1} step={0.01} onChange={(v) => write({ hue: v || undefined })} onCommit={() => commit('Hue')} format={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 30)}°`} />
      </Field>
      <Field label="Saturation">
        <Slider value={cur.sat ?? 0} min={-1} max={1} step={0.01} onChange={(v) => write({ sat: v || undefined })} onCommit={() => commit('Saturation')} format={pct} />
      </Field>
      <Field label="Luminance">
        <Slider value={cur.lum ?? 0} min={-1} max={1} step={0.01} onChange={(v) => write({ lum: v || undefined })} onCommit={() => commit('Luminance')} format={pct} />
      </Field>
    </>
  );
}

// ---------------------------------------------------------------------------
// LUTs

export function LutControls({ fx, set, commit, now }: Props) {
  const [luts, setLuts] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => api.luts().then((l) => setLuts(l.map((x) => x.name))).catch(() => setLuts([]));
  useEffect(() => void refresh(), []);
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    let last: string | null = null;
    for (const f of [...files]) {
      try {
        last = (await uploadLut(f)).name;
      } catch (err) {
        fail(err);
      }
    }
    setBusy(false);
    await refresh();
    if (last) {
      now({ lut: last, lutAmount: fx.lutAmount ?? 1 }, `LUT: ${last}`);
      toast(`Imported "${last}".`, 'success');
    }
  };
  return (
    <>
      <div className="row">
        <Select value={fx.lut ?? ''} options={[{ value: '', label: luts && luts.length ? 'None' : 'None imported yet' }, ...(luts ?? []).map((n) => ({ value: n, label: n }))]} onChange={(v) => now({ lut: v || undefined }, v ? `LUT: ${v}` : 'LUT off')} />
        <input ref={fileRef} type="file" multiple hidden accept=".cube" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
        <Button size="sm" icon="upload" disabled={busy} onClick={() => fileRef.current?.click()}>
          Import .cube
        </Button>
      </div>
      {fx.lut && (
        <Field label="Strength">
          <Slider value={fx.lutAmount ?? 1} min={0} max={1} step={0.01} onChange={(v) => set({ lutAmount: v })} onCommit={() => commit('LUT strength')} format={(v) => `${Math.round(v * 100)}%`} />
        </Field>
      )}
      <div className="hint">A LUT is a colour recipe file (.cube) from a colourist, a camera maker or a preset pack; it applies after the sliders above. Imported LUTs are kept in the library for every project.</div>
    </>
  );
}
