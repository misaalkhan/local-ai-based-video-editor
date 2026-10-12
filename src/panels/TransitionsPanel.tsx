import type { TransitionType } from '../../shared/types.ts';
import { setTransition } from '../../shared/ops.ts';
import { useDerived, useDoc, useStore } from '../store.ts';
import { commit, edit, live } from '../actions.ts';
import { Empty, Field, Slider } from '../ui.tsx';

const TYPES: { id: TransitionType | 'none'; name: string }[] = [
  { id: 'none', name: 'Cut' },
  { id: 'fade', name: 'Cross fade' },
  { id: 'dip', name: 'Dip to black' },
  { id: 'slide-left', name: 'Slide left' },
  { id: 'slide-right', name: 'Slide right' },
  { id: 'slide-up', name: 'Slide up' },
  { id: 'zoom', name: 'Zoom through' },
];

export function TransitionsPanel() {
  const doc = useDoc()!;
  const derived = useDerived()!;
  const selection = useStore((s) => s.selection);
  const seg = selection?.kind === 'main' ? derived.layout.find((s) => s.clip.id === selection.id) : undefined;

  if (!seg || seg.index === 0) {
    return (
      <div className="panel">
        <header className="panel-head"><h2>Transitions</h2></header>
        <div className="panel-body">
          <Empty icon="transition" title="Select a clip on the main track">
            A transition plays as the selected clip arrives from the one before it, so pick the second clip of the pair. Plain cuts are usually best for talking; save transitions for a change of scene.
          </Empty>
        </div>
      </div>
    );
  }
  const cur = doc.main[seg.index].transition;
  const type = cur?.type ?? 'none';
  const duration = cur?.duration ?? 0.4;
  return (
    <div className="panel">
      <header className="panel-head"><h2>Transitions</h2></header>
      <div className="panel-body">
        <div className="hint">How the selected clip arrives from the one before it.</div>
        <div className="tiles two">
          {TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tile ${type === t.id ? 'on' : ''}`}
              aria-pressed={type === t.id}
              onClick={() => edit((d) => setTransition(d, seg.clip.id, t.id === 'none' ? null : { type: t.id, duration }), `Transition: ${t.name}`)}
            >
              <em>{t.name}</em>
            </button>
          ))}
        </div>
        {type !== 'none' && (
          <Field label="Length">
            <Slider
              value={duration}
              min={0.1}
              max={1.5}
              step={0.05}
              onChange={(v) => live((d) => setTransition(d, seg.clip.id, { type: type as TransitionType, duration: v }))}
              onCommit={() => commit('Transition length')}
              format={(v) => `${v.toFixed(2)} s`}
            />
          </Field>
        )}
      </div>
    </div>
  );
}
