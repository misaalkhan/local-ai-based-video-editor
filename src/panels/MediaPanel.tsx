import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { MediaAsset } from '../../shared/types.ts';
import { api, mediaUrl } from '../api.ts';
import { fail, useStore } from '../store.ts';
import { addToTimeline, draggable, formatBytes, formatDuration, importFiles, importFromDisk, looksLikeMusic } from '../actions.ts';
import { Icon, Spinner } from '../icons.tsx';
import { Button, Empty, Menu, MenuItem } from '../ui.tsx';
import { StockDialog } from '../components/StockDialog.tsx';

function statusOf(m: MediaAsset): { text: string; busy: boolean; error?: boolean } | null {
  if (m.proxy === 'error') return { text: m.error ?? 'Could not prepare this file', busy: false, error: true };
  if (m.proxy === 'pending') return { text: 'Waiting…', busy: true };
  if (m.proxy === 'running') return { text: `Preparing preview ${Math.round((m.progress ?? 0) * 100)}%`, busy: true };
  if (m.analysis === 'running' || m.analysis === 'pending') return m.hasAudio ? { text: 'Reading audio…', busy: true } : null;
  if (m.transcript === 'pending') return { text: 'Waiting to transcribe…', busy: true };
  if (m.transcript === 'running') return { text: `Transcribing${m.progress ? ` ${Math.round(m.progress * 100)}%` : '…'}`, busy: true };
  if (m.transcript === 'error') return { text: 'Could not transcribe', busy: false, error: true };
  return null;
}

