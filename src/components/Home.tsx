import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { api } from '../api.ts';
import type { Status } from '../api.ts';
import type { ProjectSummary } from '../../shared/types.ts';
import { ASPECTS } from '../../shared/types.ts';
import { navigate } from '../router.ts';
import { setPending } from '../startup.ts';
import { fail } from '../store.ts';
import { formatBytes, formatDuration } from '../actions.ts';
import { Icon, Spinner } from '../icons.tsx';
import { Button, Menu, MenuItem } from '../ui.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';

const MEDIA_ACCEPT = 'video/*,audio/*,image/*,.mov,.mkv,.m4v,.mts,.heic';

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

function nameFor(prompt: string, files: File[], paths: string[]): string {
  const first = files[0]?.name ?? paths[0]?.split('/').pop();
  if (first) return first.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 60);
  const words = prompt.trim().split(/\s+/).slice(0, 6).join(' ');
  return words || 'Untitled project';
}

export function Home() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [paths, setPaths] = useState<string[]>([]);
  const [aspect, setAspect] = useState('9:16');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const refresh = () => api.listProjects().then(setProjects).catch(fail);
  useEffect(() => {
    void refresh();
    api.status().then(setStatus).catch(() => {});
    document.title = 'Local Studio';
  }, []);

  const addFiles = (list: FileList | File[]) => {
    const picked = [...list].filter((f) => /^(video|audio|image)\//.test(f.type) || /\.(mov|mkv|m4v|mts|heic|mp4|mp3|wav|m4a|webm)$/i.test(f.name));
    if (picked.length) setFiles((cur) => [...cur, ...picked]);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    addFiles(e.dataTransfer.files);
  };

  const pickFromDisk = async () => {
    try {
      const r = await api.pickFiles();
      if (r.paths.length) setPaths((cur) => [...new Set([...cur, ...r.paths])]);
    } catch (err) {
      fail(err);
    }
  };

  const start = async (empty = false) => {
    if (busy) return;
    setBusy(true);
    try {
      const project = await api.createProject(empty ? 'Untitled project' : nameFor(prompt, files, paths), aspect);
      if (!empty) setPending({ projectId: project.id, files, paths, prompt: prompt.trim() });
      navigate(`/p/${project.id}`);
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  };

  const count = files.length + paths.length;
  const missing: string[] = [];
  if (status && !status.ffmpeg) missing.push('ffmpeg is not installed, so clips cannot be prepared or exported');
  if (status && !status.whisper) missing.push('speech-to-text is not set up, so captions and transcript editing are off');
  if (status && !status.claude) missing.push('the claude command was not found, so the chat editor is off');

  return (
    <div className="home">
      <header className="home-bar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="play" size={12} />
          </span>
          Local Studio
        </div>
        <span className="home-note">Everything stays on this Mac. Only chat requests go to Claude.</span>
        <span className="grow" />
        <Button icon="layers" onClick={() => navigate('/plan')}>Plan and footage</Button>
        <Button icon="sliders" onClick={() => setShowSettings(true)}>Settings</Button>
        {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      </header>

      <main className="home-main">
        <h1>What are we making?</h1>

        {missing.length > 0 && (
          <div className="notice">
            <Icon name="alert" size={15} />
            <div>
              {missing.map((m) => (
                <div key={m}>{m.charAt(0).toUpperCase() + m.slice(1)}.</div>
              ))}
              <div className="notice-fix">Run <code>npm run setup</code> in the project folder to fix this.</div>
            </div>
          </div>
        )}

        <div
          className={`dropzone ${over ? 'over' : ''} ${count ? 'has-files' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          onClick={() => input.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        >
          <input ref={input} type="file" accept={MEDIA_ACCEPT} multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
          {count === 0 ? (
            <>
              <span className="dropzone-icon">
                <Icon name="upload" size={22} />
              </span>
              <strong>Drop your videos here</strong>
              <span>or click to browse</span>
            </>
          ) : (
            <div className="chips" onClick={(e) => e.stopPropagation()}>
              {files.map((f, i) => (
                <span className="chip" key={`${f.name}-${i}`}>
                  <Icon name={f.type.startsWith('audio') ? 'music' : f.type.startsWith('image') ? 'image' : 'media'} size={13} />
                  {f.name}
                  <em>{formatBytes(f.size)}</em>
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((_, k) => k !== i))}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
              {paths.map((p) => (
                <span className="chip" key={p} title={p}>
                  <Icon name="folder" size={13} />
                  {p.split('/').pop()}
                  <button type="button" aria-label="Remove" onClick={() => setPaths((cur) => cur.filter((x) => x !== p))}>
                    <Icon name="x" size={12} />
                  </button>
                </span>
              ))}
              <button type="button" className="chip chip-add" onClick={() => input.current?.click()}>
                <Icon name="plus" size={13} /> Add more
              </button>
            </div>
          )}
        </div>
        <button type="button" className="linklike" onClick={pickFromDisk}>
          <Icon name="folder" size={13} /> Use large files where they are, without copying
        </button>

        <div className="promptbox">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the edit you want. For example: cut the dead air, add bold captions, punch in on the key lines and put a hook at the top."
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && count) void start();
            }}
          />
          <div className="promptbox-row">
            <button type="button" className="iconbtn" title="Attach files" aria-label="Attach files" onClick={() => input.current?.click()}>
              <Icon name="plus" size={16} />
            </button>
            <div className="aspect-pills" role="radiogroup" aria-label="Format">
              {Object.entries(ASPECTS).map(([k, v]) => (
                <button key={k} type="button" role="radio" aria-checked={aspect === k} className={aspect === k ? 'on' : ''} onClick={() => setAspect(k)} title={v.label}>
                  {k}
                </button>
              ))}
            </div>
            <span className="grow" />
            <Button variant="primary" disabled={!count || busy} onClick={() => start()}>
              {busy ? <Spinner /> : null}
              {prompt.trim() ? 'Edit my video' : 'Open in editor'}
              <Icon name="right" size={15} />
            </Button>
          </div>
        </div>
        <button type="button" className="linklike" onClick={() => start(true)}>
          Start with an empty project
        </button>

        <section className="recent">
          <h2>Recent projects</h2>
          {projects === null ? (
            <div className="recent-empty">
              <Spinner />
            </div>
          ) : projects.length === 0 ? (
            <div className="recent-empty">Projects you create will show up here.</div>
          ) : (
            <div className="project-grid">
              {projects.map((p) => (
                <ProjectCard key={p.id} project={p} onChanged={refresh} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function ProjectCard({ project, onChanged }: { project: ProjectSummary; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState(project.name);
  const portrait = project.height > project.width;
  const rename = async () => {
    setRenaming(false);
    if (name.trim() && name.trim() !== project.name) {
      await api.renameProject(project.id, name.trim()).catch(fail);
      onChanged();
    }
  };
  return (
    <div className="project-card">
      <button type="button" className="project-thumb" onClick={() => navigate(`/p/${project.id}`)} aria-label={`Open ${project.name}`}>
        {project.thumb ? <img src={project.thumb} alt="" className={portrait ? 'portrait' : ''} /> : <Icon name="media" size={22} />}
        <span className="project-duration">{formatDuration(project.duration)}</span>
      </button>
      <div className="project-meta">
        {renaming ? (
          <input
            className="input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => e.key === 'Enter' && rename()}
          />
        ) : (
          <button type="button" className="project-name" onClick={() => navigate(`/p/${project.id}`)} title={project.name}>
            {project.name}
          </button>
        )}
        <Menu
          align="right"
          trigger={(_, toggle) => (
            <button type="button" className="iconbtn" aria-label="Project options" onClick={toggle}>
              <Icon name="more" size={15} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon="edit" onClick={() => { close(); setRenaming(true); }}>Rename</MenuItem>
              <MenuItem icon="trash" danger onClick={() => { close(); setConfirming(true); }}>Move to Trash</MenuItem>
            </>
          )}
        </Menu>
      </div>
      <div className="project-sub">Saved {timeAgo(project.updatedAt)}</div>
      {confirming && (
        <div className="project-confirm">
          <span>Move “{project.name}” to the Trash?</span>
          <div>
            <Button size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                await api.deleteProject(project.id).catch(fail);
                onChanged();
              }}
            >
              Move to Trash
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
