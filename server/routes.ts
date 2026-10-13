// REST endpoints for projects, the timeline document and the media library.

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { toolStatus } from './config.ts';
import type { Router } from './http.ts';
import { openSse, sendFile } from './http.ts';
import {
  HttpError,
  commitDoc,
  createProject,
  createSnapshot,
  deleteSnapshot,
  getProject,
  listProjects,
  mediaDir,
  readSnapshot,
  setPendingRequest,
  summarize,
  trashProject,
} from './store.ts';
import { analyzeStability } from './stabilize.ts';
import { removeObjectTrack, trackObject } from './objects.ts';
import { importMedia, proxyFile, removeMedia, resumePending, retranscribe } from './media.ts';
import { MEDIA_EXT, extOf } from './probe.ts';
import { addPlanItem, copyMedia, getRecipes, getSettings, getStudio, layOut, removePlanItem, removeRecipe, removeReference, saveProfile, saveSettings, updatePlanItem } from './studio.ts';
import type { PlanItem, Profile, Settings } from '../shared/types.ts';
import { EXPORT_DIR } from './config.ts';
import { run } from './proc.ts';
import type { ProjectDoc } from '../shared/types.ts';
import { uid } from '../shared/ops.ts';

const MEDIA_FILES: Record<string, string> = {
  'thumb.jpg': 'thumb.jpg',
  'strip.jpg': 'strip.jpg',
  'peaks.bin': 'peaks.bin',
  'envelope.bin': 'envelope.bin',
  'transcript.json': 'transcript.json',
  'faces.json': 'faces.json',
  'stability.json': 'stability.json',
  'tracks.json': 'tracks.json',
};

/** Media files in a folder, so a whole shoot can be added by pointing at it. */
function expandPath(p: string): string[] {
  const abs = path.resolve(p.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      return fs
        .readdirSync(abs)
        .filter((f) => !f.startsWith('.') && MEDIA_EXT.includes(extOf(f)))
        .sort()
        .map((f) => path.join(abs, f));
    }
  } catch {
    // reported by importMedia
  }
  return [abs];
}

/** Settings as shown to the browser: keys are never sent back, only whether one is set. */
const masked = (s: Settings): Settings => ({ ...s, tenorKey: s.tenorKey ? '•'.repeat(8) : '', freesoundKey: s.freesoundKey ? '•'.repeat(8) : '' });

