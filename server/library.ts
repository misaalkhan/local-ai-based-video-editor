// Reusable assets outside any one project: the built-in sound effects, plus
// whatever the user drops into the `library` folder (sfx, music, broll).

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT, extOf } from './probe.ts';
import { parseCube } from '../shared/color.ts';
import type { Lut3D } from '../shared/color.ts';

export const LIBRARY_DIR = process.env.STUDIO_LIBRARY ?? path.join(ROOT, 'library');
const BUILTIN_SFX = path.join(ROOT, 'assets', 'sfx');

export type SfxRole = 'ui' | 'whoosh' | 'impact' | 'riser' | 'tone';

export interface SfxEntry {
  id: string;
  name: string;
  tags: string[];
  role: SfxRole;
  file: string;
  duration: number;
  /** Seconds into the file at which the sound "lands"; that moment is what gets aligned to the picture. */
  hit: number;
  source: 'built-in' | 'pack' | 'yours';
  /** Which pack a downloaded sound belongs to. */
  set?: 'comedy' | 'social';
  /** Where a saved sound came from, for the credit line when its licence asks for one. */
  credit?: { author: string; licence: string; url: string };
  favourite?: boolean;
}

/** Sounds the user saved or dropped in: `library/sfx/mine/` with a manifest carrying their measured timing and credits. */
interface MineEntry {
  id: string;
  name: string;
  tags: string[];
  role: SfxRole;
  file: string;
  duration: number;
  hit: number;
  credit?: SfxEntry['credit'];
}

const MINE_DIR = () => path.join(LIBRARY_DIR, 'sfx', 'mine');
const MINE_FILE = () => path.join(MINE_DIR(), 'mine.json');
const FAVOURITES_FILE = () => path.join(LIBRARY_DIR, 'sfx', 'favourites.json');

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function favouriteSfx(): Set<string> {
  return new Set(readJson<string[]>(FAVOURITES_FILE(), []));
}

export function setFavouriteSfx(id: string, on: boolean): void {
  const set = favouriteSfx();
  if (on) set.add(id);
  else set.delete(id);
  fs.mkdirSync(path.join(LIBRARY_DIR, 'sfx'), { recursive: true });
  fs.writeFileSync(FAVOURITES_FILE(), JSON.stringify([...set], null, 1));
}

/** Where a sound lands: its loudest 10 ms, unless it is a long bed, which starts at the cue. */
export async function measureSfx(file: string, role: SfxRole): Promise<{ duration: number; hit: number }> {
  const { analyzePcm, decodePcm } = await import('./analyze.ts');
  const { ENVELOPE_HOP } = await import('../shared/silence.ts');
  const a = analyzePcm(await decodePcm(file));
  let hit = 0;
  let best = -1;
  a.envelope.forEach((v, i) => {
    if (v > best) {
      best = v;
      hit = i * ENVELOPE_HOP;
    }
  });
  if (a.duration > 4 && role !== 'impact') hit = 0;
  return { duration: Math.round(a.duration * 100) / 100, hit: Math.round(hit * 1000) / 1000 };
}

/** Add a sound file (already on disk inside mine/) to the user's manifest, measuring its timing. */
export async function addMineSfx(file: string, name: string, extra: { tags?: string[]; credit?: SfxEntry['credit'] } = {}): Promise<SfxEntry> {
  const words = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const tags = [...new Set([...words, ...(extra.tags ?? [])])];
  const role = guessRole(tags);
  const { duration, hit } = await measureSfx(file, role);
  const base = path.basename(file);
  const id = `mine-${base.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-')}`;
  const list = readJson<MineEntry[]>(MINE_FILE(), []).filter((m) => m.id !== id);
  const entry: MineEntry = { id, name, tags, role, file: base, duration, hit, credit: extra.credit };
  list.push(entry);
  fs.writeFileSync(MINE_FILE(), JSON.stringify(list, null, 1));
  return { ...entry, file, source: 'yours' };
}

