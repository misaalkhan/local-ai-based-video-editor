// Editor state. The timeline document lives here; every edit goes through
// applyEdit so it lands on the undo stack and is saved to the server.

import { create } from 'zustand';
import type {
  ChatMessage,
  ExportJob,
  FaceTrack,
  MotionTrack,
  ObjectTrack,
  HistoryEntry,
  ID,
  MediaAsset,
  ProjectDoc,
  Range,
  Selection,
  Snapshot,
  Word,
} from '../shared/types.ts';
import { ApiError, api, subscribe } from './api.ts';
import type { ServerEvent, Status } from './api.ts';
import { contentDuration, duckIntervals, layoutMain } from '../shared/timeline.ts';
import type { MainSeg } from '../shared/timeline.ts';
import { buildCards, speechSpans, timelineWords } from '../shared/captions.ts';
import type { CaptionCard, TLWord } from '../shared/captions.ts';

export const CLIENT_ID = Math.random().toString(36).slice(2, 10);

export interface Toast {
  id: string;
  text: string;
  kind: 'info' | 'error' | 'success';
  action?: { label: string; run: () => void };
}

export type LeftPanel = 'media' | 'music' | 'sounds' | 'memes' | 'captions' | 'text' | 'graphics' | 'effects' | 'transitions' | 'edit';
export type RightPanel = 'chat' | 'transcript';

export interface UiState {
  left: LeftPanel;
  right: RightPanel;
  pxPerSec: number;
  snap: boolean;
  ripple: boolean;
  safeZones: boolean;
  showExport: boolean;
  showHistory: boolean;
}

export interface EditorState {
  projectId: ID | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  status: Status | null;
  doc: ProjectDoc | null;
  /** A change being dragged out but not committed yet. */
  draft: ProjectDoc | null;
  rev: number;
  media: Record<ID, MediaAsset>;
  words: Record<ID, Word[]>;
  faces: Record<ID, FaceTrack>;
  stability: Record<ID, MotionTrack>;
  objects: Record<ID, ObjectTrack[]>;
  /** The preview is waiting for a box to be drawn (to track an object for this graphic). */
  pickBox: { graphicId: ID } | null;
  chat: ChatMessage[];
  snapshots: Snapshot[];
  history: HistoryEntry[];
  selection: Selection;
  undoStack: { doc: ProjectDoc; label: string }[];
  redoStack: { doc: ProjectDoc; label: string }[];
  exportJob: ExportJob | null;
  toasts: Toast[];
  uploads: Record<string, { name: string; progress: number }>;
  /** A chat request waiting for clips to finish preparing. */
  queued: string | null;
  /** A request the planner queued for this project; the editor runs it once the clips are ready. */
  pending: string | null;
  ui: UiState;
}

const DEFAULT_UI: UiState = {
  left: 'media',
  right: 'chat',
  pxPerSec: 60,
  snap: true,
  ripple: true,
  safeZones: false,
  showExport: false,
  showHistory: false,
};

export const useStore = create<EditorState>(() => ({
  projectId: null,
  loading: false,
  error: null,
  connected: true,
  status: null,
  doc: null,
  draft: null,
  rev: 0,
  media: {},
  words: {},
  faces: {},
  stability: {},
  objects: {},
  pickBox: null,
  chat: [],
  snapshots: [],
  history: [],
  selection: null,
  undoStack: [],
  redoStack: [],
  exportJob: null,
  toasts: [],
  uploads: {},
  queued: null,
  pending: null,
  ui: DEFAULT_UI,
}));

const get = useStore.getState;
const set = useStore.setState;

// ---------------------------------------------------------------------------
// Derived timeline data, recomputed only when the document or transcripts change

export interface Derived {
  layout: MainSeg[];
  duration: number;
  words: TLWord[];
  cards: CaptionCard[];
  duck: Range[];
}

let derivedKey: { doc: ProjectDoc; words: Record<ID, Word[]> } | null = null;
let derivedValue: Derived | null = null;

export function derive(doc: ProjectDoc, words: Record<ID, Word[]>): Derived {
  if (derivedKey && derivedKey.doc === doc && derivedKey.words === words && derivedValue) return derivedValue;
  const layout = layoutMain(doc);
  const tl = timelineWords(doc, layout, (id) => words[id]);
  derivedKey = { doc, words };
  derivedValue = {
    layout,
    duration: contentDuration(doc),
    words: tl,
    cards: buildCards(tl, doc.captions),
    duck: duckIntervals(speechSpans(tl)),
  };
  return derivedValue;
}

/** The document as it should be shown right now: the in-progress drag if there is one. */
export const liveDoc = (s: EditorState): ProjectDoc | null => s.draft ?? s.doc;

