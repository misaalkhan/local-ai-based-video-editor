// Meme templates: the popular formats listed by Imgflip's public endpoint,
// fetched on request and cached for a day. The app bundles none of the
// pictures; they stay with their makers and are pulled in only when a user
// picks one.

import fs from 'node:fs';
import path from 'node:path';
import { importMedia } from './media.ts';
import type { Project } from './store.ts';
import type { MediaAsset } from '../shared/types.ts';

export interface MemeTemplate {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  /** How many text boxes the format usually has. */
  boxes: number;
}

const API = process.env.STUDIO_IMGFLIP_URL ?? 'https://api.imgflip.com';
let cache: { at: number; list: MemeTemplate[] } | null = null;

export async function memeTemplates(): Promise<MemeTemplate[]> {
  if (cache && Date.now() - cache.at < 24 * 3600 * 1000) return cache.list;
  const res = await fetch(`${API}/get_memes`);
  if (!res.ok) throw new Error(`Imgflip answered ${res.status}.`);
  const data = (await res.json()) as { success?: boolean; data?: { memes?: { id: string; name: string; url: string; width: number; height: number; box_count?: number }[] } };
  const list = (data.data?.memes ?? []).map((m) => ({ id: m.id, name: m.name, url: m.url, width: m.width, height: m.height, boxes: m.box_count ?? 2 }));
  if (!list.length) throw new Error('Imgflip returned no templates.');
  cache = { at: Date.now(), list };
  return list;
}

export function findTemplate(list: MemeTemplate[], query: string): MemeTemplate[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const words = q.split(/\s+/);
  return list.filter((m) => words.every((w) => m.name.toLowerCase().includes(w)));
}

/** Download a template picture into the project (once) and add it to the project's media. */
export async function fetchMeme(p: Project, t: MemeTemplate): Promise<MediaAsset> {
  const dir = path.join(p.dir, 'memes');
  fs.mkdirSync(dir, { recursive: true });
  const ext = (/\.(png|jpe?g|gif|webp)$/i.exec(t.url)?.[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
  const file = path.join(dir, `${t.id.replace(/[^a-z0-9]/gi, '')}.${ext}`);
  if (!fs.existsSync(file)) {
    const res = await fetch(t.url);
    if (!res.ok) throw new Error(`Could not download the template (${res.status}).`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return importMedia(p, file, { name: `Meme: ${t.name}`, managed: true, origin: 'meme' });
}
