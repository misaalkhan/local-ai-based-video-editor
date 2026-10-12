// Properties of whatever is selected on the timeline.

import type { AnimKind, AudioClip, GraphicItem, GraphicTemplate, MainClip, OverlayClip, SourceClip, ZoomItem } from '../../shared/types.ts';
import * as ops from '../../shared/ops.ts';
import { FONT_FAMILIES, FONT_NOTES, nearestWeight, weightsOf } from '../../shared/fonts.ts';
import { defaultColor } from '../../shared/graphics.ts';
import { formatTime, srcDuration } from '../../shared/timeline.ts';
import { setUi, useDerived, useDoc, useStore } from '../store.ts';
import { commit, deleteSelection, duplicateSelection, edit, live, mediaDur } from '../actions.ts';
import { Button, ColorInput, Empty, Field, Section, Segmented, Select, Slider, TextInput, Toggle } from '../ui.tsx';

type FieldType = 'text' | 'multiline' | 'color' | 'optcolor' | 'slider' | 'toggle' | 'select' | 'font' | 'list' | 'number';

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  /** Colour a cleared optional colour comes back with. */
  fallback?: string;
  percent?: boolean;
}

const THEME: FieldDef = { key: 'theme', label: 'Card', type: 'select', options: [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] };
const ACCENT: FieldDef = { key: 'accent', label: 'Accent', type: 'color' };

