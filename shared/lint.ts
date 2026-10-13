// Checks that need no judgement: text shown too briefly to read, graphics
// stacked on each other or under an app's own buttons, flash frames, black
// gaps. They run before the assistant looks at rendered frames, so its
// attention goes to what only eyes can catch.

import type { FaceTrack, ID, ProjectDoc } from './types.ts';
import type { CaptionCard } from './captions.ts';
import type { MainSeg } from './timeline.ts';
import { contentDuration, faceAt, framingAt, layerGeometry, mainDuration, segAt, sourceAt, srcDuration } from './timeline.ts';

export interface Issue {
  severity: 'fix' | 'check' | 'note';
  message: string;
  at?: number;
  itemId?: ID;
}

/** Parts of a 9:16 frame that Reels, TikTok and Shorts cover with their own interface (the largest of the three). */
export const UNSAFE_VERTICAL = { top: 220 / 1920, bottom: 480 / 1920, right: 150 / 1080 };

export interface LintContext {
  layout: MainSeg[];
  cards: CaptionCard[];
  mediaSize: (id: ID) => { width: number; height: number } | undefined;
  faces: (id: ID) => FaceTrack | undefined;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

function graphicText(props: Record<string, unknown>): string {
  const parts = [props.text, props.title, props.subtitle, props.label];
  if (Array.isArray(props.items)) parts.push(props.items.join(' '));
  return parts.filter((x) => typeof x === 'string').join(' ');
}

/** Where the subject's face sits in the output frame at time t, in 0..1 of the frame, if known. */
export function faceInFrame(doc: ProjectDoc, ctx: Pick<LintContext, 'layout' | 'mediaSize' | 'faces'>, t: number): { x: number; y: number; w: number; h: number } | null {
  const seg = segAt(ctx.layout, t);
  if (!seg || seg.clip.kind !== 'media') return null;
  const c = seg.clip;
  const track = ctx.faces(c.mediaId);
  const size = ctx.mediaSize(c.mediaId);
  if (!track || !size) return null;
  const st = sourceAt(c, t - seg.start);
  const face = faceAt(track, st);
  if (!face) return null;
  const { width: W, height: H } = doc.settings;
  const g = layerGeometry(size.width, size.height, W, H, framingAt(c.framing, track, st, c.motion, t - seg.start));
  const k = g.dst.w / g.src.w;
  return {
    x: (g.dst.x + (face.x * size.width - g.src.x) * k) / W,
    y: (g.dst.y + (face.y * size.height - g.src.y) * k) / H,
    w: (face.w * size.width * k) / W,
    h: (face.h * size.height * k) / H,
  };
}

export function lint(doc: ProjectDoc, ctx: LintContext): Issue[] {
  const issues: Issue[] = [];
  const duration = contentDuration(doc);
  const main = mainDuration(doc);
  const vertical = doc.settings.height / doc.settings.width > 1.5;
  if (duration <= 0) return [{ severity: 'fix', message: 'The timeline is empty.' }];

  for (const seg of ctx.layout) {
    if (seg.end - seg.start < 0.3) issues.push({ severity: 'check', at: seg.start, itemId: seg.clip.id, message: `Main clip at ${seg.start.toFixed(2)}s lasts only ${(seg.end - seg.start).toFixed(2)}s and will read as a flash.` });
  }

  // Picture missing: timeline runs past the main track with nothing over it.
  if (duration > main + 0.05) {
    const covered = doc.overlays.some((o) => o.start <= main + 0.05 && o.start + srcDuration(o) >= duration - 0.05);
    if (!covered) issues.push({ severity: 'fix', at: main, message: `From ${main.toFixed(2)}s to ${duration.toFixed(2)}s there is no picture: something extends past the end of the main track.` });
  }

  const gs = doc.graphics.filter((g) => g.template !== 'progress' && g.template !== 'highlight');
  for (const g of gs) {
    const end = g.start + g.duration;
    const text = graphicText(g.props);
    const n = words(text);
    const need = n <= 3 ? 0.8 : Math.max(1.2, 0.3 * n);
    if (n > 0 && g.duration < need - 0.05) issues.push({ severity: 'fix', at: g.start, itemId: g.id, message: `"${text.slice(0, 40)}" is on screen for ${g.duration.toFixed(1)}s; ${n} words need about ${need.toFixed(1)}s to read.` });
    if (g.start >= duration - 0.05) issues.push({ severity: 'fix', at: g.start, itemId: g.id, message: `Graphic "${g.name ?? g.template}" starts after the video ends.` });
    else if (end > duration + 0.1) issues.push({ severity: 'check', at: g.start, itemId: g.id, message: `Graphic "${g.name ?? g.template}" runs ${(end - duration).toFixed(1)}s past the end of the video.` });
    if (vertical) {
      if (g.y < UNSAFE_VERTICAL.top - 0.02) issues.push({ severity: 'fix', at: g.start, itemId: g.id, message: `"${g.name ?? g.template}" sits at y=${g.y.toFixed(2)}, under the app's top bar. Keep the centre at y >= ${(UNSAFE_VERTICAL.top + 0.03).toFixed(2)}.` });
      if (g.y > 1 - UNSAFE_VERTICAL.bottom + 0.02) issues.push({ severity: 'fix', at: g.start, itemId: g.id, message: `"${g.name ?? g.template}" sits at y=${g.y.toFixed(2)}, where the app shows its caption and buttons. Keep it above y=${(1 - UNSAFE_VERTICAL.bottom).toFixed(2)}.` });
      if (g.x > 1 - UNSAFE_VERTICAL.right - 0.05 && g.template !== 'text') issues.push({ severity: 'check', at: g.start, itemId: g.id, message: `"${g.name ?? g.template}" is close to the right edge, where the like and share buttons sit.` });
    }
    if (doc.captions.enabled && Math.abs(g.y - doc.captions.y) < 0.09 && ctx.cards.some((c) => c.start < end && c.end > g.start)) {
      issues.push({ severity: 'fix', at: g.start, itemId: g.id, message: `"${g.name ?? g.template}" is at the same height as the captions (y=${doc.captions.y.toFixed(2)}) and will collide with them.` });
    }
    const face = faceInFrame(doc, ctx, g.start + Math.min(g.duration / 2, 0.6));
    if (face && Math.abs(g.x - face.x) < face.w * 0.6 + 0.12 && Math.abs(g.y - face.y) < face.h * 0.55) {
      issues.push({ severity: 'fix', at: g.start, itemId: g.id, message: `"${g.name ?? g.template}" covers the speaker's face (face centre ${face.x.toFixed(2)}, ${face.y.toFixed(2)}). Move it above y=${Math.max(0.14, face.y - face.h * 0.75).toFixed(2)} or below y=${(face.y + face.h * 0.8).toFixed(2)}.` });
    }
  }
  for (let i = 0; i < gs.length; i++) {
    for (let j = i + 1; j < gs.length; j++) {
      const a = gs[i];
      const b = gs[j];
      const overlap = Math.min(a.start + a.duration, b.start + b.duration) - Math.max(a.start, b.start);
      if (overlap > 0.3 && Math.abs(a.y - b.y) < 0.1 && Math.abs(a.x - b.x) < 0.35) {
        issues.push({ severity: 'fix', at: Math.max(a.start, b.start), itemId: b.id, message: `"${a.name ?? a.template}" and "${b.name ?? b.template}" are on screen together in the same place for ${overlap.toFixed(1)}s.` });
      }
    }
  }

  const zooms = [...doc.zooms].sort((a, b) => a.start - b.start);
  for (let i = 2; i < zooms.length; i++) {
    const [a, b, c] = [zooms[i - 2], zooms[i - 1], zooms[i]];
    if (a.scale === b.scale && b.scale === c.scale && a.ease === b.ease && b.ease === c.ease && a.toScale === c.toScale) {
      issues.push({ severity: 'note', at: c.start, itemId: c.id, message: 'Three punch-ins in a row are identical; vary the amount or style so they do not feel mechanical.' });
      break;
    }
  }
  for (const z of zooms) if (z.start >= main) issues.push({ severity: 'fix', at: z.start, itemId: z.id, message: 'A punch-in starts after the main track ends and does nothing.' });

  for (const o of doc.overlays) {
    const d = srcDuration(o);
    if (d < 0.8) issues.push({ severity: 'check', at: o.start, itemId: o.id, message: `B-roll at ${o.start.toFixed(2)}s lasts ${d.toFixed(2)}s, too short to register.` });
    if (o.start >= duration) issues.push({ severity: 'fix', at: o.start, itemId: o.id, message: 'B-roll starts after the video ends.' });
  }

  const sfx = doc.audio.filter((a) => a.role === 'sfx');
  if (sfx.length > Math.max(3, (duration / 60) * 12)) issues.push({ severity: 'note', message: `${sfx.length} sound effects in ${duration.toFixed(0)}s is a lot; more than about 12 a minute starts to feel busy.` });
  for (const a of doc.audio) {
    if (a.start >= duration) issues.push({ severity: 'fix', at: a.start, itemId: a.id, message: 'An audio clip starts after the video ends.' });
    if (a.role === 'music' && a.duck === false && ctx.cards.length) issues.push({ severity: 'check', itemId: a.id, message: 'The music does not duck under speech; check the voice stays clear.' });
  }

  // Captions that flash by.
  const quick = ctx.cards.filter((c) => c.end - c.start < 0.22);
  if (doc.captions.enabled && quick.length > Math.max(2, ctx.cards.length * 0.15)) {
    issues.push({ severity: 'check', at: quick[0].start, message: `${quick.length} caption cards are on screen for under a quarter of a second; use more words per card.` });
  }
  if (doc.captions.enabled && vertical && doc.captions.y > 1 - UNSAFE_VERTICAL.bottom - 0.005) {
    issues.push({ severity: 'fix', message: `Captions sit at y=${doc.captions.y.toFixed(2)}, under the app's own caption and buttons. Move them to y <= ${(1 - UNSAFE_VERTICAL.bottom - 0.01).toFixed(2)}.` });
  }
  return issues;
}
