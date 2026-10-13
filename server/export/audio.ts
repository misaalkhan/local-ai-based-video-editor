// The audio half of an export: one ffmpeg run that cuts, places, levels and
// mixes every audible clip into a single WAV.
//
// Gains come from the same functions the preview uses (clip volume, fades,
// ducking under speech, the fade at the end of over-long music), written out
// as ffmpeg expressions, so the export sounds like the preview.

import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG, RNNOISE_MODEL } from '../config.ts';
import { run } from '../proc.ts';
import type { Project } from '../store.ts';
import { getEnvelope, getWords } from '../store.ts';
import type { AudioClip, MediaAsset, ProjectDoc, Range, SourceClip } from '../../shared/types.ts';
import {
  DUCK_ATTACK,
  DUCK_LEVEL,
  DUCK_RELEASE,
  MUSIC_TAIL_FADE,
  contentDuration,
  duckIntervals,
  layoutMain,
  localAt,
  rampPoints,
  srcDuration,
  toFrames,
} from '../../shared/timeline.ts';
import { speechSpans, timelineWords } from '../../shared/captions.ts';
import { ffmpegAudioFilters } from '../../shared/audiofx.ts';

export const SAMPLE_RATE = 48000;

const n = (v: number) => (Math.round(v * 1e6) / 1e6).toString();
const samples = (t: number) => Math.max(0, Math.round(t * SAMPLE_RATE));

/** ffmpeg's atempo accepts 0.5 to 100 per instance; chain it for slower speeds. */
function tempo(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-4) out.push(`atempo=${n(Math.min(100, s))}`);
  return out;
}

/**
 * A speed ramp as stretches of the source at a constant tempo each: constant
 * parts of the ramp are one stretch, a change of speed is cut into steps of
 * about 0.2x, and each stretch is stretched to exactly the time it plays for.
 */
export function tempoPieces(clip: SourceClip): { a: number; b: number; tempo: number }[] {
  const pts = rampPoints(clip);
  const marks = new Set<number>([clip.in, clip.out]);
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const steps = Math.min(16, Math.max(1, Math.ceil(Math.abs(b.speed - a.speed) / 0.2)));
    for (let k = 0; k <= steps; k++) {
      const t = a.t + ((b.t - a.t) * k) / steps;
      if (t > clip.in + 0.02 && t < clip.out - 0.02) marks.add(Math.round(t * 1e4) / 1e4);
    }
  }
  const cuts = [...marks].sort((x, y) => x - y);
  const out: { a: number; b: number; tempo: number }[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    const plays = Math.abs(localAt({ ...clip, reverse: false }, b) - localAt({ ...clip, reverse: false }, a));
    if (plays < 1e-6) continue;
    out.push({ a, b, tempo: (b - a) / plays });
  }
  return out;
}

/** A clip's volume keyframes as an ffmpeg expression in `t` (seconds into the clip): straight lines between points, held beyond them. */
export function volumeKeysExpr(keys: { t: number; gain: number }[]): string {
  const pts = [...keys].sort((a, b) => a.t - b.t);
  if (pts.length === 1) return n(pts[0].gain);
  // Nested conditionals from the last segment back, so each lands in the right stretch.
  let expr = n(pts[pts.length - 1].gain);
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.max(1e-6, b.t - a.t);
    const line = `(${n(a.gain)}+(${n(b.gain)}-${n(a.gain)})*(t-${n(a.t)})/${n(len)})`;
    expr = `if(lt(t,${n(b.t)}),${line},${expr})`;
  }
  return `if(lt(t,${n(pts[0].t)}),${n(pts[0].gain)},${expr})`;
}

/** Gain over time for a music clip, as an ffmpeg expression in `t` (timeline seconds). */
function musicGain(duck: Range[] | null, tailEnd: number | null): string | null {
  const parts: string[] = [];
  if (duck && duck.length) {
    const ramps = duck.map(
      (iv) =>
        `clip((t-${n(iv.start - DUCK_ATTACK)})/${n(DUCK_ATTACK)},0,1)*clip((${n(iv.end + DUCK_RELEASE)}-t)/${n(DUCK_RELEASE)},0,1)`,
    );
    // duckIntervals() guarantees the ramps never overlap, so their sum is their maximum.
    parts.push(`(1-${n(1 - DUCK_LEVEL)}*(${ramps.join('+')}))`);
  }
  if (tailEnd !== null) parts.push(`clip((${n(tailEnd)}-t)/${n(MUSIC_TAIL_FADE)},0,1)`);
  return parts.length ? parts.join('*') : null;
}

/**
 * Clean-up applied to recordings of speech: noise reduction with a small neural
 * network (RNNoise) when its weights are installed, otherwise a spectral gate set
 * from the recording's own noise floor; and, when asked, a voice chain that cuts
 * rumble, adds presence and evens out the level.
 */
