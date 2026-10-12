// Memes: the sounds everybody knows, reaction GIFs, meme templates with top
// and bottom text, and the meme text styles.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as ops from '../../shared/ops.ts';
import { api } from '../api.ts';
import type { MemeTemplate, SfxEntry } from '../api.ts';
import { player } from '../engine/player.ts';
import { applyEdit, fail, select, toast, useDoc, useStore } from '../store.ts';
import { addGraphicPreset } from '../actions.ts';
import { Spinner } from '../icons.tsx';
import { Button, Section } from '../ui.tsx';
import { GifSearch } from './GifSearch.tsx';
import { SoundTile } from './SfxPanel.tsx';

function MemeSounds() {
  const [sfx, setSfx] = useState<SfxEntry[] | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const refresh = () => api.sfx().then(setSfx).catch(() => setSfx([]));
  useEffect(() => {
    void refresh();
    return () => audio.current?.pause();
  }, []);
  const preview = (url: string) => {
    audio.current?.pause();
    audio.current = new Audio(url);
    audio.current.volume = 0.8;
    void audio.current.play().catch(() => {});
  };
  const memes = useMemo(() => (sfx ?? []).filter((s) => s.tags.includes('meme')), [sfx]);
  return (
    <Section title="Meme sounds">
      {sfx === null ? (
        <Spinner />
      ) : memes.length === 0 ? (
        <div className="hint">The sound packs are not installed. Run npm run setup.</div>
      ) : (
        <div className="sfx-grid">
          {memes.map((s) => (
            <SoundTile key={s.id} s={s} onPreview={preview} onChange={() => void refresh()} />
          ))}
        </div>
      )}
    </Section>
  );
}

/** Where a template picture's top and bottom edges land in a frame of this aspect, with "contain" framing. */
function memeEdges(t: MemeTemplate, W: number, H: number): { top: number; bottom: number } {
  const frameAspect = W / H;
  const imgAspect = t.width / t.height;
  if (imgAspect >= frameAspect) {
    const h = (W / imgAspect) / H;
    return { top: 0.5 - h / 2, bottom: 0.5 + h / 2 };
  }
  return { top: 0, bottom: 1 };
}

function MemeTemplates() {
  const doc = useDoc()!;
  const projectId = useStore((s) => s.projectId)!;
  const [q, setQ] = useState('');
  const [all, setAll] = useState<MemeTemplate[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pick, setPick] = useState<MemeTemplate | null>(null);
  const [top, setTop] = useState('');
  const [bottom, setBottom] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .memeTemplates('')
      .then(setAll)
      .catch((err: Error) => setNote(err.message));
  }, []);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (all ?? []).filter((t) => words.every((w) => t.name.toLowerCase().includes(w))).slice(0, 60);
  }, [all, q]);

  const add = async () => {
    if (!pick || busy) return;
    setBusy(true);
    try {
      const { media, template } = await api.addMeme(projectId, pick.id);
      const start = player.time;
      const duration = 3;
      const { top: yTop, bottom: yBottom } = memeEdges(template, doc.settings.width, doc.settings.height);
      applyEdit((d) => {
        let next = ops.addOverlay(d, media, { start, duration, framing: { fit: 'contain', focusX: 0.5, focusY: 0.5, scale: 1, blurFill: true }, muted: true, name: media.name }).doc;
        const size = 0.062;
        if (top.trim()) next = ops.addGraphic(next, { preset: 'meme', props: { text: top.trim(), size, maxWidth: 0.94 }, start, duration, y: yTop + 0.065, name: `Meme: ${top.trim().slice(0, 24)}` }).doc;
        if (bottom.trim()) next = ops.addGraphic(next, { preset: 'meme', props: { text: bottom.trim(), size, maxWidth: 0.94 }, start, duration, y: yBottom - 0.065, name: `Meme: ${bottom.trim().slice(0, 24)}` }).doc;
        return next;
      }, 'Add meme');
      toast(`Added "${template.name}" for ${duration} s at the playhead.`, 'success');
      setPick(null);
      setTop('');
      setBottom('');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Meme templates">
      <input type="search" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search: drake, distracted, cat, button…" aria-label="Search meme templates" />
      {note && <div className="hint">{note}</div>}
      {all === null && !note && <Spinner />}
      {pick && (
        <div className="meme-compose">
          <img src={pick.url} alt={pick.name} />
          <div className="meme-compose-fields">
            <strong>{pick.name}</strong>
            <input type="text" className="input" value={top} onChange={(e) => setTop(e.target.value)} placeholder="Top text" aria-label="Top text" />
            <input type="text" className="input" value={bottom} onChange={(e) => setBottom(e.target.value)} placeholder="Bottom text" aria-label="Bottom text" />
            <div className="row">
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void add()}>
                {busy ? <Spinner size={11} /> : 'Add at playhead'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPick(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
      {shown.length > 0 && (
        <div className="meme-grid">
          {shown.map((t) => (
            <button key={t.id} type="button" className={`meme ${pick?.id === t.id ? 'on' : ''}`} onClick={() => setPick(t)} title={t.name}>
              <img src={t.url} alt={t.name} loading="lazy" />
              <span>{t.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="hint">Templates come from Imgflip's public list and are fetched only when you pick one; the pictures belong to their makers. The template goes on the b-roll track with your text in the meme style on top; move it or edit the text on the Edit tab.</div>
    </Section>
  );
}

export function MemesPanel() {
  const doc = useDoc()!;
  const vertical = doc.settings.height > doc.settings.width;
  const quick = (preset: string, y: number, text: string) => {
    applyEdit((d) => {
      const r = ops.addGraphic(d, { preset, props: { text }, start: player.time, y, name: text });
      queueMicrotask(() => select({ kind: 'graphic', id: r.item.id }));
      return r.doc;
    }, 'Add meme text');
  };
  return (
    <div className="panel">
      <header className="panel-head">
        <h2>Memes</h2>
      </header>
      <div className="panel-body">
        <Section title="Meme text">
          <div className="row wrap">
            <Button size="sm" onClick={() => quick('meme', vertical ? 0.08 : 0.1, 'TOP TEXT')}>
              Top text
            </Button>
            <Button size="sm" onClick={() => quick('meme', vertical ? 0.9 : 0.88, 'BOTTOM TEXT')}>
              Bottom text
            </Button>
            <Button size="sm" onClick={() => addGraphicPreset('comic')}>
              Comic
            </Button>
            <Button size="sm" onClick={() => addGraphicPreset('sticker')}>
              Sticker
            </Button>
          </div>
        </Section>
        <MemeSounds />
        <GifSearch />
        <MemeTemplates />
      </div>
    </div>
  );
}
