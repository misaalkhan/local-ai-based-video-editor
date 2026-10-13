import { useEffect } from 'react';
import { agentBusy, closeProject, fail, openProject, redo, select, setUi, undo, useDerived, useDoc, useStore } from '../store.ts';
import type { LeftPanel } from '../store.ts';
import { player } from '../engine/player.ts';
import { addToTimeline, deleteSelection, duplicateSelection, importFiles, importPaths, splitAtPlayhead } from '../actions.ts';
import { takePending } from '../startup.ts';
import { api } from '../api.ts';
import { navigate } from '../router.ts';
import { Icon, Spinner } from '../icons.tsx';
import type { IconName } from '../icons.tsx';
import { Button } from '../ui.tsx';
import { TopBar } from './TopBar.tsx';
import { Preview } from './Preview.tsx';
import { Timeline } from './Timeline.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { TranscriptPanel } from './TranscriptPanel.tsx';
import { ExportDialog } from './ExportDialog.tsx';
import { HistoryDialog } from './HistoryDialog.tsx';
import { MediaPanel } from '../panels/MediaPanel.tsx';
import { MusicPanel } from '../panels/MusicPanel.tsx';
import { SfxPanel } from '../panels/SfxPanel.tsx';
import { MemesPanel } from '../panels/MemesPanel.tsx';
import { CaptionsPanel } from '../panels/CaptionsPanel.tsx';
import { TextPanel } from '../panels/TextPanel.tsx';
import { GraphicsPanel } from '../panels/GraphicsPanel.tsx';
import { EffectsPanel } from '../panels/EffectsPanel.tsx';
import { TransitionsPanel } from '../panels/TransitionsPanel.tsx';
import { EditPanel } from '../panels/EditPanel.tsx';

const RAIL: { id: LeftPanel; icon: IconName; label: string }[] = [
  { id: 'media', icon: 'media', label: 'Media' },
  { id: 'music', icon: 'music', label: 'Music' },
  { id: 'sounds', icon: 'volume', label: 'Sounds' },
  { id: 'memes', icon: 'sparkles', label: 'Memes' },
  { id: 'captions', icon: 'captions', label: 'Captions' },
  { id: 'text', icon: 'text', label: 'Text' },
  { id: 'graphics', icon: 'layers', label: 'Overlays' },
  { id: 'effects', icon: 'sliders', label: 'Effects' },
  { id: 'transitions', icon: 'transition', label: 'Transitions' },
  { id: 'edit', icon: 'edit', label: 'Edit' },
];

/** True once nothing is uploading and every clip has its preview and transcript. */
function settled(): boolean {
  const s = useStore.getState();
  if (Object.keys(s.uploads).length) return false;
  const working = (x: string | undefined) => x === 'pending' || x === 'running';
  return Object.values(s.media).every((m) => !working(m.proxy) && !working(m.analysis) && !working(m.transcript));
}

function whenSettled(projectId: string, then: () => void): void {
  let done = false;
  // `then` changes the store, which notifies this very subscriber again; unsubscribe first and fire once.
  const fire = () => {
    if (done) return;
    done = true;
    then();
  };
  if (useStore.getState().projectId !== projectId) return;
  if (settled()) {
    fire();
    return;
  }
  const stop = useStore.subscribe(() => {
    if (done) return;
    if (useStore.getState().projectId !== projectId) {
      done = true;
      stop();
      return;
    }
    if (!settled()) return;
    stop();
    fire();
  });
}

/** Finish what the home screen started: import the dropped files, then either run the request or lay the clips out. */
async function runStartup(projectId: string): Promise<void> {
  const pending = takePending(projectId);
  if (!pending) {
    // A project the planner started carries its request; run it once the clips are ready.
    const s = useStore.getState();
    const queued = s.pending;
    if (queued && s.projectId === projectId && !s.chat.length) {
      useStore.setState({ queued, pending: null });
      whenSettled(projectId, () => {
        useStore.setState({ queued: null });
        api.sendChat(projectId, queued).catch(fail);
      });
    }
    return;
  }
  if (pending.prompt) useStore.setState({ queued: pending.prompt });
  await importFiles(pending.files);
  if (pending.paths.length) await importPaths(pending.paths);
  whenSettled(projectId, () => {
    const s = useStore.getState();
    // The clips go on the main track first, so a request starts from footage rather than an empty timeline.
    if (s.doc && !s.doc.main.length) {
      const videos = Object.values(s.media)
        .filter((m) => m.kind === 'video')
        .sort((a, b) => a.addedAt - b.addedAt);
      for (const m of videos) addToTimeline(m, 'main');
      select(null);
    }
    if (pending.prompt) {
      const prompt = pending.prompt;
      useStore.setState({ queued: null });
      // The layout above is saved on a short delay; let it reach the server before the request reads the timeline.
      setTimeout(() => api.sendChat(projectId, prompt).catch(fail), 700);
    }
  });
}

