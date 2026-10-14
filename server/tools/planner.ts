// Tools of the planner: the assistant that manages the creator's profile,
// footage, references and content plan, and starts projects from it. It runs
// on the footage library project, so the media tools work on the library.

import type { PlanFormat, PlanItem, PlanStatus } from '../../shared/types.ts';
import { ASPECTS } from '../../shared/types.ts';
import { createProject, getWords, setPendingRequest } from '../store.ts';
import { addPlanItem, addReference, copyMedia, getNotes, getPlan, getProfile, getReferences, layOut, library, removePlanItem, saveNote, saveProfile, updatePlanItem } from '../studio.ts';
import type { ToolDef } from './tools.ts';
import { bad, describeMedia, findMedia, str } from './helpers.ts';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties, required });
const S = (description: string, values?: string[]) => ({ type: 'string', description, ...(values ? { enum: values } : {}) });
const L = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

const FORMATS: PlanFormat[] = ['reel', 'short', 'story', 'carousel', 'post', 'long'];
const STATUSES: PlanStatus[] = ['idea', 'planned', 'making', 'ready', 'posted', 'dropped'];
const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : typeof v === 'string' && v.trim() ? v.split(/\s*,\s*/).filter(Boolean) : undefined);

export function describeProfile(): string {
  const p = getProfile();
  if (!p.updatedAt) return 'PROFILE: nothing saved yet. Ask about the creator, their audience, platforms, goals, capacity and voice before planning.';
  return [
    'PROFILE:',
    `  about: ${p.about || '(unknown)'}`,
    `  niche: ${p.niche || '(unknown)'}`,
    `  audience: ${p.audience || '(unknown)'}`,
    `  platforms: ${p.platforms.join(', ') || '(unknown)'}`,
    `  goals: ${p.goals || '(unknown)'}`,
    `  capacity: ${p.capacity || '(unknown)'}`,
    `  tone: ${p.tone || '(unknown)'}`,
    `  pillars: ${p.pillars.join(', ') || '(none yet)'}`,
    `  languages spoken in the videos: ${p.languages.join(', ') || '(not set: speech is auto-detected per clip, which misfires on short clips)'}`,
    p.notes ? `  notes: ${p.notes}` : '',
    `  web search for platform news: ${p.allowWeb ? 'allowed' : 'off (the user can allow it on the Plan page)'}`,
  ].filter(Boolean).join('\n');
}

export function describePlan(items = getPlan()): string {
  if (!items.length) return 'PLAN: empty.';
  const line = (it: PlanItem) => `  ${it.id}  ${it.date || 'undated'}${it.time ? ` ${it.time}` : ''}  ${it.platform} ${it.format}  [${it.status}]  "${it.title}"${it.pillar ? `  pillar: ${it.pillar}` : ''}${it.projectId ? `  project ${it.projectId}` : ''}\n      hook: ${it.hook}\n      story: ${it.storyline.replace(/\s+/g, ' ').slice(0, 220)}${it.footage.length ? `\n      footage: ${it.footage.join(', ')}` : ''}`;
  const sorted = [...items].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.createdAt - b.createdAt);
  return `PLAN (${items.length} item${items.length === 1 ? '' : 's'}):\n${sorted.map(line).join('\n')}`;
}

export function describeFootage(query?: string): string {
  const lib = library();
  const all = [...lib.media.values()].filter((m) => !m.origin).sort((a, b) => a.addedAt - b.addedAt);
  const q = query?.trim().toLowerCase();
  const rows = all.filter((m) => {
    if (!q) return true;
    const words = getWords(lib, m.id) ?? [];
    return m.name.toLowerCase().includes(q) || (m.insights?.summary ?? '').toLowerCase().includes(q) || (m.insights?.tags ?? []).some((t) => t.toLowerCase().includes(q)) || words.some((w) => w.text.toLowerCase().includes(q));
  });
  if (!rows.length) return q ? `No footage matches "${query}".` : 'FOOTAGE: the library is empty. The user can drop clips on the Plan page.';
  const lines = rows.map((m) => {
    const words = getWords(lib, m.id) ?? [];
    const opening = words.slice(0, 18).map((w) => w.text).join(' ');
    return `  ${describeMedia(m)}${opening ? `\n      says: "${opening}${words.length > 18 ? ' …' : ''}"` : ''}${m.insights ? '' : '\n      (not described yet: inspect_media, then save_media_notes)'}`;
  });
  return `FOOTAGE (${rows.length} of ${all.length} files; refer to a file by its letter or id):\n${lines.join('\n')}`;
}

