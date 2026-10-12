// Things the user can do, written once so buttons, menus and keyboard
// shortcuts all behave the same.

import type { ID, MediaAsset, ProjectDoc, Selection } from '../shared/types.ts';
import * as ops from '../shared/ops.ts';
import { layoutMain, snap, srcDuration } from '../shared/timeline.ts';
import { GRAPHIC_PRESETS } from '../shared/graphics.ts';
import { forPeople } from '../shared/text.ts';
import { api, uploadFile } from './api.ts';
import { player } from './engine/player.ts';
import { agentBusy, applyEdit, commitDraft, fail, select, setDraft, toast, useStore } from './store.ts';

const get = useStore.getState;

/** Manual edits wait while the assistant is mid-turn, so the two never overwrite each other. */
function blocked(): boolean {
  if (agentBusy(get())) {
    toast('The assistant is editing. You can edit again as soon as it finishes.');
    return true;
  }
  return false;
}

export function edit(fn: (doc: ProjectDoc) => ProjectDoc, label: string): void {
  if (blocked()) return;
  applyEdit(fn, label);
}

/** Preview a change while a control is being dragged. */
export function live(fn: (doc: ProjectDoc) => ProjectDoc): void {
  const s = get();
  if (!s.doc || agentBusy(s)) return;
  setDraft(fn(s.doc));
}

export const commit = commitDraft;

/** Length of a media file, or undefined for stills (which can be any length). */
export function mediaDur(mediaId: ID): number | undefined {
  const m = get().media[mediaId];
  return m && m.kind !== 'image' ? m.duration : undefined;
}

export type AddTarget = 'auto' | 'main' | 'broll' | 'voice' | 'music';

export function looksLikeMusic(m: MediaAsset): boolean {
  if (m.kind !== 'audio') return false;
  if (/music|song|beat|track|bgm|instrumental|lofi|loop/i.test(m.name)) return true;
  return m.transcript === 'done' && (m.speechSeconds ?? 0) < 1;
}

export function addToTimeline(m: MediaAsset, target: AddTarget = 'auto', where_: { at?: number; index?: number } = {}): void {
  const s = get();
  if (!s.doc || blocked()) return;
  let where = target;
  if (where === 'auto') {
    if (m.kind === 'audio') where = looksLikeMusic(m) ? 'music' : 'voice';
    else if (m.kind === 'image') where = s.doc.main.length ? 'broll' : 'main';
    else where = 'main';
  }
  const t = where_.at ?? player.time;
  if (where === 'main') {
    if (m.kind === 'audio') return toast('Audio files go on an audio track.');
    applyEdit((doc) => {
      let d = doc;
      // The first clip decides the frame rate, so 24/25 fps footage is not judder-converted.
      if (!d.main.length && !d.overlays.length && m.kind === 'video' && m.fps > 0) {
        const base = m.fps > 40 ? m.fps / 2 : m.fps;
        const fps = [24, 25, 30].reduce((a, b) => (Math.abs(b - base) < Math.abs(a - base) ? b : a), 30);
        if (fps !== d.settings.fps) d = ops.setSettings(d, { fps });
      }
      const clip = { kind: 'media' as const, ...ops.makeClip(m, d.settings.fps), name: m.name };
      const next = ops.insertMain(d, clip, where_.index);
      queueMicrotask(() => select({ kind: 'main', id: clip.id }));
      return next;
    }, 'Add clip');
    return;
  }
  if (where === 'broll') {
    if (m.kind === 'audio') return toast('Audio files go on an audio track.');
    applyEdit((doc) => {
      const r = ops.addOverlay(doc, m, { start: t, duration: m.kind === 'image' ? 3 : Math.min(m.duration, 5), name: m.name });
      queueMicrotask(() => select({ kind: 'overlay', id: r.clip.id }));
      return r.doc;
    }, 'Add b-roll');
    return;
  }
  if (!m.hasAudio) return toast('This file has no sound.');
  const music = where === 'music';
  // The first music track goes through the same tool the assistant uses, which sets its level against the voice.
  if (music && where_.at === undefined && !s.doc.audio.some((a) => a.role === 'music')) {
    void runTool('set_music', { media: m.id });
    return;
  }
  applyEdit((doc) => {
    const hasMusic = doc.audio.some((a) => a.role === 'music');
    const r = ops.addAudio(doc, m, {
      start: music && !hasMusic && where_.at === undefined ? 0 : t,
      role: music ? 'music' : 'voice',
      volume: music ? 0.5 : 1,
      name: m.name,
    });
    queueMicrotask(() => select({ kind: 'audio', id: r.clip.id }));
    return r.doc;
  }, music ? 'Add music' : 'Add audio');
}