function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (key === ' ') {
        e.preventDefault();
        player.toggle();
      } else if (mod && key === 'z') {
        e.preventDefault();
        if (agentBusy(useStore.getState())) return;
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && key === 'd') {
        e.preventDefault();
        duplicateSelection();
      } else if ((mod && key === 'b') || (!mod && key === 's')) {
        e.preventDefault();
        splitAtPlayhead();
      } else if (key === 'backspace' || key === 'delete') {
        e.preventDefault();
        deleteSelection();
      } else if (key === 'arrowleft' || key === 'arrowright') {
        e.preventDefault();
        player.step((key === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
      } else if (key === 'home') player.seek(0);
      else if (key === 'end') player.seek(player.duration);
      else if (key === 'escape') select(null);
      else if (key === '=' || key === '+') setUi({ pxPerSec: Math.min(400, useStore.getState().ui.pxPerSec * 1.3) });
      else if (key === '-') setUi({ pxPerSec: Math.max(4, useStore.getState().ui.pxPerSec / 1.3) });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function Editor({ projectId }: { projectId: string }) {
  const loading = useStore((s) => s.loading);
  const error = useStore((s) => s.error);
  const media = useStore((s) => s.media);
  const faces = useStore((s) => s.faces);
  const stability = useStore((s) => s.stability);
  const objects = useStore((s) => s.objects);
  const ui = useStore((s) => s.ui);
  const hasSelection = useStore((s) => !!s.selection);
  const doc = useDoc();
  const derived = useDerived();

  useEffect(() => {
    void openProject(projectId).then(() => runStartup(projectId));
    return () => {
      player.dispose();
      closeProject();
    };
  }, [projectId]);

  useEffect(() => {
    if (doc && derived) player.setData({ projectId, doc, media, faces, stability, objects, derived });
  }, [projectId, doc, media, faces, stability, objects, derived]);

  const editing = useStore((s) => (s.selection?.kind === 'graphic' ? s.selection.id : null));
  useEffect(() => player.setEditing(editing), [editing]);

  useEffect(() => {
    document.title = doc ? `${doc.name} · Local Studio` : 'Local Studio';
  }, [doc?.name]);

  useShortcuts();

  if (error) {
    return (
      <div className="fullscreen-msg">
        <Icon name="alert" size={26} />
        <strong>{error}</strong>
        <Button onClick={() => navigate('/')}>Back to projects</Button>
      </div>
    );
  }
  if (loading || !doc) {
    return (
      <div className="fullscreen-msg">
        <Spinner size={22} />
      </div>
    );
  }

  return (
    <div className="editor">
      <TopBar />
      <div className="workspace">
        <nav className="rail" aria-label="Tools">
          {RAIL.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`rail-btn ${ui.left === r.id ? 'active' : ''}`}
              onClick={() => setUi({ left: r.id })}
              disabled={r.id === 'edit' && !hasSelection}
              aria-pressed={ui.left === r.id}
            >
              <Icon name={r.icon} size={18} />
              <span>{r.label}</span>
            </button>
          ))}
        </nav>
        <aside className="leftpanel">
          {ui.left === 'media' && <MediaPanel />}
          {ui.left === 'music' && <MusicPanel />}
          {ui.left === 'sounds' && <SfxPanel />}
          {ui.left === 'memes' && <MemesPanel />}
          {ui.left === 'captions' && <CaptionsPanel />}
          {ui.left === 'text' && <TextPanel />}
          {ui.left === 'graphics' && <GraphicsPanel />}
          {ui.left === 'effects' && <EffectsPanel />}
          {ui.left === 'transitions' && <TransitionsPanel />}
          {ui.left === 'edit' && <EditPanel />}
        </aside>
        <Preview />
        <aside className="rightpanel">
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={ui.right === 'chat'} className={ui.right === 'chat' ? 'on' : ''} onClick={() => setUi({ right: 'chat' })}>
              <Icon name="sparkles" size={14} /> Assistant
            </button>
            <button type="button" role="tab" aria-selected={ui.right === 'transcript'} className={ui.right === 'transcript' ? 'on' : ''} onClick={() => setUi({ right: 'transcript' })}>
              <Icon name="transcript" size={14} /> Transcript
            </button>
          </div>
          {ui.right === 'chat' ? <ChatPanel /> : <TranscriptPanel />}
        </aside>
      </div>
      <Timeline />
      {ui.showExport && <ExportDialog />}
      {ui.showHistory && <HistoryDialog />}
    </div>
  );
}
