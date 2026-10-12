import type { CaptionSettings, CaptionStyle } from '../../shared/types.ts';
import { setCaptions } from '../../shared/ops.ts';
import { FONT_FAMILIES } from '../../shared/fonts.ts';
import { CAPTION_STYLES } from '../../shared/draw.ts';
import { useEffect, useState } from 'react';
import type { Recipe } from '../../shared/types.ts';
import { api } from '../api.ts';
import { fail, useDerived, useDoc } from '../store.ts';
import { commit, edit, live, runTool } from '../actions.ts';
import { Button, ColorInput, Field, IconButton, Section, Select, Slider, TextInput, Toggle } from '../ui.tsx';

/** Saved styles: apply one to this project, or keep the current one for later. */
function Recipes() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const refresh = () => api.recipes().then(setRecipes).catch(fail);
  useEffect(() => void refresh(), []);
  return (
    <Section title="Style recipes">
      <div className="hint">A recipe is a whole style: captions, fonts, colour, pacing and music level. Applying one sets the captions and colour now; the assistant follows the rest when you ask it to edit.</div>
      <div className="list">
        {recipes.map((r) => (
          <div key={r.id} className="list-item recipe">
            <span className="list-text">
              <strong>{r.name}</strong>
              <em>{r.description}</em>
            </span>
            {!r.builtIn && <IconButton icon="trash" label="Delete recipe" onClick={() => api.removeRecipe(r.id).then(refresh).catch(fail)} />}
            <Button size="sm" onClick={() => void runTool('apply_recipe', { recipe: r.id })}>Apply</Button>
          </div>
        ))}
      </div>
      <div className="row">
        <TextInput value={name} placeholder="Save the current style as…" onChange={setName} />
        <Button
          size="sm"
          disabled={!name.trim() || saving}
          onClick={async () => {
            setSaving(true);
            await runTool('save_recipe', { name: name.trim(), description: `Saved from ${document.title.split(' · ')[0]}` });
            setSaving(false);
            setName('');
            void refresh();
          }}
        >
          Save
        </Button>
      </div>
    </Section>
  );
}

const STYLES: { id: CaptionStyle; name: string; note: string }[] = [
  { id: 'pop', name: 'Bold pop', note: 'Two or three big words at a time' },
  { id: 'highlight', name: 'Highlight', note: 'A box follows the word being said' },
  { id: 'karaoke', name: 'Karaoke', note: 'Words fill in as they are spoken' },
  { id: 'clean', name: 'Clean', note: 'A plain, readable line' },
  { id: 'boxed', name: 'Boxed', note: 'Classic subtitles on a dark box' },
  { id: 'outline', name: 'Outline', note: 'Tall block capitals with a thick outline' },
  { id: 'oneword', name: 'One word', note: 'One huge word at a time' },
  { id: 'glow', name: 'Neon', note: 'Soft glow in the accent colour' },
  { id: 'glass', name: 'Glass', note: 'A frosted pill behind the line' },
  { id: 'typewriter', name: 'Typewriter', note: 'Words typed in with a cursor' },
  { id: 'band', name: 'Band', note: 'A full-width colour band, like a headline' },
  { id: 'underline', name: 'Underline', note: 'A bar slides under the spoken word' },
  { id: 'retro', name: 'Retro', note: 'Chunky letters with a hard shadow' },
  { id: 'comic', name: 'Comic', note: 'Comic lettering that wobbles' },
];

function Sample({ id, active }: { id: CaptionStyle; active: boolean }) {
  const spec = CAPTION_STYLES[id];
  const caps = ['pop', 'karaoke', 'outline', 'oneword', 'band', 'retro', 'comic'].includes(id);
  const words = id === 'oneword' ? ['POP'] : caps ? ['MAKE', 'IT', 'POP'] : ['Make', 'it', 'pop'];
  return (
    <span className={`cap-sample cap-${id} ${active ? 'on' : ''}`} style={{ fontFamily: `"${spec.font}", sans-serif`, fontWeight: spec.weight }}>
      {words.map((w, i) => (
        <b key={w} className={i === 1 ? 'hot' : ''}>
          {w}
        </b>
      ))}
    </span>
  );
}

export function CaptionsPanel() {
  const doc = useDoc()!;
  const derived = useDerived()!;
  const c = doc.captions;
  const set = (patch: Partial<CaptionSettings>) => live((d) => setCaptions(d, patch));
  const now = (patch: Partial<CaptionSettings>, label: string) => edit((d) => setCaptions(d, patch), label);
  const hasWords = derived.words.length > 0;

  return (
    <div className="panel">
      <header className="panel-head">
        <h2>Captions</h2>
        <Toggle checked={c.enabled} onChange={(v) => now({ enabled: v }, v ? 'Captions on' : 'Captions off')} label={c.enabled ? 'On' : 'Off'} />
      </header>
      <div className="panel-body">
        {!hasWords && <div className="hint">Captions come from the transcript of the clips on the main track. Add a clip with speech and they will appear, timed to every word.</div>}
        <Section title="Style">
          <div className="cap-styles">
            {STYLES.map((s) => (
              <button key={s.id} type="button" className={`cap-style ${c.style === s.id ? 'on' : ''}`} onClick={() => now({ style: s.id, enabled: true }, `Caption style: ${s.name}`)} aria-pressed={c.style === s.id}>
                <Sample id={s.id} active={c.style === s.id} />
                <strong>{s.name}</strong>
                <span>{s.note}</span>
              </button>
            ))}
          </div>
        </Section>
        <Section title="Layout">
          <Field label="Size">
            <Slider value={c.size} min={0.5} max={2} step={0.01} onChange={(v) => set({ size: v })} onCommit={() => commit('Caption size')} format={(v) => `${Math.round(v * 100)}%`} />
          </Field>
          <Field label="Position" hint="top to bottom">
            <Slider value={c.y} min={0.08} max={0.92} step={0.005} onChange={(v) => set({ y: v })} onCommit={() => commit('Caption position')} format={(v) => `${Math.round(v * 100)}%`} />
          </Field>
          <Field label="Words at a time">
            <Slider value={c.maxWords} min={1} max={9} step={1} onChange={(v) => set({ maxWords: v })} onCommit={() => commit('Caption length')} format={(v) => String(v)} />
          </Field>
          <Field label="Font">
            <Select
              value={c.font ?? ''}
              options={[{ value: '', label: 'Style default' }, ...FONT_FAMILIES.map((f) => ({ value: f, label: f }))]}
              onChange={(v) => now({ font: v || undefined }, 'Caption font')}
            />
          </Field>
          <div className="row">
            <Toggle checked={c.uppercase} onChange={(v) => now({ uppercase: v }, 'Caption case')} label="ALL CAPS" />
            <Toggle checked={c.punctuation} onChange={(v) => now({ punctuation: v }, 'Caption punctuation')} label="Punctuation" />
          </div>
        </Section>
        <Section title="Colours">
          <Field label="Text">
            <ColorInput value={c.color} onChange={(v) => set({ color: v })} onCommit={() => commit('Caption colour')} />
          </Field>
          <Field label="Accent" hint="spoken and emphasised words">
            <ColorInput value={c.accent} onChange={(v) => set({ accent: v })} onCommit={() => commit('Caption accent')} />
          </Field>
        </Section>
        <div className="hint">To fix a misheard word or emphasise one, select it in the Transcript tab on the right.</div>
        <Recipes />
      </div>
    </div>
  );
}
