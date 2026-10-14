// Girlypop: everything cute, pink and girly in one place. The fonts, caption
// styles, text, looks, effects, stickers, transitions and sounds here are the
// same ones the other tabs and the assistant use; this tab only gathers them.
// The chick flick shelf puts the famous lines on as quote cards and finds the
// scenes through GIF search.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CaptionStyle, TransitionType } from '../../shared/types.ts';
import { CHICK_FLICKS, GIRLY_REACTIONS } from '../../shared/chickflicks.ts';
import type { ChickFlick } from '../../shared/chickflicks.ts';
import { GRAPHIC_PRESETS } from '../../shared/graphics.ts';
import { LOOKS } from '../../shared/draw.ts';
import { FONT_NOTES } from '../../shared/fonts.ts';
import * as ops from '../../shared/ops.ts';
import { api } from '../api.ts';
import type { SfxEntry } from '../api.ts';
import { player } from '../engine/player.ts';
import { applyEdit, select, useDerived, useDoc, useStore } from '../store.ts';
import { addGraphicPreset, draggable, edit, runTool } from '../actions.ts';
import { Icon, Spinner } from '../icons.tsx';
import { Button, Section } from '../ui.tsx';
import { GifSearch } from './GifSearch.tsx';
import { SoundTile } from './SfxPanel.tsx';
import { TextTile } from './TextPanel.tsx';

const CAPTIONS: { id: CaptionStyle; name: string; note: string }[] = [
  { id: 'bubble', name: 'Bubble', note: 'White words on pink pills' },
  { id: 'sparkle', name: 'Sparkle', note: 'Glowing script, stars on the spoken word' },
  { id: 'coquette', name: 'Coquette', note: 'Serif, pink underline, a beating heart' },
  { id: 'y2k', name: 'Y2K', note: 'Chrome bubble letters, pink outline' },
  { id: 'kawaii', name: 'Kawaii', note: 'Soft bubble handwriting that wobbles' },
];

const TEXT = ['bubblegum', 'pinkhook', 'pinksticker', 'coquette', 'lovenote', 'y2k', 'pinkneon', 'burnbook', 'princess', 'diary', 'cherry', 'twinkle'];

const FONTS = ['Chewy', 'Fredoka', 'Baloo 2', 'Sniglet', 'Bubblegum Sans', 'Fuzzy Bubbles', 'Borel', 'Parisienne', 'Great Vibes', 'Sacramento', 'Satisfy', 'Cookie', 'Kaushan Script', 'Grand Hotel', 'Playball', 'Shadows Into Light', 'Indie Flower', 'Gochi Hand', 'Amatic SC', 'Emilys Candy', 'Princess Sofia', 'Cherry Cream Soda', 'Twinkle Star', 'Pacifico', 'Dancing Script'];

const LOOK_IDS = ['blush', 'peach', 'cottoncandy', 'barbie', 'vanilla', 'rosy', 'glam', 'y2k', 'pastel', 'dreamy'];

const EFFECTS: { id: string; name: string; note: string }[] = [
  { id: 'sparkles', name: 'Sparkles', note: 'Twinkling stars' },
  { id: 'hearts', name: 'Hearts', note: 'Floating, beating' },
  { id: 'glitter', name: 'Glitter', note: 'Fine gold and pink' },
  { id: 'bubbles', name: 'Bubbles', note: 'Rising soap bubbles' },
  { id: 'butterflies', name: 'Butterflies', note: 'Pastel, fluttering' },
  { id: 'petals', name: 'Petals', note: 'Pink petals swaying down' },
  { id: 'bokeh', name: 'Bokeh', note: 'Dreamy soft lights' },
  { id: 'pinkleak', name: 'Pink light leak', note: 'Pink light at the edges' },
];

const STICKERS = ['🎀', '💖', '✨', '🌸', '💅', '🦋', '👛', '💄', '🍓', '🧸', '🩰', '🫧', '🌷', '👑', '🍒', '🥂', '💌', '🛍️', '🪩', '💋', '🎧', '☕'];

