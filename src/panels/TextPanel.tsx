import { GRAPHIC_PRESETS } from '../../shared/graphics.ts';
import { addGraphicPreset, draggable } from '../actions.ts';

const TEXT = ['hook', 'title', 'subtitle', 'label', 'serif', 'card', 'meme', 'comic', 'sticker', 'neon', 'handwritten', 'marker', 'quote', 'glitch', 'gradient', 'typewriter'];

/** A text preset as a tile: a rough CSS echo of what the renderer draws, enough to tell the styles apart. Click adds it at the playhead; drag it onto the timeline. */
export function TextTile({ id, sample }: { id: string; sample?: string }) {
  const p = GRAPHIC_PRESETS[id];
  const props = p.props as Record<string, string | number | boolean | undefined>;
  const shadows: string[] = [];
  if (props.shadow) shadows.push('0 1px 6px rgba(0,0,0,.7)');
  if (props.glow) shadows.push(`0 0 6px ${props.glow}, 0 0 14px ${props.glow}`);
  if (props.offsetShadow) shadows.push(`2px 2px 0 ${props.offsetShadow}`);
  if (props.glitch) shadows.push('-1.5px 0 #00E5FF, 1.5px 0 #FF2BD6');
  const bg = props.highlighter ? String(props.highlighter) : props.background ? String(props.background) : undefined;
  const big = ['title', 'coquette', 'princess', 'twinkle', 'y2k'].includes(id);
  const small = ['label', 'subtitle', 'typewriter', 'diary', 'burnbook'].includes(id);
  return (
    <button type="button" className="tile text-tile" onClick={() => addGraphicPreset(id)} {...draggable({ kind: 'graphic', preset: id })}>
      <span
        className="text-sample"
        style={{
          fontFamily: `"${props.font}", sans-serif`,
          fontWeight: Number(props.weight),
          color: String(props.color ?? '#fff'),
          background: props.gradient ? `linear-gradient(${props.color}, ${props.gradient})` : bg,
          WebkitBackgroundClip: props.gradient ? 'text' : undefined,
          WebkitTextFillColor: props.gradient ? 'transparent' : undefined,
          WebkitTextStroke: props.stroke ? `1.5px ${props.stroke}` : undefined,
          textTransform: props.uppercase ? 'uppercase' : undefined,
          textShadow: shadows.join(', ') || undefined,
          padding: bg ? '3px 9px' : undefined,
          borderRadius: bg ? 7 : undefined,
          border: props.border ? `2px solid ${props.border}` : undefined,
          transform: p.rotation ? `rotate(${p.rotation}deg)` : undefined,
          fontSize: big ? 24 : small ? 13 : 17,
        }}
      >
        {sample ?? (id === 'title' ? 'Title' : id === 'typewriter' ? 'Typewriter▌' : p.label)}
      </span>
      <em>{p.label}</em>
    </button>
  );
}

export function TextPanel() {
  return (
    <div className="panel">
      <header className="panel-head">
        <h2>Text</h2>
      </header>
      <div className="panel-body">
        <div className="hint">Click a style to add it at the playhead, or drag it onto the timeline. Drag it on the picture to move it; wrap a word in *asterisks* to colour it. The cute and pink styles are on the Girlypop tab.</div>
        <div className="tiles">
          {TEXT.map((id) => (
            <TextTile key={id} id={id} />
          ))}
        </div>
      </div>
    </div>
  );
}
