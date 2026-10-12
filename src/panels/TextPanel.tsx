import { GRAPHIC_PRESETS } from '../../shared/graphics.ts';
import { addGraphicPreset, draggable } from '../actions.ts';

const TEXT = ['hook', 'title', 'subtitle', 'label', 'serif', 'card'];

export function TextPanel() {
  return (
    <div className="panel">
      <header className="panel-head">
        <h2>Text</h2>
      </header>
      <div className="panel-body">
        <div className="hint">Click a style to add it at the playhead, or drag it onto the timeline. Drag it on the picture to move it; wrap a word in *asterisks* to colour it.</div>
        <div className="tiles">
          {TEXT.map((id) => {
            const p = GRAPHIC_PRESETS[id];
            const props = p.props as Record<string, string | number | boolean | undefined>;
            return (
              <button key={id} type="button" className="tile text-tile" onClick={() => addGraphicPreset(id)} {...draggable({ kind: 'graphic', preset: id })}>
                <span
                  className="text-sample"
                  style={{
                    fontFamily: `"${props.font}", sans-serif`,
                    fontWeight: Number(props.weight),
                    color: String(props.color ?? '#fff'),
                    background: props.background ? String(props.background) : undefined,
                    WebkitTextStroke: props.stroke ? `1.5px ${props.stroke}` : undefined,
                    textTransform: props.uppercase ? 'uppercase' : undefined,
                    textShadow: props.shadow ? '0 1px 6px rgba(0,0,0,.7)' : undefined,
                    padding: props.background ? '3px 9px' : undefined,
                    borderRadius: props.background ? 7 : undefined,
                    fontSize: id === 'title' ? 24 : id === 'label' || id === 'subtitle' ? 13 : 17,
                  }}
                >
                  {id === 'title' ? 'Title' : p.label}
                </span>
                <em>{p.label}</em>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