export function registerRoutes(r: Router): void {
  r.get('/api/status', (c) => c.json(toolStatus()));

  r.get('/api/projects', (c) => c.json({ projects: listProjects() }));

  r.post('/api/projects', async (c) => {
    const body = await c.body<{ name?: string; aspect?: string }>();
    const p = createProject(body.name ?? 'Untitled project', body.aspect);
    c.json({ project: summarize(p) }, 201);
  });

  r.get('/api/projects/:pid', (c) => {
    const p = getProject(c.params.pid);
    resumePending(p);
    c.json({
      doc: p.doc,
      rev: p.rev,
      media: [...p.media.values()],
      chat: p.chat,
      snapshots: p.snapshots,
      history: p.history.slice(-200),
      pending: p.pending ?? null,
    });
  });

  // ---- the planner's state

  r.get('/api/studio', (c) => c.json(getStudio()));

  r.get('/api/recipes', (c) => c.json({ recipes: getRecipes() }));

  r.delete('/api/recipes/:id', (c) => {
    removeRecipe(c.params.id);
    c.json({ ok: true });
  });

  r.get('/api/settings', (c) => {
    const s = getSettings();
    // The key itself never goes back to the browser, only whether one is set.
    c.json({ settings: masked(s), exportDefault: EXPORT_DIR });
  });

  r.patch('/api/settings', async (c) => {
    const body = await c.body<Partial<Settings>>();
    const patch: Partial<Settings> = {};
    if (body.assistantModel && ['sonnet', 'opus', 'haiku'].includes(body.assistantModel)) patch.assistantModel = body.assistantModel;
    if (typeof body.exportDir === 'string') patch.exportDir = body.exportDir.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
    if (typeof body.tenorKey === 'string' && !/^•+$/.test(body.tenorKey)) patch.tenorKey = body.tenorKey.trim();
    if (typeof body.freesoundKey === 'string' && !/^•+$/.test(body.freesoundKey)) patch.freesoundKey = body.freesoundKey.trim();
    const s = saveSettings(patch);
    c.json({ settings: masked(s), exportDefault: EXPORT_DIR });
  });

  r.patch('/api/studio/profile', async (c) => {
    const body = await c.body<Partial<Profile>>();
    const patch: Partial<Profile> = {};
    for (const k of ['about', 'niche', 'audience', 'goals', 'capacity', 'tone', 'notes'] as const) if (typeof body[k] === 'string') patch[k] = body[k].slice(0, 2000);
    for (const k of ['platforms', 'pillars', 'languages'] as const) if (Array.isArray(body[k])) patch[k] = body[k].map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 12);
    if (typeof body.allowWeb === 'boolean') patch.allowWeb = body.allowWeb;
    c.json({ profile: saveProfile(patch) });
  });

  r.post('/api/studio/plan', async (c) => {
    const body = await c.body<Partial<PlanItem>>();
    const item = addPlanItem({
      title: String(body.title ?? 'Untitled').slice(0, 200),
      platform: String(body.platform ?? 'instagram'),
      format: (body.format ?? 'reel') as PlanItem['format'],
      date: String(body.date ?? ''),
      time: body.time ? String(body.time) : undefined,
      pillar: body.pillar ? String(body.pillar) : undefined,
      hook: String(body.hook ?? ''),
      storyline: String(body.storyline ?? ''),
      footage: Array.isArray(body.footage) ? body.footage.map(String) : [],
      caption: body.caption ? String(body.caption) : undefined,
      hashtags: Array.isArray(body.hashtags) ? body.hashtags.map(String) : undefined,
      status: (body.status ?? (body.date ? 'planned' : 'idea')) as PlanItem['status'],
      notes: body.notes ? String(body.notes) : undefined,
    });
    c.json({ item }, 201);
  });

  r.patch('/api/studio/plan/:id', async (c) => {
    const body = await c.body<Partial<PlanItem>>();
    delete body.id;
    delete body.createdAt;
    const item = updatePlanItem(c.params.id, body);
    if (!item) throw new HttpError(404, 'no such plan item');
    c.json({ item });
  });

  r.post('/api/studio/plan/:id/start', (c) => {
    const item = getStudio().plan.find((x) => x.id === c.params.id);
    if (!item) throw new HttpError(404, 'no such plan item');
    if (item.projectId) {
      try {
        getProject(item.projectId);
        c.json({ projectId: item.projectId });
        return;
      } catch {
        // the project was removed; make a new one
      }
    }
    const lib = getProject('library');
    const media = item.footage.map((id) => lib.media.get(id)).filter((m): m is NonNullable<typeof m> => !!m);
    if (!media.length) throw new HttpError(400, 'This plan item has no footage attached. Pick clips for it first.');
    const vertical = !(item.format === 'long' || (item.platform === 'youtube' && item.format !== 'short'));
    const p = createProject(item.title, vertical ? '9:16' : '16:9');
    layOut(p, media.map((m) => copyMedia(lib, m.id, p).id));
    const length = item.format === 'story' ? 'about 15 seconds' : item.format === 'reel' || item.format === 'short' ? 'under 60 seconds, tighter if the material allows' : 'as long as the material deserves';
    const request = [
      `Make a ${item.format} for ${item.platform} from these clips, ${length}.`,
      item.hook ? `Open on this hook, as on-screen text if it is not spoken: "${item.hook}".` : '',
      item.storyline ? `Storyline: ${item.storyline}` : '',
      'Cut the dead air and fillers, keep whole thoughts, add captions, punch in on the key lines, and add a sound effect where something lands.',
    ].filter(Boolean).join(' ');
    setPendingRequest(p, request);
    updatePlanItem(item.id, { projectId: p.id, status: item.status === 'idea' || item.status === 'planned' ? 'making' : item.status });
    c.json({ projectId: p.id }, 201);
  });

  r.delete('/api/studio/plan/:id', (c) => {
    if (!removePlanItem(c.params.id)) throw new HttpError(404, 'no such plan item');
    c.json({ ok: true });
  });

  r.delete('/api/studio/references/:id', (c) => {
    removeReference(c.params.id);
    c.json({ ok: true });
  });

  r.patch('/api/projects/:pid', async (c) => {
    const p = getProject(c.params.pid);
    const body = await c.body<{ name?: string }>();
    if (typeof body.name === 'string' && body.name.trim()) {
      commitDoc(p, { ...p.doc, name: body.name.trim().slice(0, 120) }, { source: 'op', label: 'Rename' });
    }
    c.json({ project: summarize(p) });
  });

  r.delete('/api/projects/:pid', (c) => {
    trashProject(c.params.pid);
    c.json({ ok: true });
  });

  // The browser sends its whole document after each edit. `baseRev` guards
  // against overwriting a change it has not seen yet (for example one the
  // assistant made in the meantime).
  r.put('/api/projects/:pid/doc', async (c) => {
    const p = getProject(c.params.pid);
    const body = await c.body<{ doc: ProjectDoc; baseRev: number; clientId?: string; label?: string }>();
    if (!body.doc || typeof body.doc !== 'object') throw new HttpError(400, 'missing document');
    if (body.baseRev !== p.rev) {
      c.json({ conflict: true, doc: p.doc, rev: p.rev }, 409);
      return;
    }
    const rev = commitDoc(p, body.doc, { source: 'client', clientId: body.clientId, label: body.label });
    c.json({ rev });
  });

  r.get('/api/projects/:pid/events', (c) => {
    const p = getProject(c.params.pid);
    const sse = openSse(c.req, c.res);
    const listener = (event: string, data: unknown) => sse.send(event, data);
    p.listeners.add(listener);
    c.req.on('close', () => p.listeners.delete(listener));
    sse.send('hello', { rev: p.rev });
  });

  // ---- snapshots (version history)

  r.post('/api/projects/:pid/snapshots', async (c) => {
    const p = getProject(c.params.pid);
    const body = await c.body<{ name?: string }>();
    c.json({ snapshot: createSnapshot(p, (body.name ?? '').trim().slice(0, 80) || `Version ${p.snapshots.filter((s) => !s.auto).length + 1}`) }, 201);
  });

  r.post('/api/projects/:pid/snapshots/:sid/restore', (c) => {
    const p = getProject(c.params.pid);
    const doc = readSnapshot(p, c.params.sid);
    createSnapshot(p, 'Before restore', true);
    const rev = commitDoc(p, { ...doc, name: p.doc.name }, { source: 'restore', label: 'Restore version' });
    c.json({ rev });
  });

  r.delete('/api/projects/:pid/snapshots/:sid', (c) => {
    deleteSnapshot(getProject(c.params.pid), c.params.sid);
    c.json({ ok: true });
  });

  // ---- media

  // A dropped file arrives as the raw request body and is stored inside the project.
  r.post('/api/projects/:pid/media/upload', async (c) => {
    const p = getProject(c.params.pid);
    const name = path.basename(c.query.get('name') ?? 'upload');
    const ext = extOf(name);
    if (!MEDIA_EXT.includes(ext)) throw new HttpError(400, `unsupported file type: .${ext || '?'}`);
    const id = uid('m');
    const dir = mediaDir(p, id);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `source.${ext}`);
    try {
      await pipeline(c.req, fs.createWriteStream(dest));
      const asset = await importMedia(p, dest, { name, managed: true, id });
      c.json({ media: asset }, 201);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  });

  // Files already on this Mac are used where they are, without copying.
  r.post('/api/projects/:pid/media/import', async (c) => {
    const p = getProject(c.params.pid);
    const body = await c.body<{ paths?: string[] }>();
    const paths = (body.paths ?? []).filter((x) => typeof x === 'string' && x.trim()).flatMap((x) => expandPath(x.trim()));
    if (!paths.length) throw new HttpError(400, 'no files given');
    const added = [];
    const errors: string[] = [];
    for (const file of paths) {
      try {
        added.push(await importMedia(p, file));
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    c.json({ media: added, errors }, added.length ? 201 : 400);
  });

  r.delete('/api/projects/:pid/media/:mid', (c) => {
    removeMedia(getProject(c.params.pid), c.params.mid);
    c.json({ ok: true });
  });

  /** Measure a video's camera motion for stabilising (once). */
  r.post('/api/projects/:pid/media/:mid/stabilize', (c) => {
    const p = getProject(c.params.pid);
    const m = p.media.get(c.params.mid);
    if (!m) throw new HttpError(404, 'no such media');
    void analyzeStability(p, m.id);
    c.json({ ok: true, state: p.media.get(m.id)?.stability ?? 'pending' });
  });

  /** Follow a box through a video from a moment on; the track is kept with the media. */
  r.post('/api/projects/:pid/media/:mid/track', async (c) => {
    const p = getProject(c.params.pid);
    const m = p.media.get(c.params.mid);
    if (!m) throw new HttpError(404, 'no such media');
    const b = await c.body<{ t?: number; cx?: number; cy?: number; w?: number; h?: number; name?: string; maxSeconds?: number }>();
    const n = (v: unknown, name: string) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new HttpError(400, `${name} must be a number`);
      return v;
    };
    try {
      c.json(await trackObject(p, m.id, { t: n(b.t, 't'), cx: n(b.cx, 'cx'), cy: n(b.cy, 'cy'), w: n(b.w, 'w'), h: n(b.h, 'h'), name: b.name, maxSeconds: b.maxSeconds }), 201);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  r.delete('/api/projects/:pid/media/:mid/track/:tid', (c) => {
    const p = getProject(c.params.pid);
    if (!p.media.get(c.params.mid)) throw new HttpError(404, 'no such media');
    removeObjectTrack(p, c.params.mid, c.params.tid);
    c.json({ ok: true });
  });

  r.post('/api/projects/:pid/media/:mid/retranscribe', (c) => {
    retranscribe(getProject(c.params.pid), c.params.mid);
    c.json({ ok: true });
  });

  r.get('/api/projects/:pid/media/:mid/:file', (c) => {
    const p = getProject(c.params.pid);
    const a = p.media.get(c.params.mid);
    if (!a) throw new HttpError(404, 'media not found');
    const { file } = c.params;
    // Derived files are immutable for a given `?r=` revision, so they can be cached hard.
    const cache = c.query.has('r') ? 'private, max-age=31536000, immutable' : 'no-cache';
    if (file === 'proxy') {
      const proxy = proxyFile(p, a);
      // Until the proxy exists, formats the browser can play anyway are served as they are.
      sendFile(c.req, c.res, fs.existsSync(proxy) ? proxy : a.path, { cache: fs.existsSync(proxy) ? cache : 'no-cache' });
      return;
    }
    const mapped = MEDIA_FILES[file];
    if (!mapped) throw new HttpError(404, 'unknown file');
    sendFile(c.req, c.res, path.join(mediaDir(p, a.id), mapped), { cache });
  });

  // ---- native file dialog

  r.post('/api/pick-files', async (c) => {
    const script = [
      'tell me to activate',
      'set chosen to choose file with prompt "Add media to Local Studio" with multiple selections allowed',
      'set out to ""',
      'repeat with f in chosen',
      'set out to out & POSIX path of f & linefeed',
      'end repeat',
      'return out',
    ];
    try {
      const res = await run('/usr/bin/osascript', script.flatMap((line) => ['-e', line]));
      c.json({ paths: res.stdout.split('\n').map((s) => s.trim()).filter(Boolean) });
    } catch (err) {
      // Closing the dialog is not an error.
      if (/User canceled|-128/.test((err as Error).message)) c.json({ paths: [], cancelled: true });
      else throw new HttpError(500, 'could not open the file dialog');
    }
  });

  r.post('/api/reveal', async (c) => {
    const body = await c.body<{ path?: string }>();
    if (!body.path || !fs.existsSync(body.path)) throw new HttpError(404, 'file not found');
    await run('/usr/bin/open', ['-R', body.path]);
    c.json({ ok: true });
  });
}
