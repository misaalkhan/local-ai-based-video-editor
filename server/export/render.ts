// Runs an export from start to finish: mix the audio, composite and encode the
// picture, and move the finished file into the exports folder.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_DIR, FFMPEG } from '../config.ts';
import type { Project } from '../store.ts';
import { emit } from '../store.ts';
import type { ExportJob, ProjectDoc } from '../../shared/types.ts';
import { contentDuration, uid } from '../../shared/ops.ts';
import { Compositor } from './compose.ts';
import { loudnormFilter, measureLoudness, renderAudio } from './audio.ts';
import { getSettings } from '../studio.ts';

export interface ExportOptions {
  width?: number;
  height?: number;
  quality?: 'high' | 'standard' | 'small';
}

interface Running {
  job: ExportJob;
  controller: AbortController;
  /** Settles when the job has finished, however it ended. */
  done: Promise<ExportJob>;
}

/** Where a render goes: the user's export folder by default, or a fixed file (sequences baked into the project). */
export interface RenderTarget {
  doc?: ProjectDoc;
  dest?: string;
}

const jobs = new Map<string, Running>();

export function getJob(id: string): ExportJob | undefined {
  return jobs.get(id)?.job;
}

export function cancelExport(id: string): void {
  jobs.get(id)?.controller.abort();
}

const even = (v: number) => Math.max(16, Math.round(v / 2) * 2);

function uniquePath(dir: string, name: string): string {
  const safe = name.replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled';
  let file = path.join(dir, `${safe}.mp4`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${safe} ${i}.mp4`);
  return file;
}

function writeFrame(stream: NodeJS.WritableStream, frame: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    stream.once('error', onError);
    const done = () => {
      stream.removeListener('error', onError);
      resolve();
    };
    if (stream.write(frame)) done();
    else stream.once('drain', done);
  });
}

/** Resolves when an export job has finished (done, failed or cancelled). */
export function exportDone(id: string): Promise<ExportJob> | undefined {
  return jobs.get(id)?.done;
}

export function startExport(p: Project, opts: ExportOptions, target: RenderTarget = {}): ExportJob {
  for (const r of jobs.values()) {
    if (r.job.projectId === p.id && r.job.status === 'running') throw new Error('An export is already running for this project.');
  }
  const doc: ProjectDoc = structuredClone(target.doc ?? p.doc);
  doc.settings.width = even(opts.width ?? doc.settings.width);
  doc.settings.height = even(opts.height ?? doc.settings.height);
  const duration = contentDuration(doc);
  if (duration <= 0) throw new Error('There is nothing on the timeline to export.');
  const job: ExportJob = {
    id: uid('x'),
    projectId: p.id,
    status: 'running',
    progress: 0,
    stage: 'Mixing audio',
    width: doc.settings.width,
    height: doc.settings.height,
    fps: doc.settings.fps,
    duration,
    startedAt: Date.now(),
  };
  const controller = new AbortController();
  let settle: (j: ExportJob) => void = () => {};
  const done = new Promise<ExportJob>((r) => (settle = r));
  jobs.set(job.id, { job, controller, done });
  let lastSent = 0;
  const update = (patch: Partial<ExportJob>, force = false) => {
    Object.assign(job, patch);
    const now = Date.now();
    if (force || now - lastSent > 200) {
      lastSent = now;
      emit(p, 'export', { ...job });
    }
  };
  void runExport(p, doc, job, opts.quality ?? 'high', controller.signal, update, target.dest)
    .then(
      () => update({ status: 'done', progress: 1, stage: 'Done', finishedAt: Date.now() }, true),
      (err: Error) => {
        if (controller.signal.aborted) update({ status: 'cancelled', stage: 'Cancelled', finishedAt: Date.now() }, true);
        else {
          console.error('[export] failed:', err);
          update({ status: 'error', stage: 'Failed', error: err.message.split('\n').slice(-2).join(' '), finishedAt: Date.now() }, true);
        }
      },
    )
    .finally(() => settle(job));
  return job;
}

async function runExport(
  p: Project,
  doc: ProjectDoc,
  job: ExportJob,
  quality: 'high' | 'standard' | 'small',
  signal: AbortSignal,
  update: (patch: Partial<ExportJob>, force?: boolean) => void,
  fixedDest?: string,
): Promise<void> {
  const work = path.join(p.dir, 'tmp', job.id);
  fs.mkdirSync(work, { recursive: true });
  const wav = path.join(work, 'mix.wav');
  const tmpOut = path.join(work, 'out.mp4');
  const comp = new Compositor(p, doc, { signal });
  try {
    update({ stage: 'Mixing audio', progress: 0.01 }, true);
    await renderAudio(p, doc, wav, signal);
    const master = doc.settings.audio;
    const loud = master.normalize && (job.duration ?? 0) >= 3 ? await measureLoudness(wav, master.targetLufs, signal) : null;
    // Do not "normalise" silence up into audible hiss.
    const audioFilter = loud && loud.i > -50 ? loudnormFilter(loud, master.targetLufs) : null;

    update({ stage: 'Rendering video', progress: 0.06 }, true);
    const { width: W, height: H, fps } = doc.settings;
    const crf = quality === 'high' ? 17 : quality === 'standard' ? 21 : 26;
    const args = [
      '-v', 'error', '-nostdin', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(fps), '-i', 'pipe:0',
      '-i', wav,
      '-map', '0:v', '-map', '1:a',
      // Convert to the colour space every player expects, and say so in the file.
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-c:v', 'libx264', '-preset', quality === 'small' ? 'slow' : 'medium', '-crf', String(crf),
      '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      ...(audioFilter ? ['-af', audioFilter] : []),
      '-c:a', 'aac', '-b:a', quality === 'small' ? '128k' : '192k', '-ar', '48000',
      '-movflags', '+faststart', '-shortest', tmpOut,
    ];
    const enc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let encErr = '';
    enc.stderr.on('data', (c: Buffer) => {
      if (encErr.length < 6000) encErr += c.toString();
    });
    const finished = new Promise<void>((resolve, reject) => {
      enc.on('error', reject);
      enc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`encoder exited with code ${code}: ${encErr.trim().split('\n').pop() ?? ''}`))));
    });
    const onAbort = () => enc.kill('SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const started = Date.now();
      for (let j = 0; j < comp.totalFrames; j++) {
        const frame = await comp.frame(j);
        await writeFrame(enc.stdin, frame);
        if (j % 5 === 0) update({ progress: 0.06 + 0.9 * (j / comp.totalFrames) });
      }
      enc.stdin.end();
      update({ stage: 'Finishing', progress: 0.97 }, true);
      await finished;
      const secs = (Date.now() - started) / 1000;
      console.log(`[export] ${comp.totalFrames} frames in ${secs.toFixed(1)}s (${(comp.totalFrames / secs).toFixed(1)} fps)`);
    } catch (err) {
      enc.kill('SIGKILL');
      await finished.catch(() => {});
      throw err;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) throw new Error('aborted');
    const dir = fixedDest ? path.dirname(fixedDest) : getSettings().exportDir.trim() || EXPORT_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const dest = fixedDest ?? uniquePath(dir, p.doc.name);
    try {
      fs.renameSync(tmpOut, dest);
    } catch {
      // Different volume: copy instead.
      fs.copyFileSync(tmpOut, dest);
    }
    job.path = dest;
    job.size = fs.statSync(dest).size;
  } finally {
    comp.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}