function Card({ m, projectId, library }: { m: MediaAsset; projectId: string; library?: boolean }) {
  const st = statusOf(m);
  const [confirm, setConfirm] = useState(false);
  const music = looksLikeMusic(m);
  const detail =
    m.kind === 'video' ? `${m.width}×${m.height}` : m.kind === 'image' ? `${m.width}×${m.height}` : music ? 'Music' : 'Audio';
  return (
    <div className={`media-card ${st?.error ? 'error' : ''}`}>
      <button type="button" className="media-thumb" onClick={() => !library && addToTimeline(m)} title={library ? m.insights?.summary ?? 'Not described yet' : 'Click to add, or drag onto the timeline'} {...(library ? {} : draggable({ kind: 'media', id: m.id }))}>
        {m.kind === 'audio' ? (
          <span className="media-audio">
            <Icon name={music ? 'music' : 'mic'} size={20} />
          </span>
        ) : (
          <img src={mediaUrl(projectId, m, m.kind === 'image' ? 'proxy' : 'thumb.jpg')} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />
        )}
        {m.kind !== 'image' && <span className="media-duration">{formatDuration(m.duration)}</span>}
        {(m.wordCount ?? 0) > 0 && (
          <span className="media-badge" title={`${m.wordCount} words transcribed`}>
            <Icon name="captions" size={11} />
          </span>
        )}
        {!library && (
          <span className="media-add">
            <Icon name="plus" size={16} />
          </span>
        )}
      </button>
      <div className="media-meta">
        <span className="media-name" title={m.name}>
          {m.name}
        </span>
        <Menu
          align="right"
          trigger={(_, toggle) => (
            <button type="button" className="iconbtn tiny" aria-label={`Options for ${m.name}`} onClick={toggle}>
              <Icon name="more" size={14} />
            </button>
          )}
        >
          {(close) => (
            <>
              {!library && m.kind !== 'audio' && <MenuItem icon="media" onClick={() => { close(); addToTimeline(m, 'main'); }}>Add to the main track</MenuItem>}
              {!library && m.kind !== 'audio' && <MenuItem icon="image" onClick={() => { close(); addToTimeline(m, 'broll'); }}>Add as b-roll at the playhead</MenuItem>}
              {!library && m.hasAudio && <MenuItem icon="mic" onClick={() => { close(); addToTimeline(m, 'voice'); }}>Add as audio at the playhead</MenuItem>}
              {!library && m.hasAudio && <MenuItem icon="music" onClick={() => { close(); addToTimeline(m, 'music'); }}>Add as background music</MenuItem>}
              {m.hasAudio && <MenuItem icon="captions" onClick={() => { close(); api.retranscribe(projectId, m.id).catch(fail); }}>Transcribe again</MenuItem>}
              <MenuItem icon="folder" onClick={() => { close(); api.reveal(m.path).catch(fail); }}>Show in Finder</MenuItem>
              <MenuItem icon="trash" danger onClick={() => { close(); setConfirm(true); }}>Remove from project</MenuItem>
            </>
          )}
        </Menu>
      </div>
      <div className={`media-sub ${st?.error ? 'error' : ''}`} title={st?.text}>
        {st ? (
          <>
            {st.busy && <Spinner size={10} />} {st.text}
          </>
        ) : (
          <>
            {detail} · {formatBytes(m.size)}
          </>
        )}
      </div>
      {m.insights && <div className="media-insight" title={m.insights.tags.join(', ')}>{m.insights.summary}</div>}
      {confirm && (
        <div className="media-confirm">
          <span>Remove it and every clip that uses it?</span>
          <div>
            <Button size="sm" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button size="sm" variant="danger" onClick={() => api.removeMedia(projectId, m.id).catch(fail)}>Remove</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function MediaPanel({ library = false }: { library?: boolean } = {}) {
  const projectId = useStore((s) => s.projectId)!;
  const media = useStore((s) => s.media);
  const uploads = useStore((s) => s.uploads);
  const [stock, setStock] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = Object.values(media)
    .filter((m) => !m.origin)
    .sort((a, b) => a.addedAt - b.addedAt);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files.length) void importFiles([...e.dataTransfer.files]);
  };

  return (
    <div
      className={`panel media-panel ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        // Only files from outside the app are imported; a card being dragged to the timeline is not.
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={onDrop}
    >
      <header className="panel-head">
        <h2>{library ? 'Footage' : 'Media'}</h2>
        <Menu
          align="right"
          trigger={(_, toggle) => (
            <Button size="sm" icon="plus" onClick={toggle}>
              Add
            </Button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon="folder" hint="no copy" onClick={() => { close(); void importFromDisk(); }}>Choose files on this Mac…</MenuItem>
              <MenuItem icon="upload" hint="copies" onClick={() => { close(); input.current?.click(); }}>Upload files…</MenuItem>
              <MenuItem icon="image" hint="public" onClick={() => { close(); setStock(true); }}>Find footage online…</MenuItem>
            </>
          )}
        </Menu>
        {stock && <StockDialog projectId={projectId} onClose={() => setStock(false)} />}
        <input ref={input} type="file" multiple hidden accept="video/*,audio/*,image/*,.mov,.mkv,.m4v,.mts,.heic" onChange={(e) => { if (e.target.files) void importFiles([...e.target.files]); e.target.value = ''; }} />
      </header>
      <div className="panel-body">
        {Object.entries(uploads).map(([k, u]) => (
          <div className="upload-row" key={k}>
            <Spinner size={11} />
            <span>{u.name}</span>
            <em>{Math.round(u.progress * 100)}%</em>
            <i style={{ width: `${u.progress * 100}%` }} />
          </div>
        ))}
        {list.length === 0 && !Object.keys(uploads).length ? (
          <Empty icon="upload" title={library ? 'Drop your footage here' : 'Drop clips here'}>
            {library
              ? 'Everything you have shot, in one place. Add → Choose files can take a whole folder without copying it. The planner reads the transcripts and describes each clip.'
              : 'Videos, voice recordings, music and images. Large files are best added with Add → Choose files, which uses them where they are.'}
          </Empty>
        ) : (
          <div className="media-grid">
            {list.map((m) => (
              <Card key={m.id} m={m} projectId={projectId} library={library} />
            ))}
          </div>
        )}
      </div>
      {over && <div className="drop-veil">Drop to add</div>}
    </div>
  );
}
