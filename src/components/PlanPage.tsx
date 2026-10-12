// The planner: your footage on the left, the planner's chat in the middle,
// and on the right who you are, what is planned and the posts you like.

import { useEffect, useRef, useState } from 'react';
import type { PlanItem, PlanStatus, Profile, Studio } from '../../shared/types.ts';
import { api } from '../api.ts';
import { importFiles } from '../actions.ts';
import { navigate } from '../router.ts';
import { agentBusy, closeProject, fail, openProject, useStore } from '../store.ts';
import { Icon, Spinner } from '../icons.tsx';
import { Button, IconButton, Select, TextInput, Toggle } from '../ui.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { MediaPanel } from '../panels/MediaPanel.tsx';

/** A post you like, handed to the planner to turn into a style card: a link or a note, with a screenshot or recording if you have one. */
function ReferenceComposer() {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const busy = useStore(agentBusy);
  const fileRef = useRef<HTMLInputElement>(null);
  const pick = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    const added = await importFiles([...list]);
    setUploading(false);
    setFiles((cur) => [...cur, ...added.map((m) => ({ id: m.id, name: m.name }))]);
  };
  const send = async () => {
    const note = text.trim();
    if ((!note && !files.length) || busy) return;
    const body = `Make a style card from this post I like${note ? `: ${note}` : ''}. ${files.length ? 'Look at what is attached, then save' : 'Save'} the card with save_reference, and tell me in two lines what to borrow from it.`;
    try {
      await api.sendChat('library', body, files.map((f) => f.id));
      setText('');
      setFiles([]);
    } catch (err) {
      fail(err);
    }
  };
  return (
    <form
      className="ref-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Link to the post, or what you noticed about it" aria-label="Post you like" />
      <div className="ref-composer-row">
        <input ref={fileRef} type="file" multiple hidden accept="video/*,image/*,.mov,.heic" onChange={(e) => { void pick(e.target.files); e.target.value = ''; }} />
        <Button size="sm" icon="attach" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {files.length ? `${files.length} attached` : 'Screenshot or recording'}
        </Button>
        {uploading && <Spinner />}
        <span className="grow" />
        <Button size="sm" variant="primary" icon="sparkles" disabled={busy || uploading || (!text.trim() && !files.length)} onClick={() => void send()}>
          Make a style card
        </Button>
      </div>
    </form>
  );
}

const STATUS: { value: PlanStatus; label: string }[] = [
  { value: 'idea', label: 'Idea' },
  { value: 'planned', label: 'Planned' },
  { value: 'making', label: 'Making' },
  { value: 'ready', label: 'Ready to post' },
  { value: 'posted', label: 'Posted' },
  { value: 'dropped', label: 'Dropped' },
];

const FIELDS: { key: keyof Profile; label: string; multiline?: boolean }[] = [
  { key: 'about', label: 'About you', multiline: true },
  { key: 'niche', label: 'What the account is about' },
  { key: 'audience', label: 'Who it is for' },
  { key: 'goals', label: 'Goals', multiline: true },
  { key: 'capacity', label: 'How much you can make' },
  { key: 'tone', label: 'Voice and style', multiline: true },
  { key: 'notes', label: 'Notes', multiline: true },
];

