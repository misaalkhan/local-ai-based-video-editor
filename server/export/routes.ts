import fs from 'node:fs';
import type { Router } from '../http.ts';
import { sendFile } from '../http.ts';
import { HttpError, getProject } from '../store.ts';
import { cancelExport, exportFolder, getJob, startExport, uniquePath } from './render.ts';
import { renderStill } from './still.ts';
import type { ExportOptions } from './render.ts';

export function register(r: Router): void {
  /** The frame at a moment, saved as a picture in the export folder (a cover, a thumbnail, a poster). */
  r.post('/api/projects/:pid/cover', async (c) => {
    const p = getProject(c.params.pid);
    const body = await c.body<{ t?: number; width?: number }>();
    const t = Number(body.t);
    if (!Number.isFinite(t)) throw new HttpError(400, 't must be a number');
    const width = Math.max(240, Math.min(4320, Number(body.width) || p.doc.settings.width));
    const still = await renderStill(p, p.doc, t, { width });
    const dest = uniquePath(exportFolder(), `${p.doc.name} cover`, 'png');
    fs.writeFileSync(dest, still.toBuffer('image/png'));
    c.json({ path: dest, width: still.width, height: still.height }, 201);
  });

  r.post('/api/projects/:pid/export', async (c) => {
    const p = getProject(c.params.pid);
    const body = await c.body<ExportOptions>();
    try {
      c.json({ job: startExport(p, body) }, 202);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  r.post('/api/projects/:pid/export/:jid/cancel', (c) => {
    cancelExport(c.params.jid);
    c.json({ ok: true });
  });

  r.get('/api/projects/:pid/export/:jid', (c) => {
    const job = getJob(c.params.jid);
    if (!job || job.projectId !== c.params.pid) throw new HttpError(404, 'no such export');
    c.json({ job });
  });

  r.get('/api/projects/:pid/export/:jid/file', (c) => {
    const job = getJob(c.params.jid);
    if (!job || job.projectId !== c.params.pid || !job.path || !fs.existsSync(job.path)) throw new HttpError(404, 'the exported file is not available');
    sendFile(c.req, c.res, job.path);
  });
}