// ---------------------------------------------------------------------------
// Dragging things from the side panels onto the timeline

export type DragPayload = { kind: 'media'; id: ID } | { kind: 'graphic'; preset: string } | { kind: 'sfx'; id: string };

const DRAG_TYPE = 'application/x-local-studio';
let dragging: DragPayload | null = null;

/** Props that make an element draggable onto the timeline. */
export function draggable(payload: DragPayload): { draggable: true; onDragStart: (e: { dataTransfer: DataTransfer }) => void; onDragEnd: () => void } {
  return {
    draggable: true,
    onDragStart: (e) => {
      dragging = payload;
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = 'copy';
    },
    onDragEnd: () => {
      dragging = null;
    },
  };
}

/** What is being dragged from a panel right now, if anything. */
export function currentDrag(): DragPayload | null {
  return dragging;
}

/** Which row a dragged item would land on, so the timeline can show it before the drop. */
export function dropRow(p: DragPayload, hovered: string | null): 'main' | 'overlay' | 'audio' | 'music' | 'graphic' {
  const s = get();
  if (p.kind === 'graphic') return 'graphic';
  if (p.kind === 'sfx') return 'audio';
  const m = s.media[p.id];
  if (!m) return 'main';
  if (m.kind === 'audio') return hovered === 'music' || (hovered !== 'audio' && looksLikeMusic(m)) ? 'music' : 'audio';
  return hovered === 'main' || !s.doc?.main.length ? 'main' : 'overlay';
}

export function dropOnTimeline(p: DragPayload, time: number, hovered: string | null): void {
  const s = get();
  if (!s.doc || blocked()) return;
  const fps = s.doc.settings.fps;
  const row = dropRow(p, hovered);
  const end = ops.contentDuration(s.doc);
  // Nothing but the main track may start in the empty space after the video.
  const t = snap(row === 'main' ? Math.max(0, time) : Math.max(0, Math.min(time, Math.max(0, end - 1 / fps))), fps);
  if (p.kind === 'graphic') {
    const def = GRAPHIC_PRESETS[p.preset];
    if (!def) return;
    applyEdit((doc) => {
      const r = ops.addGraphic(doc, { preset: p.preset, start: t, name: def.label });
      queueMicrotask(() => {
        select({ kind: 'graphic', id: r.item.id });
        useStore.setState((st) => ({ ui: { ...st.ui, left: 'edit' } }));
      });
      return r.doc;
    }, `Add ${def.label.toLowerCase()}`);
    player.seek(t);
    return;
  }
  if (p.kind === 'sfx') {
    void runTool('add_sfx', { sfx_id: p.id, at: t });
    return;
  }
  const m = s.media[p.id];
  if (!m) return;
  if (row === 'main') {
    // Lands before the first clip whose middle is to the right of the pointer.
    const index = layoutMain(s.doc).filter((seg) => (seg.start + seg.end) / 2 < time).length;
    addToTimeline(m, 'main', { index });
  } else addToTimeline(m, row === 'overlay' ? 'broll' : row === 'music' ? 'music' : 'voice', { at: t });
}

export function splitAtPlayhead(): void {
  const s = get();
  if (!s.doc) return;
  edit((doc) => ops.splitAt(doc, player.time, s.selection), 'Split');
}

export function deleteSelection(): void {
  const s = get();
  const sel = s.selection;
  if (!s.doc || !sel || blocked()) return;
  if (sel.kind === 'caption') return;
  applyEdit((doc) => ops.removeItem(doc, sel, s.ui.ripple), 'Delete');
  select(null);
}