function dateLabel(d: string): string {
  if (!d) return 'Ideas, not scheduled';
  const t = new Date(`${d}T12:00:00`);
  if (Number.isNaN(t.getTime())) return d;
  const today = new Date().toISOString().slice(0, 10);
  const prefix = d === today ? 'Today, ' : '';
  return prefix + t.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function ProfileCard({ profile, onChange }: { profile: Profile; onChange: (p: Profile) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile);
  useEffect(() => setDraft(profile), [profile]);
  const filled = FIELDS.filter((f) => String(profile[f.key] ?? '').trim());
  const save = () => {
    const patch: Partial<Profile> = {};
    for (const f of FIELDS) (patch as Record<string, unknown>)[f.key] = String(draft[f.key] ?? '');
    patch.platforms = draft.platforms;
    patch.pillars = draft.pillars;
    patch.languages = draft.languages;
    api.saveProfile(patch).then((p) => {
      onChange(p);
      setEditing(false);
    }).catch(fail);
  };
  return (
    <section className="plan-card">
      <header className="plan-card-head">
        <h3>You</h3>
        <span className="grow" />
        {editing ? (
          <>
            <Button size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={save}>Save</Button>
          </>
        ) : (
          <Button size="sm" icon="edit" onClick={() => setEditing(true)}>Edit</Button>
        )}
      </header>
      {editing ? (
        <div className="plan-form">
          {FIELDS.map((f) => (
            <label key={f.key}>
              <span>{f.label}</span>
              <TextInput value={String(draft[f.key] ?? '')} multiline={f.multiline} onChange={(v) => setDraft({ ...draft, [f.key]: v })} />
            </label>
          ))}
          <label>
            <span>Platforms (comma separated)</span>
            <TextInput value={draft.platforms.join(', ')} onChange={(v) => setDraft({ ...draft, platforms: v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) })} />
          </label>
          <label>
            <span>Content pillars (comma separated)</span>
            <TextInput value={draft.pillars.join(', ')} onChange={(v) => setDraft({ ...draft, pillars: v.split(',').map((x) => x.trim()).filter(Boolean) })} />
          </label>
          <label>
            <span>Languages in your videos, as codes (hi, en, ur ...). Put en first for Hinglish captions in Latin letters.</span>
            <TextInput value={draft.languages.join(', ')} onChange={(v) => setDraft({ ...draft, languages: v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) })} />
          </label>
        </div>
      ) : filled.length === 0 ? (
        <p className="hint">Nothing saved yet. Tell the planner about yourself in the chat, or fill this in by hand.</p>
      ) : (
        <dl className="plan-dl">
          {filled.map((f) => (
            <div key={f.key}>
              <dt>{f.label}</dt>
              <dd>{String(profile[f.key])}</dd>
            </div>
          ))}
          {profile.platforms.length > 0 && (
            <div>
              <dt>Platforms</dt>
              <dd>{profile.platforms.join(', ')}</dd>
            </div>
          )}
          {profile.pillars.length > 0 && (
            <div>
              <dt>Pillars</dt>
              <dd>{profile.pillars.join(' · ')}</dd>
            </div>
          )}
          {profile.languages.length > 0 && (
            <div>
              <dt>Languages</dt>
              <dd>{profile.languages.join(', ')}</dd>
            </div>
          )}
        </dl>
      )}
      <div className="row plan-web">
        <Toggle
          checked={profile.allowWeb}
          onChange={(v) => api.saveProfile({ allowWeb: v }).then(onChange).catch(fail)}
          label="Let the planner search the web for platform news"
        />
      </div>
    </section>
  );
}

