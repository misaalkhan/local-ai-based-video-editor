// Thin wrapper over the local server's HTTP API.

import type {
  ChatMessage,
  ExportJob,
  HistoryEntry,
  ID,
  MediaAsset,
  ProjectDoc,
  ProjectSummary,
  Snapshot,
  Transcript,
  FaceTrack,
  MotionTrack,
  PlanItem,
  Profile,
  Recipe,
  Settings,
  Studio,
} from '../shared/types.ts';

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export interface ProjectPayload {
  doc: ProjectDoc;
  rev: number;
  media: MediaAsset[];
  chat: ChatMessage[];
  snapshots: Snapshot[];
  history: HistoryEntry[];
  /** A request the planner queued for this project, to run once its clips are ready. */
  pending?: string | null;
}

export interface Status {
  ffmpeg: boolean;
  whisper: boolean;
  claude: boolean;
  exportDir: string;
  model: string;
}

export interface FoundSound {
  id: number;
  name: string;
  author: string;
  licence: string;
  url: string;
  duration: number;
  preview: string;
  tags: string[];
}

export interface MemeTemplate {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  boxes: number;
}

export interface GifEntry {
  id: string;
  url: string;
  preview: string;
  description: string;
  dims: number[];
  duration: number;
}

export interface SfxEntry {
  id: string;
  name: string;
  tags: string[];
  role?: string;
  duration: number;
  url: string;
  source?: 'built-in' | 'pack' | 'yours';
  set?: 'comedy' | 'social';
  favourite?: boolean;
  /** Credit line for the post when the sound's licence asks for one. */
  credit?: string;
}

