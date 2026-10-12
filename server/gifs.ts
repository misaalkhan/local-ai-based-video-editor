// Reaction GIFs from Tenor, for the assistant's find_gif/add_gif and the search
// box on the Overlays panel. Tenor needs an API key (free from Google), kept in
// Settings; without it the search says so instead of failing quietly.

import fs from 'node:fs';
import path from 'node:path';
import { getSettings } from './studio.ts';
import { importMedia } from './media.ts';
import type { Project } from './store.ts';
import type { MediaAsset } from '../shared/types.ts';

export interface Gif {
  id: string;
  /** Looping MP4, the form placed on the timeline. */
  url: string;
  /** Small GIF for a picture in the panel. */
  preview: string;
  description: string;
  dims: number[];
  duration: number;
}

/** GIFs found by the last search, by Tenor id, so a pick can refer to one. */
export const found = new Map<string, Gif>();

const TENOR = process.env.STUDIO_TENOR_URL ?? 'https://tenor.googleapis.com/v2';

export function gifSearchAvailable(): boolean {
  return !!getSettings().tenorKey;
}

interface TenorResult {
  id: string;
  content_description?: string;
  media_formats?: Record<string, { url: string; dims: number[]; duration: number }>;
}

/** Search Tenor; throws with a message fit for the user when it cannot. */
export async function searchGifs(query: string, limit = 12): Promise<Gif[]> {
  const key = getSettings().tenorKey;
  if (!key) throw new Error('GIF search is off: there is no Tenor API key in Settings (it is free from Google; add it on the home screen under Settings).');
  const q = query.trim();
  if (!q) throw new Error('Say what the GIF should show.');
  const n = Math.max(1, Math.min(24, Math.round(limit)));
  const url = `${TENOR}/search?q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}&client_key=local-studio&limit=${n}&media_filter=tinygif,mp4&contentfilter=medium`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tenor answered ${res.status}: check the key in Settings.`);
  const data = (await res.json()) as { results?: TenorResult[] };
  const gifs: Gif[] = [];
  for (const r of data.results ?? []) {
    const mp4 = r.media_formats?.mp4;
    if (!mp4?.url) continue;
    gifs.push({
      id: r.id,
      url: mp4.url,
      preview: r.media_formats?.tinygif?.url ?? mp4.url,
      description: r.content_description ?? '',
      dims: mp4.dims ?? [],
      duration: mp4.duration ?? 0,
    });
  }
  found.clear();
  for (const g of gifs) found.set(g.id, g);
  return gifs;
}

/** Download a GIF's MP4 into the project (once) and add it to the project's media. */
export async function fetchGif(p: Project, g: Gif): Promise<MediaAsset> {
  const dir = path.join(p.dir, 'gifs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${g.id.replace(/[^a-z0-9]/gi, '')}.mp4`);
  if (!fs.existsSync(file)) {
    const res = await fetch(g.url);
    if (!res.ok) throw new Error(`Could not download the GIF (${res.status}).`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const label = (g.description || g.id).length > 40 ? `${(g.description || g.id).slice(0, 39)}…` : g.description || g.id;
  return importMedia(p, file, { name: `GIF: ${label}`, managed: true, origin: 'gif' });
}
