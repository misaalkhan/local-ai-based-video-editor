// Reaction GIF search (Tenor), shared by the Memes tab.
import { useState } from 'react';
import { api } from '../api.ts';
import type { GifEntry } from '../api.ts';
import { player } from '../engine/player.ts';
import { runTool } from '../actions.ts';
import { Spinner } from '../icons.tsx';
import { Button, Section } from '../ui.tsx';

/** Search box and results for reaction GIFs; a pick lands at the playhead through the same tool the assistant uses. */
export function GifSearch() {
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

