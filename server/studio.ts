// The planner's state: the creator's profile, the content plan, notes on the
// platforms and reference posts. One set per installation, kept in
// data/studio. The footage library is a project with a fixed id, so every
// media tool works on it unchanged.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.ts';
import type { Project } from './store.ts';
import { commitDoc, getProject, mediaDir, nextTag, putMedia } from './store.ts';
import type { ID, MediaAsset, PlanItem, PlatformNote, Profile, Recipe, ReferenceCard, Settings, Studio } from '../shared/types.ts';
import { insertMain, makeClip, setSettings, uid } from '../shared/ops.ts';
import { getSecret, setSecret } from './secrets.ts';

export const LIBRARY_ID = 'library';
const DIR = path.join(DATA_DIR, 'studio');

const EMPTY_PROFILE: Profile = { about: '', niche: '', audience: '', platforms: ['instagram'], goals: '', capacity: '', tone: '', pillars: [], notes: '', languages: [], allowWeb: false, updatedAt: 0 };

function read<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function write(name: string, value: unknown): void {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, name);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

const EMPTY_SETTINGS: Settings = { assistantModel: 'sonnet', exportDir: '', tenorKey: '', freesoundKey: '', updatedAt: 0 };

/** The keys that live in the Keychain rather than in settings.json. */
const SECRET_KEYS: ('tenorKey' | 'freesoundKey' | 'pexelsKey' | 'pixabayKey' | 'googleKey' | 'googleCx')[] = ['tenorKey', 'freesoundKey', 'pexelsKey', 'pixabayKey', 'googleKey', 'googleCx'];
const secretName = (k: string) => (k === 'googleCx' ? 'googlecx' : k.replace(/Key$/, ''));

/** Keys saved by an older version in the file are moved into the Keychain once, then dropped from the file. */
function migrateSecrets(stored: Partial<Settings>): Partial<Settings> {
  let moved = false;
  for (const k of SECRET_KEYS) {
    const v = stored[k];
    if (typeof v === 'string' && v.trim()) {
      try {
        setSecret(secretName(k), v);
        moved = true;
      } catch (err) {
        console.warn(`[settings] could not move ${k} to the Keychain: ${(err as Error).message}`);
        continue;
      }
    }
    delete stored[k];
  }
  if (moved) write('settings.json', stored);
  return stored;
}

export function getSettings(): Settings {
  const stored = migrateSecrets(read<Partial<Settings>>('settings.json', {}));
  return { ...EMPTY_SETTINGS, ...stored, tenorKey: getSecret('tenor'), freesoundKey: getSecret('freesound'), pexelsKey: getSecret('pexels'), pixabayKey: getSecret('pixabay'), googleKey: getSecret('google'), googleCx: getSecret('googlecx') };
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const rest = { ...patch };
  for (const k of SECRET_KEYS) {
    if (typeof rest[k] === 'string') setSecret(secretName(k), rest[k] as string);
    delete rest[k];
  }
  const file = { ...read<Partial<Settings>>('settings.json', {}) };
  for (const k of SECRET_KEYS) delete file[k];
  write('settings.json', { ...EMPTY_SETTINGS, ...file, ...rest, tenorKey: undefined, freesoundKey: undefined, pexelsKey: undefined, pixabayKey: undefined, googleKey: undefined, googleCx: undefined, updatedAt: Date.now() });
  return getSettings();
}

export function getProfile(): Profile {
  return { ...EMPTY_PROFILE, ...read<Partial<Profile>>('profile.json', {}) };
}

export function saveProfile(patch: Partial<Profile>): Profile {
  const next = { ...getProfile(), ...patch, updatedAt: Date.now() };
  write('profile.json', next);
  return next;
}

export function getPlan(): PlanItem[] {
  return read<PlanItem[]>('plan.json', []);
}

export function savePlan(items: PlanItem[]): void {
  write('plan.json', items);
}

export function addPlanItem(input: Omit<PlanItem, 'id' | 'createdAt' | 'updatedAt'>): PlanItem {
  const item: PlanItem = { ...input, id: uid('n'), createdAt: Date.now(), updatedAt: Date.now() };
  savePlan([...getPlan(), item]);
  return item;
}

