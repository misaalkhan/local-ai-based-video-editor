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

export function getSettings(): Settings {
  return { ...EMPTY_SETTINGS, ...read<Partial<Settings>>('settings.json', {}) };
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch, updatedAt: Date.now() };
  write('settings.json', next);
  return next;
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
