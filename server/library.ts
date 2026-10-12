// Reusable assets outside any one project: the built-in sound effects, plus
// whatever the user drops into the `library` folder (sfx, music, broll).

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.ts';
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT, extOf } from './probe.ts';

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
  for (const d of ['sfx', 'music', 'broll']) fs.mkdirSync(path.join(LIBRARY_DIR, d), { recursive: true });
}