export function updatePlanItem(id: ID, patch: Partial<PlanItem>): PlanItem | null {
  const items = getPlan();
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return null;
  items[i] = { ...items[i], ...patch, id, updatedAt: Date.now() };
  savePlan(items);
  return items[i];
}

export function removePlanItem(id: ID): boolean {
  const items = getPlan();
  const next = items.filter((x) => x.id !== id);
  if (next.length === items.length) return false;
  savePlan(next);
  return true;
}

export function getNotes(): Record<string, PlatformNote> {
  return read<Record<string, PlatformNote>>('notes.json', {});
}

export function saveNote(platform: string, text: string, sources: string[]): PlatformNote {
  const notes = getNotes();
  notes[platform.toLowerCase()] = { text, sources, updatedAt: Date.now() };
  write('notes.json', notes);
  return notes[platform.toLowerCase()];
}

export function getReferences(): ReferenceCard[] {
  return read<ReferenceCard[]>('references.json', []);
}

export function addReference(card: Omit<ReferenceCard, 'id' | 'addedAt'>): ReferenceCard {
  const r: ReferenceCard = { ...card, id: uid('r'), addedAt: Date.now() };
  write('references.json', [...getReferences(), r]);
  return r;
}

export function removeReference(id: ID): void {
  write('references.json', getReferences().filter((r) => r.id !== id));
}

const pop = { style: 'pop' as const, y: 0.7, size: 1, maxWords: 3, uppercase: true, punctuation: false, color: '#FFFFFF', accent: '#FFE14D' };