export function duplicateSelection(): void {
  const s = get();
  const sel = s.selection;
  if (!s.doc || !sel || sel.kind === 'caption' || blocked()) return;
  applyEdit((doc) => {
    const r = ops.duplicateItem(doc, sel);
    if (r.id) queueMicrotask(() => select({ kind: sel.kind, id: r.id! } as Selection));
    return r.doc;
  }, 'Duplicate');
}

export function addGraphicPreset(preset: string, props?: Record<string, unknown>): void {
  const def = GRAPHIC_PRESETS[preset];
  if (!def) return;
  edit((doc) => {
    const r = ops.addGraphic(doc, { preset, props, start: player.time, name: def.label });
    queueMicrotask(() => {
      select({ kind: 'graphic', id: r.item.id });
      useStore.setState((st) => ({ ui: { ...st.ui, left: 'edit' } }));
    });
    return r.doc;
  }, `Add ${def.label.toLowerCase()}`);
}

export function addZoomAtPlayhead(scale = 1.25): void {
  edit((doc) => {
    const r = ops.addZoom(doc, { start: player.time, duration: 2.5, scale, name: 'Punch-in' });
    queueMicrotask(() => select({ kind: 'zoom', id: r.item.id }));
    return r.doc;
  }, 'Add punch-in');
}

/** Bounds of the selected item on the timeline, for "jump to" and similar. */
export function selectionRange(doc: ProjectDoc, sel: Selection): { start: number; end: number } | null {
  if (!sel) return null;
  if (sel.kind === 'main') {
    const seg = layoutMain(doc).find((x) => x.clip.id === sel.id);
    return seg ? { start: seg.start, end: seg.end } : null;
  }
  if (sel.kind === 'overlay' || sel.kind === 'audio') {
    const c = (sel.kind === 'overlay' ? doc.overlays : doc.audio).find((x) => x.id === sel.id);
    return c ? { start: c.start, end: c.start + srcDuration(c) } : null;
  }
  if (sel.kind === 'graphic' || sel.kind === 'zoom') {
    const c = (sel.kind === 'graphic' ? doc.graphics : doc.zooms).find((x) => x.id === sel.id);
    return c ? { start: c.start, end: c.start + c.duration } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Importing

export async function importFiles(files: File[]): Promise<MediaAsset[]> {
  const pid = get().projectId;
  if (!pid || !files.length) return [];
  const added: MediaAsset[] = [];
  for (const file of files) {
    const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 6)}`;
    const setUp = (progress: number | null) =>
      useStore.setState((s) => {
        const uploads = { ...s.uploads };
        if (progress === null) delete uploads[key];
        else uploads[key] = { name: file.name, progress };
        return { uploads };
      });
    setUp(0);
    try {
      added.push(await uploadFile(pid, file, (p) => setUp(p)));
    } catch (err) {
      fail(err, file.name);
    } finally {
      setUp(null);
    }
  }
  return added;
}

/** Open the macOS file dialog and add the chosen files without copying them. */
export async function importFromDisk(): Promise<MediaAsset[]> {
  const pid = get().projectId;
  if (!pid) return [];
  try {
    const picked = await api.pickFiles();
    if (!picked.paths.length) return [];
    const r = await api.importPaths(pid, picked.paths);
    for (const e of r.errors) toast(e, 'error');
    return r.media;
  } catch (err) {
    fail(err);
    return [];
  }
}

export async function importPaths(paths: string[]): Promise<MediaAsset[]> {
  const pid = get().projectId;
  if (!pid) return [];
  try {
    const r = await api.importPaths(pid, paths);
    for (const e of r.errors) toast(e, 'error');
    return r.media;
  } catch (err) {
    fail(err);
    return [];
  }
}

/** Run a server-side editing tool (the same ones the assistant uses) and report what it did. */
export async function runTool(tool: string, args: Record<string, unknown> = {}): Promise<string | null> {
  const pid = get().projectId;
  if (!pid || blocked()) return null;
  try {
    const r = await api.op(pid, tool, args);
    const first = forPeople(r.text);
    if (first) toast(first, 'success');
    return r.text;
  } catch (err) {
    fail(err);
    return null;
  }
}

export function formatDuration(t: number): string {
  if (!Number.isFinite(t) || t <= 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function snapTime(t: number): number {
  const fps = get().doc?.settings.fps ?? 30;
  return snap(t, fps);
}
