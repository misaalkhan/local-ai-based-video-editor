import { useState } from 'react';
import { api } from '../api.ts';
import type { GifEntry } from '../api.ts';
import { player } from '../engine/player.ts';
import { addGraphicPreset, draggable, runTool } from '../actions.ts';
import { Icon, Spinner } from '../icons.tsx';
import type { IconName } from '../icons.tsx';
import { Button, Section } from '../ui.tsx';

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

/** Search box and results for reaction GIFs; a pick lands at the playhead through the same tool the assistant uses. */
function GifSearch() {
  const [q, setQ] = useState('');
  const [gifs, setGifs] = useState<GifEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const search = async () => {
    const query = q.trim();
    if (!query || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.gifs(query);
      setGifs(r);
      if (!r.length) setNote(`Nothing for "${query}". Try a broader word.`);
    } catch (err) {
      setGifs(null);
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const add = async (g: GifEntry) => {
    setAdding(g.id);
    try {
      await runTool('add_gif', { gif_id: g.id, start: player.time, duration: 2.5 });
    } finally {
      setAdding(null);
    }
  };
  return (
    <Section title="Reaction GIFs">
      <form
        className="gif-search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="facepalm, mind blown, slow clap…" aria-label="Search GIFs" />
        <Button size="sm" icon="sparkles" disabled={busy || !q.trim()} onClick={() => void search()}>
          Search
        </Button>
      </form>
      {busy && <Spinner />}
      {note && <div className="hint">{note}</div>}
      {gifs && gifs.length > 0 && (
        <div className="gif-grid">
          {gifs.map((g) => (
            <button key={g.id} type="button" className={`gif${adding === g.id ? ' is-busy' : ''}`} onClick={() => void add(g)} disabled={adding !== null} title={`${g.description || 'GIF'} · click to add 2.5 s at the playhead`}>
              <img src={g.preview} alt={g.description || 'GIF'} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {!gifs && !note && !busy && <div className="hint">Searches Tenor (key in Settings). A GIF goes on as a small looping picture-in-picture, placed clear of the face.</div>}
    </Section>
  );
}

export function GraphicsPanel() {
  return (
    <div className="panel">
      <header className="panel-head">
        <h2>Overlays</h2>
      </header>
      <div className="panel-body">
        <div className="hint">Animated graphics for the Graphic track. Click one to add it at the playhead, or drag it onto the timeline, then edit its text on the Edit tab.</div>
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
        <GifSearch />
      </div>
    </div>
  );
}