const FIELDS: Record<GraphicTemplate, FieldDef[]> = {
  text: [
    { key: 'text', label: 'Text', type: 'multiline' },
    { key: 'font', label: 'Font', type: 'font' },
    { key: 'size', label: 'Size', type: 'slider', min: 0.02, max: 0.3, step: 0.002, percent: true },
    { key: 'color', label: 'Colour', type: 'color' },
    { key: 'accent', label: 'Accent for *starred* words', type: 'color' },
    { key: 'background', label: 'Box behind the text', type: 'optcolor', fallback: '#000000CC' },
    { key: 'stroke', label: 'Outline', type: 'optcolor', fallback: '#000000' },
    { key: 'strokeWidth', label: 'Outline width', type: 'slider', min: 0, max: 0.2, step: 0.005, percent: true },
    { key: 'maxWidth', label: 'Wrap width', type: 'slider', min: 0.3, max: 1, step: 0.01, percent: true },
    { key: 'align', label: 'Align', type: 'select', options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }] },
    { key: 'uppercase', label: 'ALL CAPS', type: 'toggle' },
    { key: 'shadow', label: 'Soft shadow', type: 'toggle' },
  ],
  popup: [{ key: 'emoji', label: 'Emoji', type: 'text' }, { key: 'title', label: 'Title', type: 'text' }, { key: 'subtitle', label: 'Detail', type: 'text' }, THEME, ACCENT],
  comment: [
    { key: 'author', label: 'Name', type: 'text' },
    { key: 'text', label: 'Comment', type: 'multiline' },
    { key: 'likes', label: 'Likes', type: 'text' },
    THEME,
    ACCENT,
  ],
  headline: [{ key: 'source', label: 'Source', type: 'text' }, { key: 'title', label: 'Headline', type: 'multiline' }, { key: 'subtitle', label: 'Date or detail', type: 'text' }, THEME, ACCENT],
  'lower-third': [{ key: 'title', label: 'Name', type: 'text' }, { key: 'subtitle', label: 'Role', type: 'text' }, ACCENT],
  callout: [
    { key: 'text', label: 'Label', type: 'text' },
    { key: 'targetX', label: 'Points to, left ↔ right', type: 'slider', min: 0, max: 1, step: 0.005, percent: true },
    { key: 'targetY', label: 'Points to, up ↔ down', type: 'slider', min: 0, max: 1, step: 0.005, percent: true },
    ACCENT,
  ],
  counter: [
    { key: 'from', label: 'From', type: 'number' },
    { key: 'to', label: 'To', type: 'number' },
    { key: 'prefix', label: 'Before the number', type: 'text' },
    { key: 'suffix', label: 'After the number', type: 'text' },
    { key: 'label', label: 'Caption', type: 'text' },
    { key: 'color', label: 'Colour', type: 'color' },
  ],
  list: [{ key: 'title', label: 'Title', type: 'text' }, { key: 'items', label: 'Points, one per line', type: 'list' }, { key: 'numbered', label: 'Numbered', type: 'toggle' }, THEME, ACCENT],
  image: [
    { key: 'width', label: 'Width', type: 'slider', min: 0.05, max: 1, step: 0.01, percent: true },
    { key: 'radius', label: 'Rounded corners', type: 'slider', min: 0, max: 0.5, step: 0.01, percent: true },
  ],
  highlight: [
    { key: 'shape', label: 'Shape', type: 'select', options: [{ value: 'box', label: 'Box' }, { value: 'ellipse', label: 'Circle' }, { value: 'underline', label: 'Underline' }] },
    { key: 'w', label: 'Width', type: 'slider', min: 0.05, max: 1, step: 0.005, percent: true },
    { key: 'h', label: 'Height', type: 'slider', min: 0.02, max: 1, step: 0.005, percent: true },
    { key: 'spotlight', label: 'Dim everything else', type: 'toggle' },
    ACCENT,
  ],
  emoji: [{ key: 'emoji', label: 'Emoji', type: 'text' }, { key: 'size', label: 'Size', type: 'slider', min: 0.05, max: 0.6, step: 0.005, percent: true }],
  progress: [{ key: 'position', label: 'Edge', type: 'select', options: [{ value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' }] }, ACCENT],
};

const ANIMS: { value: AnimKind; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade' },
  { value: 'pop', label: 'Pop' },
  { value: 'slide-up', label: 'Slide up' },
  { value: 'slide-down', label: 'Slide down' },
  { value: 'slide-left', label: 'Slide in from right' },
  { value: 'slide-right', label: 'Slide in from left' },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;

function Footer() {
  return (
    <div className="row edit-foot">
      <Button size="sm" icon="copy" onClick={duplicateSelection}>Duplicate</Button>
      <Button size="sm" icon="trash" variant="danger" onClick={deleteSelection}>Delete</Button>
    </div>
  );
}

function GraphicEditor({ g }: { g: GraphicItem }) {
  const p = g.props as Record<string, unknown>;
  const setProp = (key: string, value: unknown) => live((d) => ops.updateGraphic(d, g.id, { props: { [key]: value } }));
  const nowProp = (key: string, value: unknown, label: string) => edit((d) => ops.updateGraphic(d, g.id, { props: { [key]: value } }), label);
  const set = (patch: Partial<GraphicItem>) => live((d) => ops.updateGraphic(d, g.id, patch));
  const done = (label: string) => () => commit(label);
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : p[k] == null ? '' : String(p[k]));
  const num = (k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);

  const control = (f: FieldDef) => {
    switch (f.type) {
      case 'text':
      case 'multiline':
        return <TextInput value={str(f.key)} multiline={f.type === 'multiline'} onChange={(v) => setProp(f.key, v)} onCommit={done(f.label)} />;
      case 'number':
        return <TextInput value={str(f.key)} onChange={(v) => setProp(f.key, v === '' || Number.isNaN(Number(v)) ? v : Number(v))} onCommit={done(f.label)} />;
      case 'list':
        return (
          <TextInput
            multiline
            value={Array.isArray(p[f.key]) ? (p[f.key] as unknown[]).join('\n') : ''}
            onChange={(v) => setProp(f.key, v.split('\n'))}
            onCommit={done(f.label)}
          />
        );
      case 'color':
        return <ColorInput value={str(f.key) || defaultColor(g.template, f.key, p)} onChange={(v) => setProp(f.key, v)} onCommit={done(f.label)} />;
      case 'optcolor':
        return (
          <div className="row">
            <Toggle checked={!!p[f.key]} onChange={(v) => nowProp(f.key, v ? (f.fallback ?? '#000000') : '', f.label)} label="" />
            {!!p[f.key] && <ColorInput value={str(f.key)} onChange={(v) => setProp(f.key, v)} onCommit={done(f.label)} />}
          </div>
        );
      case 'slider':
        return (
          <Slider
            value={num(f.key, f.min ?? 0)}
            min={f.min ?? 0}
            max={f.max ?? 1}
            step={f.step ?? 0.01}
            onChange={(v) => setProp(f.key, v)}
            onCommit={done(f.label)}
            format={f.percent ? (v) => pct(v / (f.key === 'size' || f.key === 'strokeWidth' ? 1 : 1)) : undefined}
          />
        );
      case 'toggle':
        return <Toggle checked={!!p[f.key]} onChange={(v) => nowProp(f.key, v, f.label)} label="" />;
      case 'select':
        return <Select value={str(f.key) || f.options![0].value} options={f.options!} onChange={(v) => nowProp(f.key, v, f.label)} />;
      case 'font': {
        const family = str('font') || 'Inter';
        const weight = nearestWeight(family, num('weight', 700));
        return (
          <div className="row">
            <Select value={family} options={FONT_FAMILIES.map((x) => ({ value: x, label: FONT_NOTES[x] ? `${x}: ${FONT_NOTES[x].split(';')[0]}` : x }))} onChange={(v) => edit((d) => ops.updateGraphic(d, g.id, { props: { font: v, weight: nearestWeight(v, weight) } }), 'Font')} />
            <Select value={String(weight)} options={weightsOf(family).map((w) => ({ value: String(w), label: String(w) }))} onChange={(v) => nowProp('weight', Number(v), 'Weight')} />
          </div>
        );
      }
    }
  };

  return (
    <>
      <Section title="Content">
        <Field label="Name on the timeline">
          <TextInput value={g.name ?? ''} placeholder={g.template} onChange={(v) => set({ name: v })} onCommit={done('Rename')} />
        </Field>
        {FIELDS[g.template].map((f) =>
          f.type === 'toggle' ? (
            <div className="row" key={f.key}>
              <Toggle checked={!!p[f.key]} onChange={(v) => nowProp(f.key, v, f.label)} label={f.label} />
            </div>
          ) : (
            <Field key={f.key} label={f.label}>
              {control(f)}
            </Field>
          ),
        )}
      </Section>
      {g.template !== 'progress' && (
        <Section title="Placement">
          <Field label="Left ↔ right">
            <Slider value={g.x} min={0} max={1} step={0.005} onChange={(v) => set({ x: v })} onCommit={done('Move')} format={pct} />
          </Field>
          <Field label="Up ↔ down">
            <Slider value={g.y} min={0} max={1} step={0.005} onChange={(v) => set({ y: v })} onCommit={done('Move')} format={pct} />
          </Field>
          <Field label="Scale">
            <Slider value={g.scale} min={0.2} max={3} step={0.01} onChange={(v) => set({ scale: v })} onCommit={done('Scale')} format={pct} />
          </Field>
          <Field label="Rotation">
            <Slider value={g.rotation} min={-45} max={45} step={0.5} onChange={(v) => set({ rotation: v })} onCommit={done('Rotate')} format={(v) => `${v.toFixed(0)}°`} />
          </Field>
          <Field label="Opacity">
            <Slider value={g.opacity} min={0} max={1} step={0.01} onChange={(v) => set({ opacity: v })} onCommit={done('Opacity')} format={pct} />
          </Field>
        </Section>
      )}
      <Section title="Timing">
        <Field label="On screen for">
          <Slider value={g.duration} min={0.3} max={20} step={0.1} onChange={(v) => set({ duration: v })} onCommit={done('Duration')} format={(v) => `${v.toFixed(1)} s`} />
        </Field>
        {g.template !== 'progress' && (
          <>
            <Field label="Arrives with">
              <Select value={g.animIn} options={ANIMS} onChange={(v) => edit((d) => ops.updateGraphic(d, g.id, { animIn: v }), 'Entrance')} />
            </Field>
            <Field label="Leaves with">
              <Select value={g.animOut} options={ANIMS} onChange={(v) => edit((d) => ops.updateGraphic(d, g.id, { animOut: v }), 'Exit')} />
            </Field>
          </>
        )}
      </Section>
    </>
  );
}

function ZoomEditor({ z }: { z: ZoomItem }) {
  const set = (patch: Partial<ZoomItem>) => live((d) => ops.updateZoom(d, z.id, patch));
  const done = (label: string) => () => commit(label);
  return (
    <Section title="Punch-in">
      <Field label="Zoom">
        <Slider value={z.scale} min={1} max={2.5} step={0.01} onChange={(v) => set({ scale: v })} onCommit={done('Zoom')} format={(v) => `${v.toFixed(2)}×`} />
      </Field>
      <div className="row">
        <Toggle checked={z.toScale !== undefined} onChange={(v) => edit((d) => ops.updateZoom(d, z.id, { toScale: v ? Math.min(2.5, z.scale + 0.15) : undefined }), 'Push-in')} label="Keep pushing in while it lasts" />
      </div>
      {z.toScale !== undefined && (
        <Field label="Ends at">
          <Slider value={z.toScale} min={1} max={2.5} step={0.01} onChange={(v) => set({ toScale: v })} onCommit={done('Zoom')} format={(v) => `${v.toFixed(2)}×`} />
        </Field>
      )}
      <Field label="Arrives">
        <Segmented value={z.ease} options={[{ value: 'cut', label: 'Instantly' }, { value: 'smooth', label: 'Smoothly' }]} onChange={(v) => edit((d) => ops.updateZoom(d, z.id, { ease: v }), 'Zoom style')} />
      </Field>
      <Field label="Closes in on, left ↔ right">
        <Slider value={z.focusX} min={0} max={1} step={0.005} onChange={(v) => set({ focusX: v })} onCommit={done('Zoom focus')} format={pct} />
      </Field>
      <Field label="Closes in on, up ↔ down">
        <Slider value={z.focusY} min={0} max={1} step={0.005} onChange={(v) => set({ focusY: v })} onCommit={done('Zoom focus')} format={pct} />
      </Field>
      <div className="hint">You can also drag the dot on the picture to choose where it zooms.</div>
    </Section>
  );
}

function ClipEditor({ kind, clip }: { kind: 'main' | 'overlay' | 'audio'; clip: SourceClip }) {
  const media = useStore((s) => s.media);
  const m = media[clip.mediaId];
  const md = mediaDur(clip.mediaId);
  const set = (patch: Partial<OverlayClip & AudioClip>) => live((d) => ops.updateClip(d, kind, clip.id, patch, md));
  const now = (patch: Partial<OverlayClip & AudioClip>, label: string) => edit((d) => ops.updateClip(d, kind, clip.id, patch, md), label);
  const done = (label: string) => () => commit(label);
  const o = clip as OverlayClip;
  const a = clip as AudioClip;
  const tr = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, ...(o.transform ?? {}) };
  const hasSound = !!m?.hasAudio;
  return (
    <>
      <Section title={m?.name ?? 'Clip'}>
        <div className="kv">
          <span>Length</span>
          <b>{formatTime(srcDuration(clip), true)}</b>
          <span>From the source</span>
          <b>{formatTime(clip.in, true)} to {formatTime(clip.out, true)}</b>
        </div>
        {m?.kind !== 'image' && (
          <Field label="Speed">
            <Slider value={clip.speed} min={0.25} max={4} step={0.05} onChange={(v) => set({ speed: v })} onCommit={done('Speed')} format={(v) => `${v.toFixed(2)}×`} />
          </Field>
        )}
      </Section>
      {hasSound && (
        <Section title="Sound">
          <div className="row">
            <Toggle checked={!clip.muted} onChange={(v) => now({ muted: !v }, v ? 'Unmute' : 'Mute')} label={clip.muted ? 'Muted' : 'Sound on'} />
          </div>
          <Field label="Volume">
            <Slider value={clip.volume} min={0} max={2} step={0.01} onChange={(v) => set({ volume: v })} onCommit={done('Volume')} format={pct} />
          </Field>
          <Field label="Fade in">
            <Slider value={clip.fadeIn ?? 0} min={0} max={3} step={0.05} onChange={(v) => set({ fadeIn: v })} onCommit={done('Fade in')} format={(v) => `${v.toFixed(2)} s`} />
          </Field>
          <Field label="Fade out">
            <Slider value={clip.fadeOut ?? 0} min={0} max={3} step={0.05} onChange={(v) => set({ fadeOut: v })} onCommit={done('Fade out')} format={(v) => `${v.toFixed(2)} s`} />
          </Field>
          {kind === 'audio' && (
            <>
              <Field label="Used as">
                <Segmented
                  value={a.role}
                  options={[{ value: 'voice', label: 'Voice' }, { value: 'sfx', label: 'Effect' }, { value: 'music', label: 'Music' }]}
                  onChange={(v) => now({ role: v, ...(v === 'music' ? { duck: true } : {}) }, 'Audio role')}
                />
              </Field>
              {a.role === 'music' && (
                <div className="row">
                  <Toggle checked={a.duck !== false} onChange={(v) => now({ duck: v }, 'Ducking')} label="Lower it while someone speaks" />
                </div>
              )}
            </>
          )}
        </Section>
      )}
      {kind === 'overlay' && (
        <Section title="Picture in picture">
          <Field label="Size">
            <Slider value={tr.scale} min={0.1} max={1} step={0.01} onChange={(v) => set({ transform: { ...tr, scale: v } })} onCommit={done('Resize')} format={pct} />
          </Field>
          <Field label="Left ↔ right">
            <Slider value={tr.x} min={0} max={1} step={0.005} onChange={(v) => set({ transform: { ...tr, x: v } })} onCommit={done('Move')} format={pct} />
          </Field>
          <Field label="Up ↔ down">
            <Slider value={tr.y} min={0} max={1} step={0.005} onChange={(v) => set({ transform: { ...tr, y: v } })} onCommit={done('Move')} format={pct} />
          </Field>
          <Field label="Rounded corners">
            <Slider value={o.radius ?? 0} min={0} max={0.5} step={0.01} onChange={(v) => set({ radius: v })} onCommit={done('Corners')} format={pct} />
          </Field>
          <Field label="Opacity">
            <Slider value={o.opacity ?? 1} min={0} max={1} step={0.01} onChange={(v) => set({ opacity: v })} onCommit={done('Opacity')} format={pct} />
          </Field>
        </Section>
      )}
      {kind !== 'audio' && (
        <Button size="sm" icon="sliders" onClick={() => setUi({ left: 'effects' })}>
          Framing and colour
        </Button>
      )}
    </>
  );
}

function CardEditor({ clip }: { clip: Extract<MainClip, { kind: 'color' }> }) {
  return (
    <Section title="Colour card">
      <Field label="Colour">
        <ColorInput value={clip.color} onChange={(v) => live((d) => ops.updateClip(d, 'main', clip.id, { color: v }))} onCommit={() => commit('Card colour')} />
      </Field>
      <Field label="Length">
        <Slider value={clip.duration} min={0.5} max={10} step={0.1} onChange={(v) => live((d) => ops.updateClip(d, 'main', clip.id, { duration: v }))} onCommit={() => commit('Card length')} format={(v) => `${v.toFixed(1)} s`} />
      </Field>
    </Section>
  );
}

export function EditPanel() {
  const doc = useDoc()!;
  useDerived();
  const sel = useStore((s) => s.selection);
  let body: React.ReactNode = null;
  if (sel?.kind === 'graphic') {
    const g = doc.graphics.find((x) => x.id === sel.id);
    if (g) body = <GraphicEditor g={g} />;
  } else if (sel?.kind === 'zoom') {
    const z = doc.zooms.find((x) => x.id === sel.id);
    if (z) body = <ZoomEditor z={z} />;
  } else if (sel?.kind === 'main') {
    const c = doc.main.find((x) => x.id === sel.id);
    if (c?.kind === 'media') body = <ClipEditor kind="main" clip={c} />;
    else if (c) body = <CardEditor clip={c} />;
  } else if (sel?.kind === 'overlay') {
    const c = doc.overlays.find((x) => x.id === sel.id);
    if (c) body = <ClipEditor kind="overlay" clip={c} />;
  } else if (sel?.kind === 'audio') {
    const c = doc.audio.find((x) => x.id === sel.id);
    if (c) body = <ClipEditor kind="audio" clip={c} />;
  }
  return (
    <div className="panel">
      <header className="panel-head">
        <h2>Edit</h2>
      </header>
      <div className="panel-body">
        {body ? (
          <>
            {body}
            <Footer />
          </>
        ) : (
          <Empty icon="edit" title="Nothing selected">
            Click a clip, graphic or punch-in on the timeline to change it here.
          </Empty>
        )}
      </div>
    </div>
  );
}