export const api = {
  status: () => request<Status>('GET', '/api/status'),
  listProjects: () => request<{ projects: ProjectSummary[] }>('GET', '/api/projects').then((r) => r.projects),
  createProject: (name: string, aspect?: string) =>
    request<{ project: ProjectSummary }>('POST', '/api/projects', { name, aspect }).then((r) => r.project),
  getProject: (id: ID) => request<ProjectPayload>('GET', `/api/projects/${id}`),
  renameProject: (id: ID, name: string) => request('PATCH', `/api/projects/${id}`, { name }),
  deleteProject: (id: ID) => request('DELETE', `/api/projects/${id}`),
  putDoc: (id: ID, doc: ProjectDoc, baseRev: number, clientId: string, label?: string) =>
    request<{ rev: number }>('PUT', `/api/projects/${id}/doc`, { doc, baseRev, clientId, label }),

  importPaths: (id: ID, paths: string[]) =>
    request<{ media: MediaAsset[]; errors: string[] }>('POST', `/api/projects/${id}/media/import`, { paths }),
  pickFiles: () => request<{ paths: string[]; cancelled?: boolean }>('POST', '/api/pick-files', {}),
  removeMedia: (id: ID, mediaId: ID) => request('DELETE', `/api/projects/${id}/media/${mediaId}`),
  retranscribe: (id: ID, mediaId: ID) => request('POST', `/api/projects/${id}/media/${mediaId}/retranscribe`, {}),
  transcript: (id: ID, m: MediaAsset) =>
    request<Transcript>('GET', `/api/projects/${id}/media/${m.id}/transcript.json?r=${m.rev}`),
  faces: (id: ID, m: MediaAsset) => request<FaceTrack>('GET', `/api/projects/${id}/media/${m.id}/faces.json?r=${m.rev}`),
  stability: (id: ID, m: MediaAsset) => request<MotionTrack>('GET', `/api/projects/${id}/media/${m.id}/stability.json?r=${m.rev}`),
  stabilize: (id: ID, mediaId: ID) => request<{ ok: boolean; state: string }>('POST', `/api/projects/${id}/media/${mediaId}/stabilize`),

  /** Run one of the editing tools the assistant also uses (remove silences, add captions, ...). */
  op: (id: ID, tool: string, args: Record<string, unknown> = {}) =>
    request<{ text: string; rev: number }>('POST', `/api/projects/${id}/ops`, { tool, args }),

  sendChat: (id: ID, text: string, attachments?: string[]) =>
    request<{ ok: true }>('POST', `/api/projects/${id}/chat`, { text, attachments }),
  stopChat: (id: ID) => request('POST', `/api/projects/${id}/chat/stop`, {}),
  clearChat: (id: ID) => request('POST', `/api/projects/${id}/chat/clear`, {}),
  undoMessage: (id: ID, messageId: ID) => request<{ rev: number }>('POST', `/api/projects/${id}/chat/${messageId}/undo`, {}),

  studio: () => request<Studio>('GET', '/api/studio'),
  recipes: () => request<{ recipes: Recipe[] }>('GET', '/api/recipes').then((r) => r.recipes),
  removeRecipe: (id: ID) => request('DELETE', `/api/recipes/${id}`),
  settings: () => request<{ settings: Settings; exportDefault: string }>('GET', '/api/settings'),
  saveSettings: (patch: Partial<Settings>) => request<{ settings: Settings; exportDefault: string }>('PATCH', '/api/settings', patch),
  saveProfile: (patch: Partial<Profile>) => request<{ profile: Profile }>('PATCH', '/api/studio/profile', patch).then((r) => r.profile),
  addPlanItem: (item: Partial<PlanItem>) => request<{ item: PlanItem }>('POST', '/api/studio/plan', item).then((r) => r.item),
  updatePlanItem: (id: ID, patch: Partial<PlanItem>) => request<{ item: PlanItem }>('PATCH', `/api/studio/plan/${id}`, patch).then((r) => r.item),
  removePlanItem: (id: ID) => request('DELETE', `/api/studio/plan/${id}`),
  startPlanItem: (id: ID) => request<{ projectId: ID }>('POST', `/api/studio/plan/${id}/start`, {}),
  removeReference: (id: ID) => request('DELETE', `/api/studio/references/${id}`),

  saveSnapshot: (id: ID, name: string) =>
    request<{ snapshot: Snapshot }>('POST', `/api/projects/${id}/snapshots`, { name }).then((r) => r.snapshot),
  restoreSnapshot: (id: ID, sid: ID) => request('POST', `/api/projects/${id}/snapshots/${sid}/restore`, {}),
  deleteSnapshot: (id: ID, sid: ID) => request('DELETE', `/api/projects/${id}/snapshots/${sid}`),

  startExport: (id: ID, opts: Record<string, unknown>) =>
    request<{ job: ExportJob }>('POST', `/api/projects/${id}/export`, opts).then((r) => r.job),
  cancelExport: (id: ID, jobId: ID) => request('POST', `/api/projects/${id}/export/${jobId}/cancel`, {}),
  reveal: (path: string) => request('POST', '/api/reveal', { path }),

  sfx: () => request<{ sfx: SfxEntry[] }>('GET', '/api/library/sfx').then((r) => r.sfx),
  voices: () => request<{ voices: { id: string; name: string }[] }>('GET', '/api/library/voices').then((r) => r.voices),
  gifs: (q: string) => request<{ gifs: GifEntry[] }>('GET', `/api/gifs?q=${encodeURIComponent(q)}`).then((r) => r.gifs),
  sfxFavourite: (id: string, on: boolean) => request('PUT', `/api/library/sfx/${encodeURIComponent(id)}/favourite`, { on }),
  sfxRemove: (id: string) => request('DELETE', `/api/library/sfx/${encodeURIComponent(id)}`),
  soundsSearch: (q: string) => request<{ sounds: FoundSound[] }>('GET', `/api/sounds/search?q=${encodeURIComponent(q)}`).then((r) => r.sounds),
  sfxSave: (found: FoundSound) => request<{ sound: SfxEntry }>('POST', '/api/library/sfx/save', found).then((r) => r.sound),
  luts: () => request<{ luts: { name: string }[] }>('GET', '/api/library/luts').then((r) => r.luts),
  removeLut: (name: string) => request('DELETE', `/api/library/luts/${encodeURIComponent(name)}`),
  memeTemplates: (q: string) => request<{ templates: MemeTemplate[] }>('GET', `/api/memes/templates?q=${encodeURIComponent(q)}`).then((r) => r.templates),
  addMeme: (projectId: ID, id: string) => request<{ media: MediaAsset; template: MemeTemplate }>('POST', `/api/projects/${projectId}/memes`, { id }),
  still: (projectId: ID, mediaId: ID, time: number) => request<MediaAsset>('POST', `/api/projects/${projectId}/stills`, { mediaId, time }),
};

