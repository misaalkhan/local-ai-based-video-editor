import type { Router } from '../http.ts';
import { sendFile } from '../http.ts';
import { HttpError, getProject } from '../store.ts';
import { ensureLibraryDirs, listSfx } from '../library.ts';
import { listVoices } from '../tts.ts';
import { ToolError, callTool } from './index.ts';
import { searchGifs } from '../gifs.ts';

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

  r.get('/api/library/sfx', (c) => {
    c.json({ sfx: listSfx().map((s) => ({ id: s.id, name: s.name, tags: s.tags, duration: s.duration, url: `/api/library/sfx/${encodeURIComponent(s.id)}/file` })) });
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
}