export function useDoc(): ProjectDoc | null {
  return useStore(liveDoc);
}

export function useDerived(): Derived | null {
  const doc = useStore(liveDoc);
  const words = useStore((s) => s.words);
  return doc ? derive(doc, words) : null;
}

// ---------------------------------------------------------------------------
// Toasts

export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']): void {
  const id = Math.random().toString(36).slice(2);
  set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind, action }] }));
  setTimeout(() => dismissToast(id), action ? 9000 : kind === 'error' ? 7000 : 3500);
}

export function dismissToast(id: string): void {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function fail(err: unknown, prefix = ''): void {
  const msg = err instanceof Error ? err.message : String(err);
  toast(prefix ? `${prefix}: ${msg}` : msg, 'error');
}

// ---------------------------------------------------------------------------
// Saving

let saving = false;
let dirty = false;
let saveLabel: string | undefined;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(label?: string): void {
  dirty = true;
  saveLabel = label;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 200);
}

async function flushSave(): Promise<void> {
  if (saving || !dirty) return;
  const s = get();
  if (!s.projectId || !s.doc) return;
  saving = true;
  dirty = false;
  try {
    const { rev } = await api.putDoc(s.projectId, s.doc, s.rev, CLIENT_ID, saveLabel);
    set({ rev });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // Someone else (the assistant, another tab) changed the project first.
      const data = err.data as { doc: ProjectDoc; rev: number };
      dirty = false;
      set({ doc: data.doc, rev: data.rev, draft: null });
      toast('The project changed while you were editing, so your last change was not applied.', 'error');
    } else fail(err, 'Could not save');
  } finally {
    saving = false;
    if (dirty) void flushSave();
  }
}

// ---------------------------------------------------------------------------
// Editing

/** Apply an edit to the document, remembering the previous state for undo. */
export function applyEdit(fn: (doc: ProjectDoc) => ProjectDoc, label = 'Edit'): void {
  const s = get();
  if (!s.doc) return;
  const next = fn(s.doc);
  if (next === s.doc) return;
  set({
    doc: next,
    draft: null,
    undoStack: [...s.undoStack, { doc: s.doc, label }].slice(-120),
    redoStack: [],
  });
  scheduleSave(label);
}

/** Show a change while it is being dragged, without saving or touching undo. */
export function setDraft(doc: ProjectDoc | null): void {
  set({ draft: doc });
}

export function commitDraft(label: string): void {
  const s = get();
  if (!s.draft) return;
  const draft = s.draft;
  applyEdit(() => draft, label);
}

export function undo(): void {
  const s = get();
  const last = s.undoStack[s.undoStack.length - 1];
  if (!last || !s.doc) return;
  set({
    doc: last.doc,
    draft: null,
    undoStack: s.undoStack.slice(0, -1),
    redoStack: [...s.redoStack, { doc: s.doc, label: last.label }],
  });
  scheduleSave('Undo');
}

export function redo(): void {
  const s = get();
  const last = s.redoStack[s.redoStack.length - 1];
  if (!last || !s.doc) return;
  set({
    doc: last.doc,
    draft: null,
    redoStack: s.redoStack.slice(0, -1),
    undoStack: [...s.undoStack, { doc: s.doc, label: last.label }],
  });
  scheduleSave('Redo');
}

export function select(selection: Selection): void {
  set({ selection });
}

export function setUi(patch: Partial<UiState>): void {
  set((s) => ({ ui: { ...s.ui, ...patch } }));
}

// ---------------------------------------------------------------------------
// Loading and live updates

let unsubscribe: (() => void) | null = null;
const wordsRev: Record<ID, number> = {};
const facesRev: Record<ID, number> = {};
const stabilityRev: Record<ID, number> = {};
const objectsRev: Record<ID, number> = {};

function loadDerivedFiles(projectId: ID, m: MediaAsset): void {
  if (m.transcript === 'done' && wordsRev[m.id] !== m.rev) {
    wordsRev[m.id] = m.rev;
    api
      .transcript(projectId, m)
      .then((t) => {
        if (get().projectId === projectId) set((s) => ({ words: { ...s.words, [m.id]: t.words } }));
      })
      .catch(() => {
        delete wordsRev[m.id];
      });
  }
  if (m.faces === 'done' && facesRev[m.id] !== m.rev) {
    facesRev[m.id] = m.rev;
    api
      .faces(projectId, m)
      .then((f) => {
        if (get().projectId === projectId) set((s) => ({ faces: { ...s.faces, [m.id]: f } }));
      })
      .catch(() => {
        delete facesRev[m.id];
      });
  }
  if (m.tracks?.length && objectsRev[m.id] !== m.rev) {
    objectsRev[m.id] = m.rev;
    api
      .objects(projectId, m)
      .then((f) => {
        if (get().projectId === projectId) set((s) => ({ objects: { ...s.objects, [m.id]: f } }));
      })
      .catch(() => {
        delete objectsRev[m.id];
      });
  }
  if (m.stability === 'done' && stabilityRev[m.id] !== m.rev) {
    stabilityRev[m.id] = m.rev;
    api
      .stability(projectId, m)
      .then((f) => {
        if (get().projectId === projectId) set((s) => ({ stability: { ...s.stability, [m.id]: f } }));
      })
      .catch(() => {
        delete stabilityRev[m.id];
      });
  }
}