const SOUNDS = ['Cartoon kiss', 'Sparkle whoosh', 'Magic poof', 'Soap bubble', 'Giggling', 'Silly pop cluster', 'Bubble notification', 'Achievement bell', 'Magic coin', 'Toy whistle', 'Message pop', 'Fanfare', 'Cheer and applause', 'Cartoon laugh', 'Boing'];

const TRANSITIONS: { id: TransitionType; name: string; note: string }[] = [
  { id: 'heart', name: 'Heart', note: 'The next shot opens through a heart' },
  { id: 'sparkle', name: 'Sparkle', note: 'A burst of stars and a pink flash' },
  { id: 'flash', name: 'Flash', note: 'A white flash on the beat' },
  { id: 'blur', name: 'Blur', note: 'Soft, dreamy' },
];

function Fonts() {
  const doc = useDoc()!;
  const addText = (font: string) => addGraphicPreset('lovenote', { text: 'girlypop', font, weight: FONTS.includes(font) ? 400 : 700, size: 0.095 });
  const forCaptions = (font: string) => edit((d) => ops.setCaptions(d, { font, enabled: true }), `Caption font ${font}`);
  return (
    <Section title="Fonts">
      <div className="hint">Click a font to add text in it at the playhead; the caption button puts it on the captions. Every one is bundled, so the export matches.</div>
      <div className="list font-list">
        {FONTS.map((f) => (
          <div key={f} className={`list-item font-row ${doc.captions.font === f ? 'on' : ''}`}>
            <button type="button" className="font-sample" style={{ fontFamily: `"${f}", sans-serif` }} onClick={() => addText(f)} title={FONT_NOTES[f] ?? ''}>
              {f}
            </button>
            <span className="list-text">
              <em>{FONT_NOTES[f] ?? ''}</em>
            </span>
            <button type="button" className="icon-btn" title={`Use ${f} for captions`} aria-label={`Use ${f} for captions`} onClick={() => forCaptions(f)}>
              <Icon name="captions" size={14} />
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Looks() {
  const doc = useDoc()!;
  const selection = useStore((s) => s.selection);
  const target = selection?.kind === 'main' || selection?.kind === 'overlay' ? selection.id : 'all';
  const [busy, setBusy] = useState<string | null>(null);
  const apply = async (id: string) => {
    setBusy(id);
    try {
      await runTool('set_clip_look', { clip_id: target, look: id });
    } finally {
      setBusy(null);
    }
  };
  const current = selection?.kind === 'main' ? doc.main.find((c) => c.id === selection.id) : undefined;
  const hasClips = doc.main.some((c) => c.kind === 'media');
  return (
    <Section title="Looks">
      <div className="hint">{target === 'all' ? 'Applied to every main clip, so the piece holds together. Select a clip to grade only that one.' : `Applied to the selected clip${current?.name ? ` (${current.name})` : ''}.`} Fine-tune on the Effects tab.</div>
      <div className="chips">
        {LOOK_IDS.map((id) => (
          <button key={id} type="button" className={`chip look-chip look-${id}`} disabled={!hasClips || busy !== null} onClick={() => void apply(id)}>
            {busy === id ? <Spinner size={11} /> : LOOKS[id].label}
          </button>
        ))}
      </div>
    </Section>
  );
}

function Transitions() {
  const doc = useDoc()!;
  const derived = useDerived()!;
  const selection = useStore((s) => s.selection);
  const seg = selection?.kind === 'main' ? derived.layout.find((s) => s.clip.id === selection.id) : undefined;
  const cur = seg ? doc.main[seg.index].transition : undefined;
  const set = (type: TransitionType) => {
    if (!seg) return;
    edit((d) => ops.setTransition(d, seg.clip.id, { type, duration: cur?.duration ?? 0.5 }), `${type} transition`);
  };
  return (
    <Section title="Transitions">
      {!seg || seg.index === 0 ? (
        <div className="hint">Select the clip a transition should arrive on (the second of a pair) and pick one.</div>
      ) : (
        <div className="chips">
          {TRANSITIONS.map((t) => (
            <button key={t.id} type="button" className={`chip ${cur?.type === t.id ? 'on' : ''}`} title={t.note} onClick={() => set(t.id)}>
              {t.name}
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

function Sounds() {
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
  const cute = useMemo(() => {
    const byName = new Map((sfx ?? []).map((s) => [s.name, s]));
    return SOUNDS.map((n) => byName.get(n)).filter((s): s is SfxEntry => !!s);
  }, [sfx]);
  return (
    <Section title="Sounds">
      {sfx === null ? (
        <Spinner />
      ) : cute.length === 0 ? (
        <div className="hint">The sound packs are not installed. Run npm run setup.</div>
      ) : (
        <div className="sfx-grid">
          {cute.map((s) => (
            <SoundTile key={s.id} s={s} onPreview={preview} onChange={() => void refresh()} />
          ))}
        </div>
      )}
    </Section>
  );
}

type QuoteStyle = 'card' | 'sticker' | 'burnbook' | 'coquette';

function ChickFlicks({ onGifs }: { onGifs: (q: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [style, setStyle] = useState<QuoteStyle>('card');
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return CHICK_FLICKS;
    return CHICK_FLICKS.filter((f) => words.every((w) => f.title.toLowerCase().includes(w) || f.quotes.some((x) => x.toLowerCase().includes(w))));
  }, [q]);
  const add = (film: ChickFlick, quote: string) => {
    const presetId = style === 'card' ? 'quotecard' : style === 'sticker' ? 'pinksticker' : style;
    const preset = GRAPHIC_PRESETS[presetId];
    const long = quote.length > 40;
    const props: Record<string, unknown> = style === 'card' ? { emoji: film.emoji, title: quote, subtitle: `${film.title} (${film.year})` } : { text: quote, uppercase: false, ...(long ? { size: Number(preset.props.size ?? 0.08) * 0.7 } : {}) };
    const duration = Math.max(preset.duration, 1.2 + quote.split(' ').length * 0.32);
    applyEdit((d) => {
      const r = ops.addGraphic(d, { preset: presetId, props, start: player.time, duration, name: `Quote: ${quote.slice(0, 24)}` });
      queueMicrotask(() => select({ kind: 'graphic', id: r.item.id }));
      return r.doc;
    }, 'Add quote');
  };
  return (
    <Section title="Chick flick memes">
      <div className="hint">The lines everyone knows, on as a quote card or a sticker at the playhead. The scene itself comes from GIF search below (Tenor key in Settings); the films belong to their studios, so there are no clips here.</div>
      <div className="row wrap">
        <input type="search" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a film or a line…" aria-label="Search chick flick quotes" />
      </div>
      <div className="segmented" role="radiogroup" aria-label="Quote style">
        {(['card', 'sticker', 'burnbook', 'coquette'] as QuoteStyle[]).map((s) => (
          <button key={s} type="button" role="radio" aria-checked={style === s} className={style === s ? 'on' : ''} onClick={() => setStyle(s)}>
            {s === 'card' ? 'Quote card' : s === 'sticker' ? 'Sticker' : s === 'burnbook' ? 'Burn Book' : 'Coquette'}
          </button>
        ))}
      </div>
      <div className="list films">
        {shown.map((f) => {
          const isOpen = open === f.id || (q.trim().length > 0 && shown.length <= 4);
          return (
            <div key={f.id} className={`film ${isOpen ? 'open' : ''}`}>
              <button type="button" className="list-item film-head" onClick={() => setOpen(isOpen && !q ? null : f.id)}>
                <span className="list-icon film-emoji">{f.emoji}</span>
                <span className="list-text">
                  <strong>{f.title}</strong>
                  <em>
                    {f.year} · {f.quotes.length} line{f.quotes.length === 1 ? '' : 's'}
                  </em>
                </span>
                <Icon name={isOpen ? 'down' : 'plus'} size={14} />
              </button>
              {isOpen && (
                <div className="film-body">
                  {f.quotes.map((quote) => (
                    <button key={quote} type="button" className="quote-chip" onClick={() => add(f, quote)} title="Add at the playhead">
                      {quote}
                    </button>
                  ))}
                  <Button size="sm" icon="sparkles" onClick={() => onGifs(f.gif)}>
                    GIFs from {f.title}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

export function GirlypopPanel() {
  const doc = useDoc()!;
  const [gif, setGif] = useState<{ q: string; n: number }>({ q: '', n: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const style = doc.captions.style;
  const recipe = async (id: string) => {
    setBusy(id);
    try {
      await runTool('apply_recipe', { recipe: id });
    } finally {
      setBusy(null);
    }
  };
  const captions = (id: CaptionStyle) => edit((d) => ops.setCaptions(d, { style: id, enabled: true }), `Captions ${id}`);
  const searchGifs = (q: string) => setGif((g) => ({ q, n: g.n + 1 }));
  return (
    <div className="panel girlypop">
      <header className="panel-head">
        <h2>Girlypop</h2>
      </header>
      <div className="panel-body">
        <div className="hint">Cute, pink and girly, all in one place. One click sets the whole style; or pick the pieces below. The assistant knows all of it too: ask for "girlypop", "coquette", "Barbie" or "Y2K".</div>
        <div className="row wrap">
          <Button size="sm" variant="primary" icon="heart" disabled={busy !== null} onClick={() => void recipe('girlypop')}>
            {busy === 'girlypop' ? <Spinner size={11} /> : 'Girlypop style'}
          </Button>
          <Button size="sm" icon="sparkles" disabled={busy !== null} onClick={() => void recipe('coquette')}>
            {busy === 'coquette' ? <Spinner size={11} /> : 'Coquette style'}
          </Button>
        </div>
        <Section title="Captions">
          <div className="tiles">
            {CAPTIONS.map((c) => (
              <button key={c.id} type="button" className={`tile ${style === c.id && doc.captions.enabled ? 'on' : ''}`} onClick={() => captions(c.id)}>
                <span className={`cap-sample cap-${c.id}`}>
                  <b>so</b>
                  <b className="hot">cute</b>
                </span>
                <strong>{c.name}</strong>
                <em>{c.note}</em>
              </button>
            ))}
          </div>
        </Section>
        <Section title="Text">
          <div className="tiles">
            {TEXT.map((id) => (
              <TextTile key={id} id={id} />
            ))}
          </div>
        </Section>
        <Section title="Stickers">
          <div className="chips stickers">
            {STICKERS.map((e) => (
              <button key={e} type="button" className="sticker" onClick={() => addGraphicPreset('emoji', { emoji: e })} {...draggable({ kind: 'graphic', preset: 'emoji' })} title="Add at the playhead">
                {e}
              </button>
            ))}
          </div>
        </Section>
        <Section title="Effects">
          <div className="list">
            {EFFECTS.map((it) => (
              <button key={it.id} type="button" className="list-item" onClick={() => addGraphicPreset(it.id)} {...draggable({ kind: 'graphic', preset: it.id })}>
                <span className="list-icon">
                  <Icon name={it.id === 'hearts' || it.id === 'butterflies' ? 'heart' : 'sparkles'} size={16} />
                </span>
                <span className="list-text">
                  <strong>{it.name}</strong>
                  <em>{it.note}</em>
                </span>
                <Icon name="plus" size={14} />
              </button>
            ))}
          </div>
        </Section>
        <Looks />
        <Transitions />
        <Fonts />
        <Sounds />
        <ChickFlicks onGifs={searchGifs} />
        <Section title="Girly reactions">
          <div className="chips">
            {GIRLY_REACTIONS.map((r) => (
              <button key={r} type="button" className="chip" onClick={() => searchGifs(r)}>
                {r}
              </button>
            ))}
          </div>
        </Section>
        <GifSearch preset={gif.n ? gif : undefined} title="GIFs" placeholder="a film, a scene, a reaction…" />
      </div>
    </div>
  );
}
