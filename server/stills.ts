// Freeze frames: one frame of a video, saved as a picture in the project and
// added to its media so it can sit on the main track like any photo.

import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG } from './config.ts';
import { decodeSpec, importMedia } from './media.ts';
import { run } from './proc.ts';
import type { Project } from './store.ts';
import type { MediaAsset } from '../shared/types.ts';

/** Save the frame of `media` at `time` (seconds into the file) and return it as a media asset. */
export async function extractStill(p: Project, media: MediaAsset, time: number): Promise<MediaAsset> {
  if (media.kind !== 'video') throw new Error('Only video has frames to freeze.');
  const dir = path.join(p.dir, 'stills');
  fs.mkdirSync(dir, { recursive: true });
  const t = Math.max(0, Math.min(time, Math.max(0, media.duration - 0.04)));
  const file = path.join(dir, `${media.id}-${Math.round(t * 1000)}.png`);
  if (!fs.existsSync(file)) {
    const spec = decodeSpec(media, false);
    const tmp = file.replace(/\.png$/, '.tmp.png');
    await run(FFMPEG, ['-v', 'error', '-nostdin', '-y', ...spec.input, '-ss', t.toFixed(3), '-i', media.path, '-frames:v', '1', '-update', '1', '-vf', `${spec.prefix}format=rgb24`, tmp]);
    fs.renameSync(tmp, file);
  }
  const still = await importMedia(p, file, { name: `${media.name} at ${t.toFixed(2)}s`, managed: true, origin: 'still' });
  await proxyReady(p, still.id);
  return p.media.get(still.id) ?? still;
}

/** Wait (briefly) for a picture's preview copy, which the player and exporter read. */
async function proxyReady(p: Project, id: string, timeoutMs = 15000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const m = p.media.get(id);
    if (!m || m.proxy === 'done' || m.proxy === 'error' || m.proxy === 'skipped') return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