function PlanList({ items, onChange }: { items: PlanItem[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const groups = new Map<string, PlanItem[]>();
  for (const it of [...items].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.createdAt - b.createdAt)) {
    if (it.status === 'dropped') continue;
    const k = it.date || '';
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  const start = async (it: PlanItem) => {
    setBusy(it.id);
    try {
      const r = await api.startPlanItem(it.id);
      onChange();
      navigate(`/p/${r.projectId}`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };
  if (!items.length) return <p className="hint">Nothing planned yet. Ask the planner for a week, or add items as you go.</p>;
  return (
    <div className="plan-list">
      {[...groups.entries()].map(([date, list]) => (
        <div key={date || 'ideas'} className="plan-day">
          <h4>{dateLabel(date)}</h4>
          {list.map((it) => (
            <article key={it.id} className={`plan-item status-${it.status}`}>
              <div className="plan-item-top">
                <span className="chip">{it.platform}</span>
                <span className="chip">{it.format}</span>
                {it.time && <span className="chip">{it.time}</span>}
                {it.pillar && <span className="chip soft">{it.pillar}</span>}
                <span className="grow" />
                <IconButton icon="trash" label="Delete" onClick={() => api.removePlanItem(it.id).then(onChange).catch(fail)} />
              </div>
              <strong>{it.title}</strong>
              {it.hook && <p className="plan-hook">“{it.hook}”</p>}
              {it.storyline && <p className="plan-story">{it.storyline}</p>}
              {it.caption && <p className="plan-caption">{it.caption}{it.hashtags?.length ? ` ${it.hashtags.map((h) => `#${h}`).join(' ')}` : ''}</p>}
              <div className="row plan-item-foot">
                <Select value={it.status} options={STATUS} onChange={(v) => api.updatePlanItem(it.id, { status: v as PlanStatus }).then(onChange).catch(fail)} />
                <span className="grow" />
                {it.projectId ? (
                  <Button size="sm" onClick={() => navigate(`/p/${it.projectId}`)}>Open project</Button>
                ) : (
                  <Button size="sm" variant="primary" disabled={busy === it.id || !it.footage.length} title={it.footage.length ? 'Create a project from this item and start the edit' : 'Attach footage first (ask the planner)'} onClick={() => void start(it)}>
                    {busy === it.id ? <Spinner size={11} /> : <Icon name="play" size={12} />} Make it
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      ))}
    </div>
  );
}

export function PlanPage() {
  const [studio, setStudio] = useState<Studio | null>(null);
  const chat = useStore((s) => s.chat);
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);
  const refresh = () => api.studio().then(setStudio).catch(fail);

  useEffect(() => {
    void openProject('library');
    void refresh();
    document.title = 'Plan · Local Studio';
    return () => closeProject();
  }, []);

  // The planner changes the plan and profile while it talks; show them as soon as a turn ends.
  const last = chat[chat.length - 1];
  useEffect(() => {
    if (last && last.role === 'assistant' && last.status !== 'running' && last.status !== 'reviewing') void refresh();
  }, [last?.id, last?.status]);

  return (
    <div className="editor plan-page">
      <header className="topbar">
        <button type="button" className="brand brand-btn" onClick={() => navigate('/')} title="All projects">
          <span className="brand-mark">
            <Icon name="play" size={12} />
          </span>
        </button>
        <strong className="plan-title">Plan</strong>
        <span className="home-note">Your footage, your goals and what to post next. Nothing is posted for you.</span>
        <span className="grow" />
        <Button onClick={() => navigate('/')}>Projects</Button>
      </header>
      {error ? (
        <div className="fullscreen-msg">
          <Icon name="alert" size={26} />
          <strong>{error}</strong>
        </div>
      ) : loading || !studio ? (
        <div className="fullscreen-msg">
          <Spinner size={22} />
        </div>
      ) : (
        <div className="plan-grid">
          <aside className="leftpanel">
            <MediaPanel library />
          </aside>
          <section className="plan-chat">
            <ChatPanel mode="planner" />
          </section>
          <aside className="rightpanel plan-side">
            <ProfileCard profile={studio.profile} onChange={(profile) => setStudio({ ...studio, profile })} />
            <section className="plan-card">
              <header className="plan-card-head">
                <h3>Content plan</h3>
                <span className="grow" />
                <Button size="sm" icon="plus" onClick={() => api.addPlanItem({ title: 'New post', platform: studio.profile.platforms[0] ?? 'instagram', format: 'reel' }).then(refresh).catch(fail)}>Add</Button>
              </header>
              <PlanList items={studio.plan} onChange={refresh} />
            </section>
            <section className="plan-card">
              <header className="plan-card-head">
                <h3>Posts you like</h3>
              </header>
              <ReferenceComposer />
              {studio.references.length === 0 && <p className="hint">Paste a link or describe a post, attach a screenshot or screen recording, and the planner keeps what makes it work: hook, pacing, format.</p>}
              {studio.references.map((r) => (
                  <article key={r.id} className="plan-ref">
                    <div className="plan-item-top">
                      <strong>{r.summary}</strong>
                      <span className="grow" />
                      <IconButton icon="trash" label="Remove" onClick={() => api.removeReference(r.id).then(refresh).catch(fail)} />
                    </div>
                    <p>{r.why}</p>
                    <p className="hint">Hook: {r.hook} · Pacing: {r.pacing}</p>
                  </article>
                ))}
            </section>
            {Object.keys(studio.notes).length > 0 && (
              <section className="plan-card">
                <header className="plan-card-head">
                  <h3>What works now</h3>
                </header>
                {Object.entries(studio.notes).map(([k, n]) => (
                  <article key={k} className="plan-ref">
                    <strong>{k}</strong> <span className="hint">updated {new Date(n.updatedAt).toLocaleDateString()}</span>
                    <p>{n.text}</p>
                  </article>
                ))}
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
