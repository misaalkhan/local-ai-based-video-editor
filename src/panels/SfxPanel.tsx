// The sound library: the bundled packs (social, comedy), the user's own
// sounds (dropped in or saved from a search), favourites, and a search of
// Freesound for more. A click adds a sound at the playhead; a drag puts it
// where it is dropped on the timeline.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, uploadSound } from '../api.ts';
import type { FoundSound, SfxEntry } from '../api.ts';
import { player } from '../engine/player.ts';
import { fail, toast } from '../store.ts';
import { draggable, runTool } from '../actions.ts';
import { Icon, Spinner } from '../icons.tsx';
import { Button, IconButton, Section } from '../ui.tsx';

type Shelf = 'all' | 'favourites' | 'social' | 'comedy' | 'whoosh' | 'mine';

const SHELVES: { id: Shelf; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'favourites', label: 'Favourites' },
  { id: 'social', label: 'Social' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'whoosh', label: 'Whooshes and hits' },
  { id: 'mine', label: 'Mine' },
];

function onShelf(s: SfxEntry, shelf: Shelf): boolean {
  switch (shelf) {
    case 'all':
      return true;
    case 'favourites':
      return !!s.favourite;
    case 'social':
      return s.set === 'social' || (s.source === 'built-in' && s.role === 'ui');
    case 'comedy':
      return s.set === 'comedy';
    case 'whoosh':
      return s.role === 'whoosh' || s.role === 'impact' || s.role === 'riser';
    case 'mine':
      return s.source === 'yours';
  }
}

