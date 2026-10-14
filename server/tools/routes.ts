import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Router } from '../http.ts';
import { sendFile } from '../http.ts';
import { HttpError, getProject } from '../store.ts';
import { addMineSfx, ensureLibraryDirs, listLuts, listSfx, lutPath, mineSfxPath, readLut, removeLut, removeMineSfx, setFavouriteSfx } from '../library.ts';
import { listVoices } from '../tts.ts';
import { ToolError, callTool } from './index.ts';
import { searchGifs } from '../gifs.ts';
import { STOCK_SOURCES, addStock, availableSources, searchStock, stockItem } from '../stock.ts';
import type { StockKind, StockSource } from '../stock.ts';
import { createProject, summarize } from '../store.ts';
import { layOut } from '../studio.ts';
import { saveSound, searchSounds, soundCredit } from '../sounds.ts';
import type { FoundSound } from '../sounds.ts';
import { fetchMeme, findTemplate, memeTemplates } from '../memes.ts';
import { extractStill } from '../stills.ts';
import { bakeSequence } from '../sequences.ts';
import { AUDIO_EXT, extOf } from '../probe.ts';

export function register(r: Router): void {
  ensureLibraryDirs();

  // Buttons in the app run the same tools the assistant uses.
  r.post('/api/projects/:pid/ops', async (c) => {
    const p = getProject(c.params.pid);
    const body = await c.body<{ tool?: string; args?: Record<string, unknown> }>();
    try {
      const result = await callTool({ p, by: 'user' }, String(body.tool ?? ''), body.args);
      c.json({ text: result.text, rev: p.rev, images: (result.images ?? []).map((i) => ({ mime: i.mime, data: i.data.toString('base64') })) });
    } catch (err) {
      if (err instanceof ToolError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  const sfxJson = (s: ReturnType<typeof listSfx>[number]) => ({
    id: s.id,
    name: s.name,
    tags: s.tags,
    role: s.role,
    duration: s.duration,
    source: s.source,
    set: s.set,
    favourite: !!s.favourite,
    credit: soundCredit(s),
    url: `/api/library/sfx/${encodeURIComponent(s.id)}/file`,
  });
  r.get('/api/library/sfx', (c) => {
    c.json({ sfx: listSfx().map(sfxJson) });
  });

  // A sound file dropped onto the Sounds tab goes into the user's own set, timed like the packs.
  r.post('/api/library/sfx/upload', async (c) => {
    const name = path.basename(c.query.get('name') ?? 'sound');
    const ext = extOf(name);
    if (!AUDIO_EXT.includes(ext)) throw new HttpError(400, `not an audio file: .${ext || '?'}`);
    const file = mineSfxPath(name, ext);
    try {
      await pipeline(c.req, fs.createWriteStream(file));
      const entry = await addMineSfx(file, name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' '));
      c.json({ sound: sfxJson(entry) }, 201);
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
  });

  r.put('/api/library/sfx/:id/favourite', async (c) => {
    const body = await c.body<{ on?: boolean }>();
    setFavouriteSfx(c.params.id, !!body.on);
    c.json({ ok: true });
  });

  r.delete('/api/library/sfx/:id', (c) => {
    if (!removeMineSfx(c.params.id)) throw new HttpError(400, 'Only sounds you added can be removed.');
    c.json({ ok: true });
  });

  // More sounds from Freesound (key in Settings); a pick is saved into the user's set with its credit.
  r.get('/api/sounds/search', async (c) => {
    try {
      c.json({ sounds: await searchSounds(String(c.query.get('q') ?? ''), 24) });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });
  r.post('/api/library/sfx/save', async (c) => {
    const body = await c.body<FoundSound>();
    if (!body || typeof body.preview !== 'string' || !/^https:\/\/(cdn\.)?freesound\.org\//.test(body.preview)) throw new HttpError(400, 'not a Freesound preview');
    try {
      c.json({ sound: sfxJson(await saveSound(body)) }, 201);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  // Colour LUTs: .cube files in the library, dropped in from the Effects tab.
  r.get('/api/library/luts', (c) => c.json({ luts: listLuts().map((l) => ({ name: l.name })) }));
  r.get('/api/library/luts/:name/file', (c) => {
    const l = listLuts().find((x) => x.name === c.params.name);
    if (!l) throw new HttpError(404, 'no such LUT');
    sendFile(c.req, c.res, l.file, { cache: 'public, max-age=3600' });
  });
  r.post('/api/library/luts/upload', async (c) => {
    const given = path.basename(c.query.get('name') ?? 'lut.cube');
    if (!/\.cube$/i.test(given)) throw new HttpError(400, 'a LUT is a .cube file');
    const { name, file } = lutPath(given);
    await pipeline(c.req, fs.createWriteStream(file));
    if (!readLut(name)) {
      fs.rmSync(file, { force: true });
      throw new HttpError(400, 'that file is not a 3D .cube LUT');
    }
    c.json({ lut: { name } }, 201);
  });
  r.delete('/api/library/luts/:name', (c) => {
    if (!removeLut(c.params.name)) throw new HttpError(404, 'no such LUT');
    c.json({ ok: true });
  });

  // Meme templates (Imgflip's public list) and putting one into a project.
  r.get('/api/memes/templates', async (c) => {
    try {
      c.json({ templates: findTemplate(await memeTemplates(), String(c.query.get('q') ?? '')) });
    } catch (err) {
      throw new HttpError(502, (err as Error).message);
    }
  });
  r.post('/api/projects/:pid/memes', async (c) => {
    const p = getProject(c.params.pid);
    const body = await c.body<{ id?: string }>();
    const t = (await memeTemplates()).find((m) => m.id === String(body.id ?? ''));
    if (!t) throw new HttpError(404, 'no such template');
    try {
      c.json({ media: await fetchMeme(p, t), template: t }, 201);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  /** Render a nested sequence into its own clip (again, after changes). */
  r.post('/api/projects/:pid/sequences/:sid/bake', async (c) => {
    const p = getProject(c.params.pid);
    try {
      c.json({ media: await bakeSequence(p, c.params.sid) }, 201);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  /** A frame of a video clip saved as a picture, for freeze frames. */
  r.post('/api/projects/:pid/stills', async (c) => {
    const p = getProject(c.params.pid);
    const body = await c.body<{ mediaId?: string; time?: number }>();
    const m = p.media.get(String(body.mediaId ?? ''));
    if (!m) throw new HttpError(404, 'no such media');
    const time = Number(body.time);
    if (!Number.isFinite(time)) throw new HttpError(400, 'time must be a number');
    try {
      c.json(await extractStill(p, m, time), 201);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  r.get('/api/library/sfx/:id/file', (c) => {
    const s = listSfx().find((x) => x.id === c.params.id);
    if (!s) throw new HttpError(404, 'no such sound');
    sendFile(c.req, c.res, s.file, { cache: 'public, max-age=3600' });
  });

  r.get('/api/library/voices', async (c) => c.json({ voices: await listVoices() }));

  // The Overlays panel's GIF search; a pick then goes through the add_gif tool like the assistant's.
  r.get('/api/gifs', async (c) => {
    const q = String(c.query.get('q') ?? '');
    try {
      c.json({ gifs: await searchGifs(q, 18) });
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  // Public footage and pictures: the Find footage dialog on the home screen and the Media tab.
  r.get('/api/stock/sources', (c) => {
    const open = availableSources();
    c.json({ sources: STOCK_SOURCES.map((s) => ({ ...s, available: open.includes(s.id) })) });
  });

  r.get('/api/stock/search', async (c) => {
    const q = String(c.query.get('q') ?? '');
    const kind = (['video', 'image', 'any'].includes(String(c.query.get('kind'))) ? String(c.query.get('kind')) : 'any') as StockKind | 'any';
    const sources = String(c.query.get('sources') ?? '')
      .split(',')
      .filter((x): x is StockSource => STOCK_SOURCES.some((s) => s.id === x));
    const limit = Number(c.query.get('limit') ?? 24);
    c.json(await searchStock({ q, kind, sources: sources.length ? sources : undefined, limit: Number.isFinite(limit) ? limit : 24 }));
  });

  // Download one found item into a project and prepare it like an upload.
  r.post('/api/projects/:pid/stock', async (c) => {
    const p = getProject(c.params.pid);
    const body = await c.body<{ id?: string }>();
    const item = body.id ? stockItem(body.id) : undefined;
    if (!item) throw new HttpError(400, 'search first, then pick an item from the results');
    try {
      c.json({ media: await addStock(p, item) }, 201);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  // A new project from found items, laid out on the main track in the order picked.
  r.post('/api/stock/project', async (c) => {
    const body = await c.body<{ name?: string; aspect?: string; ids?: string[] }>();
    const items = (body.ids ?? []).map((id) => stockItem(id)).filter((x): x is NonNullable<typeof x> => !!x);
    if (!items.length) throw new HttpError(400, 'pick at least one item');
    const p = createProject((body.name ?? '').trim() || `Footage: ${items[0].title.slice(0, 40)}`, body.aspect);
    const errors: string[] = [];
    const added = [];
    for (const it of items) {
      try {
        added.push(await addStock(p, it));
      } catch (err) {
        errors.push(`${it.title}: ${(err as Error).message}`);
      }
    }
    layOut(p, added.map((m) => m.id));
    c.json({ project: summarize(p), added: added.length, errors }, 201);
  });
}
