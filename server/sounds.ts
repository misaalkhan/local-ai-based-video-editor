// Finding more sounds: a text search on Freesound (needs a free API key, kept
// in Settings), limited to sounds whose licence allows use in a video: CC0,
// which needs nothing, and CC BY, which needs a credit line that is stored
// with the saved sound.

import fs from 'node:fs';
import { getSettings } from './studio.ts';
import { addMineSfx, mineSfxPath } from './library.ts';
import type { SfxEntry } from './library.ts';

export interface FoundSound {
  id: number;
  name: string;
  author: string;
  /** "CC0" or "CC BY". */
  licence: string;
  url: string;
  duration: number;
  preview: string;
  tags: string[];
}

const API = process.env.STUDIO_FREESOUND_URL ?? 'https://freesound.org/apiv2';

export function soundSearchAvailable(): boolean {
  return !!getSettings().freesoundKey;
}

interface FreesoundResult {
  id: number;
  name: string;
  username: string;
  license: string;
  duration: number;
  url: string;
  tags?: string[];
  previews?: Record<string, string>;
}

function licenceLabel(url: string): string {
  if (/publicdomain\/zero/.test(url)) return 'CC0';
  if (/licenses\/by\/\d/.test(url)) return 'CC BY';
  return url;
}

/** Search Freesound; throws with a message fit for the user when it cannot. */
export async function searchSounds(query: string, limit = 24): Promise<FoundSound[]> {
  const key = getSettings().freesoundKey;
  if (!key) throw new Error('Sound search is off: there is no Freesound API key in Settings (free at freesound.org; add it on the home screen under Settings).');
  const q = query.trim();
  if (!q) throw new Error('Say what the sound should be.');
  const params = new URLSearchParams({
    query: q,
    token: key,
    page_size: String(Math.max(1, Math.min(50, Math.round(limit)))),
    fields: 'id,name,username,license,duration,url,tags,previews',
    filter: 'license:("Creative Commons 0" OR "Attribution") duration:[0 TO 30]',
    sort: 'score',
  });
  const res = await fetch(`${API}/search/text/?${params}`);
  if (res.status === 401) throw new Error('Freesound rejected the key: check it in Settings.');
  if (!res.ok) throw new Error(`Freesound answered ${res.status}.`);
  const data = (await res.json()) as { results?: FreesoundResult[] };
  const out: FoundSound[] = [];
  for (const r of data.results ?? []) {
    const preview = r.previews?.['preview-hq-mp3'] ?? r.previews?.['preview-lq-mp3'];
    if (!preview) continue;
    out.push({ id: r.id, name: r.name, author: r.username, licence: licenceLabel(r.license), url: r.url, duration: Math.round(r.duration * 10) / 10, preview, tags: (r.tags ?? []).slice(0, 8) });
  }
  return out;
}

/** Download a found sound into the user's sounds, keeping who made it and under what licence. */
export async function saveSound(found: FoundSound): Promise<SfxEntry> {
  const res = await fetch(found.preview);
  if (!res.ok) throw new Error(`Could not download the sound (${res.status}).`);
  const name = found.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim() || `sound ${found.id}`;
  const file = mineSfxPath(name, 'mp3');
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return addMineSfx(file, name, { tags: found.tags, credit: { author: found.author, licence: found.licence, url: found.url } });
}

/** The line to put in a post's caption for a CC BY sound; empty for CC0 and the bundled packs. */
export function soundCredit(e: SfxEntry): string {
  if (!e.credit || e.credit.licence !== 'CC BY') return '';
  return `Sound: "${e.name}" by ${e.credit.author} (freesound.org), CC BY`;
}