export function describeNotes(): string {
  const notes = getNotes();
  const keys = Object.keys(notes);
  if (!keys.length) return 'PLATFORM NOTES: none saved. Ask the user to paste what they know, or search the web if allowed, then save_platform_notes.';
  return `PLATFORM NOTES:\n${keys.map((k) => `  ${k} (updated ${new Date(notes[k].updatedAt).toISOString().slice(0, 10)}):\n    ${notes[k].text.replace(/\n/g, '\n    ')}${notes[k].sources.length ? `\n    sources: ${notes[k].sources.join(' ')}` : ''}`).join('\n')}`;
}

export function describeReferences(): string {
  const refs = getReferences();
  if (!refs.length) return 'REFERENCES: none yet. The user can paste a post, a link or a screenshot to turn into a style card.';
  return `REFERENCES (posts the user likes, as style cards):\n${refs.map((r) => `  ${r.id} from ${r.source}: ${r.summary}\n      hook: ${r.hook} | structure: ${r.structure} | pacing: ${r.pacing} | text: ${r.text} | sound: ${r.sound}\n      why it works: ${r.why}${r.tags.length ? ` [${r.tags.join(', ')}]` : ''}`).join('\n')}`;
}

export const PLANNER_TOOLS: ToolDef[] = [
  {
    name: 'get_profile',
    description: 'Read what is known about the creator: niche, audience, platforms, goals, capacity, voice, content pillars.',
    schema: obj({}),
    label: () => 'Reading the profile',
    readOnly: true,
    run: () => ({ text: describeProfile() }),
  },
  {
    name: 'save_profile',
    description: 'Save what you learned about the creator. Give only the fields that changed; each replaces the saved value, so write the whole field. Keep every field short and in the creator\'s own terms.',
    schema: obj({
      about: S('The creator or brand in one or two sentences.'),
      niche: S('What the account is about and its angle.'),
      audience: S('Who it is for.'),
      platforms: L('e.g. ["instagram", "youtube"]'),
      goals: S('What success looks like.'),
      capacity: S('How much they can make: posts per week, hours, gear.'),
      tone: S('Voice, language, things to always or never do.'),
      pillars: L('3 to 5 recurring content themes.'),
      languages: L('ISO codes of the languages spoken in the videos, e.g. ["hi", "en"]. First one wins when detection is unsure; "en" first turns Hindi speech into Hinglish captions in Latin letters.'),
      notes: S('Anything else worth remembering.'),
    }),
    label: () => 'Saving the profile',
    run: (_ctx, a) => {
      const patch: Record<string, unknown> = {};
      for (const k of ['about', 'niche', 'audience', 'goals', 'capacity', 'tone', 'notes'] as const) if (a[k] !== undefined) patch[k] = str(a[k]).trim();
      const platforms = list(a.platforms);
      if (platforms) patch.platforms = platforms.map((x) => x.toLowerCase());
      const pillars = list(a.pillars);
      if (pillars) patch.pillars = pillars;
      const languages = list(a.languages);
      if (languages) patch.languages = languages.map((x) => x.toLowerCase());
      if (!Object.keys(patch).length) bad('Nothing to save: give at least one field.');
      saveProfile(patch);
      return { text: `Saved.\n${describeProfile()}` };
    },
  },
  {
    name: 'list_footage',
    description: 'List the clips in the footage library with their length, speech, notes and the start of what is said. Pass query to filter by name, notes or spoken words. Clips without notes should be looked at (inspect_media) and described (save_media_notes) before planning around them.',
    schema: obj({ query: S('Words to look for in names, notes and transcripts.') }),
    label: () => 'Reading the footage list',
    readOnly: true,
    run: (_ctx, a) => ({ text: describeFootage(a.query === undefined ? undefined : str(a.query)) }),
  },
  {
    name: 'list_plan',
    description: 'Read the content plan: every planned, idea-stage, in-progress and posted item with its id.',
    schema: obj({ status: S('Only items in this state.', STATUSES) }),
    label: () => 'Reading the plan',
    readOnly: true,
    run: (_ctx, a) => ({ text: describePlan(a.status ? getPlan().filter((x) => x.status === a.status) : getPlan()) }),
  },
  {
    name: 'add_plan_item',
    description: 'Add a post to the content plan. A plan item is one piece of content: when, where, what format, the hook, the storyline and which footage it uses. Dates are YYYY-MM-DD; leave the date empty for an idea that is not scheduled yet.',
    schema: obj({
      title: S('A short working title.'),
      platform: S('instagram, youtube, tiktok, ...'),
      format: S('Kind of post.', FORMATS),
      date: S('YYYY-MM-DD, or empty.'),
      time: S('HH:MM local, optional.'),
      pillar: S('Which content pillar it serves.'),
      hook: S('The first line or first three seconds.'),
      storyline: S('The story in a few lines: what happens in what order, and the payoff.'),
      footage: L('Letters or ids of library clips to make it from.'),
      caption: S('Draft caption.'),
      hashtags: L('Hashtags without the # sign.'),
      status: S('Default "planned" when dated, "idea" otherwise.', STATUSES),
      notes: S('Anything else.'),
    }, ['title', 'platform', 'format', 'hook', 'storyline']),
    label: () => 'Adding to the plan',
    run: async (_ctx, a) => {
      const lib = library();
      const footage: string[] = [];
      for (const ref of list(a.footage) ?? []) footage.push((await findMedia(lib, ref)).id);
      const date = str(a.date).trim();
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) bad('date must be YYYY-MM-DD.');
      const item = addPlanItem({
        title: str(a.title).trim(),
        platform: str(a.platform).trim().toLowerCase() || 'instagram',
        format: (FORMATS.includes(a.format as PlanFormat) ? a.format : 'reel') as PlanFormat,
        date,
        time: str(a.time).trim() || undefined,
        pillar: str(a.pillar).trim() || undefined,
        hook: str(a.hook).trim(),
        storyline: str(a.storyline).trim(),
        footage,
        caption: str(a.caption).trim() || undefined,
        hashtags: list(a.hashtags)?.map((h) => h.replace(/^#/, '')),
        status: (STATUSES.includes(a.status as PlanStatus) ? a.status : date ? 'planned' : 'idea') as PlanStatus,
        notes: str(a.notes).trim() || undefined,
      });
      return { text: `Added ${item.id}: ${item.date || 'undated'} ${item.platform} ${item.format} "${item.title}".` };
    },
  },
  {
    name: 'update_plan_item',
    description: 'Change a plan item: reschedule it, rewrite its hook or storyline, change its status, attach footage. Only the fields given change.',
    schema: obj({
      id: S('Plan item id.'),
      title: S(''), platform: S(''), format: S('', FORMATS), date: S('YYYY-MM-DD or "" to unschedule.'), time: S(''), pillar: S(''), hook: S(''), storyline: S(''),
      footage: L('Library clip letters or ids; replaces the list.'), caption: S(''), hashtags: L(''), status: S('', STATUSES), notes: S(''),
    }, ['id']),
    label: () => 'Updating the plan',
    run: async (_ctx, a) => {
      const patch: Partial<PlanItem> = {};
      for (const k of ['title', 'platform', 'date', 'time', 'pillar', 'hook', 'storyline', 'caption', 'notes'] as const) if (a[k] !== undefined) (patch as Record<string, unknown>)[k] = str(a[k]).trim();
      if (patch.date && !/^\d{4}-\d{2}-\d{2}$/.test(patch.date)) bad('date must be YYYY-MM-DD.');
      if (a.format !== undefined) patch.format = (FORMATS.includes(a.format as PlanFormat) ? a.format : 'reel') as PlanFormat;
      if (a.status !== undefined) {
        if (!STATUSES.includes(a.status as PlanStatus)) bad(`status must be one of ${STATUSES.join(', ')}.`);
        patch.status = a.status as PlanStatus;
      }
      const footage = list(a.footage);
      if (footage) {
        const lib = library();
        patch.footage = [];
        for (const ref of footage) patch.footage.push((await findMedia(lib, ref)).id);
      }
      const hashtags = list(a.hashtags);
      if (hashtags) patch.hashtags = hashtags.map((h) => h.replace(/^#/, ''));
      const item = updatePlanItem(str(a.id), patch);
      if (!item) bad(`No plan item ${a.id}.`);
      return { text: `Updated ${item.id}: ${item.date || 'undated'} ${item.platform} ${item.format} [${item.status}] "${item.title}".` };
    },
  },
  {
    name: 'remove_plan_item',
    description: 'Delete a plan item. Prefer status "dropped" when the idea might come back.',
    schema: obj({ id: S('Plan item id.') }, ['id']),
    label: () => 'Removing from the plan',
    run: (_ctx, a) => {
      if (!removePlanItem(str(a.id))) bad(`No plan item ${a.id}.`);
      return { text: `Removed ${a.id}.` };
    },
  },
  {
    name: 'get_platform_notes',
    description: 'Read the saved notes on what works on each platform right now (formats, lengths, hooks, posting times, recent changes).',
    schema: obj({}),
    label: () => 'Reading the platform notes',
    readOnly: true,
    run: () => ({ text: describeNotes() }),
  },
  {
    name: 'save_platform_notes',
    description: 'Replace the notes for one platform with what you now know. Keep them practical: formats, lengths, hooks, what the algorithm rewards, posting times, recent changes with dates. List the sources (links, or "user" when the user told you).',
    schema: obj({ platform: S('instagram, youtube, tiktok, ...'), text: S('The notes, plain text, under 300 words.'), sources: L('Links or "user".') }, ['platform', 'text']),
    label: () => 'Saving platform notes',
    run: (_ctx, a) => {
      const n = saveNote(str(a.platform), str(a.text).trim(), list(a.sources) ?? []);
      return { text: `Saved notes for ${str(a.platform).toLowerCase()} (${n.text.split(/\s+/).length} words).` };
    },
  },
  {
    name: 'list_references',
    description: 'Read the style cards made from posts the user likes.',
    schema: obj({}),
    label: () => 'Reading the references',
    readOnly: true,
    run: () => ({ text: describeReferences() }),
  },
  {
    name: 'save_reference',
    description: 'Turn a post the user showed you (pasted text, a link you read, or a screenshot you looked at with inspect_media) into a style card: what the hook does, how the piece is built, its pacing, how text and sound are used, and why it works. Describe the technique, not the content, so it can be reused on the user\'s own footage.',
    schema: obj({
      source: S('Where it came from: the link, "pasted text", or the screenshot file name.'),
      summary: S('One line: what the post is.'),
      hook: S('How the first second works.'),
      structure: S('How the piece is built, beat by beat.'),
      pacing: S('Cut rhythm, length, speed.'),
      text: S('How on-screen text is used: style, amount, placement.'),
      sound: S('Music, voice, effects.'),
      why: S('Why it works for its audience.'),
      tags: L('A few tags: format, mood, niche.'),
    }, ['source', 'summary', 'hook', 'structure', 'pacing', 'text', 'sound', 'why']),
    label: () => 'Saving a style card',
    run: (_ctx, a) => {
      const r = addReference({ source: str(a.source), summary: str(a.summary), hook: str(a.hook), structure: str(a.structure), pacing: str(a.pacing), text: str(a.text), sound: str(a.sound), why: str(a.why), tags: list(a.tags) ?? [] });
      return { text: `Saved style card ${r.id} (${r.summary}).` };
    },
  },
  {
    name: 'start_project',
    description: 'Start making a post: creates a project, lays the chosen footage out on its main track in the order given, and queues an editing request for the editing assistant to run as soon as the user opens it. Give the plan item (its footage and storyline are used) or a name plus footage. The request should say what to make: length, hook, structure, captions, graphics, music, in the editor\'s terms. Returns the project id; the user opens it from the Plan page.',
    schema: obj({
      plan_item_id: S('The plan item this is for.'),
      name: S('Project name, when there is no plan item.'),
      footage: L('Library clip letters or ids; defaults to the plan item\'s footage.'),
      request: S('The editing request to run, as the user would type it to the editing assistant.'),
      aspect: S('9:16 (default for reels and shorts), 16:9, 1:1, 4:5.', Object.keys(ASPECTS)),
    }, ['request']),
    label: () => 'Starting a project',
    run: async (_ctx, a) => {
      const lib = library();
      const item = a.plan_item_id ? getPlan().find((x) => x.id === str(a.plan_item_id)) : undefined;
      if (a.plan_item_id && !item) bad(`No plan item ${a.plan_item_id}.`);
      const refs = list(a.footage) ?? item?.footage ?? [];
      if (!refs.length) bad('Say which footage to use.');
      const media = [];
      for (const ref of refs) media.push(await findMedia(lib, ref));
      const name = str(a.name).trim() || item?.title || media[0].name.replace(/\.[^.]+$/, '');
      const aspect = str(a.aspect) || (item && (item.format === 'long' || item.platform === 'youtube' && item.format !== 'short') ? '16:9' : '9:16');
      const p = createProject(name, aspect);
      layOut(p, media.map((m) => copyMedia(lib, m.id, p).id));
      setPendingRequest(p, str(a.request).trim());
      if (item) updatePlanItem(item.id, { projectId: p.id, status: item.status === 'idea' || item.status === 'planned' ? 'making' : item.status });
      return { text: `Started project ${p.id} "${p.doc.name}" (${aspect}) with ${media.length} clip${media.length === 1 ? '' : 's'}. The editing request will run when the user opens it: /p/${p.id}` };
    },
  },
];

/** Media tools the planner shares with the editor. */
export const PLANNER_SHARED = ['inspect_media', 'save_media_notes', 'get_media_transcript', 'list_library', 'list_recipes', 'read_link', 'research_reddit'];

export function isLibrary(id: string): boolean {
  return id === 'library';
}
