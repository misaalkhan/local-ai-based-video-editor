import type { ClipFx, Framing, MediaMainClip, MotionKeyframe, OverlayClip } from '../../shared/types.ts';
import { addZoom, setMotion, updateClip, upsertKeyframe } from '../../shared/ops.ts';
import { player } from '../engine/player.ts';
import { usePlayerTime } from '../hooks.ts';
import { DEFAULT_FRAMING, framingAt } from '../../shared/timeline.ts';
import { LOOKS } from '../../shared/draw.ts';
import { fail, useDerived, useDoc, useStore } from '../store.ts';
import { addZoomAtPlayhead, commit, edit, live, mediaDur, runTool } from '../actions.ts';
import { api } from '../api.ts';
import { Button, Field, Section, Segmented, Slider, Toggle } from '../ui.tsx';
import { CurveEditor, HslControls, LightAndColour, LutControls } from './ColorControls.tsx';

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function EffectsPanel() {
  const doc = useDoc()!;
  const selection = useStore((s) => s.selection);
  const media = useStore((s) => s.media);
  const projectId = useStore((s) => s.projectId)!;
  const kind = selection?.kind === 'main' || selection?.kind === 'overlay' ? selection.kind : null;
  const clip: MediaMainClip | OverlayClip | undefined =
    kind === 'main'
      ? (doc.main.find((c) => c.id === selection!.id && c.kind === 'media') as MediaMainClip | undefined)
      : kind === 'overlay'
        ? doc.overlays.find((c) => c.id === selection!.id)
        : undefined;
  const m = clip ? media[clip.mediaId] : undefined;
  const derived = useDerived();
  const fps = doc.settings.fps;
  const clipStart = kind === 'overlay' ? (clip as OverlayClip).start : (derived?.layout.find((seg) => seg.clip.id === clip?.id)?.start ?? 0);
  const time = usePlayerTime();
  const local = clip ? Math.max(0, time - clipStart) : 0;
  // With motion keyframes, the framing shown and edited is the one at the playhead.
  const animated = !!clip?.motion?.length;
  const framing: Framing = animated ? framingAt(clip!.framing, undefined, 0, clip!.motion, local) : { ...DEFAULT_FRAMING, ...(clip?.framing ?? {}) };
  const fx: ClipFx = clip?.fx ?? {};
  const md = clip ? mediaDur(clip.mediaId) : undefined;

  const setFraming = (patch: Partial<Framing>, label?: string) => {
    if (!clip || !kind) return;
    const motionKeys = ['scale', 'focusX', 'focusY'] as const;
    if (animated && motionKeys.some((k) => patch[k] !== undefined)) {
      // Auto-key: the change lands on the keyframe at the playhead (made if there is none).
      const kf: MotionKeyframe = { t: Math.round(local * fps) / fps };
      for (const k of motionKeys) kf[k] = patch[k] ?? framing[k];
      const next = upsertKeyframe(clip.motion, kf, fps);
      if (label) edit((d) => setMotion(d, kind, clip.id, next), label);
      else live((d) => setMotion(d, kind, clip.id, next));
      const rest = { ...patch };
      for (const k of motionKeys) delete rest[k];
      if (!Object.keys(rest).length) return;
      patch = rest;
    }
    const next = { ...(animated ? { ...DEFAULT_FRAMING, ...(clip.framing ?? {}) } : framing), ...patch };
    if (label) edit((d) => updateClip(d, kind, clip.id, { framing: next }, md), label);
    else live((d) => updateClip(d, kind, clip.id, { framing: next }, md));
  };
  const setFx = (patch: Partial<ClipFx>) => {
    if (!clip || !kind) return;
    live((d) => updateClip(d, kind, clip.id, { fx: { ...fx, ...patch } }, md));
  };
  const setFxNow = (patch: Partial<ClipFx>, label: string) => {
    if (!clip || !kind) return;
    edit((d) => updateClip(d, kind, clip.id, { fx: { ...fx, ...patch } }, md), label);
  };
  const colour = { fx, set: setFx, commit, now: setFxNow };

  return (
    <div className="panel">
      <header className="panel-head"><h2>Effects</h2></header>
      <div className="panel-body">
        <Section title="Punch-in">
          <div className="hint">A zoom on the main track for emphasis. Add one at the playhead, then drag it on the Zoom row.</div>
          <div className="row">
            <Button size="sm" icon="target" onClick={() => addZoomAtPlayhead(1.2)}>Punch in</Button>
            <Button
              size="sm"
              icon="zoomIn"
              onClick={() => edit((d) => addZoom(d, { start: player.time, duration: 4, scale: 1, toScale: 1.15, ease: 'smooth', name: 'Slow push-in' }).doc, 'Add slow push-in')}
            >
              Slow push-in
            </Button>
            <Button
              size="sm"
              icon="alert"
              onClick={() => edit((d) => addZoom(d, { start: player.time, duration: 0.5, scale: 1, shake: 0.7, ease: 'cut', name: 'Shake' }).doc, 'Add shake')}
            >
              Shake
            </Button>
          </div>
        </Section>

        {!clip || !m ? (
          <div className="hint">Select a clip on the main or b-roll track to reframe it or adjust its colour.</div>
        ) : (
          <>
            <Section title="Framing">
              {animated && <div className="hint">This clip has motion keyframes: the zoom and focus here are the ones at the playhead, and a change lands on that keyframe.</div>}
              <Field label="Fit">
                <Segmented
                  value={framing.fit}
                  options={[{ value: 'cover', label: 'Fill the frame' }, { value: 'contain', label: 'Show it all' }]}
                  onChange={(v) => setFraming({ fit: v }, 'Fit')}
                />
              </Field>
              {framing.fit === 'contain' && <Toggle checked={!!framing.blurFill} onChange={(v) => setFraming({ blurFill: v }, 'Blurred background')} label="Blurred background" />}
              {m.kind === 'video' && (
                <Toggle
                  checked={!!framing.track}
                  onChange={(v) => {
                    setFraming({ track: v }, v ? 'Follow face' : 'Stop following face');
                    if (v && m.faces !== 'done') void runTool('set_reframe', { clip_id: clip.id, mode: 'track' });
                  }}
                  label="Keep the face centred"
                />
              )}
              <Field label="Zoom">
                <Slider value={framing.scale} min={1} max={3} step={0.01} onChange={(v) => setFraming({ scale: v })} onCommit={() => commit('Zoom')} format={(v) => `${v.toFixed(2)}×`} />
              </Field>
              {m.kind === 'video' && (
                <Field label="Stabilise">
                  <Slider
                    value={fx.stabilize ?? 0}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={(v) => setFx({ stabilize: v || undefined })}
                    onCommit={() => {
                      commit('Stabilise');
                      if ((fx.stabilize ?? 0) > 0 && m.stability !== 'done' && m.stability !== 'running') api.stabilize(projectId, m.id).catch(fail);
                    }}
                    format={(v) => (v ? `${Math.round(v * 100)}%` : 'Off')}
                  />
                  {(fx.stabilize ?? 0) > 0 && m.stability === 'running' && <div className="hint">Measuring the camera's motion…</div>}
                  {(fx.stabilize ?? 0) > 0 && (m.stability === 'error' || m.stability === 'skipped') && <div className="hint">The camera motion could not be measured for this file.</div>}
                  {(fx.stabilize ?? 0) > 0 && m.stability === 'done' && <div className="hint">Smooths out handheld shake; the picture is cropped by {Math.round((3 + 9 * (fx.stabilize ?? 0)) * 2)}% to make room.</div>}
                </Field>
              )}
              {!framing.track && (
                <>
                  <Field label="Left ↔ right">
                    <Slider value={framing.focusX} min={0} max={1} step={0.005} onChange={(v) => setFraming({ focusX: v })} onCommit={() => commit('Reframe')} format={(v) => `${Math.round(v * 100)}%`} />
                  </Field>
                  <Field label="Up ↔ down">
                    <Slider value={framing.focusY} min={0} max={1} step={0.005} onChange={(v) => setFraming({ focusY: v })} onCommit={() => commit('Reframe')} format={(v) => `${Math.round(v * 100)}%`} />
                  </Field>
                </>
              )}
            </Section>
            <Section title="Colour" action={<Button size="sm" variant="ghost" onClick={() => edit((d) => updateClip(d, kind!, clip.id, { fx: undefined }, md), 'Reset colour')}>Reset</Button>}>
              <div className="looks">
                {Object.entries(LOOKS).map(([id, l]) => (
                  <button key={id} type="button" className="tile" onClick={() => edit((d) => updateClip(d, kind!, clip.id, { fx: { ...l.fx } }, md), `Look: ${l.label}`)}>
                    <em>{l.label}</em>
                  </button>
                ))}
              </div>
              <div className="row">
                <Button size="sm" variant="ghost" onClick={() => edit((d) => { let x = d; for (const c of d.main) if (c.kind === 'media') x = updateClip(x, 'main', c.id, { fx: clip.fx ? { ...clip.fx } : undefined }, mediaDur(c.mediaId)); return x; }, 'Look on all clips')}>Apply this clip's look to all main clips</Button>
              </div>
              <Field label="Brightness">
                <Slider value={fx.brightness ?? 1} min={0.5} max={1.5} onChange={(v) => setFx({ brightness: v })} onCommit={() => commit('Brightness')} format={(v) => `${Math.round(v * 100)}%`} />
              </Field>
              <Field label="Contrast">
                <Slider value={fx.contrast ?? 1} min={0.5} max={1.5} onChange={(v) => setFx({ contrast: v })} onCommit={() => commit('Contrast')} format={(v) => `${Math.round(v * 100)}%`} />
              </Field>
              <Field label="Saturation">
                <Slider value={fx.saturation ?? 1} min={0} max={2} onChange={(v) => setFx({ saturation: v })} onCommit={() => commit('Saturation')} format={(v) => `${Math.round(v * 100)}%`} />
              </Field>
              <Field label="Black and white">
                <Slider value={fx.grayscale ?? 0} min={0} max={1} onChange={(v) => setFx({ grayscale: v })} onCommit={() => commit('Black and white')} format={(v) => `${Math.round(v * 100)}%`} />
              </Field>
              <Field label="Blur">
                <Slider value={fx.blur ?? 0} min={0} max={0.03} step={0.0005} onChange={(v) => setFx({ blur: v })} onCommit={() => commit('Blur')} format={(v) => `${Math.round((v / 0.03) * 100)}%`} />
              </Field>
              <LightAndColour {...colour} />
              <Field label="Warmth" hint="cool to warm">
                <Slider value={fx.warmth ?? 0} min={-1} max={1} step={0.01} onChange={(v) => setFx({ warmth: v })} onCommit={() => commit('Warmth')} format={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`} />
              </Field>
              <Field label="Vignette">
                <Slider value={fx.vignette ?? 0} min={0} max={1} step={0.01} onChange={(v) => setFx({ vignette: v })} onCommit={() => commit('Vignette')} format={pct} />
              </Field>
              <Field label="Sepia">
                <Slider value={fx.sepia ?? 0} min={0} max={1} step={0.01} onChange={(v) => setFx({ sepia: v })} onCommit={() => commit('Sepia')} format={pct} />
              </Field>
              <Field label="Glow (bloom)">
                <Slider value={fx.bloom ?? 0} min={0} max={1} step={0.01} onChange={(v) => setFx({ bloom: v || undefined })} onCommit={() => commit('Glow')} format={pct} />
              </Field>
              <Field label="Colour fringe (RGB split)">
                <Slider value={(fx.rgbSplit ?? 0) * 100} min={0} max={3} step={0.05} onChange={(v) => setFx({ rgbSplit: v ? v / 100 : undefined })} onCommit={() => commit('Colour fringe')} format={(v) => `${v.toFixed(1)}%`} />
              </Field>
              <Field label="Film grain">
                <Slider value={fx.grain ?? 0} min={0} max={1} step={0.01} onChange={(v) => setFx({ grain: v })} onCommit={() => commit('Film grain')} format={pct} />
              </Field>
              <Field label="Cinema bars" hint="black bars top and bottom">
                <Slider value={fx.letterbox ?? 0} min={0} max={0.25} step={0.005} onChange={(v) => setFx({ letterbox: v })} onCommit={() => commit('Cinema bars')} format={pct} />
              </Field>
              <Toggle checked={!!fx.flip} onChange={(v) => edit((d) => updateClip(d, kind!, clip.id, { fx: { ...fx, flip: v || undefined } }, md), v ? 'Mirror' : 'Unmirror')} label="Mirror left to right" />
            </Section>
            <Section title="Curves">
              <CurveEditor {...colour} />
            </Section>
            <Section title="Colour by hue (HSL)">
              <HslControls {...colour} />
            </Section>
            <Section title="LUT">
              <LutControls {...colour} />
            </Section>
            <Section title="Apply to every clip">
              <div className="row">
                <Button size="sm" onClick={() => void runTool('set_clip_look', { clip_id: 'all', copy_from: clip.id })}>
                  Copy this grade to all main clips
                </Button>
              </div>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
