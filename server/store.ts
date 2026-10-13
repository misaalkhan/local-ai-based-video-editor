// Projects on disk. Each project is a folder:
//
//   project.json     the timeline document and its revision number
//   media.json       the media library
//   chat.json        the conversation with the assistant
//   history.json     append-only log of edits (who, what, why)
//   snapshots/       saved versions of the document
//   media/<id>/      proxy, thumbnails, waveform, transcript for one file
//
// The server is the single owner of these files. Browsers get changes pushed
// to them over server-sent events.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECTS_DIR } from './config.ts';
import type {
  ChatMessage,
  FaceTrack,
  MotionTrack,
  ObjectTrack,
  HistoryEntry,
  ID,
  MediaAsset,
  ProjectDoc,
  ProjectSummary,
  Snapshot,
  Transcript,
  Word,
} from '../shared/types.ts';
import { contentDuration, createDoc, sanitizeDoc, uid } from '../shared/ops.ts';
import type { MediaLike } from '../shared/ops.ts';

export type Listener = (event: string, data: unknown) => void;

export interface Project {
  id: ID;
  dir: string;
  doc: ProjectDoc;
  rev: number;
  media: Map<ID, MediaAsset>;
  chat: ChatMessage[];
  history: HistoryEntry[];
  snapshots: Snapshot[];
  listeners: Set<Listener>;
  transcripts: Map<ID, Transcript | null>;
  envelopes: Map<ID, Uint8Array | null>;
  faces: Map<ID, FaceTrack | null>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  /** A request the planner queued, to run once the media are ready (see pending.json). */
  pending?: string;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const projects = new Map<ID, Project>();

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write through a temporary file so a crash never leaves a half-written project. */
function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function validId(id: string): boolean {
  return /^[a-z0-9_-]{4,40}$/i.test(id);
}

export function ensureDirs(): void {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

function projectDir(id: ID): string {
  if (!validId(id)) throw new HttpError(400, 'bad project id');
  return path.join(PROJECTS_DIR, id);
}

export function mediaDir(p: Project, mediaId: ID): string {
  if (!validId(mediaId)) throw new HttpError(400, 'bad media id');
  return path.join(p.dir, 'media', mediaId);
}

function schedule(p: Project, key: string, fn: () => void, delay = 250): void {
  const old = p.timers.get(key);
  if (old) clearTimeout(old);
  p.timers.set(
    key,
    setTimeout(() => {
      p.timers.delete(key);
      try {
        fn();
      } catch (err) {
        console.error(`[store] could not save ${key} for ${p.id}:`, err);
      }
    }, delay),
  );
}

const saveDoc = (p: Project) => schedule(p, 'doc', () => writeJson(path.join(p.dir, 'project.json'), { doc: p.doc, rev: p.rev }));
const saveMedia = (p: Project) => schedule(p, 'media', () => writeJson(path.join(p.dir, 'media.json'), [...p.media.values()]));
const saveChat = (p: Project) => schedule(p, 'chat', () => writeJson(path.join(p.dir, 'chat.json'), p.chat));
const saveHistory = (p: Project) => schedule(p, 'history', () => writeJson(path.join(p.dir, 'history.json'), p.history.slice(-500)));
const saveSnapshots = (p: Project) => writeJson(path.join(p.dir, 'snapshots', 'index.json'), p.snapshots);

/** Write everything that is still waiting on a debounce timer. Called on shutdown. */
export function flushAll(): void {
  for (const p of projects.values()) {
    for (const t of p.timers.values()) clearTimeout(t);
    p.timers.clear();
    try {
      writeJson(path.join(p.dir, 'project.json'), { doc: p.doc, rev: p.rev });
      writeJson(path.join(p.dir, 'media.json'), [...p.media.values()]);
      writeJson(path.join(p.dir, 'chat.json'), p.chat);
      writeJson(path.join(p.dir, 'history.json'), p.history.slice(-500));
    } catch (err) {
      console.error(`[store] flush failed for ${p.id}:`, err);
    }
  }
}

export function emit(p: Project, event: string, data: unknown): void {
  for (const l of p.listeners) {
    try {
      l(event, data);
    } catch {
      // a broken connection is cleaned up by its own close handler
    }
  }
}

function load(id: ID): Project {
  const dir = projectDir(id);
  const file = path.join(dir, 'project.json');
  if (!fs.existsSync(file)) throw new HttpError(404, 'project not found');
  const saved = readJson<{ doc: ProjectDoc; rev: number } | null>(file, null);
  if (!saved?.doc) throw new HttpError(500, 'project file is unreadable');
  const media = new Map<ID, MediaAsset>();
  for (const a of readJson<MediaAsset[]>(path.join(dir, 'media.json'), [])) media.set(a.id, a);
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
  const p: Project = {
    id,
    dir,
    doc: sanitizeDoc(saved.doc, (m) => media.has(m)),
    rev: saved.rev ?? 1,
    media,
    chat: readJson<ChatMessage[]>(path.join(dir, 'chat.json'), []),
    history: readJson<HistoryEntry[]>(path.join(dir, 'history.json'), []),
    snapshots: readJson<Snapshot[]>(path.join(dir, 'snapshots', 'index.json'), []),
    listeners: new Set(),
    transcripts: new Map(),
    envelopes: new Map(),
    faces: new Map(),
    timers: new Map(),
  };
  const pending = readJson<{ text?: string } | null>(path.join(dir, 'pending.json'), null);
  if (pending?.text) p.pending = pending.text;
  // A turn that was running when the server stopped can never finish.
  for (const m of p.chat) {
    if (m.status === 'running' || m.status === 'reviewing') m.status = 'stopped';
    for (const a of m.actions ?? []) if (a.status === 'running') a.status = 'error';
  }
  return p;
}

export function getProject(id: ID): Project {
  let p = projects.get(id);
  if (!p) {
    // The footage library is made on first use.
    if (id === 'library' && !fs.existsSync(path.join(projectDir(id), 'project.json'))) return createProject('Footage library', '9:16', id);
    p = load(id);
    projects.set(id, p);
  }
  return p;
}

export function summarize(p: Project): ProjectSummary {
  const firstVisual =
    p.doc.main.find((c) => c.kind === 'media') ?? [...p.media.values()].find((m) => m.kind !== 'audio' && !m.origin);
  const thumbMedia = firstVisual && 'mediaId' in firstVisual ? firstVisual.mediaId : (firstVisual as MediaAsset | undefined)?.id;
  const m = thumbMedia ? p.media.get(thumbMedia) : undefined;
  return {
    id: p.id,
    name: p.doc.name,
    updatedAt: p.doc.updatedAt,
    createdAt: p.doc.createdAt,
    duration: contentDuration(p.doc),
    width: p.doc.settings.width,
    height: p.doc.settings.height,
    thumb: m && m.kind !== 'audio' ? `/api/projects/${p.id}/media/${m.id}/thumb.jpg?r=${m.rev}` : undefined,
  };
}

export function listProjects(): ProjectSummary[] {
  ensureDirs();
  const out: ProjectSummary[] = [];
  for (const name of fs.readdirSync(PROJECTS_DIR)) {
    // The footage library is a project too, but it has its own place in the app.
    if (!validId(name) || name === 'library') continue;
    try {
      out.push(summarize(getProject(name)));
    } catch {
      // skip folders that are not projects
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createProject(name: string, aspect?: string, fixedId?: ID): Project {
  ensureDirs();
  const id = fixedId ?? uid('p');
  const dir = projectDir(id);
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
  const doc = createDoc(id, name.trim().slice(0, 120) || 'Untitled project', aspect);
  writeJson(path.join(dir, 'project.json'), { doc, rev: 1 });
  return getProject(id);
}

/** Projects are moved to the macOS Trash rather than deleted, so a slip can be undone in Finder. */
export function trashProject(id: ID): void {
  const p = getProject(id);
  for (const t of p.timers.values()) clearTimeout(t);
  projects.delete(id);
  const trash = path.join(os.homedir(), '.Trash');
  const safe = p.doc.name.replace(/[^\w .-]+/g, '_').slice(0, 60);
  const dest = path.join(trash, `Local Studio - ${safe} - ${Date.now()}`);
  try {
    fs.renameSync(p.dir, dest);
  } catch {
    // Trash on another volume or not writable: fall back to removing the folder.
    fs.rmSync(p.dir, { recursive: true, force: true });
  }
  for (const l of p.listeners) l('deleted', {});
}

// ---------------------------------------------------------------------------
// Document

export interface CommitMeta {
  source: 'client' | 'agent' | 'op' | 'restore';
  clientId?: string;
  label?: string;
  messageId?: string;
}

export function commitDoc(p: Project, doc: ProjectDoc, meta: CommitMeta): number {
  p.doc = sanitizeDoc({ ...doc, id: p.id, createdAt: p.doc.createdAt, updatedAt: Date.now() }, (m) => p.media.has(m));
  p.rev++;
  saveDoc(p);
  emit(p, 'doc', { doc: p.doc, rev: p.rev, ...meta });
  return p.rev;
}

export function logHistory(p: Project, entry: Omit<HistoryEntry, 'id' | 'ts'>): HistoryEntry {
  const full: HistoryEntry = { id: uid('h'), ts: Date.now(), ...entry };
  p.history.push(full);
  saveHistory(p);
  emit(p, 'history', full);
  return full;
}

// ---------------------------------------------------------------------------
// Snapshots (version history and per-message undo)

export function createSnapshot(p: Project, name: string, auto = false): Snapshot {
  const snap: Snapshot = { id: uid('s'), name, ts: Date.now(), auto, duration: contentDuration(p.doc) };
  writeJson(path.join(p.dir, 'snapshots', `${snap.id}.json`), p.doc);
  p.snapshots.push(snap);
  // Keep every named version, but only the most recent automatic ones.
  const autos = p.snapshots.filter((s) => s.auto);
  for (const old of autos.slice(0, Math.max(0, autos.length - 40))) {
    fs.rmSync(path.join(p.dir, 'snapshots', `${old.id}.json`), { force: true });
    p.snapshots = p.snapshots.filter((s) => s.id !== old.id);
  }
  saveSnapshots(p);
  emit(p, 'snapshots', p.snapshots);
  return snap;
}

export function readSnapshot(p: Project, id: ID): ProjectDoc {
  if (!validId(id)) throw new HttpError(400, 'bad snapshot id');
  const doc = readJson<ProjectDoc | null>(path.join(p.dir, 'snapshots', `${id}.json`), null);
  if (!doc) throw new HttpError(404, 'that version no longer exists');
  return doc;
}

export function deleteSnapshot(p: Project, id: ID): void {
  if (!validId(id)) throw new HttpError(400, 'bad snapshot id');
  fs.rmSync(path.join(p.dir, 'snapshots', `${id}.json`), { force: true });
  p.snapshots = p.snapshots.filter((s) => s.id !== id);
  saveSnapshots(p);
  emit(p, 'snapshots', p.snapshots);
}

// ---------------------------------------------------------------------------
// Media

export function putMedia(p: Project, asset: MediaAsset): void {
  p.media.set(asset.id, asset);
  saveMedia(p);
  emit(p, 'media', asset);
}

export function patchMedia(p: Project, id: ID, patch: Partial<MediaAsset>): MediaAsset | undefined {
  const cur = p.media.get(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  putMedia(p, next);
  return next;
}

/** Forget a media file and drop every clip that used it. */
export function dropMedia(p: Project, id: ID): void {
  if (!p.media.delete(id)) return;
  forgetDerived(p, id);
  saveMedia(p);
  emit(p, 'media-removed', { id });
  commitDoc(p, p.doc, { source: 'op', label: 'Remove media' });
}

/** Next unused short handle for a media file's words: a, b, ... z, aa, ab, ... */
export function nextTag(p: Project): string {
  const used = new Set([...p.media.values()].map((m) => m.tag).filter(Boolean));
  for (let i = 0; ; i++) {
    let n = i;
    let tag = '';
    do {
      tag = String.fromCharCode(97 + (n % 26)) + tag;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    if (!used.has(tag)) return tag;
  }
}

export function mediaLike(p: Project, id: ID): MediaLike | undefined {
  const m = p.media.get(id);
  return m ? { id: m.id, kind: m.kind, duration: m.duration } : undefined;
}

export function getTranscript(p: Project, mediaId: ID): Transcript | undefined {
  if (!p.transcripts.has(mediaId)) {
    const file = path.join(mediaDir(p, mediaId), 'transcript.json');
    p.transcripts.set(mediaId, fs.existsSync(file) ? readJson<Transcript | null>(file, null) : null);
  }
  return p.transcripts.get(mediaId) ?? undefined;
}

export function getWords(p: Project, mediaId: ID): Word[] | undefined {
  return getTranscript(p, mediaId)?.words;
}

export function setTranscript(p: Project, mediaId: ID, t: Transcript): void {
  writeJson(path.join(mediaDir(p, mediaId), 'transcript.json'), t);
  p.transcripts.set(mediaId, t);
}

export function getEnvelope(p: Project, mediaId: ID): Uint8Array | undefined {
  if (!p.envelopes.has(mediaId)) {
    const file = path.join(mediaDir(p, mediaId), 'envelope.bin');
    p.envelopes.set(mediaId, fs.existsSync(file) ? new Uint8Array(fs.readFileSync(file)) : null);
  }
  return p.envelopes.get(mediaId) ?? undefined;
}

export function getFaces(p: Project, mediaId: ID): FaceTrack | undefined {
  if (!p.faces.has(mediaId)) {
    const file = path.join(mediaDir(p, mediaId), 'faces.json');
    p.faces.set(mediaId, fs.existsSync(file) ? readJson<FaceTrack | null>(file, null) : null);
  }
  return p.faces.get(mediaId) ?? undefined;
}

export function setFaces(p: Project, mediaId: ID, track: FaceTrack): void {
  writeJson(path.join(mediaDir(p, mediaId), 'faces.json'), track);
  p.faces.set(mediaId, track);
}

const stability = new Map<string, MotionTrack | null>();

/** The camera path measured for stabilising, when the analysis has run. */
export function getStability(p: Project, mediaId: ID): MotionTrack | undefined {
  const key = `${p.id}/${mediaId}`;
  if (!stability.has(key)) {
    const file = path.join(mediaDir(p, mediaId), 'stability.json');
    stability.set(key, fs.existsSync(file) ? readJson<MotionTrack | null>(file, null) : null);
  }
  return stability.get(key) ?? undefined;
}

export function setStability(p: Project, mediaId: ID, track: MotionTrack): void {
  writeJson(path.join(mediaDir(p, mediaId), 'stability.json'), track);
  stability.set(`${p.id}/${mediaId}`, track);
}

const objects = new Map<string, ObjectTrack[] | null>();

/** Objects tracked through a video, for graphics that follow them. */
export function getObjectTracks(p: Project, mediaId: ID): ObjectTrack[] | undefined {
  const key = `${p.id}/${mediaId}`;
  if (!objects.has(key)) {
    const file = path.join(mediaDir(p, mediaId), 'tracks.json');
    objects.set(key, fs.existsSync(file) ? readJson<ObjectTrack[] | null>(file, null) : null);
  }
  return objects.get(key) ?? undefined;
}

export function setObjectTracks(p: Project, mediaId: ID, tracks: ObjectTrack[]): void {
  writeJson(path.join(mediaDir(p, mediaId), 'tracks.json'), tracks);
  objects.set(`${p.id}/${mediaId}`, tracks);
}

export function forgetDerived(p: Project, mediaId: ID): void {
  p.transcripts.delete(mediaId);
  p.envelopes.delete(mediaId);
  p.faces.delete(mediaId);
}

// ---------------------------------------------------------------------------
// Chat

export function addMessage(p: Project, msg: ChatMessage): ChatMessage {
  p.chat.push(msg);
  saveChat(p);
  emit(p, 'chat', msg);
  return msg;
}

export function updateMessage(p: Project, id: ID, patch: Partial<ChatMessage>): ChatMessage | undefined {
  const m = p.chat.find((x) => x.id === id);
  if (!m) return undefined;
  Object.assign(m, patch);
  saveChat(p);
  emit(p, 'chat', m);
  return m;
}

export function clearChat(p: Project): void {
  p.chat = [];
  saveChat(p);
  emit(p, 'chat-reset', {});
}

/** Queue a request to run as soon as the project's media are ready, or clear it. */
export function setPendingRequest(p: Project, text: string | null): void {
  const file = path.join(p.dir, 'pending.json');
  if (text) {
    p.pending = text;
    writeJson(file, { text });
  } else {
    delete p.pending;
    fs.rmSync(file, { force: true });
  }
}