/** Styles that ship with the app. Saved recipes come after them. */
export const BUILT_IN_RECIPES: Recipe[] = [
  { id: 'talking-head', name: 'Talking head reel', description: 'Bold word-by-word captions, tight pacing, no music unless asked.', captions: pop, hookFont: 'Montserrat', hookStyle: 'hook', pacing: { silence: 0.4, fillers: 1 }, music: 'none', notes: 'Punch in on key lines; one pop-up where a fact deserves it.', builtIn: true },
  { id: 'meme', name: 'Meme and comedy', description: 'Comic fonts, two-word caption cards, sounds on the beats, reaction pop-ups.', captions: { ...pop, maxWords: 2, font: 'Luckiest Guy', accent: '#FFE14D' }, hookFont: 'Bangers', hookStyle: 'title', pacing: { silence: 0.35, fillers: 1 }, music: 'quiet', notes: 'Hold the beat before the punchline, sound effect on the landing, crickets or sad trombone on a flop, a reaction GIF at most once.', builtIn: true },
  { id: 'tutorial', name: 'Tutorial and explainer', description: 'Clean readable captions, calm pacing, step labels and lists.', captions: { style: 'clean', y: 0.72, size: 1, maxWords: 6, uppercase: false, punctuation: true, color: '#FFFFFF', accent: '#FFE14D', font: 'Inter' }, hookFont: 'Montserrat', hookStyle: 'hook', pacing: { silence: 0.6, fillers: 0 }, music: 'quiet', notes: 'Number the steps with labels or a list graphic; no comedy sounds.', builtIn: true },
  { id: 'vlog', name: 'Vlog and lifestyle', description: 'Highlight captions, breezy music, easy pacing.', captions: { style: 'highlight', y: 0.7, size: 1, maxWords: 4, uppercase: false, punctuation: false, color: '#FFFFFF', accent: '#7C5CFF', font: 'Poppins' }, hookFont: 'Pacifico', hookStyle: 'subtitle', pacing: { silence: 0.5, fillers: 0 }, music: 'present', notes: 'B-roll over the talking where there is any; keep the speaker for the opening line.', builtIn: true },
  { id: 'elegant', name: 'Elegant and editorial', description: 'Serif text, quiet captions, slow pacing, soft music.', captions: { style: 'clean', y: 0.74, size: 0.9, maxWords: 6, uppercase: false, punctuation: true, color: '#FFFFFF', accent: '#FFFFFF', font: 'Playfair Display' }, hookFont: 'Cormorant Garamond', hookStyle: 'serif', pacing: { silence: 0.8, fillers: 0 }, music: 'quiet', notes: 'Few graphics; a slow push-in rather than cut punch-ins; cross fades between scenes are allowed.', builtIn: true },
  { id: 'montage', name: 'Montage to music', description: 'Cuts on the beat, big titles, music up front.', captions: { ...pop, maxWords: 2, font: 'Bebas Neue' }, hookFont: 'Anton', hookStyle: 'title', pacing: { silence: 0.3, fillers: 1 }, music: 'present', notes: 'Pick a track first, then cut clips to its beats; speech is secondary.', builtIn: true },
  { id: 'hype', name: 'Hype and sports', description: 'Fast, loud and punchy: oneword captions, speed ramps, sparks, big music.', captions: { ...pop, style: 'oneword', maxWords: 1, font: 'Anton', accent: '#FF3B3B' }, hookFont: 'Anton', hookStyle: 'title', look: { contrast: 1.12, saturation: 1.15, vignette: 0.25 }, pacing: { silence: 0.3, fillers: 1 }, music: 'present', notes: 'Ramp in, slow-moment on the hit, sparks or a flash on the big line, burst past dull stretches, music big with a dip under the key words; the voice preset on talking.', builtIn: true },
  { id: 'cinematic', name: 'Cinematic', description: 'Widescreen bars, graded colour, slow moves, film burns and light leaks.', captions: { style: 'clean', y: 0.76, size: 0.9, maxWords: 6, uppercase: false, punctuation: true, color: '#FFFFFF', accent: '#FFD166', font: 'Cormorant Garamond' }, hookFont: 'Cormorant Garamond', hookStyle: 'serif', look: { contrast: 1.1, saturation: 0.9, warmth: 0.15, letterbox: 0.1, vignette: 0.35, grain: 0.15 }, pacing: { silence: 0.8, fillers: 0 }, music: 'present', notes: 'Push-ins and drifts instead of punch-ins, a light leak on the opening, burn or dip transitions between scenes, slow motion with optical flow on movement, stabilise handheld shots.', builtIn: true },
  { id: 'retro', name: 'Retro and VHS', description: 'Grain, colour fringing, a radio voice and retro type.', captions: { style: 'retro', y: 0.72, size: 1, maxWords: 3, uppercase: true, punctuation: false, color: '#FFF4C2', accent: '#FF7AB6', font: 'Space Mono' }, hookFont: 'Space Mono', hookStyle: 'typewriter', look: { sepia: 0.2, grain: 0.45, saturation: 0.85, contrast: 1.08, vignette: 0.4, rgbSplit: 0.004 }, pacing: { silence: 0.5, fillers: 0 }, music: 'present', notes: 'Glitch transitions, the radio or warm tone on the voice, a freeze frame on the punchline; nothing too clean.', builtIn: true },
  { id: 'clean', name: 'Clean and minimal', description: 'Glass captions, lots of air, no effects, soft music.', captions: { style: 'glass', y: 0.74, size: 0.95, maxWords: 5, uppercase: false, punctuation: true, color: '#FFFFFF', accent: '#FFFFFF', font: 'Inter' }, hookFont: 'Inter', hookStyle: 'subtitle', pacing: { silence: 0.6, fillers: 0 }, music: 'quiet', notes: 'Plain cuts, one push-in at most, no sound effects; let the content carry it.', builtIn: true },
  { id: 'girlypop', name: 'Girlypop', description: 'Pink and bubbly: bubble captions, sparkles and hearts, a blush look, chick flick quotes, cute sounds.', captions: { style: 'bubble', y: 0.7, size: 1, maxWords: 4, uppercase: false, punctuation: false, color: '#FFFFFF', accent: '#FF69B4', font: 'Fredoka' }, hookFont: 'Chewy', hookStyle: 'bubblegum', look: { brightness: 1.05, contrast: 0.94, saturation: 1.05, warmth: 0.2, tint: 0.22, bloom: 0.12 }, pacing: { silence: 0.45, fillers: 1 }, music: 'present', notes: 'Pink sticker labels (pinksticker) and bubblegum text, sparkles or hearts on the cute moments (add_vfx), glitter on the reveal, a heart or sparkle transition between scenes, a chick flick line (add_quote) where the footage sets it up, cartoon kiss, sparkle whoosh, magic poof or giggling on the beats (add_sfx), a slow-moment on the hair flip or the outfit reveal; bright girly voice (Bella) for a voiceover.', builtIn: true },
  { id: 'coquette', name: 'Coquette', description: 'Soft and pretty: serif captions with hearts, bows and script, a cotton candy look, slow and dreamy.', captions: { style: 'coquette', y: 0.72, size: 0.95, maxWords: 5, uppercase: false, punctuation: true, color: '#FFFFFF', accent: '#FFB6C1', font: 'Playfair Display' }, hookFont: 'Parisienne', hookStyle: 'coquette', look: { brightness: 1.08, contrast: 0.86, saturation: 0.95, temperature: -0.15, tint: 0.35, bloom: 0.2, blacks: 0.25 }, pacing: { silence: 0.7, fillers: 0 }, music: 'present', notes: 'Slow push-ins and drifts, petals or butterflies at most once, a pink light leak on the opening, sparkle transitions, lovenote or princess text for the pretty lines, a quote card from The Notebook, Pretty Woman or Gossip Girl where it fits, soft bells and sparkle sounds only; no hard cuts on the beat.', builtIn: true },
];