export function speechFilters(p: Project, media: MediaAsset, audio: ProjectDoc['settings']['audio']): string {
  const parts: string[] = [];
  if (audio.denoise) {
    if (fs.existsSync(RNNOISE_MODEL)) parts.push(`arnndn=m=${RNNOISE_MODEL.replace(/([\\':])/g, '\\$1')}:mix=0.85`);
    else {
      // The gate needs to know where the noise sits; the quietest 5% of the recording is a fair guess.
      const env = getEnvelope(p, media.id);
      let floor = -45;
      if (env?.length) {
        const sorted = Array.from(env).sort((a, b) => a - b);
        floor = sorted[Math.floor(sorted.length * 0.05)] - 100;
      }
      parts.push(`afftdn=nr=15:nf=${Math.round(Math.max(-80, Math.min(-20, floor + 3)))}`);
    }
  }
  if (audio.enhance) {
    parts.push('highpass=f=80:p=2', 'equalizer=f=250:t=q:w=1.2:g=-2', 'equalizer=f=3500:t=q:w=1:g=2.5', 'acompressor=threshold=-18dB:ratio=2:attack=10:release=200');
  }
  return parts.length ? `,${parts.join(',')}` : '';
}

export interface AudioPlan {
  inputs: string[];
  filter: string;
  totalSamples: number;
  /** False when nothing on the timeline makes a sound. */
  audible: boolean;
}

