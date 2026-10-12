import { addGraphicPreset, draggable } from '../actions.ts';
import { Icon } from '../icons.tsx';
import type { IconName } from '../icons.tsx';

const ITEMS: { id: string; name: string; note: string; icon: IconName }[] = [
  { id: 'popup', name: 'Pop-up card', note: 'Emoji, title and a line of detail', icon: 'sparkles' },
  { id: 'comment', name: 'Comment bubble', note: 'A viewer comment on screen', icon: 'chat' },
  { id: 'headline', name: 'Headline card', note: 'A press clipping or quote', icon: 'transcript' },
  { id: 'lower-third', name: 'Lower third', note: 'Name and role', icon: 'text' },
  { id: 'callout', name: 'Callout', note: 'A label with a pointer', icon: 'target' },
  { id: 'counter', name: 'Counter', note: 'A number that counts up', icon: 'zoomIn' },
  { id: 'list', name: 'List', note: 'Points that arrive one by one', icon: 'layers' },
  { id: 'highlight', name: 'Highlight box', note: 'Draw attention to an area', icon: 'crop' },
  { id: 'emoji', name: 'Emoji', note: 'A big reaction', icon: 'sparkles' },
  { id: 'progress', name: 'Progress bar', note: 'Fills across the top', icon: 'sliders' },
];

export function GraphicsPanel() {
  return (
    <div className="panel">
      <header className="panel-head">
        <h2>Overlays</h2>
      </header>
      <div className="panel-body">
        <div className="hint">Animated graphics for the Graphic track. Click one to add it at the playhead, or drag it onto the timeline, then edit its text on the Edit tab. Reaction GIFs and meme templates are on the Memes tab.</div>
        <div className="list">
          {ITEMS.map((it) => (
            <button key={it.id} type="button" className="list-item" onClick={() => addGraphicPreset(it.id)} {...draggable({ kind: 'graphic', preset: it.id })}>
              <span className="list-icon">
                <Icon name={it.icon} size={16} />
              </span>
              <span className="list-text">
                <strong>{it.name}</strong>
                <em>{it.note}</em>
              </span>
              <Icon name="plus" size={14} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