function onServerEvent(projectId: ID, e: ServerEvent): void {
  const s = get();
  if (s.projectId !== projectId) return;
  switch (e.type) {
    case 'doc': {
      if (e.clientId === CLIENT_ID) {
        if (e.rev > s.rev) set({ rev: e.rev });
        return;
      }
      // An edit from the assistant or a server-side tool: take it, and keep
      // what we had so Cmd+Z steps back over it.
      dirty = false;
      const label = e.source === 'agent' ? 'Assistant edit' : (e.label ?? 'Edit');
      set({
        doc: e.doc,
        rev: e.rev,
        draft: null,
        undoStack: s.doc ? [...s.undoStack, { doc: s.doc, label }].slice(-120) : s.undoStack,
        redoStack: [],
      });
      return;
    }
    case 'media':
      set({ media: { ...s.media, [e.asset.id]: e.asset } });
      loadDerivedFiles(projectId, e.asset);
      return;
    case 'media-removed': {
      const media = { ...s.media };
      delete media[e.id];
      set({ media });
      return;
    }
    case 'chat': {
      const i = s.chat.findIndex((m) => m.id === e.message.id);
      const chat = i >= 0 ? s.chat.map((m, k) => (k === i ? e.message : m)) : [...s.chat, e.message];
      set({ chat });
      return;
    }
    case 'chat-reset':
      set({ chat: [] });
      return;
    case 'history':
      set({ history: [...s.history, e.entry].slice(-300) });
      return;
    case 'snapshots':
      set({ snapshots: e.snapshots });
      return;
    case 'export':
      set({ exportJob: e.job });
      return;
    case 'toast':
      toast(e.text, e.kind === 'error' ? 'error' : e.kind === 'success' ? 'success' : 'info');
      return;
    case 'deleted':
      set({ error: 'This project was deleted.' });
      return;
  }
}

export async function openProject(projectId: ID): Promise<void> {
  closeProject();
  set({ projectId, loading: true, error: null });
  try {
    const [payload, status] = await Promise.all([api.getProject(projectId), get().status ? Promise.resolve(get().status) : api.status()]);
    if (get().projectId !== projectId) return;
    const media: Record<ID, MediaAsset> = {};
    for (const m of payload.media) media[m.id] = m;
    set({
      loading: false,
      status,
      doc: payload.doc,
      rev: payload.rev,
      media,
      chat: payload.chat,
      snapshots: payload.snapshots,
      history: payload.history,
      words: {},
      faces: {},
      stability: {},
      objects: {},
      pickBox: null,
      selection: null,
      undoStack: [],
      redoStack: [],
      draft: null,
      exportJob: null,
      pending: payload.pending ?? null,
    });
    for (const m of payload.media) loadDerivedFiles(projectId, m);
    unsubscribe = subscribe(
      projectId,
      (e) => onServerEvent(projectId, e),
      (connected) => set({ connected }),
    );
  } catch (err) {
    if (get().projectId === projectId) set({ loading: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export function closeProject(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (saveTimer) clearTimeout(saveTimer);
  void flushSave();
  for (const k of Object.keys(wordsRev)) delete wordsRev[k];
  for (const k of Object.keys(facesRev)) delete facesRev[k];
  for (const k of Object.keys(stabilityRev)) delete stabilityRev[k];
  for (const k of Object.keys(objectsRev)) delete objectsRev[k];
  set({ projectId: null, doc: null, draft: null, media: {}, words: {}, faces: {}, stability: {}, objects: {}, pickBox: null, chat: [], selection: null, undoStack: [], redoStack: [], queued: null, pending: null, uploads: {} });
}

/** True while the assistant is in the middle of a turn. Manual edits wait, so the two do not collide. */
export function agentBusy(s: EditorState): boolean {
  const last = s.chat[s.chat.length - 1];
  return !!last && last.role === 'assistant' && last.status === 'running';
}
