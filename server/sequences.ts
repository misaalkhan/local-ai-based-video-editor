// Nested sequences (compound clips): a group of clips rendered into a video
// of its own with the same exporter, then placed on the main track where the
// group was. The render is kept with the project; the user's own files are
// never touched.

import fs from 'node:fs';
import path from 'node:path';
import { exportDone, startExport } from './export/render.ts';
import { importMedia, removeMedia } from './media.ts';
import type { Project } from './store.ts';
import { commitDoc } from './store.ts';
import { placeSequenceMedia } from '../shared/ops.ts';
import type { ID, MediaAsset, ProjectDoc } from '../shared/types.ts';

/** Render a sequence and put the result in place of its stand-in. Resolves with the new media. */
export async function bakeSequence(p: Project, sequenceId: ID): Promise<MediaAsset> {
  const seq = p.doc.sequences?.find((s) => s.id === sequenceId);
  if (!seq) throw new Error('No such sequence.');
  if (!seq.main.length) throw new Error('The sequence is empty.');
  const doc: ProjectDoc = { ...p.doc, name: seq.name, main: seq.main, overlays: seq.overlays, audio: seq.audio, graphics: seq.graphics, zooms: seq.zooms };
  delete doc.sequences;
  delete doc.markers;
  const dir = path.join(p.dir, 'sequences');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${seq.id}-r${seq.rev}.mp4`);
  const job = startExport(p, { quality: 'high' }, { doc, dest });
  const finished = await exportDone(job.id);
  if (!finished || finished.status !== 'done') throw new Error(finished?.error || 'The sequence could not be rendered.');
  const previous = p.doc.sequences?.find((s) => s.id === sequenceId)?.mediaId;
  const media = await importMedia(p, dest, { name: seq.name, managed: true, origin: 'sequence' });
  commitDoc(p, placeSequenceMedia(p.doc, sequenceId, media), { source: 'op', label: `Rendered ${seq.name}` });
  if (previous && previous !== media.id) removeMedia(p, previous);
  return media;
}
