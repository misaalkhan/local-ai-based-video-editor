import fs from 'node:fs';
import type { Router } from '../http.ts';
import { sendFile } from '../http.ts';
import { HttpError, getProject } from '../store.ts';
import { cancelExport, getJob, startExport } from './render.ts';
import type { ExportOptions } from './render.ts';

export function register(r: Router): void {
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
