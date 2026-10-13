// The editing tools. The chat assistant calls these through MCP; the "Clean
// up" menu and other buttons in the app call the very same functions over
// HTTP. Each returns a plain-language account of what actually changed, so a
// caller never has to guess whether an edit took effect.

import fs from 'node:fs';
import path from 'node:path';
import type { ID, MediaAsset, OverlayClip, ProjectDoc, Range, TakeGroup } from '../../shared/types.ts';
import { ASPECTS, aspectOf } from '../../shared/types.ts';
import * as ops from '../../shared/ops.ts';
import { DEFAULT_FRAMING, clamp, contentDuration, layoutMain, snap, sourceAt, srcDuration } from '../../shared/timeline.ts';
import { extractStill } from '../stills.ts';
import { analyzeStability } from '../stabilize.ts';
import { trackObject } from '../objects.ts';
import { bakeSequence } from '../sequences.ts';
import { AUDIO_PRESETS } from '../../shared/audiofx.ts';
import { getObjectTracks } from '../store.ts';
import { clipGeometry, framingAt, segAt, sourceAt as sourceTimeAt } from '../../shared/timeline.ts';
import { detectSilences } from '../../shared/silence.ts';
import { FONT_FAMILIES, FONT_NOTES, nearestWeight } from '../../shared/fonts.ts';
import { GRAPHIC_PRESETS, GRAPHIC_TEMPLATES } from '../../shared/graphics.ts';
import { findTakes } from '../../shared/takes.ts';
import { faceInFrame, lint } from '../../shared/lint.ts';
import { getEnvelope, getFaces, getWords, mediaDir, patchMedia } from '../store.ts';
import type { Project } from '../store.ts';
import { importMedia } from '../media.ts';
import { analyzeFaces, faceCoverage } from '../faces.ts';
import { listLibrary, listLuts, listSfx, readLut, searchSfx } from '../library.ts';
import { listVoices, synthesize } from '../tts.ts';
import { fetchGif, found as foundGifs, searchGifs } from '../gifs.ts';
import { saveSound, searchSounds, soundCredit } from '../sounds.ts';
import type { FoundSound } from '../sounds.ts';
import { fetchMeme, findTemplate, memeTemplates } from '../memes.ts';
import { findRecipe, getRecipes, getSettings, saveRecipe } from '../studio.ts';
import { findBeats } from '../../shared/beats.ts';
import { LOOKS } from '../../shared/draw.ts';
import { contactSheet, mediaStill, renderStill, stamp } from '../export/still.ts';
import type { Args, ToolCtx, ToolResult } from './helpers.ts';
import {
  absorbSlivers,
  bad,
  dbToGain,
  describeMedia,
  describeTimeline,
  describeTranscript,
  describeWords,
  envelopeSoon,
  findItem,
  findMedia,
  gainToDb,
  lintContext,
  loudLevelDb,
  num,
  optNum,
  parseWordRefs,
  place,
  rangesTotal,
  save,
  sec,
  sourceClip,
  span,
  str,
  view,
  voiceLevelDb,
  voicePeakDb,
  WHEN,
  wordCut,
  wordId,
  wordTime,
} from './helpers.ts';

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** A few words for the activity list in the chat ("Removing silences"). */
  label: (a: Args) => string;
  readOnly?: boolean;
  run: (ctx: ToolCtx, a: Args) => Promise<ToolResult> | ToolResult;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, properties, required });
const N = (description: string) => ({ type: 'number', description });
const L2 = (description: string) => ({ type: 'array', items: { type: 'string' }, description });
const S = (description: string, values?: string[]) => ({ type: 'string', description, ...(values ? { enum: values } : {}) });
const B = (description: string) => ({ type: 'boolean', description });

const after = (doc: ProjectDoc) => `The video is now ${sec(contentDuration(doc))}s long.`;

/** The average colour of a picture's four corners, as a hex string: the usual way to find a green screen's green. */
async function autoKeyColor(p: Project, mediaId: ID): Promise<string | null> {
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const img = await loadImage(path.join(mediaDir(p, mediaId), 'thumb.jpg'));
    const c = createCanvas(img.width, img.height);
    const cx = c.getContext('2d');
    cx.drawImage(img, 0, 0);
    const s = Math.max(2, Math.round(Math.min(img.width, img.height) * 0.04));
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const [x, y] of [[0, 0], [img.width - s, 0], [0, img.height - s], [img.width - s, img.height - s]]) {
      const d = cx.getImageData(x, y, s, s).data;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
        n++;
      }
    }
    const hex = (v: number) => Math.round(v / n).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase();
  } catch {
    return null;
  }
}

/** Sounds found by the last find_sound_online call, by Freesound id. */
const foundSounds = new Map<number, FoundSound>();

/** Media the assistant has looked at (inspect_media) this turn, by project; cleared when a turn starts. */
export const seen = new Map<ID, Set<ID>>();
const markSeen = (pid: ID, mid: ID) => {
  const set = seen.get(pid) ?? new Set<ID>();
  set.add(mid);
  seen.set(pid, set);
};

/** Video files the assistant has neither looked at this turn nor saved notes on. */
function unseenVideo(p: Project): MediaAsset[] {
  return [...p.media.values()].filter((m) => m.kind === 'video' && m.origin !== 'sfx' && m.origin !== 'gif' && !m.insights && !seen.get(p.id)?.has(m.id));
}
const shifted = 'Timeline times after the cut have moved; re-read the transcript before using times again.';
const scraps = (n: number) => (n ? ` Also removed ${n} leftover scrap${n === 1 ? '' : 's'} with no words.` : '');
const clip = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);


const POSITION = 'Where it sits: "auto" (clear of the face and of app buttons), top, upper, center, lower, bottom, top-left, top-right, left, right, or give x and y (0-1 from the top left).';