/** Upload one file as the raw request body, reporting progress as it goes. */
export function uploadFile(projectId: ID, file: File, onProgress?: (fraction: number) => void): Promise<MediaAsset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/projects/${projectId}/media/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText) as { media?: MediaAsset; error?: string };
        if (xhr.status >= 200 && xhr.status < 300 && data.media) resolve(data.media);
        else reject(new ApiError(xhr.status, data.error ?? 'upload failed'));
      } catch {
        reject(new ApiError(xhr.status, 'upload failed'));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'upload failed: the server did not answer'));
    xhr.send(file);
  });
}

/** A .cube LUT file, saved into the library. */
export function uploadLut(file: File): Promise<{ name: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/library/luts/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText) as { lut?: { name: string }; error?: string };
        if (xhr.status >= 200 && xhr.status < 300 && data.lut) resolve(data.lut);
        else reject(new ApiError(xhr.status, data.error ?? 'upload failed'));
      } catch {
        reject(new ApiError(xhr.status, 'upload failed'));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'upload failed: the server did not answer'));
    xhr.send(file);
  });
}

/** A sound file dropped onto the Sounds tab, saved into the library (not into a project). */
export function uploadSound(file: File): Promise<SfxEntry> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/library/sfx/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText) as { sound?: SfxEntry; error?: string };
        if (xhr.status >= 200 && xhr.status < 300 && data.sound) resolve(data.sound);
        else reject(new ApiError(xhr.status, data.error ?? 'upload failed'));
      } catch {
        reject(new ApiError(xhr.status, 'upload failed'));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'upload failed: the server did not answer'));
    xhr.send(file);
  });
}

export const mediaUrl = (projectId: ID, m: MediaAsset, file: string) => `/api/projects/${projectId}/media/${m.id}/${file}?r=${m.rev}`;

export type ServerEvent =
  | { type: 'hello'; rev: number }
  | { type: 'doc'; doc: ProjectDoc; rev: number; source: string; clientId?: string; label?: string; messageId?: string }
  | { type: 'media'; asset: MediaAsset }
  | { type: 'media-removed'; id: ID }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'chat-reset' }
  | { type: 'history'; entry: HistoryEntry }
  | { type: 'snapshots'; snapshots: Snapshot[] }
  | { type: 'export'; job: ExportJob }
  | { type: 'toast'; text: string; kind?: string; messageId?: string }
  | { type: 'deleted' };

/** Subscribe to live updates for a project. Returns a function that closes the connection. */
export function subscribe(projectId: ID, onEvent: (e: ServerEvent) => void, onState?: (connected: boolean) => void): () => void {
  const es = new EventSource(`/api/projects/${projectId}/events`);
  const on = <T,>(name: string, map: (data: T) => ServerEvent) =>
    es.addEventListener(name, (ev) => {
      try {
        onEvent(map(JSON.parse((ev as MessageEvent).data) as T));
      } catch (err) {
        console.error('bad event', name, err);
      }
    });
  on<{ rev: number }>('hello', (d) => ({ type: 'hello', rev: d.rev }));
  on<Omit<Extract<ServerEvent, { type: 'doc' }>, 'type'>>('doc', (d) => ({ type: 'doc', ...d }));
  on<MediaAsset>('media', (asset) => ({ type: 'media', asset }));
  on<{ id: ID }>('media-removed', (d) => ({ type: 'media-removed', id: d.id }));
  on<ChatMessage>('chat', (message) => ({ type: 'chat', message }));
  on<object>('chat-reset', () => ({ type: 'chat-reset' }));
  on<HistoryEntry>('history', (entry) => ({ type: 'history', entry }));
  on<Snapshot[]>('snapshots', (snapshots) => ({ type: 'snapshots', snapshots }));
  on<ExportJob>('export', (job) => ({ type: 'export', job }));
  on<{ text: string; kind?: string; messageId?: string }>('toast', (d) => ({ type: 'toast', ...d }));
  on<object>('deleted', () => ({ type: 'deleted' }));
  es.onopen = () => onState?.(true);
  es.onerror = () => onState?.(false);
  return () => es.close();
}