export function planAudio(p: Project, doc: ProjectDoc): AudioPlan {
  const fps = doc.settings.fps;
  const layout = layoutMain(doc);
  const duration = contentDuration(doc);
  const totalSamples = samples(duration);
  const words = timelineWords(doc, layout, (id) => getWords(p, id));
  const duck = duckIntervals(speechSpans(words));

  const inputs: string[] = [];
  const uses = new Map<string, { index: number; labels: string[]; media: MediaAsset }>();
  const chains: string[] = [];
  let counter = 0;

  /** Reserve one branch of a media file's audio and return its label. */
  const tap = (media: MediaAsset): string => {
    let u = uses.get(media.id);
    if (!u) {
      u = { index: inputs.length, labels: [], media };
      inputs.push(media.path);
      uses.set(media.id, u);
    }
    const label = `s${u.index}_${u.labels.length}`;
    u.labels.push(label);
    return label;
  };

  /** A clip cut out of its source, at the right speed and level, exactly `frames` long. */
  const clipChain = (clip: SourceClip, media: MediaAsset, frames: number, microFade: boolean): string => {
    const len = Math.round((frames * SAMPLE_RATE) / fps);
    const dur = len / SAMPLE_RATE;
    const out = `c${counter++}`;
    const f: string[] = [];
    let src: string;
    if (clip.ramp?.length) {
      // Each stretch of the ramp at its own tempo, joined end to end.
      const labels = tempoPieces(clip).map((piece) => {
        const label = `r${counter++}`;
        const part = [`atrim=start_sample=${samples(piece.a)}:end_sample=${samples(piece.b)}`, 'asetpts=PTS-STARTPTS', ...tempo(piece.tempo)];
        chains.push(`[${tap(media)}]${part.join(',')}[${label}]`);
        return label;
      });
      src = `j${counter++}`;
      chains.push(labels.length === 1 ? `[${labels[0]}]anull[${src}]` : `${labels.map((l) => `[${l}]`).join('')}concat=n=${labels.length}:v=0:a=1[${src}]`);
    } else {
      src = tap(media);
      f.push(`atrim=start_sample=${samples(clip.in)}:end_sample=${samples(clip.out)}`, 'asetpts=PTS-STARTPTS', ...tempo(clip.speed));
    }
    if (clip.reverse) f.push('areverse');
    f.push(...ffmpegAudioFilters(clip.audioFx));
    if (Math.abs(clip.volume - 1) > 1e-4) f.push(`volume=${n(clip.volume)}`);
    if (clip.volumeKeys?.length) f.push(`volume=eval=frame:volume='${volumeKeysExpr(clip.volumeKeys)}'`);
    // A few milliseconds of fade at every cut keeps the waveform from stepping, which would click.
    const fadeIn = Math.max(clip.fadeIn ?? 0, microFade && dur > 0.05 ? 0.006 : 0);
    const fadeOut = Math.max(clip.fadeOut ?? 0, microFade && dur > 0.05 ? 0.006 : 0);
    if (fadeIn > 0) f.push(`afade=t=in:st=0:d=${n(Math.min(fadeIn, dur))}`);
    if (fadeOut > 0) f.push(`afade=t=out:st=${n(Math.max(0, dur - fadeOut))}:d=${n(Math.min(fadeOut, dur))}`);
    f.push(`apad=whole_len=${len}`, `atrim=end_sample=${len}`);
    chains.push(`[${src}]${f.join(',')}[${out}]`);
    return out;
  };

  const silence = (frames: number): string => {
    const len = Math.max(1, Math.round((frames * SAMPLE_RATE) / fps));
    const out = `c${counter++}`;
    chains.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=end_sample=${len}[${out}]`);
    return out;
  };

  const audibleMedia = (clip: SourceClip): MediaAsset | null => {
    const m = p.media.get(clip.mediaId);
    return m && m.hasAudio && !clip.muted && clip.volume > 0 && fs.existsSync(m.path) ? m : null;
  };

  const mixIn: string[] = [];
  let audible = false;

  // Main track: one piece per clip, joined end to end.
  if (layout.length) {
    const pieces = layout.map((seg) => {
      const frames = seg.endFrame - seg.startFrame;
      const m = seg.clip.kind === 'media' ? audibleMedia(seg.clip) : null;
      if (seg.clip.kind === 'media' && m) {
        audible = true;
        return clipChain(seg.clip, m, frames, true);
      }
      return silence(frames);
    });
    if (pieces.length === 1) mixIn.push(pieces[0]);
    else {
      chains.push(`${pieces.map((l) => `[${l}]`).join('')}concat=n=${pieces.length}:v=0:a=1[maina]`);
      mixIn.push('maina');
    }
  }

  // Everything with its own start time is delayed into place.
  const timed: (SourceClip & { start: number; role?: AudioClip['role']; duck?: boolean })[] = [...doc.overlays, ...doc.audio];
  for (const clip of timed) {
    const m = audibleMedia(clip);
    if (!m || clip.start >= duration) continue;
    audible = true;
    const frames = Math.max(1, toFrames(srcDuration(clip), fps));
    const base = clipChain(clip, m, frames, false);
    const out = `t${counter++}`;
    const f: string[] = [`adelay=delays=${samples(clip.start)}S:all=1`];
    if (clip.role === 'music') {
      const tail = clip.start + srcDuration(clip) > duration + 1e-6 ? duration : null;
      const expr = musicGain(clip.duck !== false ? duck : null, tail);
      if (expr) f.push(`volume=eval=frame:volume='${expr}'`);
    }
    chains.push(`[${base}]${f.join(',')}[${out}]`);
    mixIn.push(out);
  }

  // Each source file is decoded once, brought to one format, then split per use.
  const heads: string[] = [];
  for (const u of uses.values()) {
    const voice = (u.media.wordCount ?? 0) > 0;
    const clean = voice ? speechFilters(p, u.media, doc.settings.audio) : '';
    const head = `[${u.index}:a:0]aresample=${SAMPLE_RATE}:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo${clean}`;
    heads.push(u.labels.length === 1 ? `${head}[${u.labels[0]}]` : `${head},asplit=${u.labels.length}${u.labels.map((l) => `[${l}]`).join('')}`);
  }

  const finish = `apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples},alimiter=limit=0.95:attack=5:release=60:level=disabled`;
  let tail: string;
  if (!mixIn.length) tail = `anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=end_sample=${Math.max(1, totalSamples)}[out]`;
  else if (mixIn.length === 1) tail = `[${mixIn[0]}]${finish}[out]`;
  else tail = `${mixIn.map((l) => `[${l}]`).join('')}amix=inputs=${mixIn.length}:normalize=0:dropout_transition=0:duration=longest,${finish}[out]`;

  return { inputs, filter: [...heads, ...chains, tail].join(';\n'), totalSamples, audible };
}

export interface Loudness {
  i: number;
  tp: number;
  lra: number;
  thresh: number;
  offset: number;
}

/** First pass of EBU R128 normalisation: measure the mix. Returns null when it is too short or silent to measure. */
export async function measureLoudness(wav: string, target: number, signal?: AbortSignal): Promise<Loudness | null> {
  try {
    const r = await run(
      FFMPEG,
      ['-hide_banner', '-nostdin', '-i', wav, '-af', `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'],
      { signal },
    );
    const m = /\{[^{}]*"input_i"[^{}]*\}/.exec(r.stderr);
    if (!m) return null;
    const j = JSON.parse(m[0]) as Record<string, string>;
    const v = {
      i: Number(j.input_i),
      tp: Number(j.input_tp),
      lra: Number(j.input_lra),
      thresh: Number(j.input_thresh),
      offset: Number(j.target_offset),
    };
    return Object.values(v).every(Number.isFinite) ? v : null;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

/** The second-pass filter that applies a measured correction linearly (no pumping). */
export function loudnormFilter(m: Loudness, target: number): string {
  return `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${m.i}:measured_TP=${m.tp}:measured_LRA=${m.lra}:measured_thresh=${m.thresh}:offset=${m.offset}:linear=true,aresample=${SAMPLE_RATE}`;
}

/** Render the whole mix to a WAV file. */
export async function renderAudio(p: Project, doc: ProjectDoc, outWav: string, signal?: AbortSignal): Promise<AudioPlan> {
  const plan = planAudio(p, doc);
  const script = outWav.replace(/\.wav$/, '.filter.txt');
  fs.mkdirSync(path.dirname(outWav), { recursive: true });
  fs.writeFileSync(script, plan.filter);
  const args = ['-v', 'error', '-nostdin', '-y'];
  for (const file of plan.inputs) args.push('-vn', '-i', file);
  args.push('-/filter_complex', script, '-map', '[out]', '-c:a', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '2', outWav);
  await run(FFMPEG, args, { signal });
  fs.rmSync(script, { force: true });
  return plan;
}