function matches(s: SfxEntry, q: string): boolean {
  if (!q) return true;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${s.name} ${s.tags.join(' ')}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Shared one-at-a-time audio preview. */
function usePreview() {
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  return (url: string) => {
    audio.current?.pause();
    audio.current = new Audio(url);
    audio.current.volume = 0.8;
    void audio.current.play().catch(() => {});
  };
}

export function SoundTile({ s, onPreview, onChange }: { s: SfxEntry; onPreview: (url: string) => void; onChange?: () => void }) {
  const star = async () => {
    try {
      await api.sfxFavourite(s.id, !s.favourite);
      onChange?.();
    } catch (err) {
      fail(err);
    }
  };
  const remove = async () => {
    try {
      await api.sfxRemove(s.id);
      onChange?.();
    } catch (err) {
      fail(err);
    }
  };
  return (
    <div className={`sfx ${s.favourite ? 'is-fav' : ''}`}>
      <button type="button" className="sfx-play" onClick={() => onPreview(s.url)} title="Listen" aria-label={`Listen to ${s.name}`}>
        <Icon name="play" size={11} />
      </button>
      <button
        type="button"
        className="sfx-name"
        onClick={() => void runTool('add_sfx', { sfx_id: s.id, at: player.time })}
        title={`Click to add at the playhead, or drag onto the timeline · ${s.tags.join(', ')}${s.credit ? ` · ${s.credit}` : ''}`}
        {...draggable({ kind: 'sfx', id: s.id })}
      >
        {s.name}
        {s.duration > 0 && <em>{s.duration.toFixed(1)}s</em>}
      </button>
      <button type="button" className={`sfx-star ${s.favourite ? 'on' : ''}`} onClick={() => void star()} title={s.favourite ? 'Remove from favourites' : 'Add to favourites'} aria-label="Favourite" aria-pressed={!!s.favourite}>
        ★
      </button>
      {s.source === 'yours' && s.id.startsWith('mine-') && <IconButton icon="trash" label="Remove sound" onClick={() => void remove()} />}
    </div>
  );
}

/** Search Freesound and save picks into the library. */
function FindMore({ onSaved, preview }: { onSaved: () => void; preview: (url: string) => void }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<FoundSound[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const search = async () => {
    const query = q.trim();
    if (!query || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await api.soundsSearch(query);
      setFound(r);
      if (!r.length) setNote(`Nothing for "${query}". Try another word.`);
    } catch (err) {
      setFound(null);
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async (f: FoundSound) => {
    setSaving(f.id);
    try {
      const s = await api.sfxSave(f);
      toast(`Saved "${s.name}" to your sounds${s.credit ? ' (credit line kept)' : ''}.`, 'success');
      onSaved();
    } catch (err) {
      fail(err);
    } finally {
      setSaving(null);
    }
  };
  return (
    <Section title="Find more sounds">
      <form
        className="gif-search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="cash register, vine boom, bruh…" aria-label="Search sounds online" />
        <Button size="sm" icon="sparkles" disabled={busy || !q.trim()} onClick={() => void search()}>
          Search
        </Button>
      </form>
      {busy && <Spinner />}
      {note && <div className="hint">{note}</div>}
      {found && found.length > 0 && (
        <div className="list">
          {found.map((f) => (
            <div key={f.id} className="list-item found-sound">
              <button type="button" className="sfx-play" onClick={() => preview(f.preview)} title="Listen" aria-label={`Listen to ${f.name}`}>
                <Icon name="play" size={11} />
              </button>
              <span className="list-text">
                <strong>{f.name}</strong>
                <em>
                  {f.duration}s · {f.author} · {f.licence}
                </em>
              </span>
              <Button size="sm" disabled={saving !== null} onClick={() => void save(f)}>
                {saving === f.id ? <Spinner size={11} /> : 'Save'}
              </Button>
            </div>
          ))}
        </div>
      )}
      {!found && !note && !busy && <div className="hint">Searches Freesound (key in Settings) for sounds you may use in videos: CC0 needs nothing, CC BY keeps a credit line for your caption.</div>}
    </Section>
  );
}

export function SfxPanel() {
  const [sfx, setSfx] = useState<SfxEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [shelf, setShelf] = useState<Shelf>('all');
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const preview = usePreview();
  const refresh = () => api.sfx().then(setSfx).catch(() => setSfx([]));
  useEffect(() => void refresh(), []);

  const add = async (files: FileList | File[] | null) => {
    const list = [...(files ?? [])].filter((f) => /\.(mp3|wav|m4a|aac|ogg|flac|aif|aiff)$/i.test(f.name));
    if (!list.length) return toast('Drop audio files (mp3, wav, m4a…).');
    setUploading(list.length);
    for (const f of list) {
      try {
        await uploadSound(f);
      } catch (err) {
        fail(err);
      }
      setUploading((n) => n - 1);
    }
    toast(`Added ${list.length} sound${list.length === 1 ? '' : 's'} to your library.`, 'success');
    void refresh();
    setShelf('mine');
  };

  const shown = useMemo(() => (sfx ?? []).filter((s) => onShelf(s, shelf) && matches(s, q)), [sfx, shelf, q]);
  const counts = useMemo(() => Object.fromEntries(SHELVES.map((sh) => [sh.id, (sfx ?? []).filter((s) => onShelf(s, sh.id)).length])), [sfx]);

  return (
    <div
      className={`panel ${over ? 'is-drop' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(false);
        void add(e.dataTransfer.files);
      }}
    >
      <header className="panel-head">
        <h2>Sounds</h2>
        <input ref={fileRef} type="file" multiple hidden accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
        <Button size="sm" icon="plus" onClick={() => fileRef.current?.click()} disabled={uploading > 0}>
          {uploading > 0 ? `Adding ${uploading}…` : 'Add your own'}
        </Button>
      </header>
      <div className="panel-body">
        <div className="hint">Click a sound to add it at the playhead, or drag it onto the timeline. Drop your own sound files anywhere on this panel to keep them here for every project.</div>
        <input type="search" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: keyboard, ping, shutter, record scratch…" aria-label="Search sounds" />
        <div className="chips">
          {SHELVES.map((sh) => (
            <button key={sh.id} type="button" className={`chip ${shelf === sh.id ? 'on' : ''}`} onClick={() => setShelf(sh.id)} aria-pressed={shelf === sh.id}>
              {sh.label}
              {counts[sh.id] > 0 && <span className="chip-count">{counts[sh.id]}</span>}
            </button>
          ))}
        </div>
        {sfx === null ? (
          <Spinner />
        ) : shown.length === 0 ? (
          <div className="hint">
            {shelf === 'favourites' ? 'Star a sound to keep it here.' : shelf === 'mine' ? 'Drop audio files on this panel, or save sounds from the search below.' : sfx.length === 0 ? 'No sounds are installed. Run npm run setup to download the packs.' : 'Nothing matches. Try another word.'}
          </div>
        ) : (
          <div className="sfx-grid">
            {shown.map((s) => (
              <SoundTile key={s.id} s={s} onPreview={preview} onChange={() => void refresh()} />
            ))}
          </div>
        )}
        <FindMore onSaved={() => void refresh()} preview={preview} />
        <div className="hint">The bundled packs come from Mixkit (free for any video, no credit needed). Sounds saved from Freesound are CC0 or CC BY; a CC BY credit line is kept with the sound and shown when you hover over it.</div>
      </div>
    </div>
  );
}