export function getRecipes(): Recipe[] {
  return [...BUILT_IN_RECIPES, ...read<Recipe[]>('recipes.json', [])];
}

export function saveRecipe(r: Omit<Recipe, 'id' | 'builtIn'>): Recipe {
  const mine = read<Recipe[]>('recipes.json', []).filter((x) => x.name.toLowerCase() !== r.name.toLowerCase());
  const recipe: Recipe = { ...r, id: uid('x') };
  write('recipes.json', [...mine, recipe]);
  return recipe;
}

export function removeRecipe(id: ID): void {
  write('recipes.json', read<Recipe[]>('recipes.json', []).filter((x) => x.id !== id));
}

export function findRecipe(ref: string): Recipe | undefined {
  const q = ref.trim().toLowerCase();
  return getRecipes().find((r) => r.id === q || r.name.toLowerCase() === q) ?? getRecipes().find((r) => r.name.toLowerCase().includes(q));
}

export function getStudio(): Studio {
  return { profile: getProfile(), plan: getPlan(), notes: getNotes(), references: getReferences() };
}

/** The footage library, made on first use. */
export function library(): Project {
  return getProject(LIBRARY_ID);
}

/** Put clips on the main track, back to back, the way the editor's own "add" does: the first video sets the frame rate. */
export function layOut(p: Project, ids: ID[]): void {
  let d = p.doc;
  for (const id of ids) {
    const m = p.media.get(id);
    if (!m || m.kind === 'audio') continue;
    if (!d.main.length && !d.overlays.length && m.kind === 'video' && m.fps > 0) {
      const base = m.fps > 40 ? m.fps / 2 : m.fps;
      const fps = [24, 25, 30].reduce((a, b) => (Math.abs(b - base) < Math.abs(a - base) ? b : a), 30);
      if (fps !== d.settings.fps) d = setSettings(d, { fps });
    }
    d = insertMain(d, { kind: 'media', ...makeClip(m, d.settings.fps), name: m.name });
  }
  if (d !== p.doc) commitDoc(p, d, { source: 'op', label: 'Lay out footage' });
}

/**
 * Bring a library clip into a project without preparing it again: the file is
 * referenced in place and the preview, transcript, face track and notes are
 * copied over.
 */
export function copyMedia(from: Project, id: ID, to: Project): MediaAsset {
  const src = from.media.get(id);
  if (!src) throw new Error(`no media ${id} in ${from.id}`);
  const same = [...to.media.values()].find((m) => m.path === src.path && !m.origin);
  if (same) return same;
  const nid = uid('m');
  const dir = mediaDir(to, nid);
  fs.mkdirSync(dir, { recursive: true });
  const srcDir = mediaDir(from, id);
  for (const f of fs.existsSync(srcDir) ? fs.readdirSync(srcDir) : []) {
    if (f === 'stt') continue;
    fs.copyFileSync(path.join(srcDir, f), path.join(dir, f));
  }
  const asset: MediaAsset = { ...src, id: nid, tag: nextTag(to), addedAt: Date.now(), rev: 1 };
  delete asset.progress;
  delete asset.stage;
  putMedia(to, asset);
  return asset;
}