export const TOOLS: ToolDef[] = [
  // ------------------------------------------------------------------ reading
  {
    name: 'get_timeline',
    description: 'Read the whole project: settings, media files with their letters, every segment and item on every track with ids and times, and take groups. Call this first and again after edits.',
    schema: obj({}),
    label: () => 'Reading the timeline',
    readOnly: true,
    run: (ctx) => ({ text: describeTimeline(ctx.p) }),
  },
  {
    name: 'get_transcript',
    description: 'Read what is said in the video as it currently plays: sentences with timeline times, word-id ranges and [gap] markers for pauses. Set include_cut to also see sentences that have been cut (they can be restored). For individual word ids inside a sentence, pass detail="words" with a start and end time.',
    schema: obj({
      start: N('Only from this timeline time (seconds).'),
      end: N('Only up to this timeline time (seconds).'),
      include_cut: B('Also list sentences that are currently cut.'),
      detail: S('"sentences" (default) or "words" for every word id in the window.', ['sentences', 'words']),
    }),
    label: () => 'Reading the transcript',
    readOnly: true,
    run: (ctx, a) => {
      const start = optNum(a.start, 'start');
      const end = optNum(a.end, 'end');
      if (a.detail === 'words') return { text: describeWords(ctx.p, start ?? 0, end ?? (start ?? 0) + 30) };
      return { text: describeTranscript(ctx.p, { start, end, includeCut: !!a.include_cut }) };
    },
  },
  {
    name: 'get_media_transcript',
    description: 'Read the full transcript of one media file in its own time (seconds from the start of the file), whether or not it is on the timeline. Use it to choose which part of a clip to add.',
    schema: obj({ media: S('Letter, id or name of the file.'), start: N('From this second of the file.'), end: N('Up to this second of the file.') }, ['media']),
    label: () => 'Reading a clip',
    readOnly: true,
    run: async (ctx, a) => {
      const m = await findMedia(ctx.p, a.media);
      const ws = getWords(ctx.p, m.id);
      if (!ws?.length) return { text: `"${m.name}" has no speech${m.transcript === 'running' || m.transcript === 'pending' ? ' yet (still transcribing)' : ''}.` };
      const from = optNum(a.start, 'start') ?? 0;
      const to = optNum(a.end, 'end') ?? Infinity;
      const lines: string[] = [];
      let cur: { a: number; b: number; t0: number; t1: number; text: string[] } | null = null;
      const flush = () => {
        if (cur) lines.push(`[${sec(cur.t0)}-${sec(cur.t1)}] ${wordId(m, cur.a)}-${wordId(m, cur.b)}: ${cur.text.join(' ')}`);
        cur = null;
      };
      ws.forEach((w, i) => {
        if (w.t1 < from || w.t0 > to) return;
        if (cur && (w.t0 - cur.t1 >= 0.7 || /[.!?…]$/.test(cur.text[cur.text.length - 1]) || cur.text.length >= 40)) {
          const gap = w.t0 - cur.t1;
          flush();
          if (gap >= 0.7) lines.push(`  [gap ${gap.toFixed(1)}s]`);
        }
        if (!cur) cur = { a: i, b: i, t0: w.t0, t1: w.t1, text: [] };
        cur.b = i;
        cur.t1 = w.t1;
        cur.text.push(w.text);
      });
      flush();
      return { text: `TRANSCRIPT of [${m.tag}] "${m.name}" (${sec(m.duration)}s, times within the file):\n${lines.join('\n')}` };
    },
  },
  {
    name: 'inspect_frames',
    description: 'Look at the video as it will be exported. Returns a contact sheet of rendered frames (captions, graphics and crops included), each stamped with its time. Use it after editing to check framing, text placement and overlaps. Give exact times, or every_s to sample a range. At most 20 frames per call.',
    schema: obj({
      times: { type: 'array', items: { type: 'number' }, description: 'Timeline times in seconds.' },
      every_s: N('Sample one frame every this many seconds instead.'),
      start: N('Start of the sampled range (default 0).'),
      end: N('End of the sampled range (default: the end of the video).'),
      without_overlays: B('Show the footage alone, without captions and graphics.'),
    }),
    label: () => 'Looking at the frames',
    readOnly: true,
    run: async (ctx, a) => {
      const v = view(ctx.p);
      if (v.duration <= 0) return { text: 'The timeline is empty, so there is nothing to look at.' };
      let times: number[] = Array.isArray(a.times) ? a.times.map((t) => num(t, 'times')) : [];
      if (!times.length) {
        const start = clamp(optNum(a.start, 'start') ?? 0, 0, v.duration);
        const end = clamp(optNum(a.end, 'end') ?? v.duration, start, v.duration);
        const step = Math.max(0.2, optNum(a.every_s, 'every_s') ?? Math.max(1, (end - start) / 10));
        for (let t = start + Math.min(step / 2, 0.5); t < end; t += step) times.push(t);
      }
      times = [...new Set(times.map((t) => Math.round(clamp(t, 0, Math.max(0, v.duration - 0.04)) * 100) / 100))].sort((x, y) => x - y).slice(0, 20);
      const portrait = v.doc.settings.height >= v.doc.settings.width;
      const width = portrait ? 300 : 500;
      const frames = [];
      for (const t of times) {
        if (ctx.signal?.aborted) bad('Stopped.');
        frames.push({ canvas: await renderStill(ctx.p, v.doc, t, { width, bare: !!a.without_overlays }), label: stamp(t) });
      }
      const per = portrait ? 10 : 9;
      const images = [];
      for (let i = 0; i < frames.length; i += per) images.push({ data: contactSheet(frames.slice(i, i + per), portrait ? 5 : 3), mime: 'image/jpeg' });
      return {
        text: `${frames.length} frame${frames.length === 1 ? '' : 's'} of the ${aspectOf(v.doc.settings)} video at ${times.map(sec).join(', ')}s. Each is stamped with its time (m:ss.t) in the top-left corner.`,
        images,
      };
    },
  },
  {
    name: 'inspect_media',
    description: 'Look at a media file itself, uncropped: a contact sheet of frames spread across it (or at given times within the file). Use it to learn what b-roll shows and to pick the best part. Follow with save_media_notes so you remember.',
    schema: obj({ media: S('Letter, id or name of the file.'), times: { type: 'array', items: { type: 'number' }, description: 'Seconds within the file. Default: six frames spread evenly.' } }, ['media']),
    label: () => 'Looking at a clip',
    readOnly: true,
    run: async (ctx, a) => {
      const m = await findMedia(ctx.p, a.media);
      if (m.kind === 'audio') return { text: `"${m.name}" is audio only. ${describeMedia(m)}` };
      if (m.proxy !== 'done') return { text: `"${m.name}" is still being prepared; try again in a moment.` };
      markSeen(ctx.p.id, m.id);
      let times = Array.isArray(a.times) ? a.times.map((t) => num(t, 'times')) : [];
      if (!times.length) times = m.kind === 'image' ? [0] : [0.08, 0.25, 0.42, 0.58, 0.75, 0.92].map((f) => f * m.duration);
      times = times.slice(0, 12);
      const frames = [];
      for (const t of times) {
        const c = await mediaStill(ctx.p, m, t, m.width >= m.height ? 480 : 300);
        if (c) frames.push({ canvas: c, label: stamp(t) });
      }
      if (!frames.length) return { text: `Could not read frames from "${m.name}".` };
      return { text: `${frames.length} frame${frames.length === 1 ? '' : 's'} of ${describeMedia(m)}. Times are within the file.`, images: [{ data: contactSheet(frames, m.width >= m.height ? 3 : 6), mime: 'image/jpeg' }] };
    },
  },
  {
    name: 'save_media_notes',
    description: 'Record what a media file shows, in one sentence plus a few tags, so it can be matched to the script later. Shown to the user as the clip\'s insights.',
    schema: obj({ media: S('Letter, id or name.'), summary: S('One sentence describing the clip.'), tags: { type: 'array', items: { type: 'string' }, description: 'Up to six short tags.' } }, ['media', 'summary']),
    label: () => 'Noting what a clip shows',
    run: async (ctx, a) => {
      const m = await findMedia(ctx.p, a.media);
      const tags = Array.isArray(a.tags) ? a.tags.map((t) => str(t).slice(0, 24)).filter(Boolean).slice(0, 6) : [];
      patchMedia(ctx.p, m.id, { insights: { summary: str(a.summary).slice(0, 200), tags, at: Date.now() } });
      return { text: `Saved notes for "${m.name}".` };
    },
  },
  {
    name: 'check_edit',
    description: 'Run the automatic checks on the current edit: text on screen too briefly to read, graphics overlapping each other, the captions or the face, items under app buttons, flash-length clips, missing picture. Returns a list to fix. Run it before inspect_frames when reviewing.',
    schema: obj({}),
    label: () => 'Checking the edit',
    readOnly: true,
    run: (ctx) => {
      const v = view(ctx.p);
      const issues = lint(v.doc, lintContext(ctx.p, v));
      if (!issues.length) return { text: 'No problems found by the automatic checks.' };
      const order = { fix: 0, check: 1, note: 2 };
      return {
        text: `${issues.length} thing${issues.length === 1 ? '' : 's'} to look at:\n${issues
          .sort((x, y) => order[x.severity] - order[y.severity])
          .map((i) => `- [${i.severity}]${i.itemId ? ` (${i.itemId})` : ''} ${i.message}`)
          .join('\n')}`,
      };
    },
  },
  {
    name: 'list_library',
    description: 'List what is available beyond this project: built-in and user sound effects, the user\'s music and b-roll library, voiceover voices and fonts.',
    schema: obj({ kind: S('What to list.', ['sfx', 'music', 'broll', 'voices', 'fonts', 'luts']) }, ['kind']),
    label: (a) => `Listing ${str(a.kind)}`,
    readOnly: true,
    run: async (_ctx, a) => {
      if (a.kind === 'sfx') return { text: `SOUND EFFECTS (use the id with add_sfx):\n${listSfx().map((s) => `  ${s.id}: ${s.name} [${s.role}] ${s.tags.slice(0, 5).join(', ')}`).join('\n') || '  (none installed)'}` };
      if (a.kind === 'voices') return { text: `VOICES for add_voiceover:\n${(await listVoices()).map((v) => `  ${v.id}: ${v.name}`).join('\n') || '  (none)'}` };
      if (a.kind === 'luts') return { text: `LUTS for set_clip_look lut=<name>:\n${listLuts().map((l) => `  ${l.name}`).join('\n') || '  (none imported; the user can import .cube files on the Effects tab)'}` };
      if (a.kind === 'fonts') return { text: `FONTS (use the family name with add_text font or set_font):\n${FONT_FAMILIES.map((f) => `  ${f}: ${FONT_NOTES[f] ?? ''}`).join('\n')}` };
      const files = listLibrary(a.kind === 'music' ? 'music' : 'broll');
      return { text: files.length ? `${str(a.kind).toUpperCase()} LIBRARY (refer to a file as "library:<name>"):\n${files.map((f) => `  ${f.name}`).join('\n')}` : `The ${str(a.kind)} library is empty. Only the files in this project are available.` };
    },
  },

  // ------------------------------------------------------------------ cutting
  {
    name: 'add_clip',
    description: 'Put a media file, or part of one, on the main track. By default it goes at the end; give index to insert earlier (0 = first). source_start/source_end are seconds within the file.',
    schema: obj({ media: S('Letter, id or name.'), source_start: N('Start within the file.'), source_end: N('End within the file.'), index: N('Position among the main segments, 0 = first. Default: the end.'), duration: N('For images: how long to show it.') }, ['media']),
    label: () => 'Adding a clip',
    run: async (ctx, a) => {
      const m = await findMedia(ctx.p, a.media);
      if (m.kind === 'audio') bad(`"${m.name}" is audio. Use set_music or add_audio.`);
      const d = ctx.p.doc;
      const c = { kind: 'media' as const, ...ops.makeClip(m, d.settings.fps, { in: optNum(a.source_start, 'source_start'), out: optNum(a.source_end, 'source_end'), duration: optNum(a.duration, 'duration') }), name: m.name, createdBy: ctx.messageId };
      const next = ops.insertMain(d, c, optNum(a.index, 'index'));
      save(ctx, next, 'add_clip', `Added ${m.name} to the main track`);
      const seg = layoutMain(next).find((s) => s.clip.id === c.id)!;
      // Building from a pile of clips: say which ones have not been looked at, so none is left out unseen.
      const unseen = !d.main.length && ctx.by !== 'user' ? unseenVideo(ctx.p).filter((x) => x.id !== m.id) : [];
      const note = unseen.length >= 2 ? ` Not looked at yet: ${unseen.map((x) => x.tag ?? x.name).join(', ')}. Look at each (inspect_media) before you finish so nothing good is left out.` : '';
      return { text: `Added "${m.name}" (source ${sec(c.in)}-${sec(c.out)}s) as main segment ${seg.index + 1}, id ${c.id}, at ${sec(seg.start)}-${sec(seg.end)}s. ${after(next)}${note}` };
    },
  },
  {
    name: 'keep_only',
    description: 'Of what is in the video now, keep only the passages you list, in the order you list them, and cut everything else: the other speech, the pauses between the passages, and stretches without speech such as an intro or outro. This is the way to make a short from a longer recording: choose the passages worth keeping and give each as a word range. A passage may come earlier than it was said, for example to open on the strongest line. Passages that follow each other in the recording stay joined. Words that are already cut stay cut (fillers and pauses removed earlier do not come back); to include something that was cut, use restore_words first. Graphics, punch-ins, b-roll and effects move with the words they sat over; those whose moment is cut are removed. Title cards and clips without speech on the main track are dropped. Use remove_words afterwards for small trims.',
    schema: obj({ passages: { type: 'array', items: { type: 'string' }, description: 'Word ranges in playing order, each a whole sentence or thought, e.g. ["a125-a148", "a187-a209"].' }, reason: S('One line on what was kept and why, shown to the user.') }, ['passages', 'reason']),
    label: () => 'Choosing what to keep',
    run: (ctx, a) => {
      const runs = parseWordRefs(ctx.p, a.passages);
      const before = ctx.p.doc;
      const d = ops.keepPassages(before, runs, (id) => getWords(ctx.p, id));
      if (!d.main.length) bad('None of those words are in the video right now, so nothing would be left. Check the ids against get_transcript, or bring cut words back with restore_words first.');
      const lost = before.graphics.length + before.zooms.length + before.overlays.length - (d.graphics.length + d.zooms.length + d.overlays.length);
      save(ctx, d, 'keep_only', str(a.reason) || `Kept ${runs.length} passage(s)`);
      return { text: `Kept ${runs.length} passage${runs.length === 1 ? '' : 's'}. ${after(d)} (It was ${sec(contentDuration(before))}s.)${lost > 0 ? ` ${lost} item${lost === 1 ? '' : 's'} on other tracks sat over footage that was cut and went with it.` : ''} It now reads:\n${describeTranscript(ctx.p)}` };
    },
  },
  {
    name: 'remove_words',
    description: 'Cut words out of the video by their ids. This is the main way to remove false starts, repeated attempts, tangents and anything not worth keeping. Cut whole phrases or sentences so what remains still reads as complete sentences. Pauses around a removed phrase are tidied automatically.',
    schema: obj({ words: { type: 'array', items: { type: 'string' }, description: 'Word ids or ranges, e.g. ["a12", "a40-a58"].' }, reason: S('One line on why, shown to the user.') }, ['words', 'reason']),
    label: () => 'Cutting words',
    run: (ctx, a) => {
      const runs = parseWordRefs(ctx.p, a.words);
      let d = ctx.p.doc;
      const before = contentDuration(d);
      const removed: string[] = [];
      for (const r of runs) {
        const cur = ops.removeSourceSpans(d, r.media.id, [wordCut(ctx.p, d, r.media, r.words, r.from, r.to)]);
        if (contentDuration(cur) < contentDuration(d) - 1e-6) removed.push(r.words.slice(r.from, r.to + 1).map((w) => w.text).join(' '));
        d = cur;
      }
      if (before - contentDuration(d) < 0.02) return { text: 'Nothing changed: those words are not in the video (already cut, or not on the main track).' };
      const tidy = ops.dropScraps(ctx.p.doc, d, (id) => getWords(ctx.p, id));
      d = tidy.doc;
      save(ctx, d, 'remove_words', str(a.reason) || `Cut ${removed.length} passage(s)`);
      // Show both ends of each passage, so a cut that took one word too many is easy to spot.
      const ends = (t: string) => (t.length > 110 ? `${t.slice(0, 60)} […] ${t.slice(-40)}` : t);
      return { text: `Cut ${sec(before - contentDuration(d))}s: ${removed.map((t) => `"${ends(t)}"`).join('; ')}.${scraps(tidy.dropped)} ${after(d)} ${shifted}` };
    },
  },
  {
    name: 'restore_words',
    description: 'Bring back words that were cut, by their ids. They return to their place among the remaining pieces of the same file.',
    schema: obj({ words: { type: 'array', items: { type: 'string' }, description: 'Word ids or ranges.' }, reason: S('One line on why.') }, ['words']),
    label: () => 'Restoring words',
    run: (ctx, a) => {
      const runs = parseWordRefs(ctx.p, a.words);
      let d = ctx.p.doc;
      const before = contentDuration(d);
      for (const r of runs) d = ops.restoreSourceSpan(d, r.media, ops.wordRestoreSpan(r.words, r.from, r.to, r.media.duration));
      const gained = contentDuration(d) - before;
      if (gained < 0.02) return { text: 'Nothing changed: those words are already in the video.' };
      save(ctx, d, 'restore_words', str(a.reason) || 'Restored words');
      return { text: `Restored ${sec(gained)}s. ${after(d)} ${shifted}` };
    },
  },
  {
    name: 'remove_silences',
    description: 'Cut the dead air out of the main track: every pause longer than min_gap_s, leaving keep_pad_s of quiet around the speech so words are not clipped and breaths stay natural.',
    schema: obj({ min_gap_s: N('Shortest pause to cut. Default 0.5; use 0.35 for a tighter, faster feel.'), keep_pad_s: N('Quiet kept on each side of speech. Default 0.12.') }),
    label: () => 'Removing silences',
    run: (ctx, a) => {
      const v = view(ctx.p);
      const minGap = clamp(optNum(a.min_gap_s, 'min_gap_s') ?? 0.5, 0.15, 5);
      const pad = clamp(optNum(a.keep_pad_s, 'keep_pad_s') ?? 0.12, 0.03, 0.5);
      const cache = new Map<string, Range[] | undefined>();
      const silences = (id: string) => {
        if (!cache.has(id)) {
          const env = getEnvelope(ctx.p, id);
          cache.set(id, env ? detectSilences(env, { minSilence: Math.min(0.3, minGap) }) : undefined);
        }
        return cache.get(id);
      };
      // A quietly spoken word can sit below the loudness line. Where the transcript puts a word, nothing is cut.
      const ranges = ops
        .silenceCutRanges(v.layout, silences, { minSilence: minGap, padBefore: pad * 0.85, padAfter: pad * 1.15 })
        .flatMap((r) => {
          let parts: Range[] = [r];
          for (const w of v.words) {
            if (w.end <= r.start || w.start >= r.end) continue;
            parts = parts.flatMap((x) => [{ start: x.start, end: Math.min(x.end, w.start - 0.03) }, { start: Math.max(x.start, w.end + 0.03), end: x.end }]);
          }
          return parts.filter((x) => x.end - x.start >= 0.12);
        });
      if (!ranges.length) return { text: `No pauses longer than ${minGap}s were found on the main track.` };
      const tidy = ops.dropScraps(v.doc, ops.rippleDelete(v.doc, absorbSlivers(v, ranges)), (id) => getWords(ctx.p, id));
      const d = tidy.doc;
      const cut = v.duration - contentDuration(d);
      save(ctx, d, 'remove_silences', `Cut ${ranges.length} pauses over ${minGap}s (${sec(cut)}s)`);
      return { text: `Cut ${ranges.length} pause${ranges.length === 1 ? '' : 's'} totalling ${sec(cut)}s (${Math.round((cut / v.duration) * 100)}% of the video). ${after(d)} ${shifted}` };
    },
  },
  {
    name: 'remove_fillers',
    description: 'Cut filler words from the main track. aggressiveness 0 = hesitation sounds only (um, uh, erm); 1 = also "you know", "I mean", "sort of" and immediate word repeats ("I I think"); 2 = also "like", "basically", "actually", "literally". Level 2 can remove words that carry meaning, so check the transcript afterwards.',
    schema: obj({ aggressiveness: { type: 'integer', minimum: 0, maximum: 2, description: '0, 1 or 2. Default 0.' } }),
    label: () => 'Removing filler words',
    run: (ctx, a) => {
      const v = view(ctx.p);
      const level = clamp(Math.round(optNum(a.aggressiveness, 'aggressiveness') ?? 0), 0, 2);
      const f = ops.fillerCutRanges(v.words, ops.fillersFor(level));
      const st = level >= 1 ? ops.stutterCutRanges(v.words) : { ranges: [], matched: [], runs: [] };
      const ranges = [...f.ranges, ...st.ranges];
      if (!ranges.length) return { text: 'No filler words were found.' };
      // Each is cut out of its own recording, against what is still in the video at that point.
      let d = v.doc;
      for (const r of [...f.runs, ...st.runs].sort((x, y) => y.from - x.from)) {
        const m = ctx.p.media.get(r.mediaId);
        const ws = getWords(ctx.p, r.mediaId);
        if (m && ws) d = ops.removeSourceSpans(d, m.id, [wordCut(ctx.p, d, m, ws, r.from, r.to)]);
      }
      d = ops.dropScraps(v.doc, d, (id) => getWords(ctx.p, id)).doc;
      const cut = v.duration - contentDuration(d);
      const counts = new Map<string, number>();
      for (const m of [...f.matched, ...st.matched.map((x) => `${x} (repeated)`)]) {
        const k = m.toLowerCase().replace(/[^\p{L}\p{N}' ()]+/gu, '');
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const list = [...counts].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ×${n}`).join(', ');
      save(ctx, d, 'remove_fillers', `Cut ${ranges.length} fillers (${list})`);
      return { text: `Cut ${ranges.length} filler${ranges.length === 1 ? '' : 's'} (${list}), ${sec(cut)}s in all. ${after(d)} ${shifted}` };
    },
  },
  {
    name: 'cut_range',
    description: 'Cut a stretch of timeline time out of the whole video, regardless of words (for example silence at the very start, or a non-speech moment). Prefer remove_words for speech.',
    schema: obj({ start: N('Timeline seconds.'), end: N('Timeline seconds.'), reason: S('One line on why.') }, ['start', 'end', 'reason']),
    label: () => 'Cutting a range',
    run: (ctx, a) => {
      const v = view(ctx.p);
      const start = clamp(num(a.start, 'start'), 0, v.duration);
      const end = clamp(num(a.end, 'end'), 0, v.duration);
      if (end - start < 0.03) bad(`Nothing to cut between ${sec(start)}s and ${sec(end)}s.`);
      const text = ops.wordsInRanges(v.words, [{ start, end }]);
      const d = ops.dropScraps(v.doc, ops.rippleDelete(v.doc, absorbSlivers(v, [{ start, end }])), (id) => getWords(ctx.p, id)).doc;
      save(ctx, d, 'cut_range', str(a.reason) || `Cut ${sec(start)}-${sec(end)}s`);
      return { text: `Cut ${sec(start)}-${sec(end)}s${text ? ` (which said: "${clip(text, 100)}")` : ''}. ${after(d)} ${shifted}` };
    },
  },
  {
    name: 'find_takes',
    description: 'Find lines the speaker attempted more than once (false starts and retakes) in the files on the main track, and record them as take groups. Then use choose_take on each.',
    schema: obj({}),
    label: () => 'Looking for retakes',
    run: (ctx) => {
      const v = view(ctx.p);
      const d = ops.cloneDoc(v.doc);
      const medias = [...new Set(v.layout.flatMap((s) => (s.clip.kind === 'media' ? [s.clip.mediaId] : [])))];
      const found: TakeGroup[] = [];
      for (const id of medias) {
        const ws = getWords(ctx.p, id);
        if (ws?.length) found.push(...findTakes(id, ws, () => ops.uid('k')));
      }
      // Keep decisions already made; replace undecided groups with the fresh search.
      d.takes = [...d.takes.filter((t) => t.chosen !== null), ...found.filter((g) => !d.takes.some((t) => t.chosen !== null && t.mediaId === g.mediaId && t.takes[0].from === g.takes[0].from))];
      if (!found.length) return { text: 'No repeated lines were found.' };
      save(ctx, d, 'find_takes', `Found ${found.length} repeated line(s)`);
      const lines = found.map((g) => {
        const m = ctx.p.media.get(g.mediaId);
        const ws = getWords(ctx.p, g.mediaId) ?? [];
        return `${g.id}:\n${g.takes.map((t, i) => `    take ${i + 1} ${wordId(m, t.from)}-${wordId(m, t.to)}: "${clip(ws.slice(t.from, t.to + 1).map((w) => w.text).join(' '), 110)}"`).join('\n')}`;
      });
      return { text: `Found ${found.length} line${found.length === 1 ? '' : 's'} with more than one attempt:\n${lines.join('\n')}\nUse choose_take for each (take numbers start at 1). Normally keep the last complete one.` };
    },
  },
  {
    name: 'choose_take',
    description: 'Keep one attempt of a repeated line and cut the others. Give a take_group_id from find_takes, or your own list of word ranges (one per attempt). The cut attempts stay available and can be chosen later.',
    schema: obj({
      take_group_id: S('Id of a take group.'),
      ranges: { type: 'array', items: { type: 'string' }, description: 'Alternative to take_group_id: one word range per attempt, e.g. ["a5-a12", "a20-a29"].' },
      take: { type: 'integer', minimum: 1, description: 'Which attempt to keep, counting from 1.' },
      reason: S('One line on why this take.'),
    }, ['take', 'reason']),
    label: () => 'Choosing the best take',
    run: (ctx, a) => {
      const d = ctx.p.doc;
      let group = d.takes.find((t) => t.id === str(a.take_group_id));
      if (!group) {
        if (!Array.isArray(a.ranges) || a.ranges.length < 2) bad('Give a take_group_id from find_takes, or at least two word ranges.');
        const runs = parseWordRefs(ctx.p, a.ranges);
        if (runs.some((r) => r.media.id !== runs[0].media.id)) bad('All attempts must come from the same file.');
        group = { id: ops.uid('k'), mediaId: runs[0].media.id, takes: runs.map((r) => ({ from: r.from, to: r.to })), chosen: null };
      }
      const m = ctx.p.media.get(group.mediaId);
      const ws = getWords(ctx.p, group.mediaId);
      if (!m || !ws) bad('That take group refers to a file that is no longer in the project.');
      const index = Math.round(num(a.take, 'take')) - 1;
      if (index < 0 || index >= group.takes.length) bad(`This line has ${group.takes.length} takes; choose 1 to ${group.takes.length}.`);
      const next = ops.chooseTake(d, group, index, ws, m, str(a.reason));
      save(ctx, next, 'choose_take', str(a.reason) || `Kept take ${index + 1}`);
      const kept = group.takes[index];
      return { text: `Kept take ${index + 1} ("${clip(ws.slice(kept.from, kept.to + 1).map((w) => w.text).join(' '), 90)}") and cut the other ${group.takes.length - 1}. ${after(next)} ${shifted}` };
    },
  },
  {
    name: 'reorder_segments',
    description: 'Rearrange the main track. Give segment ids in the new order; any you leave out keep their order after the listed ones. Use it to move the strongest line to the front as a hook.',
    schema: obj({ segment_ids: { type: 'array', items: { type: 'string' }, description: 'Main segment ids, in the order they should play.' } }, ['segment_ids']),
    label: () => 'Reordering the story',
    run: (ctx, a) => {
      const ids = Array.isArray(a.segment_ids) ? a.segment_ids.map(str) : [];
      const d = ctx.p.doc;
      const unknown = ids.filter((id) => !d.main.some((c) => c.id === id));
      if (unknown.length) bad(`Not main segment ids: ${unknown.join(', ')}. Call get_timeline for current ids.`);
      const next = ops.reorderMain(d, ids);
      save(ctx, next, 'reorder_segments', 'Reordered the main track');
      return { text: `New order: ${layoutMain(next).map((x) => `${x.clip.id} ${sec(x.start)}-${sec(x.end)}`).join(', ')}. Graphics, b-roll, punch-ins and effects moved with the footage they sat over. ${shifted}` };
    },
  },
  {
    name: 'split_clip',
    description: 'Split the main segment at a timeline time into two, without removing anything. Needed before reordering part of a segment or adding a transition mid-clip.',
    schema: obj({ at: N('Timeline seconds.') }, ['at']),
    label: () => 'Splitting a clip',
    run: (ctx, a) => {
      const d = ctx.p.doc;
      const next = ops.splitAt(d, num(a.at, 'at'));
      if (next.main.length === d.main.length) return { text: `No split made: ${sec(num(a.at, 'at'))}s is not inside a main segment (or is on a cut already).` };
      save(ctx, next, 'split_clip', `Split at ${sec(num(a.at, 'at'))}s`);
      return { text: `Split. Main segments: ${layoutMain(next).map((s) => `${s.clip.id} ${sec(s.start)}-${sec(s.end)}`).join(', ')}.` };
    },
  },
  {
    name: 'update_item',
    description: 'Change any item on the timeline (main segment, b-roll, audio, graphic or punch-in) by id. Only the fields you give change. For graphics, pass content changes in props (text, title, subtitle, color, ...).',
    schema: obj({
      item_id: S('Id from get_timeline.'),
      start: N('New start time (not for main segments).'),
      end: N('New end time.'),
      duration: N('New length in seconds.'),
      source_start: N('Clips: start within the file.'),
      source_end: N('Clips: end within the file.'),
      volume_db: N('Clips: level change in dB (0 = original, -6 = half).'),
      muted: B('Clips: silence the clip.'),
      speed: N('Clips: playback speed, 1 = normal (a plain speed replaces any speed ramp; use set_speed for ramps, reverse and freeze frames).'),
      fade_in_s: N('Clips: fade in.'),
      fade_out_s: N('Clips: fade out.'),
      x: N('Graphics and picture-in-picture: horizontal centre, 0-1.'),
      y: N('Vertical centre, 0-1.'),
      scale: N('Size multiplier (graphics, picture-in-picture, punch-in amount).'),
      rotation: N('Graphics: degrees.'),
      opacity: N('0-1.'),
      name: S('Label on the timeline.'),
      props: { type: 'object', description: 'Graphics: fields to change, merged into the existing ones.' },
      focus_x: N('Punch-ins: point to close in on.'),
      focus_y: N('Punch-ins: point to close in on.'),
    }, ['item_id']),
    label: () => 'Adjusting an item',
    run: (ctx, a) => {
      const v = view(ctx.p);
      const it = findItem(v, a.item_id);
      let d = v.doc;
      const fps = d.settings.fps;
      const start = optNum(a.start, 'start');
      const end = optNum(a.end, 'end');
      const duration = optNum(a.duration, 'duration');
      if (it.kind === 'graphic' || it.kind === 'zoom') {
        const ns = start ?? it.start;
        const nd = end !== undefined ? end - ns : (duration ?? it.end - it.start);
        if (nd < 2 / fps) bad('The item would have no length.');
        if (it.kind === 'graphic') {
          const patch: Record<string, unknown> = { start: ns, duration: nd };
          for (const k of ['x', 'y', 'scale', 'rotation', 'opacity'] as const) if (a[k] !== undefined) patch[k] = num(a[k], k);
          if (a.name !== undefined) patch.name = str(a.name);
          if (a.props && typeof a.props === 'object') patch.props = a.props as Record<string, unknown>;
          d = ops.updateGraphic(d, it.id, patch);
        } else {
          const patch: Record<string, unknown> = { start: ns, duration: nd };
          if (a.scale !== undefined) patch.scale = clamp(num(a.scale, 'scale'), 1, 4);
          if (a.focus_x !== undefined) patch.focusX = clamp(num(a.focus_x, 'focus_x'), 0, 1);
          if (a.focus_y !== undefined) patch.focusY = clamp(num(a.focus_y, 'focus_y'), 0, 1);
          if (a.name !== undefined) patch.name = str(a.name);
          d = ops.updateZoom(d, it.id, patch);
        }
      } else {
        const cur = sourceClip(d, it.kind, it.id);
        if (!cur) {
          // A colour card: only its length and name can change.
          d = ops.updateClip(d, 'main', it.id, { duration: duration ?? (end !== undefined ? end - it.start : undefined), name: a.name !== undefined ? str(a.name) : undefined });
        } else {
          const media = ctx.p.media.get(cur.mediaId);
          const md = media && media.kind !== 'image' ? media.duration : undefined;
          const patch: Record<string, unknown> = {};
          if (a.source_start !== undefined) patch.in = Math.max(0, num(a.source_start, 'source_start'));
          if (a.source_end !== undefined) patch.out = num(a.source_end, 'source_end');
          if (a.volume_db !== undefined) patch.volume = clamp(dbToGain(num(a.volume_db, 'volume_db')), 0, 4);
          if (a.muted !== undefined) patch.muted = !!a.muted;
          if (a.speed !== undefined) patch.speed = clamp(num(a.speed, 'speed'), 0.1, 8);
          if (a.fade_in_s !== undefined) patch.fadeIn = Math.max(0, num(a.fade_in_s, 'fade_in_s'));
          if (a.fade_out_s !== undefined) patch.fadeOut = Math.max(0, num(a.fade_out_s, 'fade_out_s'));
          if (a.name !== undefined) patch.name = str(a.name);
          if (it.kind !== 'main') {
            if (start !== undefined) patch.start = Math.max(0, start);
            if (a.opacity !== undefined && it.kind === 'overlay') patch.opacity = clamp(num(a.opacity, 'opacity'), 0, 1);
            if (it.kind === 'overlay' && (a.x !== undefined || a.y !== undefined || a.scale !== undefined)) {
              const o = d.overlays.find((c) => c.id === it.id)!;
              patch.transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1, ...(o.transform ?? {}), ...(a.x !== undefined ? { x: num(a.x, 'x') } : {}), ...(a.y !== undefined ? { y: num(a.y, 'y') } : {}), ...(a.scale !== undefined ? { scale: clamp(num(a.scale, 'scale'), 0.05, 1) } : {}) };
            }
          }
          const inn = (patch.in as number | undefined) ?? cur.in;
          const want = duration ?? (end !== undefined ? end - (start ?? it.start) : undefined);
          if (want !== undefined && patch.out === undefined) {
            // How far into the source `want` seconds reach, through the clip's speed or ramp (a new speed replaces the ramp).
            const probe = { ...cur, ...(patch as Partial<typeof cur>), in: inn, reverse: false };
            if (patch.speed !== undefined) delete probe.ramp;
            patch.out = sourceAt(probe, want);
          }
          d = ops.updateClip(d, it.kind, it.id, patch, md);
        }
      }
      save(ctx, d, 'update_item', `Adjusted ${it.kind} ${it.id}`);
      const now = findItem(view(ctx.p), it.id);
      return { text: `Updated ${it.kind} ${it.id}; it now runs ${sec(now.start)}-${sec(now.end)}s. ${after(d)}` };
    },
  },
  {
    name: 'delete_item',
    description: 'Remove an item from the timeline by id. Removing a main segment closes the gap (later items move earlier).',
    schema: obj({ item_id: S('Id from get_timeline.'), reason: S('One line on why.') }, ['item_id']),
    label: () => 'Removing an item',
    run: (ctx, a) => {
      const v = view(ctx.p);
      const it = findItem(v, a.item_id);
      const d = ops.removeItem(v.doc, { kind: it.kind, id: it.id });
      save(ctx, d, 'delete_item', str(a.reason) || `Removed ${it.kind} ${it.id}`);
      return { text: `Removed ${it.kind} ${it.id}. ${after(d)}${it.kind === 'main' ? ` ${shifted}` : ''}` };
    },
  },

  // ------------------------------------------------------------------ picture
  {
    name: 'set_aspect',
    description: 'Change the shape of the video: 9:16 (Reels, TikTok, Shorts), 16:9, 1:1 or 4:5. Clips are re-cropped around their focus point; check framing afterwards.',
    schema: obj({ aspect: S('Target shape.', Object.keys(ASPECTS)) }, ['aspect']),
    label: (a) => `Changing the format to ${str(a.aspect)}`,
    run: (ctx, a) => {
      const t = ASPECTS[str(a.aspect)];
      if (!t) bad(`Unknown aspect "${a.aspect}". Use ${Object.keys(ASPECTS).join(', ')}.`);
      const d = ops.setSettings(ctx.p.doc, { width: t.width, height: t.height });
      save(ctx, d, 'set_aspect', `Format ${a.aspect}`);
      return { text: `The video is now ${a.aspect} (${t.width}x${t.height}). Clips whose shape differs are cropped to fill; use set_reframe to choose what stays in view.` };
    },
  },
  {
    name: 'set_reframe',
    description: 'Choose how clips are cropped into the frame. mode "track" follows the speaker\'s face (use this when horizontal footage goes vertical); "center" crops around the middle; "manual" uses focus_x/focus_y. fit "contain" shows the whole picture with bars, optionally filled with a blurred copy. Applies to one clip, or to every clip on the main track when clip_id is omitted.',
    schema: obj({
      clip_id: S('A main or b-roll clip id. Omit for all main clips.'),
      mode: S('How the crop is chosen.', ['track', 'center', 'manual']),
      focus_x: N('Manual: the point kept in view, 0 = left edge, 1 = right.'),
      focus_y: N('Manual: 0 = top, 1 = bottom.'),
      zoom: N('Extra zoom, 1 = none.'),
      fit: S('"cover" fills the frame (default); "contain" shows everything.', ['cover', 'contain']),
      blur_fill: B('With contain: fill the bars with a blurred copy of the picture.'),
    }, ['mode']),
    label: () => 'Reframing',
    run: async (ctx, a) => {
      let d = ctx.p.doc;
      const mode = str(a.mode);
      const targets: { kind: 'main' | 'overlay' | 'audio' | 'graphic' | 'zoom'; id: string }[] = a.clip_id
        ? [findItem(view(ctx.p), a.clip_id)].filter((t) => t.kind === 'main' || t.kind === 'overlay')
        : layoutMain(d).filter((s) => s.clip.kind === 'media').map((s) => ({ kind: 'main' as const, id: s.clip.id }));
      if (!targets.length) bad('There are no clips to reframe.');
      const notes: string[] = [];
      const seen = new Set<string>();
      for (const t of targets) {
        const c = sourceClip(d, t.kind, t.id);
        if (!c) continue;
        const m = ctx.p.media.get(c.mediaId);
        if (!m) continue;
        let track = false;
        if (mode === 'track' && m.kind === 'video') {
          const faces = getFaces(ctx.p, m.id) ?? (await analyzeFaces(ctx.p, m.id, ctx.signal)) ?? undefined;
          const cover = faceCoverage(faces);
          track = cover > 0.2;
          if (!seen.has(m.id)) {
            seen.add(m.id);
            notes.push(track ? `"${m.name}": a face is in view for ${Math.round(cover * 100)}% of the clip; the crop follows it.` : `"${m.name}": no face found, so it stays centred.`);
          }
        }
        const base = { ...DEFAULT_FRAMING, ...(c.framing ?? {}) };
        const framing = {
          ...base,
          track,
          fit: (a.fit === 'contain' || a.fit === 'cover' ? a.fit : base.fit) as 'cover' | 'contain',
          blurFill: a.blur_fill !== undefined ? !!a.blur_fill : base.blurFill,
          scale: a.zoom !== undefined ? clamp(num(a.zoom, 'zoom'), 0.2, 4) : base.scale,
          focusX: mode === 'center' ? 0.5 : mode === 'manual' ? clamp(optNum(a.focus_x, 'focus_x') ?? base.focusX, 0, 1) : base.focusX,
          focusY: mode === 'center' ? 0.5 : mode === 'manual' ? clamp(optNum(a.focus_y, 'focus_y') ?? base.focusY, 0, 1) : base.focusY,
        };
        d = ops.updateClip(d, t.kind as 'main' | 'overlay', t.id, { framing }, m.kind === 'image' ? undefined : m.duration);
      }
      save(ctx, d, 'set_reframe', `Reframed ${targets.length} clip(s): ${mode}`);
      return { text: `Reframed ${targets.length} clip${targets.length === 1 ? '' : 's'} (${mode}).${notes.length ? ` ${notes.join(' ')}` : ''} Use inspect_frames to check.` };
    },
  },
  {
    name: 'add_zoom',
    description: 'Add a punch-in on the main track for emphasis. A quick cut-in of 1.15-1.3x on a key line is the classic; ease "smooth" with to_scale gives a slow push-in; shake makes the picture shake instead (a hit, a beat drop, a reveal). If no focus is given it closes in on the speaker\'s face when one is known. Vary the amount between punch-ins so they do not feel mechanical.',
    schema: obj({
      ...WHEN,
      scale: N('Zoom amount, e.g. 1.2. Default 1.2.'),
      to_scale: N('If set, the zoom drifts from scale to this over its length.'),
      focus_x: N('0-1. Default: the face, or the middle.'),
      focus_y: N('0-1.'),
      ease: S('"cut" snaps in (default), "smooth" eases in and out.', ['cut', 'smooth']),
      shake: N('0-1: shake the picture for the length of the item instead of zooming (a hit, a drop, a shock); 0.3-0.5 s is enough. Use scale 1 with it.'),
      name: S('Label on the timeline.'),
    }),
    label: (a) => (a.shake ? 'Adding a shake' : 'Adding a punch-in'),
    run: (ctx, a) => {
      const v = view(ctx.p);
      const { start, duration } = span(ctx.p, a, v, 2.5);
      let fx = optNum(a.focus_x, 'focus_x');
      let fy = optNum(a.focus_y, 'focus_y');
      let how = '';
      if (fx === undefined || fy === undefined) {
        const face = faceInFrame(v.doc, lintContext(ctx.p, v), start + Math.min(0.3, duration / 2));
        if (face) {
          fx ??= clamp(face.x, 0.2, 0.8);
          fy ??= clamp(face.y, 0.15, 0.7);
          how = ' on the face';
        }
      }
      const r = ops.addZoom(v.doc, {
        start,
        duration,
        scale: optNum(a.scale, 'scale') ?? 1.2,
        toScale: optNum(a.to_scale, 'to_scale'),
        focusX: fx ?? 0.5,
        focusY: fy ?? 0.4,
        ease: a.ease === 'smooth' ? 'smooth' : 'cut',
        shake: optNum(a.shake, 'shake'),
        name: str(a.name) || (a.shake ? 'Shake' : 'Punch-in'),
        createdBy: ctx.messageId,
      });
      save(ctx, r.doc, 'add_zoom', `Punch-in at ${sec(start)}s`);
      return { text: `Added punch-in ${r.item.id}: ${sec(r.item.start)}-${sec(r.item.start + r.item.duration)}s at ${r.item.scale.toFixed(2)}x${r.item.toScale ? ` to ${r.item.toScale.toFixed(2)}x` : ''}${how}.` };
    },
  },
  {
    name: 'add_transition',
    description: 'Make a main segment arrive from the previous one with a transition instead of a plain cut: fade (cross fade), dip (to black), flash (white flash, for energy and beats), slide-left, slide-right, slide-up, whip (fast blurred whip pan), zoom, blur (one picture blurs into the next), glitch (digital tearing, for tech or chaos), burn (film burn: the picture flares orange and white from a corner, for nostalgia, travel, film looks), or none to remove. Plain cuts are best inside a talking sequence; use transitions sparingly, for a change of scene or topic.',
    schema: obj({ clip_id: S('The segment that arrives (the second of the pair).'), type: S('Transition.', ['fade', 'dip', 'flash', 'slide-left', 'slide-right', 'slide-up', 'whip', 'zoom', 'blur', 'glitch', 'burn', 'none']), duration_s: N('Length. Default 0.4.') }, ['clip_id', 'type']),
    label: () => 'Adding a transition',
    run: (ctx, a) => {
      const v = view(ctx.p);
      const seg = v.layout.find((s) => s.clip.id === str(a.clip_id));
      if (!seg) bad(`"${a.clip_id}" is not a main segment.`);
      if (seg.index === 0) bad('The first segment has nothing to transition from.');
      const type = str(a.type);
      const d = ops.setTransition(v.doc, seg.clip.id, type === 'none' ? null : { type: type as 'fade', duration: optNum(a.duration_s, 'duration_s') ?? 0.4 });
      save(ctx, d, 'add_transition', `${type} into segment ${seg.index + 1}`);
      return { text: type === 'none' ? `Segment ${seg.index + 1} now arrives with a plain cut.` : `Segment ${seg.index + 1} (${seg.clip.id}) now arrives with a ${type}.` };
    },
  },
  {
    name: 'set_clip_look',
    description: `Grade the colour of a main or b-roll clip, or every main clip when clip_id is "all". Start from a look (${Object.keys(LOOKS).join(', ')}) or from the clip's current grade, then set values. Basic: brightness/contrast/saturation (multipliers, 1 = unchanged), black_and_white 0-1, blur, warmth -1..1, vignette, sepia, grain, cinema_bars 0-0.25, mirror. Lightroom-style: exposure (stops, -2..2), highlights and shadows (-1..1: pull down blown skies with highlights -0.4, open dark faces with shadows +0.3), whites and blacks (-1..1), temperature (-1 blue..1 amber) and tint (-1 green..1 magenta) to fix a colour cast, vibrance (-1..1, saturates muted colours first). curve_rgb (and curve_r/g/b): points of [in, out] in 0..1, e.g. a gentle S [[0,0],[0.25,0.2],[0.75,0.8],[1,1]] for contrast, [[0,0.08],[1,1]] lifts the blacks for a matte film look. hsl: per hue range (red, orange, yellow, green, aqua, blue, purple, magenta) {hue, sat, lum} each -1..1, e.g. {"orange":{"sat":-0.3}} tames skin, {"green":{"hue":0.3,"sat":-0.2}} makes foliage teal. lut: the name of an imported .cube LUT (list_library kind=luts) with lut_amount 0-1. copy_from: a clip id whose grade is copied to the targets (the way to match clips). Pass reset to clear. For a consistent piece grade all main clips together (clip_id "all").`,
    schema: obj({
      clip_id: S('Clip id, or "all" for every main clip.'),
      look: S('A ready-made look.', Object.keys(LOOKS)),
      copy_from: S('A clip id whose grade is copied to the targets.'),
      brightness: N('1 = unchanged.'),
      contrast: N('1 = unchanged.'),
      saturation: N('1 = unchanged.'),
      black_and_white: N('0-1.'),
      blur: N('0-1, 1 = heavy blur.'),
      warmth: N('-1 cool to 1 warm.'),
      vignette: N('0-1.'),
      sepia: N('0-1.'),
      grain: N('0-1.'),
      bloom: N('Glow on the bright parts, 0-1 (0.3 is dreamy, 0.7 is a haze).'),
      rgb_split: N('Colour fringing: the red and blue channels pulled apart, as a fraction of the width (0.004 subtle, 0.012 strong; for glitch, VHS, hype).'),
      cinema_bars: N('0-0.25 of the height.'),
      mirror: B('Flip the picture left to right.'),
      exposure: N('Stops, -2..2.'),
      highlights: N('-1..1.'),
      shadows: N('-1..1.'),
      whites: N('-1..1.'),
      blacks: N('-1..1.'),
      temperature: N('-1 blue to 1 amber.'),
      tint: N('-1 green to 1 magenta.'),
      vibrance: N('-1..1.'),
      curve_rgb: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Master curve points [[in,out],...] in 0..1.' },
      curve_r: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Red curve points.' },
      curve_g: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Green curve points.' },
      curve_b: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'Blue curve points.' },
      hsl: { type: 'object', description: 'Per hue range {hue, sat, lum} in -1..1, e.g. {"orange":{"sat":-0.3}}.' },
      lut: S('Name of an imported .cube LUT, or "" to remove it.'),
      lut_amount: N('0-1, default 1.'),
      reset: B('Remove all adjustments.'),
    }, ['clip_id']),
    label: () => 'Adjusting colour',
    run: (ctx, a) => {
      const v = view(ctx.p);
      const targets = str(a.clip_id) === 'all' ? v.layout.filter((s) => s.clip.kind === 'media').map((s) => ({ kind: 'main' as const, id: s.clip.id })) : [findItem(v, a.clip_id)];
      let d = v.doc;
      let n = 0;
      for (const it of targets) {
        if (it.kind !== 'main' && it.kind !== 'overlay') bad('Colour can only be adjusted on main and b-roll clips.');
        const cur = sourceClip(d, it.kind, it.id);
        if (!cur) continue;
        const from = a.copy_from ? sourceClip(d, findItem(v, a.copy_from).kind as 'main' | 'overlay', str(a.copy_from)) : undefined;
        if (a.copy_from && !from) bad(`No clip ${a.copy_from} to copy the grade from.`);
        // A copied grade or a look brings its colour, not the clip's own stabilising.
        const own = { ...(cur.fx?.stabilize ? { stabilize: cur.fx.stabilize } : {}) };
        const base = { ...(a.look ? (LOOKS[str(a.look)]?.fx ?? bad(`Unknown look "${a.look}". Use ${Object.keys(LOOKS).join(', ')}.`)) : from ? { ...(from.fx ?? {}), stabilize: undefined } : cur.fx ?? {}), ...own };
        const signed = (key: string, lo = -1, hi = 1) => (a[key] !== undefined ? { [key]: clamp(num(a[key], key), lo, hi) || undefined } : {});
        const curve = (key: string) => {
          const pts = a[key];
          if (pts === undefined) return {};
          if (!Array.isArray(pts) || pts.some((p) => !Array.isArray(p) || p.length !== 2)) bad(`${key} must be a list of [in, out] pairs.`);
          return { [key]: (pts as number[][]).map(([x, y]) => [clamp(x, 0, 1), clamp(y, 0, 1)] as [number, number]) };
        };
        const curves = { ...(base.curves ?? {}), ...(curve('curve_rgb').curve_rgb ? { rgb: curve('curve_rgb').curve_rgb } : {}), ...(curve('curve_r').curve_r ? { r: curve('curve_r').curve_r } : {}), ...(curve('curve_g').curve_g ? { g: curve('curve_g').curve_g } : {}), ...(curve('curve_b').curve_b ? { b: curve('curve_b').curve_b } : {}) };
        if (a.hsl !== undefined && (typeof a.hsl !== 'object' || a.hsl === null)) bad('hsl must be an object such as {"orange":{"sat":-0.3}}.');
        const hsl = a.hsl ? { ...(base.hsl ?? {}), ...(a.hsl as Record<string, { hue?: number; sat?: number; lum?: number }>) } : base.hsl;
        if (a.lut && !readLut(str(a.lut))) bad(`No LUT named "${a.lut}" in the library (list_library kind=luts).`);
        const fx = a.reset
          ? undefined
          : {
              ...base,
              ...signed('exposure', -2, 2),
              ...signed('highlights'),
              ...signed('shadows'),
              ...signed('whites'),
              ...signed('blacks'),
              ...signed('temperature'),
              ...signed('tint'),
              ...signed('vibrance'),
              ...(Object.keys(curves).length ? { curves } : {}),
              ...(hsl && Object.keys(hsl).length ? { hsl } : {}),
              ...(a.lut !== undefined ? { lut: str(a.lut) || undefined } : {}),
              ...(a.lut_amount !== undefined ? { lutAmount: clamp(num(a.lut_amount, 'lut_amount'), 0, 1) } : {}),
              ...(a.brightness !== undefined ? { brightness: clamp(num(a.brightness, 'brightness'), 0.2, 2) } : {}),
              ...(a.contrast !== undefined ? { contrast: clamp(num(a.contrast, 'contrast'), 0.2, 2) } : {}),
              ...(a.saturation !== undefined ? { saturation: clamp(num(a.saturation, 'saturation'), 0, 3) } : {}),
              ...(a.black_and_white !== undefined ? { grayscale: clamp(num(a.black_and_white, 'black_and_white'), 0, 1) } : {}),
              ...(a.blur !== undefined ? { blur: clamp(num(a.blur, 'blur'), 0, 1) * 0.03 } : {}),
              ...(a.warmth !== undefined ? { warmth: clamp(num(a.warmth, 'warmth'), -1, 1) } : {}),
              ...(a.vignette !== undefined ? { vignette: clamp(num(a.vignette, 'vignette'), 0, 1) } : {}),
              ...(a.sepia !== undefined ? { sepia: clamp(num(a.sepia, 'sepia'), 0, 1) } : {}),
              ...(a.grain !== undefined ? { grain: clamp(num(a.grain, 'grain'), 0, 1) } : {}),
              ...(a.bloom !== undefined ? { bloom: clamp(num(a.bloom, 'bloom'), 0, 1) || undefined } : {}),
              ...(a.rgb_split !== undefined ? { rgbSplit: clamp(num(a.rgb_split, 'rgb_split'), 0, 0.05) || undefined } : {}),
              ...(a.cinema_bars !== undefined ? { letterbox: clamp(num(a.cinema_bars, 'cinema_bars'), 0, 0.25) } : {}),
              ...(a.mirror !== undefined ? { flip: !!a.mirror || undefined } : {}),
            };
        d = ops.updateClip(d, it.kind, it.id, { fx });
        n++;
      }
      if (!n) bad('No clip with a picture to adjust.');
      save(ctx, d, 'set_clip_look', a.look ? `Look: ${str(a.look)}` : a.copy_from ? 'Match grade' : 'Colour');
      return { text: a.reset ? `Cleared colour adjustments on ${n} clip${n === 1 ? '' : 's'}.` : `Updated the grade of ${n} clip${n === 1 ? '' : 's'}${a.look ? ` (${LOOKS[str(a.look)].label})` : a.copy_from ? ` (copied from ${str(a.copy_from)})` : ''}.` };
    },
  },

  // ------------------------------------------------------------------ graphics
  {
    name: 'add_text',
    description: `Put text on screen. Styles: hook (bold on a white box, for the opening line), title (huge outlined), subtitle, label (small pill), serif, card (plain, for title cards), meme (block capitals with an outline, top of the frame), comic (BOOM-style lettering, pops in), sticker (tilted yellow sticker, bounces in), neon (glowing script), handwritten (tilted marker handwriting), marker (highlighter stroke behind the words), quote (serif in quotation marks), glitch (cyan and magenta tearing), gradient (two-colour fill, flies in), typewriter (typed in letter by letter on a dark box). Wrap a word in *asterisks* to give it the accent colour. Keep it short: 3-6 words reads in a second or two. The font can match the mood (comic, handwritten, elegant, hype): list_library kind=fonts describes each. ${POSITION}`,
    schema: obj({
      text: S('What it says. Use \\n for a line break.'),
      ...WHEN,
      style: S('Preset.', ['hook', 'title', 'subtitle', 'label', 'serif', 'card', 'meme', 'comic', 'sticker', 'neon', 'handwritten', 'marker', 'quote', 'glitch', 'gradient', 'typewriter']),
      position: S('Named position or "auto".'),
      x: N('0-1.'),
      y: N('0-1.'),
      font: S('Font family.', FONT_FAMILIES),
      size: N('Size multiplier, 1 = the preset\'s size.'),
      color: S('Text colour, #RRGGBB.'),
      background: S('Box colour behind the text, #RRGGBB or #RRGGBBAA; "" for none.'),
      accent: S('Colour for *starred* words.'),
      name: S('Label on the timeline, e.g. "Hook".'),
    }, ['text']),
    label: () => 'Adding text',
    run: (ctx, a) => {
      const v = view(ctx.p);
      const style = GRAPHIC_PRESETS[str(a.style)]?.template === 'text' ? str(a.style) : 'hook';
      const preset = GRAPHIC_PRESETS[style];
      const { start, duration } = span(ctx.p, a, v, preset.duration);
      const pos = a.position === undefined && a.x === undefined && a.y === undefined ? { x: preset.x, y: preset.y, how: `the ${style} position` } : place(ctx.p, v, a.position ?? 'auto', start + Math.min(0.5, duration / 2), optNum(a.x, 'x'), optNum(a.y, 'y'));
      const props: Record<string, unknown> = { text: str(a.text).replace(/\\n/g, '\n') };
      if (a.font !== undefined && FONT_FAMILIES.includes(str(a.font))) {
        props.font = str(a.font);
        props.weight = nearestWeight(str(a.font), Number(preset.props.weight ?? 700));
      }
      if (a.size !== undefined) props.size = Number(preset.props.size ?? 0.07) * clamp(num(a.size, 'size'), 0.3, 4);
      if (a.color !== undefined) props.color = str(a.color);
      if (a.background !== undefined) props.background = str(a.background);
      if (a.accent !== undefined) props.accent = str(a.accent);
      const r = ops.addGraphic(v.doc, { preset: style, props, start, duration, x: pos.x, y: pos.y, name: str(a.name) || `${preset.label}: ${clip(str(a.text), 24)}`, createdBy: ctx.messageId });
      save(ctx, r.doc, 'add_text', `Text "${clip(str(a.text), 40)}" at ${sec(start)}s`);
      return { text: `Added text ${r.item.id} "${clip(str(a.text), 50)}" ${sec(start)}-${sec(start + duration)}s at x=${pos.x.toFixed(2)} y=${pos.y.toFixed(2)} (${pos.how}).` };
    },
  },
  {
    name: 'add_motion_graphic',
    description: `Add an animated graphic. Templates and their props:
- popup: emoji, title, subtitle (a card for a fact or definition)
- comment: author, text, likes (a viewer comment bubble)
- headline: source, title, subtitle (a press clipping or quote card)
- lower-third: title (name), subtitle (role)
- callout: text, target_x, target_y (a label with a line to a point in the frame)
- counter: from, to, prefix, suffix, label (a number that counts up)
- list: title, items[] (points arriving one by one; give it enough time)
- highlight: w, h (fractions of the frame), shape box|ellipse|underline, spotlight (dims the rest)
- emoji: emoji
- progress: (a bar that fills across the top over its duration)
All cards accept theme light|dark and accent (#RRGGBB). ${POSITION} Give each a short descriptive name. Do not stack two graphics in the same place at the same time.`,
    schema: obj({
      template: S('Which graphic.', GRAPHIC_TEMPLATES.filter((t) => t !== 'text' && t !== 'image')),
      ...WHEN,
      props: { type: 'object', description: 'Content for the template, as listed above.' },
      position: S('Named position or "auto".'),
      x: N('0-1.'),
      y: N('0-1.'),
      scale: N('Size multiplier, 1 = normal.'),
      anim_in: S('Entrance.', ['none', 'fade', 'pop', 'bounce', 'zoom', 'slide-up', 'slide-down', 'slide-left', 'slide-right']),
      name: S('Label on the timeline, e.g. "Credibility comment popup".'),
    }, ['template', 'props']),
    label: (a) => `Adding a ${str(a.template).replace('-', ' ')}`,
    run: (ctx, a) => {
      const v = view(ctx.p);
      const template = str(a.template);
      const preset = GRAPHIC_PRESETS[template];
      if (!preset || template === 'text') bad(`Unknown template "${template}".`);
      const { start, duration } = span(ctx.p, a, v, preset.duration);
      const raw = (a.props && typeof a.props === 'object' ? a.props : {}) as Record<string, unknown>;
      const props: Record<string, unknown> = { ...raw };
      if (raw.target_x !== undefined) props.targetX = raw.target_x;
      if (raw.target_y !== undefined) props.targetY = raw.target_y;
      delete props.target_x;
      delete props.target_y;
      const free = a.position === undefined && a.x === undefined && a.y === undefined;
      const pos = template === 'progress' ? { x: 0.5, y: 0, how: 'top edge' } : free && template === 'lower-third' ? { x: preset.x, y: undefined, how: 'lower left' } : place(ctx.p, v, a.position ?? 'auto', start + Math.min(0.5, duration / 2), optNum(a.x, 'x'), optNum(a.y, 'y'));
      const r = ops.addGraphic(v.doc, {
        preset: template,
        props,
        start,
        duration,
        x: pos.x,
        y: pos.y,
        scale: optNum(a.scale, 'scale'),
        animIn: a.anim_in ? (str(a.anim_in) as 'pop') : undefined,
        name: str(a.name) || preset.label,
        createdBy: ctx.messageId,
      });
      save(ctx, r.doc, 'add_motion_graphic', `${preset.label} at ${sec(start)}s`);
      return { text: `Added ${template} ${r.item.id} "${r.item.name}" ${sec(start)}-${sec(start + duration)}s at x=${r.item.x.toFixed(2)} y=${r.item.y.toFixed(2)} (${pos.how}).` };
    },
  },
  {
    name: 'add_keyframes',
    description: 'Animate an item over its life. For a graphic or a picture-in-picture clip, each keyframe gives a time t (seconds after the item starts) and any of x, y, scale, rotation, opacity (its placement). For the picture inside a main or b-roll clip, give zoom (framing scale, 1 = none), focus_x and focus_y (0-1, the point kept centred): a slow push-in, a pan, a Ken Burns drift on a photo. Values ease between keyframes (ease: linear, in, out, inout, back). Replaces the item\'s existing keyframes of that kind. For the common moves, add_motion is quicker.',
    schema: obj({
      item_id: S('A graphic, b-roll or main clip id.'),
      keyframes: {
        type: 'array',
        items: { type: 'object', properties: { t: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, scale: { type: 'number' }, rotation: { type: 'number' }, opacity: { type: 'number' }, zoom: { type: 'number' }, focus_x: { type: 'number' }, focus_y: { type: 'number' }, ease: { type: 'string', enum: ['linear', 'in', 'out', 'inout', 'back'] } }, required: ['t'] },
        description: 'At least two keyframes.',
      },
    }, ['item_id', 'keyframes']),
    label: () => 'Animating an item',
    run: (ctx, a) => {
      const v = view(ctx.p);
      const it = findItem(v, a.item_id);
      if (it.kind !== 'graphic' && it.kind !== 'overlay' && it.kind !== 'main') bad('Keyframes apply to graphics, b-roll and main clips.');
      const raw = (Array.isArray(a.keyframes) ? a.keyframes : []) as Record<string, unknown>[];
      const motionKeys = raw.some((k) => k.zoom !== undefined || k.focus_x !== undefined || k.focus_y !== undefined);
      if (raw.length < 2) bad('Give at least two keyframes.');
      let d = v.doc;
      if (motionKeys || it.kind === 'main') {
        if (it.kind === 'graphic') bad('A graphic has no picture to zoom; use x, y, scale, rotation, opacity.');
        const kfs = raw.map((o) => {
          const out: Record<string, unknown> = { t: Math.max(0, num(o.t, 't')) };
          if (o.zoom !== undefined) out.scale = clamp(num(o.zoom, 'zoom'), 1, 4);
          if (o.focus_x !== undefined) out.focusX = clamp(num(o.focus_x, 'focus_x'), 0, 1);
          if (o.focus_y !== undefined) out.focusY = clamp(num(o.focus_y, 'focus_y'), 0, 1);
          if (typeof o.ease === 'string') out.ease = o.ease;
          return out as { t: number };
        });
        d = ops.setMotion(d, it.kind as 'main' | 'overlay', it.id, kfs);
        save(ctx, d, 'add_keyframes', `Moved the picture of ${it.id}`);
        return { text: `Set ${kfs.length} motion keyframes on ${it.kind} clip ${it.id}.` };
      }
      const kfs = raw.map((o) => {
        const out: Record<string, unknown> = { t: Math.max(0, num(o.t, 't')) };
        for (const key of ['x', 'y', 'scale', 'rotation', 'opacity'] as const) if (o[key] !== undefined) out[key] = num(o[key], key);
        if (typeof o.ease === 'string') out.ease = o.ease;
        return out as { t: number };
      });
      d = ops.setKeyframes(d, it.kind as 'overlay' | 'graphic', it.id, kfs);
      save(ctx, d, 'add_keyframes', `Animated ${it.id}`);
      return { text: `Set ${kfs.length} keyframes on ${it.kind} ${it.id}.` };
    },
  },
  {
    name: 'group_sequence',
    description: 'Group a run of main segments (and the b-roll, text, punch-ins and sound that sit over them) into one nested sequence: it is rendered once and then sits on the main track as a single clip, so speed, a transition, a mask, a grade or a freeze can apply to the whole group. Rendering takes a few seconds per ten seconds of footage. Expand it again with expand_sequence to change what is inside.',
    schema: obj({ from_clip_id: S('The first main segment of the run.'), to_clip_id: S('The last one (default: the next segment).'), name: S('A name for the sequence.') }, ['from_clip_id']),
    label: (a) => `Grouping into ${str(a.name) || 'a sequence'}`,
    run: async (ctx, a) => {
      const v = view(ctx.p);
      const from = findItem(v, a.from_clip_id);
      if (from.kind !== 'main') bad('Only main segments can be grouped.');
      const layout = layoutMain(v.doc);
      const i0 = layout.findIndex((s) => s.clip.id === from.id);
      const i1 = a.to_clip_id ? layout.findIndex((s) => s.clip.id === findItem(v, a.to_clip_id).id) : i0 + 1;
      if (i1 < 0 || i1 >= layout.length) bad('The last segment was not found.');
      if (i1 <= i0) bad('to_clip_id must come after from_clip_id.');
      const r = ops.groupSequence(v.doc, i0, i1, a.name !== undefined ? str(a.name) : undefined);
      save(ctx, r.doc, 'group_sequence', `Grouped ${i1 - i0 + 1} segments into "${r.sequence.name}"`);
      const media = await bakeSequence(ctx.p, r.sequence.id);
      return { text: `"${r.sequence.name}" (${sec(media.duration)}s) now stands in for segments ${i0 + 1}-${i1 + 1} as main clip ${r.clip.id}, rendered as file ${media.name}. ${shifted}` };
    },
  },
  {
    name: 'expand_sequence',
    description: 'Unpack a nested sequence back into its clips where it sits, to change what is inside (then group_sequence again).',
    schema: obj({ clip_id: S('The main clip that stands for the sequence.') }, ['clip_id']),
    label: () => 'Expanding a sequence',
    run: (ctx, a) => {
      const v = view(ctx.p);
      const it = findItem(v, a.clip_id);
      const clip = v.doc.main.find((c) => c.id === it.id);
      if (!clip?.sequenceId) bad('That clip is not a sequence.');
      const d = ops.expandSequence(v.doc, clip.id);
      save(ctx, d, 'expand_sequence', `Expanded ${clip.name ?? 'the sequence'}`);
      return { text: `Expanded the sequence back into its clips. ${after(d)} ${shifted}` };
    },
  },
  {
    name: 'add_marker',
    description: 'Put a marker with a note on the ruler at a moment (a cue for later, a point to snap to, a question for the user). Markers move with cuts. Use remove to delete one by id.',
    schema: obj({ at: N('Timeline seconds.'), label: S('The note.'), color: S('A colour, e.g. #ff7ab6.'), remove: S('A marker id to remove instead.') }, []),
    label: (a) => (a.remove ? 'Removing a marker' : `Marker: ${str(a.label) || sec(num(a.at, 'at'))}`),
    run: (ctx, a) => {
      if (a.remove) {
        const id = str(a.remove);
        if (!ctx.p.doc.markers?.some((m) => m.id === id)) bad(`No marker ${id}.`);
        save(ctx, ops.removeMarker(ctx.p.doc, id), 'add_marker', `Removed marker ${id}`);
        return { text: `Removed marker ${id}.` };
      }
      const at = num(a.at, 'at');
      const d = ops.addMarker(ctx.p.doc, at, str(a.label), str(a.color) || undefined);
      save(ctx, d, 'add_marker', `Marker at ${sec(at)}s`);
      return { text: `Marker at ${sec(at)}s${a.label ? ` "${str(a.label)}"` : ''}.` };
    },
  },
  {
    name: 'roll_cut',
    description: 'Move the cut between a main segment and the next one without changing the total length: by seconds (positive = later, the first clip shows more and the next one less). Use it to land a cut on a beat or just after a word when the two sides are from one recording or when a frame or two matters.',
    schema: obj({ clip_id: S('The first of the two main segments.'), by: N('Seconds, positive = later.') }, ['clip_id', 'by']),
    label: () => 'Rolling a cut',
    run: (ctx, a) => {
      const v = view(ctx.p);
      const it = findItem(v, a.clip_id);
      if (it.kind !== 'main') bad('Only cuts on the main track can be rolled.');
      const index = layoutMain(v.doc).findIndex((s) => s.clip.id === it.id);
      if (index < 0 || index >= v.doc.main.length - 1) bad('That segment has nothing after it.');
      const d = ops.rollCut(v.doc, index, num(a.by, 'by'), (id) => ctx.p.media.get(id)?.duration);
      if (d === v.doc) bad('The cut cannot move that way (one side has no more footage or would vanish).');
      save(ctx, d, 'roll_cut', `Rolled the cut after ${it.id}`);
      const now = findItem(view(ctx.p), it.id);
      return { text: `The cut after ${it.id} is now at ${sec(now.end)}s.` };
    },
  },
  {
    name: 'set_audio_fx',
    description: 'Tone and dynamics of a clip\'s sound (main, b-roll, music, voice or effect clips). Presets: voice (rumble out, presence up, light levelling: the default for talking), podcast (fuller, studio-like), warm, bright, bass (music low end), radio and phone (narrow, for a call or a broadcast gag), muffled (through a wall, behind a door, underwater), big (loud and dense, for a drop). Then bass/mids/treble in dB (-12..12) and compress 0-1 on top. Pass preset none to clear.',
    schema: obj({ clip_id: S('A clip id.'), preset: S('Tone preset.', ['voice', 'podcast', 'warm', 'bright', 'bass', 'radio', 'phone', 'muffled', 'big', 'none']), bass: N('dB.'), mids: N('dB.'), treble: N('dB.'), compress: N('0-1.') }, ['clip_id']),
    label: (a) => `Sound: ${str(a.preset) || 'tone'}`,
    run: (ctx, a) => {
      const v = view(ctx.p);
      const it = findItem(v, a.clip_id);
      if (it.kind === 'graphic' || it.kind === 'zoom') bad('Only clips with sound can be shaped.');
      const clip = sourceClip(v.doc, it.kind as 'main' | 'overlay' | 'audio', it.id);
      if (!clip) bad('No such clip.');
      const fx: Record<string, unknown> = { ...(clip.audioFx ?? {}) };
      if (a.preset !== undefined) {
        const preset = str(a.preset);
        if (preset === 'none') delete fx.preset;
        else if (AUDIO_PRESETS.some((p) => p.id === preset)) fx.preset = preset;
        else bad(`Unknown preset "${preset}".`);
      }
      for (const [key, name] of [['low', 'bass'], ['mid', 'mids'], ['high', 'treble']] as const) if (a[name] !== undefined) fx[key] = clamp(num(a[name], name), -12, 12) || undefined;
      if (a.compress !== undefined) fx.compress = clamp(num(a.compress, 'compress'), 0, 1) || undefined;
      const clean = Object.fromEntries(Object.entries(fx).filter(([, val]) => val !== undefined));
      const d = ops.updateClip(v.doc, it.kind as 'main' | 'overlay' | 'audio', it.id, { audioFx: Object.keys(clean).length ? clean : undefined });
      save(ctx, d, 'set_audio_fx', `Sound on ${it.id}`);
      return { text: `${it.kind} clip ${it.id} sound: ${Object.keys(clean).length ? JSON.stringify(clean) : 'as recorded'}.` };
    },
  },
  {
    name: 'set_volume_keys',
    description: 'Volume over a clip\'s life: points of {at: timeline seconds, gain: multiplier of the clip\'s volume} with straight ramps between them. Or a preset at a moment: dip (down to 25% for 0.3 s around `at`, back up: music under a spoken line or a sound effect), swell (up to 160% around `at`: the drop, the reveal), fade_under (down to 20% from `at` to the clip\'s end: music settling under the talking). Music already ducks under speech by itself; use this for moments, not whole clips. Pass clear to remove.',
    schema: obj({ clip_id: S('A clip with sound.'), points: { type: 'array', description: 'Your own points.', items: obj({ at: N('Timeline seconds.'), gain: N('0-2, 1 = the clip\'s volume.') }, ['at', 'gain']) }, preset: S('A shape around `at`.', ['dip', 'swell', 'fade_under']), at: N('Timeline seconds for the preset.'), clear: B('Remove all points.') }, ['clip_id']),
    label: (a) => (a.preset ? `Volume ${str(a.preset)}` : 'Volume points'),
    run: (ctx, a) => {
      const v = view(ctx.p);
      const it = findItem(v, a.clip_id);
      if (it.kind === 'graphic' || it.kind === 'zoom') bad('Only clips with sound have a volume.');
      const kind = it.kind as 'main' | 'overlay' | 'audio';
      const clip = sourceClip(v.doc, kind, it.id);
      if (!clip) bad('No such clip.');
      const fps = v.doc.settings.fps;
      const length = srcDuration(clip);
      const localOf = (tl: number) => clamp(tl - it.start, 0, length);
      let keys = clip.volumeKeys ?? [];
      if (a.clear) keys = [];
      if (Array.isArray(a.points) && a.points.length) {
        for (const pt of a.points as { at: unknown; gain: unknown }[]) keys = ops.upsertKeyframe(keys, { t: Math.round(localOf(num(pt.at, 'points.at')) * fps) / fps, gain: clamp(num(pt.gain, 'points.gain'), 0, 2) }, fps);
      }
      if (a.preset !== undefined) {
        const preset = str(a.preset);
        const at = localOf(a.at !== undefined ? num(a.at, 'at') : it.start + length / 2);
        const put = (t: number, gain: number) => (keys = ops.upsertKeyframe(keys, { t: Math.round(clamp(t, 0, length) * fps) / fps, gain }, fps));
        if (preset === 'dip' || preset === 'swell') {
          const to = preset === 'dip' ? 0.25 : 1.6;
          put(at - 0.5, 1);
          put(at - 0.15, to);
          put(at + 0.15, to);
          put(at + 0.5, 1);
        } else if (preset === 'fade_under') {
          put(at, 1);
          put(Math.min(length, at + 1), 0.2);
        } else bad(`Unknown preset "${preset}".`);
      }
      const d = ops.updateClip(v.doc, kind, it.id, { volumeKeys: keys.length ? keys : undefined });
      save(ctx, d, 'set_volume_keys', `Volume points on ${it.id}`);
      return { text: keys.length ? `${it.id} volume: ${keys.map((k) => `${sec(it.start + k.t)}s ${Math.round(k.gain * 100)}%`).join(', ')}.` : `${it.id} has no volume points.` };
    },
  },
  {
    name: 'get_beats',
    description: 'The beats of a music file (bpm and beat times in the file), to land cuts, effects, text and punch-ins on them. cut_to_beat uses them for a montage; this is for placing single things. Timeline time of a beat = music clip start + (beat time - its source start).',
    schema: obj({ media: S('The music file (letter, id or name); default: the music on the timeline.'), from: N('First file second of interest.'), count: N('How many beats to list, default 32.') }, []),
    label: () => 'Reading the beat',
    run: async (ctx, a) => {
      const d0 = ctx.p.doc;
      const existing = d0.audio.find((x) => x.role === 'music');
      const music = a.music ? await findMedia(ctx.p, a.music) : existing ? ctx.p.media.get(existing.mediaId) : undefined;
      if (!music) bad('Which music? Give a file or add music first.');
      const env = await envelopeSoon(ctx.p, music.id, ctx.signal);
      if (!env) bad(`"${music.name}" could not be analysed for its beat.`);
      const beats = findBeats(env);
      const from = optNum(a.from, 'from') ?? 0;
      const count = clamp(optNum(a.count, 'count') ?? 32, 1, 200);
      const times = beats.times.filter((t) => t >= from).slice(0, count);
      const placed = existing && existing.mediaId === music.id ? ` On the timeline (clip ${existing.id} at ${sec(existing.start)}s, source from ${sec(existing.in)}s): ${times.map((t) => sec(existing.start + (t - existing.in))).join(', ')}.` : '';
      return { text: `"${music.name}": ${Math.round(beats.bpm)} bpm (confidence ${beats.confidence.toFixed(2)}). Beats in the file: ${times.map((t) => sec(t)).join(', ')}.${placed}` };
    },
  },
  {
    name: 'add_vfx',
    description: 'An effects layer over the picture for a stretch of time: confetti (a win, a birthday, a reveal), sparks (fire, hype, energy), snow, petals (soft, romantic, spring), rain (mood), bokeh (dreamy soft lights, music and night), lightleak (warm film light at the edges, nostalgia and travel), flare (a lens flare at x,y, for a sun or a shine; moves with keyframes). density/speed/size scale the particles (1 = normal); color forces one colour; hue (light leak) and intensity (leak and flare). Every frame is the same in the preview and the export.',
    schema: obj({ kind: S('The effect.', ['confetti', 'sparks', 'snow', 'petals', 'rain', 'bokeh', 'lightleak', 'flare']), start: N('Timeline seconds.'), duration: N('Seconds, default 4.'), density: N('0.1-3.'), speed: N('0.2-3.'), size: N('0.3-3.'), color: S('One colour for the particles, e.g. #FFD166.'), hue: N('Light leak hue 0-360, default 28 (amber).'), intensity: N('0-2 for lightleak and flare.'), x: N('Flare: where the light is, 0-1.'), y: N('Flare: 0-1.') }, ['kind', 'start']),
    label: (a) => `Adding ${str(a.kind)}`,
    run: (ctx, a) => {
      const kind = str(a.kind);
      if (!GRAPHIC_PRESETS[kind] || !['particles', 'lightleak', 'flare'].includes(GRAPHIC_PRESETS[kind].template)) bad(`Unknown effect "${kind}".`);
      const props: Record<string, unknown> = {};
      for (const key of ['density', 'speed', 'size', 'hue', 'intensity'] as const) if (a[key] !== undefined) props[key] = num(a[key], key);
      if (a.color !== undefined) props.color = str(a.color);
      const r = ops.addGraphic(ctx.p.doc, { preset: kind, props, start: Math.max(0, num(a.start, 'start')), duration: Math.max(0.2, optNum(a.duration, 'duration') ?? 4), x: a.x !== undefined ? clamp(num(a.x, 'x'), 0, 1) : undefined, y: a.y !== undefined ? clamp(num(a.y, 'y'), 0, 1) : undefined, name: GRAPHIC_PRESETS[kind].label, createdBy: ctx.messageId });
      save(ctx, r.doc, 'add_vfx', `${GRAPHIC_PRESETS[kind].label} at ${sec(r.item.start)}s`);
      return { text: `Added ${GRAPHIC_PRESETS[kind].label.toLowerCase()} ${r.item.id} from ${sec(r.item.start)} to ${sec(r.item.start + r.item.duration)}s.` };
    },
  },
  {
    name: 'set_speed',
    description:
      'Speed of a main or b-roll clip: a plain speed, a speed ramp (preset or your own points), reverse, and how slowed footage is smoothed on export. Presets, built around `at` (timeline seconds; default the middle of the clip): slow-moment (normal, eases into slow motion, back to normal: the hit, the reveal, the look), hero (fast in, slow at the moment, fast out), ramp-in (fast start settling to normal), ramp-out (speeds away at the end), burst (a one-second fast-forward). A ramp changes the clip length; later main clips move along. interpolate blend or flow makes slowed footage smooth on export (flow is slowest to export, best for 0.5x and under); the preview repeats frames either way.',
    schema: obj(
      {
        clip_id: S('A main or b-roll clip id.'),
        speed: N('A plain speed 0.1-8 (clears any ramp).'),
        preset: S('A ready-made ramp.', ['slow-moment', 'hero', 'ramp-in', 'ramp-out', 'burst']),
        at: N('Timeline seconds the preset is built around (the moment to slow down or burst from).'),
        slow: N('The slow speed of slow-moment and hero, default 0.3.'),
        ramp: { type: 'array', description: 'Your own ramp instead of a preset: points of {at: timeline seconds, speed}, speed changing evenly between them. 2-8 points.', items: obj({ at: N('Timeline seconds (as the clip plays now).'), speed: N('0.05-16.') }, ['at', 'speed']) },
        clear_ramp: B('Remove the ramp and go back to the plain speed.'),
        reverse: B('Play backwards.'),
        interpolate: S('Frames for slowed footage on export.', ['none', 'blend', 'flow']),
        tape: B('Let the pitch drop and rise with the speed (the slowed-down record gag); default keeps the pitch.'),
      },
      ['clip_id'],
    ),
    label: (a) => (a.preset ? `Speed ramp: ${str(a.preset)}` : a.reverse ? 'Reversing a clip' : 'Changing the speed'),
    run: (ctx, a) => {
      const v = view(ctx.p);
      const it = findItem(v, a.clip_id);
      if (it.kind !== 'main' && it.kind !== 'overlay') bad('Speed applies to main and b-roll clips.');
      const clip = sourceClip(v.doc, it.kind, it.id);
      if (!clip) bad('No such clip.');
      const media = ctx.p.media.get(clip.mediaId);
      if (!media || media.kind === 'image') bad('That clip is a picture; its length is set with edit_clip duration.');
      const patch: Record<string, unknown> = {};
      const notes: string[] = [];
      if (a.speed !== undefined) {
        patch.speed = clamp(num(a.speed, 'speed'), 0.1, 8);
        patch.ramp = undefined;
        notes.push(`${patch.speed}x`);
      }
      const srcTime = (tl: number) => sourceAt(clip, clamp(tl - it.start, 0, srcDuration(clip)));
      if (a.preset !== undefined) {
        const preset = str(a.preset) as ops.RampPreset;
        if (!ops.RAMP_PRESETS.some((r) => r.id === preset)) bad(`Unknown preset "${preset}".`);
        const at = a.at !== undefined ? num(a.at, 'at') : it.start + srcDuration(clip) / 2;
        if (at < it.start - 1e-6 || at > it.end + 1e-6) bad(`at=${sec(at)} is outside ${it.id} (${sec(it.start)}-${sec(it.end)}s).`);
        patch.ramp = ops.rampPreset({ ...clip, ...(a.speed !== undefined ? { speed: patch.speed as number } : {}) }, srcTime(at), preset, clamp(optNum(a.slow, 'slow') ?? 0.3, 0.05, 1));
        notes.push(`${preset} ramp around ${sec(at)}s`);
      } else if (Array.isArray(a.ramp) && a.ramp.length) {
        const pts = a.ramp as { at: unknown; speed: unknown }[];
        if (pts.length < 2 || pts.length > 8) bad('A ramp needs 2 to 8 points.');
        patch.ramp = pts.map((k) => ({ t: ops.snapSource(srcTime(num(k.at, 'ramp.at'))), speed: clamp(num(k.speed, 'ramp.speed'), 0.05, 16) }));
        notes.push(`ramp with ${pts.length} points`);
      } else if (a.clear_ramp) {
        patch.ramp = undefined;
        notes.push('ramp removed');
      }
      if (a.reverse !== undefined) {
        patch.reverse = !!a.reverse || undefined;
        notes.push(a.reverse ? 'reversed' : 'forwards');
      }
      if (a.interpolate !== undefined) {
        const mode = str(a.interpolate);
        patch.interpolate = mode === 'blend' || mode === 'flow' ? mode : undefined;
        notes.push(mode === 'none' ? 'frames repeated' : `${mode} interpolation`);
      }
      if (a.tape !== undefined) {
        patch.pitchFollowsSpeed = !!a.tape || undefined;
        notes.push(a.tape ? 'pitch follows speed' : 'pitch kept');
      }
      if (!notes.length) bad('Nothing to change: give speed, preset, ramp, clear_ramp, reverse or interpolate.');
      const d = ops.updateClip(v.doc, it.kind, it.id, patch, media.duration);
      save(ctx, d, 'set_speed', `${notes.join(', ')} on ${it.id}`);
      const now = findItem(view(ctx.p), it.id);
      return { text: `${it.kind} clip ${it.id}: ${notes.join(', ')}. It now runs ${sec(now.start)}-${sec(now.end)}s. ${after(d)}` };
    },
  },
  {
    name: 'stabilize_clip',
    description: 'Smooth out camera shake on a main or b-roll clip (handheld walking shots, vlogs, phone footage). strength 0-1: 0.4 takes the jitter out of a steady hand, 0.7 for walking, 1 for running or a car; the picture is cropped by 6-24% to make room, so keep it low on tight framings. 0 turns it off. The camera motion is measured the first time (a few seconds per minute of footage).',
    schema: obj({ clip_id: S('A main or b-roll clip id.'), strength: N('0-1, default 0.5.') }, ['clip_id']),
    label: () => 'Stabilising',
    run: async (ctx, a) => {
      const v = view(ctx.p);
      const it = findItem(v, a.clip_id);
      if (it.kind !== 'main' && it.kind !== 'overlay') bad('Stabilising applies to main and b-roll clips.');
      const clip = sourceClip(v.doc, it.kind, it.id);
      if (!clip) bad('No such clip.');
      const media = ctx.p.media.get(clip.mediaId);
      if (!media || media.kind !== 'video') bad('Only video can be stabilised.');
      const strength = clamp(optNum(a.strength, 'strength') ?? 0.5, 0, 1);
      if (strength > 0) {
        const track = await analyzeStability(ctx.p, media.id);
        if (!track) bad('The camera motion could not be measured for this file.');
      }
      const d = ops.updateClip(ctx.p.doc, it.kind, it.id, { fx: { ...(clip.fx ?? {}), stabilize: strength || undefined } }, media.duration);
      save(ctx, d, 'stabilize_clip', `${strength ? `Stabilised ${Math.round(strength * 100)}%` : 'Stabilising off'} on ${it.id}`);
      return { text: strength ? `Stabilised ${it.kind} clip ${it.id} at ${Math.round(strength * 100)}% (cropped ${Math.round((3 + 9 * strength) * 2)}%).` : `Stabilising is off on ${it.id}.` };
    },
  },
  {
    name: 'track_object',
    description: 'Follow a thing through the main clip under a moment (a product, a hand, a dog, a sign) so text can stick to it: give the box around it as you see it in a still of the frame (fractions of the frame: centre x, y and width, height). Tracking runs from that moment to the end of the clip or until it is lost. Returns a track id for follow_target. For faces use follow_target target face instead; faces are found already.',
    schema: obj({ at: N('Timeline seconds of the still you looked at.'), x: N('Centre of the box, 0-1 across the frame.'), y: N('Centre of the box, 0-1 down the frame.'), w: N('Width of the box, 0-1.'), h: N('Height of the box, 0-1.'), name: S('What it is, for the list.'), max_seconds: N('Stop after this many seconds (default: the clip).') }, ['at', 'x', 'y', 'w', 'h']),
    label: (a) => `Tracking ${str(a.name) || 'an object'}`,
    run: async (ctx, a) => {
      const v = view(ctx.p);
      const at = num(a.at, 'at');
      const seg = segAt(layoutMain(v.doc), at);
      if (!seg || seg.clip.kind !== 'media') bad(`There is no main clip at ${sec(at)}s.`);
      const media = ctx.p.media.get(seg.clip.mediaId);
      if (!media || media.kind !== 'video') bad('Only video can be tracked.');
      const { width: W, height: H } = v.doc.settings;
      const clip = seg.clip;
      const sourceTime = sourceTimeAt(clip, at - seg.start);
      const framing = framingAt(clip.framing, getFaces(ctx.p, media.id), sourceTime, clip.motion, at - seg.start);
      const strength = clip.fx?.stabilize ?? 0;
      const stab = strength > 0 ? await analyzeStability(ctx.p, media.id) : null;
      const g = clipGeometry(media.width, media.height, W, H, framing, stab ? { track: stab, t: sourceTime, strength } : undefined);
      const k = g.src.w / g.dst.w;
      const bx = clamp(num(a.x, 'x'), 0, 1);
      const by = clamp(num(a.y, 'y'), 0, 1);
      const bw = clamp(num(a.w, 'w'), 0.01, 1);
      const bh = clamp(num(a.h, 'h'), 0.01, 1);
      const box = {
        cx: ((bx * W - g.dst.x) * k + g.src.x) / media.width,
        cy: ((by * H - g.dst.y) * k + g.src.y) / media.height,
        w: (bw * W * k) / media.width,
        h: (bh * H * k) / media.height,
      };
      const maxSeconds = optNum(a.max_seconds, 'max_seconds') ?? Math.max(0.5, clip.out - sourceTime);
      const track = await trackObject(ctx.p, media.id, { t: sourceTime, ...box, name: a.name !== undefined ? str(a.name) : undefined, maxSeconds });
      const seen = track.boxes.filter(Boolean).length;
      return { text: `Tracked "${track.name}" (track ${track.id}) in file ${media.name} from ${sec(at)}s for ${sec(track.boxes.length * track.interval)}s; seen in ${Math.round((100 * seen) / Math.max(1, track.boxes.length))}% of those frames. Use follow_target with track_id ${track.id}.` };
    },
  },
  {
    name: 'follow_target',
    description: 'Make a text or graphic move with the subject\'s face or a tracked object in the main clip under it (a name label that stays by the person, an arrow on a product, a price on a dish, a "me" tag in a crowd). anchor above (default: hangs over the head or object), centre (on it) or below; offset_x/offset_y nudge it in fractions of the frame (offset_y -0.05 is a little higher). target none stops following. While following, position keyframes are ignored.',
    schema: obj({ item_id: S('A text or graphic id.'), target: S('What to follow.', ['face', 'object', 'none']), track_id: S('From track_object (needed for object).'), anchor: S('Where it hangs.', ['above', 'centre', 'below']), offset_x: N('-0.5..0.5, default 0.'), offset_y: N('-0.5..0.5, default -0.03 above / 0.03 below.') }, ['item_id', 'target']),
    label: (a) => (a.target === 'none' ? 'Stop following' : `Following the ${str(a.target)}`),
    run: (ctx, a) => {
      const v = view(ctx.p);
      const it = findItem(v, a.item_id);
      if (it.kind !== 'graphic') bad('Only text and graphics can follow something.');
      const target = str(a.target);
      if (target === 'none') {
        const d = ops.updateGraphic(v.doc, it.id, { follow: undefined });
        save(ctx, d, 'follow_target', `${it.id} stays put`);
        return { text: `${it.id} no longer follows anything.` };
      }
      if (target !== 'face' && target !== 'object') bad('target must be face, object or none.');
      let trackId: string | undefined;
      if (target === 'object') {
        trackId = str(a.track_id);
        const known = [...ctx.p.media.values()].some((m) => (getObjectTracks(ctx.p, m.id) ?? []).some((t) => t.id === trackId));
        if (!trackId || !known) bad('Give the track_id from track_object.');
      }
      const anchor = (['above', 'centre', 'below'].includes(str(a.anchor)) ? str(a.anchor) : 'above') as 'above' | 'centre' | 'below';
      const follow = { target: target as 'face' | 'object', trackId, anchor, offsetX: clamp(optNum(a.offset_x, 'offset_x') ?? 0, -0.5, 0.5), offsetY: clamp(optNum(a.offset_y, 'offset_y') ?? (anchor === 'below' ? 0.03 : anchor === 'above' ? -0.03 : 0), -0.5, 0.5) };
      const d = ops.updateGraphic(v.doc, it.id, { follow });
      save(ctx, d, 'follow_target', `${it.id} follows the ${target}`);
      return { text: `${it.id} now follows the ${target}${trackId ? ` (track ${trackId})` : ''}, hanging ${anchor} it.` };
    },
  },
  {
    name: 'freeze_frame',
    description: 'Hold the frame at a moment of the main track for a while: the clip is split there and a still of that frame goes between the halves (framed and graded like the clip); everything after moves along. For a punchline, a reveal, a face to put text on, or a "wait for it".',
    schema: obj({ at: N('Timeline seconds of the frame to hold.'), duration: N('Seconds to hold, default 2.') }, ['at']),
    label: (a) => `Freezing the frame at ${sec(num(a.at, 'at'))}s`,
    run: async (ctx, a) => {
      const v = view(ctx.p);
      const at = num(a.at, 'at');
      const seg = layoutMain(v.doc).find((s) => at >= s.start - 1e-6 && at < s.end - 1e-6);
      if (!seg || seg.clip.kind !== 'media') bad(`There is no main clip at ${sec(at)}s.`);
      const media = ctx.p.media.get(seg.clip.mediaId);
      if (!media || media.kind !== 'video') bad('Only video frames can be frozen.');
      const duration = clamp(optNum(a.duration, 'duration') ?? 2, 1 / v.doc.settings.fps, 30);
      const still = await extractStill(ctx.p, media, sourceAt(seg.clip, at - seg.start));
      const d = ops.freezeFrame(ctx.p.doc, at, still, duration);
      save(ctx, d, 'freeze_frame', `Froze ${sec(at)}s for ${duration}s`);
      return { text: `Held the frame at ${sec(at)}s for ${duration}s (still ${still.id}). ${after(d)} ${shifted}` };
    },
  },
  {
    name: 'add_motion',
    description: 'Give the picture of a main or b-roll clip a slow move over its whole life: push-in (a slow zoom in, the classic for a line that matters), pull-out, pan-left, pan-right, tilt-up, tilt-down, drift (Ken Burns: zoom with a gentle sideways move, for photos). amount is how far it travels (0.1 subtle, 0.2 default, 0.4 strong). Use it on photos and b-roll so they are never static, and on a talking head only for one key line.',
    schema: obj({ clip_id: S('A main or b-roll clip id.'), preset: S('The move.', ['push-in', 'pull-out', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'drift']), amount: N('0.05-0.6, default 0.2.') }, ['clip_id', 'preset']),
    label: (a) => `Adding a ${str(a.preset)}`,
    run: (ctx, a) => {
      const v = view(ctx.p);
      const it = findItem(v, a.clip_id);
      if (it.kind !== 'main' && it.kind !== 'overlay') bad('Motion applies to main and b-roll clips.');
      const clip = sourceClip(v.doc, it.kind, it.id);
      if (!clip) bad('No such clip.');
      const length = srcDuration(clip);
      const preset = str(a.preset) as Parameters<typeof ops.motionPreset>[2];
      const motion = ops.motionPreset(clip.framing, length, preset, clamp(optNum(a.amount, 'amount') ?? 0.2, 0.05, 0.6));
      const d = ops.setMotion(v.doc, it.kind, it.id, motion);
      save(ctx, d, 'add_motion', `${preset} on ${it.id}`);
      return { text: `Added a ${preset} over ${sec(length)}s on ${it.kind} clip ${it.id}.` };
    },
  },
  {
    name: 'set_font',
    description: `Change the font of a text graphic, of all text graphics, or of the captions. Fonts: ${FONT_FAMILIES.join(', ')}.`,
    schema: obj({ item_id: S('A text graphic id.'), scope: S('Instead of item_id.', ['captions', 'all_text']), family: S('Font family.', FONT_FAMILIES), weight: N('400-900; the nearest available weight is used.'), size: N('Size multiplier relative to the current size.') }, ['family']),
    label: () => 'Changing the font',
    run: (ctx, a) => {
      const family = str(a.family);
      if (!FONT_FAMILIES.includes(family)) bad(`Unknown font "${family}". Available: ${FONT_FAMILIES.join(', ')}.`);
      let d = ctx.p.doc;
      if (a.scope === 'captions') {
        d = ops.setCaptions(d, { font: family, ...(a.size !== undefined ? { size: clamp(d.captions.size * num(a.size, 'size'), 0.3, 3) } : {}) });
        save(ctx, d, 'set_font', `Captions in ${family}`);
        return { text: `Captions now use ${family}.` };
      }
      const ids = a.scope === 'all_text' ? d.graphics.filter((g) => g.template === 'text').map((g) => g.id) : [findItem(view(ctx.p), a.item_id).id];
      let n = 0;
      for (const id of ids) {
        const g = d.graphics.find((x) => x.id === id);
        if (!g || g.template !== 'text') continue;
        const weight = nearestWeight(family, optNum(a.weight, 'weight') ?? Number(g.props.weight ?? 700));
        const size = a.size !== undefined ? Number(g.props.size ?? 0.07) * clamp(num(a.size, 'size'), 0.3, 4) : g.props.size;
        d = ops.updateGraphic(d, id, { props: { font: family, weight, size } });
        n++;
      }
      if (!n) bad('No text graphic to change.');
      save(ctx, d, 'set_font', `${n} text item(s) in ${family}`);
      return { text: `${n} text item${n === 1 ? '' : 's'} now use${n === 1 ? 's' : ''} ${family}.` };
    },
  },
  {
    name: 'add_title_card',
    description: 'Insert a solid-colour card with centred text into the main track (for an opening title or a chapter break). Everything after it moves later.',
    schema: obj({ text: S('What it says.'), duration: N('Seconds. Default 2.5.'), index: N('Position among main segments, 0 = the very start (default).'), color: S('Card colour. Default black.'), text_color: S('Default white.'), background: S('A moving background instead of a flat card: flow (soft colour blobs), aurora (bands of light), rays (sunburst), bokeh (soft lights), grid (sliding grid).', ['flow', 'aurora', 'rays', 'bokeh', 'grid']), accent: S('Colour of the moving background, default white.') }, ['text']),
    label: () => 'Adding a title card',
    run: (ctx, a) => {
      const animated = ['flow', 'aurora', 'rays', 'bokeh', 'grid'].includes(str(a.background)) ? (str(a.background) as 'flow') : undefined;
      const d = ops.addTitleCard(ctx.p.doc, { text: str(a.text), duration: optNum(a.duration, 'duration') ?? 2.5, index: optNum(a.index, 'index') ?? 0, color: str(a.color) || '#000000', textColor: str(a.text_color) || '#FFFFFF', animated, accent: str(a.accent) || undefined, createdBy: ctx.messageId });
      save(ctx, d, 'add_title_card', `Title card "${clip(str(a.text), 40)}"`);
      return { text: `Added a title card "${clip(str(a.text), 50)}". ${after(d)} ${shifted}` };
    },
  },
  {
    name: 'set_captions',
    description: 'Turn word-timed captions on or off and style them. Presets: pop (2-3 big bold words, the spoken word highlighted), highlight (a box follows the spoken word), karaoke (words fill in), clean (a plain line), boxed (classic subtitles), outline (tall block capitals with a thick outline), oneword (one huge word at a time, for fast energetic talk), glow (neon glow in the accent colour), glass (frosted pill, elegant), typewriter (typed in with a cursor, dry or techy), band (full-width colour band like a headline), underline (a bar slides under the spoken word), retro (chunky letters with a hard shadow), comic (comic lettering that wobbles). Captions follow every cut automatically. Use emphasize to keep key words (numbers, names, the payoff) in the accent colour, one or two per sentence at most. Use fix to correct a misheard word.',
    schema: obj({
      enabled: B('Show captions.'),
      preset: S('Style.', ['pop', 'highlight', 'karaoke', 'clean', 'boxed', 'outline', 'oneword', 'glow', 'glass', 'typewriter', 'band', 'underline', 'retro', 'comic']),
      words_per_line: N('Words shown at a time (1-9).'),
      position_y: N('Vertical centre, 0 = top, 1 = bottom. Default 0.7. In vertical video do not go below the 0.74 line (that is, keep position_y <= 0.74) or apps cover it.'),
      size: N('Size multiplier, 1 = default.'),
      uppercase: B('ALL CAPS.'),
      color: S('Text colour.'),
      accent: S('Colour of the spoken and emphasised words.'),
      emphasize: { type: 'array', items: { type: 'string' }, description: 'Word ids to keep in the accent colour.' },
      clear_emphasis: B('Remove all emphasis first.'),
      fix: { type: 'array', items: { type: 'object', properties: { word: { type: 'string' }, text: { type: 'string' } }, required: ['word', 'text'] }, description: 'Corrections: word id and the right text ("" hides the word in captions).' },
    }),
    label: () => 'Styling captions',
    run: (ctx, a) => {
      const d0 = ctx.p.doc;
      const patch: Record<string, unknown> = {};
      if (a.preset !== undefined) patch.style = str(a.preset);
      if (a.enabled !== undefined) patch.enabled = !!a.enabled;
      else if (a.preset !== undefined) patch.enabled = true;
      let d = ops.setCaptions(d0, patch);
      const more: Record<string, unknown> = {};
      if (a.words_per_line !== undefined) more.maxWords = clamp(Math.round(num(a.words_per_line, 'words_per_line')), 1, 9);
      if (a.position_y !== undefined) more.y = clamp(num(a.position_y, 'position_y'), 0.05, 0.95);
      if (a.size !== undefined) more.size = clamp(num(a.size, 'size'), 0.3, 3);
      if (a.uppercase !== undefined) more.uppercase = !!a.uppercase;
      if (a.color !== undefined) more.color = str(a.color);
      if (a.accent !== undefined) more.accent = str(a.accent);
      const emphasis = new Set(a.clear_emphasis ? [] : (d.captions.emphasis ?? []));
      if (Array.isArray(a.emphasize)) for (const r of parseWordRefs(ctx.p, a.emphasize)) for (let i = r.from; i <= r.to; i++) emphasis.add(`${r.media.id}:${i}`);
      if (Array.isArray(a.emphasize) || a.clear_emphasis) more.emphasis = [...emphasis];
      const edits: Record<string, string> = {};
      if (Array.isArray(a.fix)) {
        for (const f of a.fix as { word: unknown; text: unknown }[]) {
          const [r] = parseWordRefs(ctx.p, [f.word]);
          edits[`${r.media.id}:${r.from}`] = str(f.text);
        }
        more.edits = edits;
      }
      d = ops.setCaptions(d, more);
      save(ctx, d, 'set_captions', `Captions ${d.captions.enabled ? `on (${d.captions.style})` : 'off'}`);
      const v = view(ctx.p);
      const said = v.words.length;
      return {
        text: `Captions are ${d.captions.enabled ? `on: ${d.captions.style}, ${d.captions.maxWords} words at a time, at y=${d.captions.y.toFixed(2)}` : 'off'}.${d.captions.enabled && !said ? ' Note: there are no transcribed words on the main track yet, so nothing will show.' : ''}${Object.keys(edits).length ? ` Fixed ${Object.keys(edits).length} word(s).` : ''}${more.emphasis ? ` ${emphasis.size} word(s) emphasised.` : ''}`,
      };
    },
  },

  // ------------------------------------------------------------------ b-roll and sound
  {
    name: 'cut_to_beat',
    description: 'Build a montage: lay the music under the video and cut between clips exactly on its beats. Replaces the whole timeline (main track, graphics, b-roll, effects) with slices of the given clips plus the music; every clip\'s sound is muted and the music carries it. Add text and effects after it. beats_per_cut 1 is frantic, 2 is lively, 4 is calm. Good for b-roll reels, travel, before-and-after, product shots; not for a talking head.',
    schema: obj({
      music: S('Letter, id or name of the music file, or "library:<name>". Default: the music already on the timeline.'),
      clips: L2('Letters or ids of the video clips to cut between, in order. Default: every video file in the project.'),
      beats_per_cut: N('Beats each shot lasts. Default 2.'),
      length_s: N('How long the montage runs. Default: the shorter of 30 s and the music.'),
      order: S('"sequence" walks through the clips in turn; "shuffle" mixes them.', ['sequence', 'shuffle']),
      keep_sound: B('Keep the clips\' own sound under the music. Default false.'),
    }),
    label: () => 'Cutting to the beat',
    run: async (ctx, a) => {
      const d0 = ctx.p.doc;
      const existing = d0.audio.find((x) => x.role === 'music');
      const music = a.music ? await findMedia(ctx.p, a.music) : existing ? ctx.p.media.get(existing.mediaId) : undefined;
      if (!music) bad('Which music? Give a file or add music first (list_library kind=music shows the built-in tracks).');
      const env = await envelopeSoon(ctx.p, music.id, ctx.signal);
      if (!env) bad(`"${music.name}" could not be analysed for its beat.`);
      const beats = findBeats(env);
      if (beats.times.length < 4) bad(`Could not find a steady beat in "${music.name}".`);
      const refs = Array.isArray(a.clips) ? a.clips.map(String) : [];
      const clips: MediaAsset[] = [];
      if (refs.length) for (const r of refs) clips.push(await findMedia(ctx.p, r));
      else clips.push(...[...ctx.p.media.values()].filter((m) => m.kind === 'video' && !m.origin).sort((x, y) => x.addedAt - y.addedAt));
      if (!clips.length) bad('There are no video clips to cut between.');
      const per = clamp(Math.round(optNum(a.beats_per_cut, 'beats_per_cut') ?? 2), 1, 16);
      const length = clamp(optNum(a.length_s, 'length_s') ?? Math.min(30, music.duration), 2, music.duration);
      const fps = d0.settings.fps;
      // Cut points: the beats, taken per `per`, from the first beat after a short lead-in.
      const first = beats.times.findIndex((t) => t >= 0.15);
      const cuts: number[] = [0];
      for (let k = Math.max(0, first); k < beats.times.length && beats.times[k] < length; k += per) cuts.push(snap(beats.times[k], fps));
      cuts.push(snap(length, fps));
      // Each clip keeps a cursor, so successive shots from it show new material.
      const cursor = new Map(clips.map((c) => [c.id, 0]));
      const order = str(a.order) === 'shuffle';
      // The old timeline's items were placed for footage that is gone; start clean, keeping only the music track.
      let d: ProjectDoc = { ...d0, main: [], overlays: [], graphics: [], zooms: [], audio: d0.audio.filter((x) => x.role === 'music') };
      let n = 0;
      for (let i = 0; i + 1 < cuts.length; i++) {
        const dur = cuts[i + 1] - cuts[i];
        if (dur < 1 / fps - 1e-6) continue;
        const m = order ? clips[Math.floor(Math.random() * clips.length)] : clips[i % clips.length];
        let at = cursor.get(m.id) ?? 0;
        if (at + dur > m.duration) at = 0;
        const c = { kind: 'media' as const, ...ops.makeClip(m, fps, { in: at, duration: dur }), name: m.name, createdBy: ctx.messageId, muted: !a.keep_sound };
        d = ops.insertMain(d, c);
        cursor.set(m.id, at + dur);
        n++;
      }
      // The music starts with the picture; its own tool sets the level and the ducking.
      d = { ...d, audio: d.audio.filter((x) => x.role !== 'music') };
      const r = ops.addAudio(d, music, { start: 0, role: 'music', volume: existing?.volume ?? clamp(dbToGain(-9), 0, 2), duck: !!a.keep_sound, name: music.name, createdBy: ctx.messageId });
      d = r.doc;
      save(ctx, d, 'cut_to_beat', `Montage: ${n} shots on the beat of ${music.name}`);
      return { text: `Built a ${sec(contentDuration(d))}s montage of ${n} shots from ${clips.length} clip${clips.length === 1 ? '' : 's'}, cutting every ${per} beat${per === 1 ? '' : 's'} of "${music.name}" (${beats.bpm} bpm, beat confidence ${Math.round(beats.confidence * 100)}%). The clips are ${a.keep_sound ? 'audible under the music' : 'muted; the music carries it'}. Captions are off unless there is speech. ${shifted}` };
    },
  },
  {
    name: 'list_recipes',
    description: 'List the saved editing styles (recipes): captions, fonts, colour, pacing, music level and notes. Apply one with apply_recipe when the user names a style or when the plan says which recipe to use.',
    schema: obj({}),
    label: () => 'Reading the recipes',
    readOnly: true,
    run: () => ({ text: `RECIPES:\n${getRecipes().map((r) => `  "${r.name}"${r.builtIn ? '' : ' (saved by the user)'}: ${r.description} Captions ${r.captions.style}, ${r.captions.maxWords} words${r.captions.font ? ` in ${r.captions.font}` : ''}; hook text in ${r.hookFont ?? 'the default font'} (${r.hookStyle ?? 'hook'}); pauses over ${r.pacing.silence}s cut, fillers level ${r.pacing.fillers}; music ${r.music}.${r.notes ? ` Notes: ${r.notes}` : ''}`).join('\n')}` }),
  },
  {
    name: 'apply_recipe',
    description: 'Apply a recipe (built in: talking-head, meme, tutorial, vlog, elegant, montage, hype, cinematic, retro, clean, plus any the user saved): sets the captions and the colour look right away and tells you the pacing, fonts, music level and effects to follow for the rest of the edit (then do those steps yourself: remove_silences, remove_fillers, add_text with the font, set_music, the effects in the notes).',
    schema: obj({ recipe: S('Recipe name or id from list_recipes.') }, ['recipe']),
    label: (a) => `Applying the "${str(a.recipe)}" style`,
    run: (ctx, a) => {
      const r = findRecipe(str(a.recipe));
      if (!r) bad(`No recipe called "${a.recipe}". list_recipes shows them.`);
      let d = ops.setCaptions(ctx.p.doc, { ...r.captions, enabled: true, font: r.captions.font });
      if (r.look) for (const c of d.main) if (c.kind === 'media') d = ops.updateClip(d, 'main', c.id, { fx: { ...r.look } });
      save(ctx, d, 'apply_recipe', `Style: ${r.name}`);
      return { text: `Applied "${r.name}": captions are ${r.captions.style}, ${r.captions.maxWords} words${r.captions.font ? ` in ${r.captions.font}` : ''}${r.look ? '; colour look applied to the main clips' : ''}. Now follow the rest of it: cut pauses over ${r.pacing.silence}s, fillers at level ${r.pacing.fillers}; hook and title text in ${r.hookFont ?? 'the default font'} with style "${r.hookStyle ?? 'hook'}"; music ${r.music === 'none' ? 'none unless asked' : r.music === 'quiet' ? 'quiet, under the voice' : 'present, a real part of the piece'}.${r.notes ? ` ${r.notes}` : ''}` };
    },
  },
  {
    name: 'save_recipe',
    description: 'Save the current project\'s style as a recipe for later: its caption settings, the font of its hook text, the colour look of its main clips, and the pacing and music level you used. Give it a short name and a one-line description.',
    schema: obj({ name: S('Short name, e.g. "My podcast clips".'), description: S('One line on when to use it.'), silence_s: N('Pauses over this length were cut. Default 0.5.'), fillers: N('Filler level used, 0-2. Default 1.'), music: S('none, quiet or present.', ['none', 'quiet', 'present']), notes: S('Anything else about the style.') }, ['name', 'description']),
    label: () => 'Saving a recipe',
    run: (ctx, a) => {
      const d = ctx.p.doc;
      const c = d.captions;
      const hook = d.graphics.find((g) => g.template === 'text' && /hook/i.test(g.name ?? '')) ?? d.graphics.find((g) => g.template === 'text');
      const look = d.main.find((x): x is Extract<typeof x, { kind: 'media' }> => x.kind === 'media' && !!x.fx)?.fx;
      const musicClip = d.audio.find((x) => x.role === 'music');
      const music = (a.music as 'none' | 'quiet' | 'present' | undefined) ?? (!musicClip ? 'none' : musicClip.volume < 0.4 ? 'quiet' : 'present');
      const r = saveRecipe({
        name: str(a.name).trim(),
        description: str(a.description).trim(),
        captions: { style: c.style, y: c.y, size: c.size, maxWords: c.maxWords, uppercase: c.uppercase, punctuation: c.punctuation, color: c.color, accent: c.accent, ...(c.font ? { font: c.font } : {}) },
        hookFont: hook ? str((hook.props as Record<string, unknown>).font) || undefined : undefined,
        hookStyle: hook ? (Object.entries(GRAPHIC_PRESETS).find(([, p]) => p.template === 'text' && p.props.size === (hook.props as Record<string, unknown>).size)?.[0] ?? 'hook') : undefined,
        look: look ? { ...look } : undefined,
        pacing: { silence: optNum(a.silence_s, 'silence_s') ?? 0.5, fillers: clamp(Math.round(optNum(a.fillers, 'fillers') ?? 1), 0, 2) },
        music,
        notes: str(a.notes).trim(),
      });
      return { text: `Saved recipe "${r.name}". It can be applied to any project with apply_recipe.` };
    },
  },
  {
    name: 'find_sound_online',
    description: 'When the built-in sounds (list_library kind=sfx, add_sfx query) have nothing right, search Freesound for more (needs the Freesound key from Settings). Only CC0 and CC BY sounds are returned. Pick one and call save_sound; it then works with add_sfx like any other sound.',
    schema: obj({ query: S('What the sound should be: "cash register", "vine boom", "bruh", "windows error".'), limit: N('How many to list, default 8.') }, ['query']),
    label: (a) => `Searching sounds for "${str(a.query)}"`,
    readOnly: true,
    run: async (_ctx, a) => {
      const q = str(a.query).trim();
      const results = await searchSounds(q, optNum(a.limit, 'limit') ?? 8).catch((err: Error) => bad(err.message));
      if (!results.length) return { text: `No sounds found for "${q}". Try a broader word.` };
      foundSounds.clear();
      for (const r of results) foundSounds.set(r.id, r);
      return { text: `Sounds for "${q}" (use the id with save_sound):\n${results.map((r) => `  ${r.id}  "${r.name}"  ${r.duration}s, by ${r.author}, ${r.licence}${r.tags.length ? `, tags: ${r.tags.join(' ')}` : ''}`).join('\n')}` };
    },
  },
  {
    name: 'save_sound',
    description: 'Save a sound from find_sound_online into the user\'s sound library, then place it with add_sfx (sfx_id from the result). A CC BY sound comes with a credit line for the caption; pass it on.',
    schema: obj({ sound_id: N('Id from find_sound_online.') }, ['sound_id']),
    label: () => 'Saving a sound',
    run: async (_ctx, a) => {
      const f = foundSounds.get(Number(a.sound_id));
      if (!f) bad(`No sound with id ${a.sound_id} in the last search; call find_sound_online first.`);
      const entry = await saveSound(f).catch((err: Error) => bad(err.message));
      const credit = soundCredit(entry);
      return { text: `Saved "${entry.name}" as ${entry.id} (${entry.duration}s).${credit ? ` Credit line for the caption: ${credit}` : ''} Place it with add_sfx sfx_id=${entry.id}.` };
    },
  },
  {
    name: 'add_meme',
    description: `Put a classic meme template on screen (from Imgflip's public list: "drake", "distracted boyfriend", "two buttons", "change my mind", "expanding brain", "is this a pigeon", "woman yelling at cat", "surprised pikachu"...) as a full-frame b-roll shot with top and bottom text in the meme style, over the footage for the time given. A meme is a punchline device: one per reel, on the beat, 2-3 s, text of 2-6 words per line. Give start and duration, or start_word and end_word.`,
    schema: obj({ template: S('Name or part of the name of the template.'), top: S('Top line.'), bottom: S('Bottom line.'), ...WHEN }, ['template']),
    label: (a) => `Adding a "${str(a.template)}" meme`,
    run: async (ctx, a) => {
      const list = await memeTemplates().catch((err: Error) => bad(err.message));
      const t = findTemplate(list, str(a.template))[0];
      if (!t) bad(`No template matches "${str(a.template)}". Popular ones: ${list.slice(0, 12).map((m) => m.name).join(', ')}.`);
      const v = view(ctx.p);
      const { start, duration } = span(ctx.p, a, v, 3);
      const m = await fetchMeme(ctx.p, t).catch((err: Error) => bad(err.message));
      const W = v.doc.settings.width;
      const H = v.doc.settings.height;
      const imgAspect = t.width / t.height;
      const top = imgAspect >= W / H ? 0.5 - (W / imgAspect / H) / 2 : 0;
      const bottom = imgAspect >= W / H ? 0.5 + (W / imgAspect / H) / 2 : 1;
      let d = ops.addOverlay(v.doc, m, { start, duration, framing: { fit: 'contain', focusX: 0.5, focusY: 0.5, scale: 1, blurFill: true }, muted: true, name: m.name, createdBy: ctx.messageId }).doc;
      const overlayId = d.overlays[d.overlays.length - 1].id;
      const ids: string[] = [];
      for (const [text, y] of [[str(a.top), top + 0.065], [str(a.bottom), bottom - 0.065]] as [string, number][]) {
        if (!text.trim()) continue;
        const r = ops.addGraphic(d, { preset: 'meme', props: { text: text.trim(), size: 0.062, maxWidth: 0.94 }, start, duration, y, name: `Meme: ${clip(text.trim(), 24)}`, createdBy: ctx.messageId });
        d = r.doc;
        ids.push(r.item.id);
      }
      save(ctx, d, 'add_meme', `Meme "${t.name}" at ${sec(start)}s`);
      return { text: `Added the "${t.name}" meme as b-roll ${overlayId} ${sec(start)}-${sec(start + duration)}s${ids.length ? ` with text ${ids.join(', ')}` : ''}.` };
    },
  },
  {
    name: 'find_gif',
    description: 'Search Tenor for reaction GIFs (needs the Tenor key from Settings). Returns candidates with ids and descriptions; pick one and call add_gif. Describe the reaction or joke, not the subject: "facepalm", "mind blown", "slow clap", "confused math lady", "this is fine".',
    schema: obj({ query: S('What the GIF should show.'), limit: N('How many to list, default 6.') }, ['query']),
    label: (a) => `Searching GIFs for "${str(a.query)}"`,
    readOnly: true,
    run: async (_ctx, a) => {
      const q = str(a.query).trim();
      const results = await searchGifs(q, optNum(a.limit, 'limit') ?? 6).catch((err: Error) => bad(err.message));
      if (!results.length) return { text: `No GIFs found for "${q}". Try a broader word.` };
      return { text: `GIFs for "${q}" (use the id with add_gif):\n${results.map((r) => `  ${r.id}  "${r.description}"  ${r.dims.join('x')}, ${r.duration.toFixed(1)}s`).join('\n')}` };
    },
  },
  {
    name: 'add_gif',
    description: `Put a reaction GIF from find_gif on screen as a small picture-in-picture, looping for the time given. Use at most one or two per reel, on a reaction beat or a visual joke, 1.5 to 3 seconds, clear of the face. ${POSITION} size is the share of the frame width it takes, default 0.42.`,
    schema: obj({ gif_id: S('Id from find_gif.'), ...WHEN, position: S('Named position or "auto".'), x: N('0-1.'), y: N('0-1.'), size: N('0.2-0.7, default 0.42.'), name: S('Label on the timeline.') }, ['gif_id']),
    label: () => 'Adding a GIF',
    run: async (ctx, a) => {
      const g = foundGifs.get(str(a.gif_id));
      if (!g) bad(`No GIF with id "${a.gif_id}" in the last search; call find_gif first.`);
      const v = view(ctx.p);
      const { start, duration } = span(ctx.p, a, v, Math.min(3, Math.max(1.5, g.duration || 2)));
      const m = await fetchGif(ctx.p, g).catch((err: Error) => bad(err.message));
      const size = clamp(optNum(a.size, 'size') ?? 0.42, 0.2, 0.7);
      const pos = place(ctx.p, v, a.position ?? 'auto', start + Math.min(0.5, duration / 2), optNum(a.x, 'x'), optNum(a.y, 'y'));
      // The GIF loops: lay copies back to back until the time is covered.
      let d = v.doc;
      let t = start;
      let first: string | null = null;
      const loop = Math.max(0.2, m.duration || 2);
      while (t < start + duration - 0.05) {
        const r = ops.addOverlay(d, m, { start: t, duration: Math.min(loop, start + duration - t), framing: { fit: 'contain', focusX: 0.5, focusY: 0.5, scale: 1 }, muted: true, name: str(a.name) || m.name, createdBy: ctx.messageId });
        const o = r.doc.overlays[r.doc.overlays.length - 1];
        o.transform = { x: pos.x, y: pos.y, scale: size, rotation: 0, opacity: 1 };
        o.radius = 0.06;
        first ??= o.id;
        d = r.doc;
        t += loop;
      }
      save(ctx, d, 'add_gif', `GIF "${clip(g.description, 40)}" at ${sec(start)}s`);
      return { text: `Added GIF ${first} "${g.description}" ${sec(start)}-${sec(start + duration)}s at x=${pos.x.toFixed(2)} y=${pos.y.toFixed(2)} (${pos.how}), ${Math.round(size * 100)}% of the frame width.` };
    },
  },
  {
    name: 'style_overlay',
    description: 'Shape, blend or key a b-roll (picture-in-picture) layer. blend: how it mixes with what is under it (screen for light leaks, overlays and glows on dark footage; multiply for textures and paper; overlay for punch; lighter for sparks). mask: a rect or ellipse in fractions of the picture (x, y, w, h), with feather for a soft edge and invert to cut a hole; "none" removes it. Green screen: key_color "auto" samples the picture\'s corners, or give a hex such as #00FF00; key_similarity (0.15-0.35 usual), key_smoothness (0.1-0.3), key_spill (0.5 usual); "none" removes it. Opacity and position stay on the clip itself (update_item).',
    schema: obj({
      item_id: S('The b-roll clip id.'),
      blend: S('Blend mode.', ['normal', 'screen', 'multiply', 'overlay', 'lighten', 'darken', 'soft-light', 'difference', 'lighter']),
      mask_shape: S('Mask shape, or "none" to remove.', ['rect', 'ellipse', 'none']),
      mask_x: N('0-1 of the picture width.'),
      mask_y: N('0-1 of the picture height.'),
      mask_w: N('0-1.'),
      mask_h: N('0-1.'),
      mask_feather: N('0-0.5, softness of the edge.'),
      mask_invert: B('Cut the shape out instead of keeping it.'),
      mask_radius: N('Rect corners, 0-0.5.'),
      key_color: S('"auto", a hex colour, or "none" to remove the green screen.'),
      key_similarity: N('0-1.'),
      key_smoothness: N('0-1.'),
      key_spill: N('0-1.'),
    }, ['item_id']),
    label: () => 'Styling a layer',
    run: async (ctx, a) => {
      const v = view(ctx.p);
      const it = findItem(v, a.item_id);
      if (it.kind !== 'overlay') bad('style_overlay works on b-roll (picture-in-picture) clips.');
      const o = v.doc.overlays.find((x) => x.id === it.id)!;
      const patch: Partial<OverlayClip> = {};
      if (a.blend !== undefined) patch.blend = str(a.blend) === 'normal' ? undefined : (str(a.blend) as OverlayClip['blend']);
      if (a.mask_shape === 'none') patch.mask = undefined;
      else if (a.mask_shape !== undefined || a.mask_x !== undefined || a.mask_w !== undefined || a.mask_feather !== undefined || a.mask_invert !== undefined) {
        const cur = o.mask ?? { shape: 'rect' as const, x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
        patch.mask = {
          ...cur,
          shape: a.mask_shape !== undefined ? (str(a.mask_shape) as 'rect' | 'ellipse') : cur.shape,
          x: a.mask_x !== undefined ? clamp(num(a.mask_x, 'mask_x'), -0.5, 1) : cur.x,
          y: a.mask_y !== undefined ? clamp(num(a.mask_y, 'mask_y'), -0.5, 1) : cur.y,
          w: a.mask_w !== undefined ? clamp(num(a.mask_w, 'mask_w'), 0.01, 1.5) : cur.w,
          h: a.mask_h !== undefined ? clamp(num(a.mask_h, 'mask_h'), 0.01, 1.5) : cur.h,
          feather: a.mask_feather !== undefined ? clamp(num(a.mask_feather, 'mask_feather'), 0, 0.5) : cur.feather,
          invert: a.mask_invert !== undefined ? !!a.mask_invert : cur.invert,
          radius: a.mask_radius !== undefined ? clamp(num(a.mask_radius, 'mask_radius'), 0, 0.5) : cur.radius,
        };
      }
      if (a.key_color === 'none') patch.key = undefined;
      else if (a.key_color !== undefined || a.key_similarity !== undefined || a.key_smoothness !== undefined || a.key_spill !== undefined) {
        const cur = o.key ?? { color: '#00FF00', similarity: 0.25, smoothness: 0.15, spill: 0.5 };
        let color = cur.color;
        if (a.key_color === 'auto') color = (await autoKeyColor(ctx.p, o.mediaId)) ?? bad('Could not sample the corners of that clip.');
        else if (a.key_color !== undefined) {
          if (!/^#[0-9a-f]{6}$/i.test(str(a.key_color))) bad('key_color must be "auto", "none" or a hex colour like #00FF00.');
          color = str(a.key_color).toUpperCase();
        }
        patch.key = {
          color,
          similarity: a.key_similarity !== undefined ? clamp(num(a.key_similarity, 'key_similarity'), 0, 1) : cur.similarity,
          smoothness: a.key_smoothness !== undefined ? clamp(num(a.key_smoothness, 'key_smoothness'), 0, 1) : cur.smoothness,
          spill: a.key_spill !== undefined ? clamp(num(a.key_spill, 'key_spill'), 0, 1) : cur.spill,
        };
      }
      const d = ops.updateClip(v.doc, 'overlay', it.id, patch);
      save(ctx, d, 'style_overlay', `Styled ${it.id}`);
      const parts = [patch.blend !== undefined ? `blend ${patch.blend ?? 'normal'}` : '', 'mask' in patch ? (patch.mask ? `${patch.mask.shape} mask` : 'mask removed') : '', 'key' in patch ? (patch.key ? `green screen on ${patch.key.color}` : 'green screen off') : ''].filter(Boolean);
      return { text: `Layer ${it.id}: ${parts.join(', ') || 'unchanged'}.` };
    },
  },
  {
    name: 'add_broll',
    description: 'Lay b-roll (a video or image) over the main track while its sound continues underneath. Give the stretch either as timeline times or as word ids so it covers exactly the words it illustrates. source_start picks the part of the b-roll file to use. 2-4 seconds is typical; do not cover the first sentence of the video, where the speaker should be seen.',
    schema: obj({
      media: S('Letter, id or name of the b-roll file (or "library:<name>").'),
      start: N('Timeline seconds.'),
      end: N('Timeline seconds.'),
      duration: N('Alternative to end.'),
      start_word: S('Alternative to start: begin with this word.'),
      end_word: S('Alternative to end: finish after this word.'),
      source_start: N('Second of the b-roll file to start from. Default 0.'),
      name: S('Label on the timeline.'),
    }, ['media']),
    label: () => 'Adding b-roll',
    run: async (ctx, a) => {
      const m = await findMedia(ctx.p, a.media);
      if (m.kind === 'audio') bad(`"${m.name}" is audio, not b-roll.`);
      const v = view(ctx.p);
      const timeOf = (ref: unknown, edge: 'start' | 'end'): number | undefined => (ref === undefined || ref === '' ? undefined : wordTime(ctx.p, v, ref, edge));
      const start = timeOf(a.start_word, 'start') ?? num(a.start, 'start (or start_word)');
      const end = timeOf(a.end_word, 'end') ?? optNum(a.end, 'end');
      let duration = end !== undefined ? end - start : (optNum(a.duration, 'duration') ?? 3);
      const from = Math.max(0, optNum(a.source_start, 'source_start') ?? 0);
      if (m.kind === 'video') duration = Math.min(duration, m.duration - from);
      if (duration < 0.3) bad('The b-roll would be shorter than 0.3s. Check the times, or source_start against the length of the file.');
      const r = ops.addOverlay(v.doc, m, { start, duration, in: from, name: str(a.name) || m.name, createdBy: ctx.messageId });
      save(ctx, r.doc, 'add_broll', `B-roll ${m.name} at ${sec(start)}s`);
      const said = ops.wordsInRanges(v.words, [{ start, end: start + duration }]);
      return { text: `Added b-roll ${r.clip.id} "${m.name}" over ${sec(r.clip.start)}-${sec(r.clip.start + srcDuration(r.clip))}s${said ? ` (while: "${clip(said, 80)}")` : ''}.` };
    },
  },
  {
    name: 'add_sfx',
    description: 'Place a sound effect. Give a query ("whoosh", "soft pop", "ding") or an id from list_library. "at" is the moment the sound should land (a cut, or a graphic appearing): the effect is lined up so its loudest moment hits that time, and its level is set quietly against the voice. A few well-placed effects beat one on every cut.',
    schema: obj({ query: S('What kind of sound.'), sfx_id: S('Exact id from list_library.'), at: N('Timeline seconds at which it lands.'), at_word: S('Alternative to at: land as this word is spoken (a word id).'), at_item: S('Alternative to at: land as this graphic, b-roll clip or punch-in appears (its id).'), gain_db: N('Louder (+) or quieter (-) than the automatic level.'), name: S('Label on the timeline.') }),
    label: (a) => `Adding a ${str(a.query || a.sfx_id || 'sound')} effect`,
    run: async (ctx, a) => {
      const entry = a.sfx_id ? listSfx().find((s) => s.id === str(a.sfx_id)) : searchSfx(str(a.query), 1)[0];
      if (!entry) bad(a.sfx_id ? `No sound effect with id "${a.sfx_id}". Use list_library kind=sfx.` : `No sound effect matches "${a.query}". Use list_library kind=sfx to see what exists.`);
      const m = await importMedia(ctx.p, entry.file, { name: entry.name, origin: 'sfx' });
      const v = view(ctx.p);
      const when = a.at_item ? findItem(v, a.at_item).start : a.at_word ? wordTime(ctx.p, v, a.at_word, 'start') : num(a.at, 'at (or at_word, at_item)');
      const at = clamp(when, 0, Math.max(0, v.duration));
      // Sit under the voice: effects that compete with speech sound amateur.
      const offset = { ui: -14, tone: -13, whoosh: -12, riser: -12, impact: -8 }[entry.role];
      const gainDb = clamp(voicePeakDb(ctx.p, v) + offset + 1.5 + (optNum(a.gain_db, 'gain_db') ?? 0), -40, 6);
      const r = ops.addAudio(v.doc, m, { start: Math.max(0, at - entry.hit - 0.015), role: 'sfx', volume: dbToGain(gainDb), name: str(a.name) || entry.name, createdBy: ctx.messageId });
      save(ctx, r.doc, 'add_sfx', `${entry.name} at ${sec(at)}s`);
      const credit = soundCredit(entry);
      return { text: `Added "${entry.name}" (${r.clip.id}) landing at ${sec(at)}s, ${gainDb.toFixed(0)} dB.${credit ? ` This sound needs a credit line in the post's caption; give it to the user: ${credit}` : ''}` };
    },
  },
  {
    name: 'set_music',
    description: 'Put background music under the video (replacing any existing music), or remove it. The music ducks automatically whenever someone speaks and fades out at the end. If the file is shorter than the video it repeats. Use a file the user provided (MEDIA in get_timeline) or one from the built-in set (list_library kind=music; the names say the mood; refer to one as "library:<name>"). Built-in tracks need a credit line in the caption, which the result gives you: pass it on to the user.',
    schema: obj({ media: S('Letter, id or name of an audio file, or "library:<name>".'), volume_db: N('Level of the music in dB. Leave it out to have it set automatically against the voice (recommended); it drops a further 14 dB under speech.'), duck: B('Lower it under speech. Default true.'), start: N('Timeline second at which the music begins. Default 0.'), source_start: N('Second of the song to start from. Default 0.'), remove: B('Remove the music instead.') }),
    label: (a) => (a.remove ? 'Removing the music' : 'Adding music'),
    run: async (ctx, a) => {
      let d = ops.cloneDoc(ctx.p.doc);
      const had = d.audio.filter((x) => x.role === 'music').length;
      d.audio = d.audio.filter((x) => x.role !== 'music');
      if (a.remove) {
        if (!had) return { text: 'There was no music to remove.' };
        save(ctx, d, 'set_music', 'Removed the music');
        return { text: 'Removed the music.' };
      }
      const m = await findMedia(ctx.p, a.media);
      if (!m.hasAudio) bad(`"${m.name}" has no sound.`);
      const total = contentDuration(d);
      // Songs are mastered at very different levels. Unless told otherwise, set this one against the voice:
      // clearly under it when nobody speaks, and well under it (the ducking) when somebody does.
      const voice = voiceLevelDb(ctx.p, view(ctx.p));
      await envelopeSoon(ctx.p, m.id, ctx.signal, 8000);
      const song = loudLevelDb(ctx.p, m.id);
      const auto = voice !== null && song !== null ? clamp(voice - 8 - song, -30, 6) : -9;
      const volume = clamp(dbToGain(optNum(a.volume_db, 'volume_db') ?? auto), 0, 2);
      let t = clamp(optNum(a.start, 'start') ?? 0, 0, Math.max(0, total - 0.5));
      let from = clamp(optNum(a.source_start, 'source_start') ?? 0, 0, Math.max(0, m.duration - 1));
      let copies = 0;
      while (t < total - 0.05 && copies < 40) {
        const r = ops.addAudio(d, m, { start: t, in: from, role: 'music', volume, duck: a.duck !== false, name: m.name, createdBy: ctx.messageId });
        d = r.doc;
        if (copies > 0) d.audio[d.audio.length - 1].fadeIn = 0.3;
        t += srcDuration(r.clip);
        from = 0;
        copies++;
      }
      save(ctx, d, 'set_music', `Music: ${m.name}`);
      const how = a.volume_db === undefined && voice !== null && song !== null ? ' (set from the voice: about 8 dB under it when nobody is speaking)' : '';
      // Tracks from the built-in set are free to use with a credit; hand the line over so it reaches the caption.
      const credit = /\(Kevin MacLeod, CC BY\)/.test(m.name) ? ` Credit line for the caption: Music: "${m.name.replace(/^.*? - /, '').replace(/ \(Kevin MacLeod, CC BY\)\.\w+$/, '')}" Kevin MacLeod (incompetech.com), licensed under Creative Commons: By Attribution 4.0.` : '';
      return { text: `"${m.name}" now plays under the video at ${gainToDb(volume).toFixed(0)} dB${how}${a.duck !== false ? ', dropping a further 14 dB under speech' : ''}${copies > 1 ? `, repeated ${copies} times to cover the length` : ''}. It fades out at the end.${credit}` };
    },
  },
  {
    name: 'add_audio',
    description: 'Place an audio file (or the sound of a video) on an audio track at a time, as a voice-over recording or an effect. For background music use set_music instead.',
    schema: obj({ media: S('Letter, id or name.'), start: N('Timeline seconds.'), source_start: N('Second of the file to start from.'), duration: N('How much of it to use.'), volume_db: N('Level change in dB.'), role: S('"voice" (captioned, music ducks under it) or "sfx".', ['voice', 'sfx']) }, ['media', 'start']),
    label: () => 'Adding audio',
    run: async (ctx, a) => {
      const m = await findMedia(ctx.p, a.media);
      if (!m.hasAudio) bad(`"${m.name}" has no sound.`);
      const r = ops.addAudio(ctx.p.doc, m, { start: Math.max(0, num(a.start, 'start')), in: optNum(a.source_start, 'source_start'), duration: optNum(a.duration, 'duration'), role: a.role === 'sfx' ? 'sfx' : 'voice', volume: clamp(dbToGain(optNum(a.volume_db, 'volume_db') ?? 0), 0, 4), name: m.name, createdBy: ctx.messageId });
      save(ctx, r.doc, 'add_audio', `Audio ${m.name}`);
      return { text: `Added audio ${r.clip.id} "${m.name}" at ${sec(r.clip.start)}-${sec(r.clip.start + srcDuration(r.clip))}s.` };
    },
  },
  {
    name: 'add_voiceover',
    description: 'Generate a spoken line with text-to-speech and place it on an audio track. It is captioned like any other speech once transcribed. Use list_library kind=voices for voice ids.',
    schema: obj({ text: S('What to say. One or two sentences per call.'), start: N('Timeline seconds at which it starts.'), voice: S('Voice id. Default: the first available.'), volume_db: N('Level change in dB.'), name: S('Label on the timeline.') }, ['text', 'start']),
    label: () => 'Recording a voiceover line',
    run: async (ctx, a) => {
      const text = str(a.text).trim();
      if (!text) bad('Nothing to say.');
      const dir = path.join(ctx.p.dir, 'voiceover');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${ops.uid('v')}.wav`);
      await synthesize(text, str(a.voice) || undefined, file, ctx.signal);
      const m: MediaAsset = await importMedia(ctx.p, file, { name: `Voiceover: ${clip(text, 36)}`, managed: true, origin: 'voiceover' });
      const r = ops.addAudio(ctx.p.doc, m, { start: Math.max(0, num(a.start, 'start')), role: 'voice', volume: clamp(dbToGain(optNum(a.volume_db, 'volume_db') ?? 0), 0, 4), name: str(a.name) || `Voiceover: ${clip(text, 24)}`, createdBy: ctx.messageId });
      save(ctx, r.doc, 'add_voiceover', `Voiceover "${clip(text, 50)}"`);
      return { text: `Added a ${sec(m.duration)}s voiceover line (${r.clip.id}) at ${sec(r.clip.start)}s: "${clip(text, 80)}". It will be captioned once it has been transcribed.` };
    },
  },
  {
    name: 'set_audio',
    description: 'Settings for the final mix on export: bring it to a standard loudness (-14 LUFS suits Reels, TikTok and YouTube), reduce background noise in speech, and make the voice clearer (less rumble, more presence, a steadier level).',
    schema: obj({ normalize: B('Normalise loudness on export.'), target_lufs: N('Target loudness. Default -14.'), denoise: B('Reduce background noise in speech.'), enhance_voice: B('Clean up the voice: high-pass, presence, gentle compression.') }),
    label: () => 'Setting up the mix',
    run: (ctx, a) => {
      const cur = ctx.p.doc.settings.audio;
      const audio = { normalize: a.normalize !== undefined ? !!a.normalize : cur.normalize, targetLufs: clamp(optNum(a.target_lufs, 'target_lufs') ?? cur.targetLufs, -30, -8), denoise: a.denoise !== undefined ? !!a.denoise : cur.denoise, enhance: a.enhance_voice !== undefined ? !!a.enhance_voice : !!cur.enhance };
      save(ctx, ops.setSettings(ctx.p.doc, { audio }), 'set_audio', 'Mix settings');
      return { text: `On export: ${audio.normalize ? `loudness normalised to ${audio.targetLufs} LUFS` : 'no loudness normalisation'}, noise reduction ${audio.denoise ? 'on' : 'off'}, voice clean-up ${audio.enhance ? 'on' : 'off'}.` };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