export function removeMineSfx(id: string): boolean {
  const list = readJson<MineEntry[]>(MINE_FILE(), []);
  const entry = list.find((m) => m.id === id);
  if (!entry) return false;
  fs.rmSync(path.join(MINE_DIR(), entry.file), { force: true });
  fs.writeFileSync(MINE_FILE(), JSON.stringify(list.filter((m) => m.id !== id), null, 1));
  setFavouriteSfx(id, false);
  return true;
}

/** A free file name inside mine/ for a new sound. */
export function mineSfxPath(name: string, ext: string): string {
  fs.mkdirSync(MINE_DIR(), { recursive: true });
  const base = name.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sound';
  let file = path.join(MINE_DIR(), `${base}.${ext}`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(MINE_DIR(), `${base}-${n}.${ext}`);
  return file;
}

const SYNONYMS: Record<string, string[]> = {
  whoosh: ['swoosh', 'woosh', 'swish', 'transition', 'swipe', 'pass', 'slide'],
  pop: ['bubble', 'plop', 'blop', 'appear', 'popup'],
  ding: ['bell', 'ping', 'correct'],
  chime: ['success', 'win', 'tada', 'reveal'],
  impact: ['boom', 'hit', 'thud', 'slam', 'punch', 'bass', 'stomp'],
  riser: ['build', 'buildup', 'rise', 'tension', 'suspense'],
  click: ['tap', 'button', 'select'],
  notification: ['alert', 'message', 'comment', 'phone'],
  shutter: ['camera', 'photo', 'snap', 'screenshot'],
  typing: ['keyboard', 'type', 'keys'],
  error: ['wrong', 'fail', 'buzz', 'mistake'],
  sparkle: ['magic', 'shimmer', 'shine', 'glitter'],
  drop: ['fall', 'down'],
};

function guessRole(words: string[]): SfxRole {
  const has = (...xs: string[]) => xs.some((x) => words.includes(x));
  if (has('whoosh', 'swoosh', 'swish', 'woosh', 'transition', 'swipe')) return 'whoosh';
  if (has('impact', 'boom', 'hit', 'thud', 'slam', 'punch', 'bass')) return 'impact';
  if (has('riser', 'rise', 'build', 'buildup', 'tension')) return 'riser';
  if (has('ding', 'bell', 'chime', 'notification', 'alert')) return 'tone';
  return 'ui';
}

function listDir(dir: string, exts: string[]): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => !f.startsWith('.') && exts.includes(extOf(f)))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function listSfx(): SfxEntry[] {
  const out: SfxEntry[] = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(BUILTIN_SFX, 'index.json'), 'utf8')) as (Omit<SfxEntry, 'file' | 'source'> & { file: string })[];
    for (const m of manifest) {
      const file = path.join(BUILTIN_SFX, m.file);
      if (fs.existsSync(file)) out.push({ ...m, file, source: 'built-in' });
    }
  } catch {
    // no built-in set yet (run: node scripts/make-sfx.ts)
  }
  // The downloaded comedy pack carries its own tags and landing points (see scripts/sounds.ts).
  const packed = new Set<string>();
  try {
    const pack = JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, 'sfx', 'pack.json'), 'utf8')) as (Omit<SfxEntry, 'file' | 'source'> & { file: string })[];
    for (const m of pack) {
      const file = path.join(LIBRARY_DIR, 'sfx', m.file);
      if (!fs.existsSync(file)) continue;
      packed.add(file);
      out.push({ ...m, file, source: 'pack' });
    }
  } catch {
    // no pack yet (run: node scripts/sounds.ts)
  }
  // Sounds saved from the app or dropped onto the Sounds tab, with measured timing.
  for (const m of readJson<MineEntry[]>(MINE_FILE(), [])) {
    const file = path.join(MINE_DIR(), m.file);
    if (!fs.existsSync(file)) continue;
    packed.add(file);
    out.push({ ...m, file, source: 'yours' });
  }
  for (const file of listDir(path.join(LIBRARY_DIR, 'sfx'), AUDIO_EXT)) {
    if (packed.has(file)) continue;
    const base = path.basename(file, path.extname(file));
    const words = base.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    out.push({
      id: `user-${base.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: base.replace(/[_-]+/g, ' '),
      tags: words,
      role: guessRole(words),
      file,
      duration: 0,
      hit: 0,
      source: 'yours',
    });
  }
  const fav = favouriteSfx();
  for (const e of out) if (fav.has(e.id)) e.favourite = true;
  return out;
}

/** Best matches for a description such as "soft pop" or "whoosh". */
export function searchSfx(query: string, limit = 5): SfxEntry[] {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!tokens.length) return listSfx().slice(0, limit);
  const scored = listSfx().map((s) => {
    const nameWords = s.name.toLowerCase().split(/[^a-z0-9]+/);
    let score = 0;
    for (const t of tokens) {
      if (s.id === t || nameWords.includes(t)) score += 3;
      else if (s.tags.includes(t)) score += 2;
      else if (Object.entries(SYNONYMS).some(([k, syn]) => (syn.includes(t) || k === t) && (s.tags.includes(k) || s.id.includes(k)))) score += 1.5;
      else if (s.tags.some((tag) => tag.includes(t) || t.includes(tag))) score += 0.5;
    }
    return { s, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

// ---------------------------------------------------------------------------
// LUTs: .cube files in library/luts, parsed once and kept.

const LUT_DIR = () => path.join(LIBRARY_DIR, 'luts');
const lutCache = new Map<string, Lut3D | null>();

export function listLuts(): { name: string; file: string }[] {
  return listDir(LUT_DIR(), ['cube']).map((f) => ({ name: path.basename(f, '.cube'), file: f }));
}

/** A LUT by name; null when there is no such file or it does not parse. */
export function readLut(name: string): Lut3D | null {
  const hit = lutCache.get(name);
  if (hit !== undefined) return hit;
  const file = path.join(LUT_DIR(), `${path.basename(name)}.cube`);
  let lut: Lut3D | null = null;
  try {
    lut = parseCube(fs.readFileSync(file, 'utf8'));
  } catch {
    lut = null;
  }
  lutCache.set(name, lut);
  return lut;
}

/** A free file path in the luts folder for a new .cube; clears the cache for that name. */
export function lutPath(name: string): { name: string; file: string } {
  fs.mkdirSync(LUT_DIR(), { recursive: true });
  const base = path.basename(name).replace(/\.cube$/i, '').replace(/[^A-Za-z0-9 _.-]+/g, '').trim() || 'lut';
  let n = base;
  let file = path.join(LUT_DIR(), `${n}.cube`);
  for (let i = 2; fs.existsSync(file); i++) {
    n = `${base} ${i}`;
    file = path.join(LUT_DIR(), `${n}.cube`);
  }
  lutCache.delete(n);
  return { name: n, file };
}

export function removeLut(name: string): boolean {
  const file = path.join(LUT_DIR(), `${path.basename(name)}.cube`);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  lutCache.delete(name);
  return true;
}

export interface LibraryFile {
  name: string;
  file: string;
  kind: 'music' | 'broll';
}

/** Music and b-roll the user keeps for reuse across projects. */
export function listLibrary(kind?: 'music' | 'broll'): LibraryFile[] {
  const out: LibraryFile[] = [];
  if (!kind || kind === 'music') for (const f of listDir(path.join(LIBRARY_DIR, 'music'), AUDIO_EXT)) out.push({ name: path.basename(f), file: f, kind: 'music' });
  if (!kind || kind === 'broll') for (const f of listDir(path.join(LIBRARY_DIR, 'broll'), [...VIDEO_EXT, ...IMAGE_EXT])) out.push({ name: path.basename(f), file: f, kind: 'broll' });
  return out;
}

export function ensureLibraryDirs(): void {
  for (const d of ['sfx', 'sfx/mine', 'music', 'broll', 'luts']) fs.mkdirSync(path.join(LIBRARY_DIR, d), { recursive: true });
}
