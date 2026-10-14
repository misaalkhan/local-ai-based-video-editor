// Find footage: public footage and pictures by prompt, from sources whose
// licences allow use in a video. From the home screen a pick becomes a new
// project; from the Media tab it is added to the open one. Every result shows
// its licence; the credit line, when one is owed, is kept with the file.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import type { StockItem, StockSourceInfo } from '../api.ts';
import { navigate } from '../router.ts';
import { fail, toast } from '../store.ts';
import { formatDuration } from '../actions.ts';
import { Icon, Spinner } from '../icons.tsx';
import { Button, Modal } from '../ui.tsx';

type Kind = 'video' | 'image' | 'any';

/** Sources on by default; the archive and NASA are specialised and come in when picked. */
const DEFAULT_OFF = new Set(['archive', 'nasa']);

export function StockDialog({ projectId, onClose, initialQuery = '' }: { projectId?: string; onClose: () => void; initialQuery?: string }) {
  const [sources, setSources] = useState<StockSourceInfo[] | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [q, setQ] = useState(initialQuery);
  const [kind, setKind] = useState<Kind>('video');
  const [items, setItems] = useState<StockItem[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Map<string, StockItem>>(new Map());
  const [adding, setAdding] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [aspect, setAspect] = useState('9:16');

  useEffect(() => {
    api
      .stockSources()
      .then((list) => {
        setSources(list);
        setOn(new Set(list.filter((s) => s.available && !DEFAULT_OFF.has(s.id)).map((s) => s.id)));
      })
      .catch(fail);
  }, []);

  const search = async () => {
    const query = q.trim();
    if (!query || busy) return;
    setBusy(true);
    setErrors([]);
    try {
      const r = await api.stockSearch(query, kind, [...on]);
      setItems(r.items);
      setErrors(r.errors);
    } catch (err) {
      setItems([]);
      setErrors([(err as Error).message]);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (it: StockItem) => {
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(it.id)) next.delete(it.id);
      else next.set(it.id, it);
      return next;
    });
  };

  const credits = useMemo(() => [...picked.values()].filter((x) => x.credit).map((x) => x.credit), [picked]);

  const go = async () => {
    if (!picked.size || adding) return;
    const list = [...picked.values()];
    if (projectId) {
      // Into the open project, one at a time so the first clip shows up while the rest download.
      for (const it of list) {
        setAdding(it.id);
        try {
          await api.addStock(projectId, it.id);
          setPicked((m) => {
            const next = new Map(m);
            next.delete(it.id);
            return next;
          });
        } catch (err) {
          fail(err);
        }
      }
      setAdding(null);
      toast(`Added ${list.length} file${list.length === 1 ? '' : 's'}; they are being prepared.`, 'success');
      if (credits.length) toast(`Credit lines are kept with the files; the assistant will pass them on for the caption.`, 'info');
      onClose();
      return;
    }
    setAdding('project');
    try {
      const r = await api.stockProject(name, aspect, list.map((x) => x.id));
      if (r.errors.length) toast(r.errors.join('; '), 'error');
      navigate(`/p/${r.project.id}`);
      onClose();
    } catch (err) {
      fail(err);
      setAdding(null);
    }
  };

  const keyed = (sources ?? []).filter((s) => s.key && !s.available);
  return (
    <Modal
      title="Find footage"
      onClose={onClose}
      width={880}
      footer={
        <>
          <span className="hint grow">
            {picked.size ? `${picked.size} picked${credits.length ? `, ${credits.length} with a credit line` : ''}` : 'Pick the shots you want.'}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!picked.size || adding !== null} onClick={() => void go()}>
            {adding ? <Spinner size={12} /> : projectId ? `Add ${picked.size || ''} to project` : `New project with ${picked.size || ''}`}
          </Button>
        </>
      }
    >
      <div className="stock">
        <form
          className="stock-search"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="what the shot should show: friends on a beach at sunset, city traffic at night, coffee pour…" aria-label="Search footage" autoFocus />
          <div className="segmented" role="radiogroup" aria-label="Kind">
            {(['video', 'image', 'any'] as Kind[]).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                {k === 'any' ? 'Both' : k === 'video' ? 'Video' : 'Pictures'}
              </button>
            ))}
          </div>
          <Button size="sm" variant="primary" icon="sparkles" disabled={busy || !q.trim() || !on.size} onClick={() => void search()}>
            Search
          </Button>
        </form>
        <div className="chips stock-sources">
          {(sources ?? []).map((s) => (
            <button
              key={s.id}
              type="button"
              className={`chip ${on.has(s.id) ? 'on' : ''}`}
              disabled={!s.available}
              title={s.available ? s.note : `${s.note}. Add the key in Settings.`}
              onClick={() =>
                setOn((set) => {
                  const next = new Set(set);
                  if (next.has(s.id)) next.delete(s.id);
                  else next.add(s.id);
                  return next;
                })
              }
            >
              {s.name}
              {!s.available && <span className="chip-count">key</span>}
            </button>
          ))}
        </div>
        {keyed.length > 0 && items === null && (
          <div className="hint">
            {keyed.map((s) => s.name).join(' and ')} have the biggest free stock libraries; a free key each in Settings turns them on. Wikimedia Commons, Openverse, the Internet Archive and NASA need nothing.
          </div>
        )}
        {!projectId && (
          <div className="row wrap stock-newproject">
            <input type="text" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name (optional)" aria-label="Project name" />
            <div className="segmented" role="radiogroup" aria-label="Shape">
              {['9:16', '16:9', '1:1'].map((a) => (
                <button key={a} type="button" role="radio" aria-checked={aspect === a} className={aspect === a ? 'on' : ''} onClick={() => setAspect(a)}>
                  {a}
                </button>
              ))}
            </div>
          </div>
        )}
        {busy && <Spinner />}
        {errors.length > 0 && <div className="hint">{errors.join(' · ')}</div>}
        {items && items.length === 0 && !busy && <div className="hint">Nothing found. Try plainer words, "Both", or add the Internet Archive and NASA.</div>}
        {items && items.length > 0 && (
          <div className="stock-grid">
            {items.map((it) => {
              const isOn = picked.has(it.id);
              return (
                <button key={it.id} type="button" className={`stock-item ${isOn ? 'on' : ''} ${adding === it.id ? 'is-busy' : ''}`} onClick={() => toggle(it)} title={`${it.title}\n${it.license}${it.author ? ` · ${it.author}` : ''}\n${it.pageUrl}`}>
                  <span className="stock-thumb">
                    <img src={it.thumb} alt={it.title} loading="lazy" />
                    {it.kind === 'video' && <span className="stock-dur">{it.duration ? formatDuration(it.duration) : 'video'}</span>}
                    {isOn && (
                      <span className="stock-check">
                        <Icon name="check" size={14} />
                      </span>
                    )}
                  </span>
                  <span className="stock-meta">
                    <strong>{it.title}</strong>
                    <em>
                      {it.license}
                      {it.credit ? ' · credit' : ''} · {it.source === 'commons' ? 'Commons' : it.source === 'archive' ? 'Archive' : it.source === 'nasa' ? 'NASA' : it.source === 'openverse' ? 'Openverse' : it.source === 'pexels' ? 'Pexels' : 'Pixabay'}
                      {it.width && it.height ? ` · ${it.width}×${it.height}` : ''}
                    </em>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {items === null && !busy && (
          <div className="hint">
            Public domain, CC0, Pexels and Pixabay files need no credit. CC BY and CC BY-SA files are free to use with a credit line, which is kept with the file and given to you for the caption. Nothing here is copyrighted film or TV; for a video about a show, these are the shots that illustrate your script.
          </div>
        )}
      </div>
    </Modal>
  );
}
