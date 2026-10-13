// The picture half of an export. ffmpeg decodes each clip to raw frames, this
// file lays them out on a canvas with the same renderFrame() the browser
// preview uses, and hands finished frames to the encoder.
//
// Neighbouring main clips cut from the same file (the usual result of removing
// silences) are read by a single decoder that skips the gaps, rather than one
// ffmpeg process per clip.

import { readLut } from '../library.ts';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { GlobalFonts, ImageData, createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas, Image } from '@napi-rs/canvas';
import { FFMPEG, FONTS_DIR } from '../config.ts';
import { decodeSpec, proxyFile } from '../media.ts';
import type { Project } from '../store.ts';
import { getFaces, getStability, getWords } from '../store.ts';
import type { ID, MediaAsset, ProjectDoc, SourceClip } from '../../shared/types.ts';
import { FONT_FILES } from '../../shared/fonts.ts';
import { renderFrame } from '../../shared/draw.ts';
import type { FrameProvider, LayerImage } from '../../shared/draw.ts';
import type { Ctx2D } from '../../shared/graphics.ts';
import { buildCards, timelineWords } from '../../shared/captions.ts';
import type { CaptionCard } from '../../shared/captions.ts';
import {
  contentDuration,
  clipGeometry,
  framingAt,
  isRemapped,
  layerGeometry,
  layoutMain,
  localAt,
  maxZoomIn,
  overlaysAt,
  rampPoints,
  segAt,
  sourceAt,
  srcDuration,
  toFrames,
} from '../../shared/timeline.ts';
import type { MainSeg, Rect } from '../../shared/timeline.ts';

let fontsReady = false;

export function ensureFonts(): void {
  if (fontsReady) return;
  for (const f of FONT_FILES) GlobalFonts.registerFromPath(path.join(FONTS_DIR, f.file), f.family);
  fontsReady = true;
}

/** Which part of a clip's source a decoder delivers, and at what size. */
export interface LayerPlan {
  region: Rect;
  outW: number;
  outH: number;
  /** Delivered pixels per source pixel. */
  k: number;
}

/**
 * Work out the crop a decoder should apply for a clip. Normally that is
 * exactly what the frame shows. When the crop follows a face it is the area
 * swept over the whole clip, and renderFrame picks the right part per frame.
 */
export function planLayer(
  p: Project,
  media: MediaAsset,
  clip: SourceClip,
  W: number,
  H: number,
  fps: number,
  supersample: number,
): LayerPlan {
  const faces = clip.framing?.track ? getFaces(p, media.id) : undefined;
  const times: number[] = [clip.in];
  if (faces) for (let t = clip.in; t < clip.out; t += Math.max(1 / fps, faces.interval / 2)) times.push(t);
  // Motion keyframes and stabilising move the crop too: sample the clip's life so the decoded region covers every position.
  const stab = clip.fx?.stabilize ? getStability(p, media.id) : undefined;
  if (clip.motion?.length || stab) for (let t = clip.in; t < clip.out; t += Math.max(1 / fps, 0.1)) times.push(t);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let density = 0;
  for (const t of times) {
    const g = clipGeometry(media.width, media.height, W, H, framingAt(clip.framing, faces, t, clip.motion, localAt(clip, t)), stab ? { track: stab, t, strength: clip.fx!.stabilize! } : undefined);
    x0 = Math.min(x0, g.src.x);
    y0 = Math.min(y0, g.src.y);
    x1 = Math.max(x1, g.src.x + g.src.w);
    y1 = Math.max(y1, g.src.y + g.src.h);
    // The tightest crop over the clip's life decides how much resolution to keep.
    density = Math.max(density, g.dst.w / g.src.w);
  }
  const region: Rect = {
    x: Math.max(0, Math.floor(x0)),
    y: Math.max(0, Math.floor(y0)),
    w: 0,
    h: 0,
  };
  region.w = Math.max(2, Math.min(media.width, Math.ceil(x1)) - region.x);
  region.h = Math.max(2, Math.min(media.height, Math.ceil(y1)) - region.y);
  // Extra resolution for punch-ins, but never more than the source has.
  const k = Math.min(density * Math.max(1, supersample), Math.max(1, density));
  return { region, outW: Math.max(2, Math.round(region.w * k)), outH: Math.max(2, Math.round(region.h * k)), k };
}

/** Reads fixed-size raw frames from a stream, pausing the source when it gets ahead. */
class FrameReader {
  private chunks: Buffer[] = [];
  private have = 0;
  private ended = false;
  private wake: (() => void) | null = null;
  private stream: NodeJS.ReadableStream;
  private size: number;

  constructor(stream: NodeJS.ReadableStream, size: number) {
    this.stream = stream;
    this.size = size;
    stream.on('data', (c: Buffer) => {
      this.chunks.push(c);
      this.have += c.length;
      if (this.have >= this.size * 3) this.stream.pause();
      this.wake?.();
    });
    const end = () => {
      this.ended = true;
      this.wake?.();
    };
    stream.on('end', end);
    stream.on('close', end);
    stream.on('error', end);
  }

  /** Fill `out` with the next frame. Returns false when the stream has ended. */
  async next(out: Buffer): Promise<boolean> {
    while (this.have < this.size && !this.ended) {
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
    if (this.have < this.size) return false;
    let filled = 0;
    while (filled < this.size) {
      const head = this.chunks[0];
      const take = Math.min(head.length, this.size - filled);
      head.copy(out, filled, 0, take);
      filled += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.have -= this.size;
    if (this.have < this.size * 2) this.stream.resume();
    return true;
  }
}

/** One ffmpeg process delivering the frames of one or more clips, in order. */
class Decoder {
  plan: LayerPlan;
  canvas: Canvas;
  private proc: ChildProcess | null = null;
  private reader: FrameReader | null = null;
  private buf: Buffer;
  protected args: string[];
  private stderr = '';
  protected got = false;
  label: string;

  constructor(plan: LayerPlan, args: string[], label: string) {
    this.plan = plan;
    this.args = args;
    this.label = label;
    this.canvas = createCanvas(plan.outW, plan.outH);
    this.buf = Buffer.alloc(plan.outW * plan.outH * 4);
  }

  start(): void {
    if (this.proc) return;
    this.proc = spawn(FFMPEG, this.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stderr?.on('data', (c: Buffer) => {
      if (this.stderr.length < 4000) this.stderr += c.toString();
    });
    this.proc.on('error', (err) => (this.stderr += String(err)));
    this.reader = new FrameReader(this.proc.stdout!, this.buf.length);
  }

  /** Read one frame onto the canvas; false once the process has nothing more. */
  protected async read(): Promise<boolean> {
    this.start();
    const ok = await this.reader!.next(this.buf);
    if (!ok) return false;
    this.got = true;
    const data = new Uint8ClampedArray(this.buf.buffer, this.buf.byteOffset, this.buf.length);
    this.canvas.getContext('2d').putImageData(new ImageData(data, this.plan.outW, this.plan.outH), 0, 0);
    return true;
  }

  protected failure(): Error {
    return new Error(`could not read video from ${this.label}: ${this.stderr.trim().split('\n').pop() ?? 'no frames'}`);
  }

  /** Put the next frame on this decoder's canvas. Past the end of the source the last frame is held. */
  async advance(): Promise<void> {
    if (!(await this.read()) && !this.got) throw this.failure();
  }

  /** For plain decoders every output frame is the next frame; `s` is ignored. */
  async advanceTo(_s: number): Promise<void> {
    await this.advance();
  }

  stop(): void {
    this.proc?.kill('SIGKILL');
    this.proc = null;
    this.reader = null;
  }
}

/** The rate at which a remapped clip's source is read: its own, raised for slowed stretches that are interpolated. */
export function readRate(media: MediaAsset, clip: SourceClip, fps: number): number {
  const native = media.fps > 1 ? media.fps : fps;
  if (!clip.interpolate) return Math.min(240, Math.max(fps, native));
  const pts = rampPoints(clip);
  const slowest = pts.length ? Math.min(...pts.map((k) => k.speed)) : clip.speed || 1;
  return Math.min(240, Math.max(native, Math.ceil(fps / Math.max(0.05, slowest))));
}

/** The ffmpeg filter that makes up frames between the source's own. */
export function interpolation(mode: SourceClip['interpolate'], fps: number): string {
  return mode === 'flow' ? `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : `minterpolate=fps=${fps}:mi_mode=blend`;
}

/** Decoding arguments for one stretch of a remapped clip's source, read at `rate`, optionally backwards. */
export function remapArgs(
  media: MediaAsset,
  o: { inT: number; frames: number; rate: number; plan: LayerPlan; reverse: boolean; interpolate?: SourceClip['interpolate']; file?: string; useProxy?: boolean },
): string[] {
  const spec = o.useProxy ? { input: [] as string[], prefix: '' } : decodeSpec(media);
  const r = o.plan.region;
  const vf = [
    `${spec.prefix}crop=${r.w}:${r.h}:${r.x}:${r.y}`,
    `scale=${o.plan.outW}:${o.plan.outH}:flags=bicubic`,
    o.interpolate ? interpolation(o.interpolate, o.rate) : `fps=${o.rate}:start_time=0`,
    o.reverse ? 'reverse' : '',
    'format=rgba',
  ]
    .filter(Boolean)
    .join(',');
  return [
    '-v', 'error', '-nostdin', ...spec.input, '-ss', o.inT.toFixed(6), '-t', ((o.frames + 0.5) / o.rate).toFixed(6), '-i', o.file ?? media.path,
    '-an', '-sn', '-dn', '-vf', vf, '-fps_mode', 'passthrough', '-frames:v', String(o.frames),
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
  ];
}

/**
 * Frames of a clip whose time runs unevenly or backwards (a speed ramp, a
 * reversed clip). The source is read at its own rate, in order of play, and
 * each output frame takes the nearest source frame: frames repeat when the
 * footage is slowed and are skipped when it is sped up. A reversed clip is
 * read in short stretches from the end, each turned around by ffmpeg, so no
 * more than a stretch of frames is ever held in memory.
 */
class RemapDecoder extends Decoder {
  private chunks: { args: string[]; frames: number }[];
  private chunk = 0;
  /** Index (in the clip's own play order) of the frame on the canvas, and how many the clip has. */
  private k = -1;
  private readInChunk = 0;
  private total: number;
  private rate: number;
  private inT: number;
  private reverse: boolean;

  constructor(
    media: MediaAsset,
    clip: SourceClip,
    plan: LayerPlan,
    fps: number,
    o: { file?: string; useProxy?: boolean; scaledPlan: LayerPlan },
  ) {
    super(plan, [], media.name);
    this.rate = readRate(media, clip, fps);
    this.inT = clip.in;
    this.reverse = !!clip.reverse;
    this.total = Math.max(1, Math.round((clip.out - clip.in) * this.rate));
    // Reversing holds a stretch of decoded frames; keep each stretch to about 100 MB.
    const perChunk = this.reverse ? Math.max(4, Math.min(this.total, Math.floor(1e8 / (plan.outW * plan.outH * 4)))) : this.total;
    this.chunks = [];
    for (let a = 0; a < this.total; a += perChunk) {
      const frames = Math.min(perChunk, this.total - a);
      this.chunks.push({ frames, args: remapArgs(media, { inT: clip.in + a / this.rate, frames, rate: this.rate, plan: o.scaledPlan, reverse: this.reverse, interpolate: clip.interpolate, file: o.file, useProxy: o.useProxy }) });
    }
    if (this.reverse) this.chunks.reverse();
    this.args = this.chunks[0].args;
  }

  /** Source time of the frame `k` in play order. */
  private timeOf(k: number): number {
    return this.inT + (this.reverse ? this.total - 1 - k : k) / this.rate;
  }

  private async nextFrame(): Promise<boolean> {
    for (;;) {
      if (this.readInChunk >= this.chunks[this.chunk].frames) {
        if (this.chunk + 1 >= this.chunks.length) return false;
        this.stop();
        this.chunk++;
        this.readInChunk = 0;
        this.args = this.chunks[this.chunk].args;
      }
      if (await this.read()) {
        this.readInChunk++;
        this.k++;
        return true;
      }
      // The stretch came up short (the file ended early): skip the frames it owed.
      this.k += this.chunks[this.chunk].frames - this.readInChunk;
      this.readInChunk = this.chunks[this.chunk].frames;
    }
  }

  /** Show the source frame nearest to source time `s`, which must not move against the clip's direction. */
  override async advanceTo(s: number): Promise<void> {
    if (this.k < 0 && !(await this.nextFrame())) throw this.failure();
    while (this.k + 1 < this.total && Math.abs(this.timeOf(this.k + 1) - s) < Math.abs(this.timeOf(this.k) - s)) {
      if (!(await this.nextFrame())) break;
    }
  }

  override async advance(): Promise<void> {
    await this.nextFrame();
  }
}

export function decoderArgs(
  media: MediaAsset,
  o: { inT: number; speed: number; fps: number; plan: LayerPlan; frames: number; select?: string; file?: string; useProxy?: boolean; interpolate?: SourceClip['interpolate'] },
): string[] {
  const spec = o.useProxy ? { input: [] as string[], prefix: '' } : decodeSpec(media);
  const r = o.plan.region;
  const slowed = o.speed < 1 - 1e-6 && o.interpolate;
  const vf = [
    // Slowed footage can have its missing frames made up rather than repeated; that works on the cropped picture to save time.
    slowed ? `${spec.prefix}crop=${r.w}:${r.h}:${r.x}:${r.y},scale=${o.plan.outW}:${o.plan.outH}:flags=bicubic,setpts=PTS/${o.speed},${interpolation(o.interpolate, o.fps)}` : `${spec.prefix}${Math.abs(o.speed - 1) > 1e-6 ? `setpts=PTS/${o.speed},` : ''}fps=${o.fps}:start_time=0`,
    o.select ? `select='${o.select}'` : '',
    slowed ? '' : `crop=${r.w}:${r.h}:${r.x}:${r.y}`,
    slowed ? '' : `scale=${o.plan.outW}:${o.plan.outH}:flags=bicubic`,
    'format=rgba',
  ]
    .filter(Boolean)
    .join(',');
  return [
    '-v', 'error', '-nostdin', ...spec.input, '-ss', o.inT.toFixed(6), '-i', o.file ?? media.path,
    '-an', '-sn', '-dn', '-vf', vf, '-fps_mode', 'passthrough', '-frames:v', String(o.frames),
    '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
  ];
}

interface Run {
  decoder: Decoder;
  clipIds: Set<ID>;
  lastIndex: number;
}

export interface ComposeOptions {
  signal?: AbortSignal;
  /** Read the small proxies instead of the originals (for quick preview frames). */
  useProxy?: boolean;
}

export class Compositor {
  readonly doc: ProjectDoc;
  readonly layout: MainSeg[];
  readonly totalFrames: number;
  readonly canvas: Canvas;
  private p: Project;
  private opts: ComposeOptions;
  private cards: CaptionCard[];
  private runs = new Map<ID, Run>();
  private overlayDecoders = new Map<ID, Decoder>();
  private images = new Map<ID, Image>();
  private frozen: { clipId: ID; canvas: Canvas; plan: LayerPlan } | null = null;
  private mainClip: ID | null = null;
  private scratch = new Map<string, { canvas: Canvas; ctx: Ctx2D }>();

  constructor(p: Project, doc: ProjectDoc, opts: ComposeOptions = {}) {
    ensureFonts();
    this.p = p;
    this.doc = doc;
    this.opts = opts;
    this.layout = layoutMain(doc);
    this.totalFrames = toFrames(contentDuration(doc), doc.settings.fps);
    this.canvas = createCanvas(doc.settings.width, doc.settings.height);
    this.cards = buildCards(timelineWords(doc, this.layout, (id) => getWords(p, id)), doc.captions);
    this.planRuns();
  }

  private video(mediaId: ID): MediaAsset | null {
    const m = this.p.media.get(mediaId);
    return m && m.kind === 'video' ? m : null;
  }

  private file(m: MediaAsset): string {
    return this.opts.useProxy ? proxyFile(this.p, m) : m.path;
  }

  /** Group neighbouring main clips from one file into runs that share a decoder. */
  private planRuns(): void {
    const { width: W, height: H, fps } = this.doc.settings;
    let group: MainSeg[] = [];
    const flush = () => {
      if (!group.length) return;
      const first = group[0].clip as SourceClip;
      const media = this.video(first.mediaId)!;
      const zoom = Math.max(...group.map((s) => maxZoomIn(this.doc, s.start, s.end)));
      const plans = group.map((s) => planLayer(this.p, media, s.clip as SourceClip, W, H, fps, zoom));
      // One crop that covers every clip of the run.
      const x0 = Math.min(...plans.map((q) => q.region.x));
      const y0 = Math.min(...plans.map((q) => q.region.y));
      const x1 = Math.max(...plans.map((q) => q.region.x + q.region.w));
      const y1 = Math.max(...plans.map((q) => q.region.y + q.region.h));
      const k = Math.max(...plans.map((q) => q.k));
      const region = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      const plan: LayerPlan = { region, outW: Math.max(2, Math.round(region.w * k)), outH: Math.max(2, Math.round(region.h * k)), k };
      // Frame numbers (after conversion to the project frame rate) each clip needs.
      const step = first.speed / fps;
      const ranges: string[] = [];
      let frames = 0;
      for (const s of group) {
        const c = s.clip as SourceClip;
        const a = Math.round((c.in - first.in) / step);
        const count = s.endFrame - s.startFrame;
        ranges.push(`between(n,${a},${a + count - 1})`);
        frames += count;
      }
      const scale = this.opts.useProxy ? this.proxyScale(media) : 1;
      const scaledPlan = scale === 1 ? plan : this.scaledPlan(plan, scale);
      const decoder = isRemapped(first)
        ? new RemapDecoder(media, first, plan, fps, { file: this.file(media), useProxy: this.opts.useProxy, scaledPlan })
        : new Decoder(
            plan,
            decoderArgs(media, {
              inT: first.in,
              speed: first.speed,
              fps,
              plan: scaledPlan,
              frames,
              select: group.length > 1 ? ranges.join('+') : undefined,
              file: this.file(media),
              useProxy: this.opts.useProxy,
              interpolate: first.interpolate,
            }),
            media.name,
          );
      const run: Run = { decoder, clipIds: new Set(group.map((s) => s.clip.id)), lastIndex: group[group.length - 1].index };
      for (const s of group) this.runs.set(s.clip.id, run);
      group = [];
    };
    for (const seg of this.layout) {
      const c = seg.clip;
      if (c.kind !== 'media' || !this.video(c.mediaId)) {
        flush();
        continue;
      }
      const prev = group[group.length - 1]?.clip as SourceClip | undefined;
      if (prev) {
        const gap = c.in - prev.out;
        const step = c.speed / fps;
        const offset = (c.in - (group[0].clip as SourceClip).in) / step;
        const aligned = Math.abs(offset - Math.round(offset)) < 0.02;
        const same =
          prev.mediaId === c.mediaId &&
          prev.speed === c.speed &&
          prev.interpolate === c.interpolate &&
          !isRemapped(prev) &&
          !isRemapped(c) &&
          JSON.stringify(prev.framing ?? null) === JSON.stringify(c.framing ?? null) &&
          !c.framing?.track;
        if (!(same && aligned && gap >= -1e-6 && gap <= 6)) flush();
      }
      group.push(seg);
    }
    flush();
  }

  /** Proxies are smaller than the source; scale crop coordinates to match. */
  private proxyScale(media: MediaAsset): number {
    return Math.min(1, 1280 / Math.max(media.width, media.height));
  }

  private scaledPlan(plan: LayerPlan, s: number): LayerPlan {
    return {
      ...plan,
      region: {
        x: Math.floor(plan.region.x * s),
        y: Math.floor(plan.region.y * s),
        w: Math.max(2, Math.floor(plan.region.w * s)),
        h: Math.max(2, Math.floor(plan.region.h * s)),
      },
    };
  }

  private overlayDecoder(clip: SourceClip & { start: number }, media: MediaAsset): Decoder {
    let d = this.overlayDecoders.get(clip.id);
    if (!d) {
      const { width: W, height: H, fps } = this.doc.settings;
      const plan = planLayer(this.p, media, clip, W, H, fps, 1);
      const scale = this.opts.useProxy ? this.proxyScale(media) : 1;
      const scaledPlan = scale === 1 ? plan : this.scaledPlan(plan, scale);
      d = isRemapped(clip)
        ? new RemapDecoder(media, clip, plan, fps, { file: this.file(media), useProxy: this.opts.useProxy, scaledPlan })
        : new Decoder(
            plan,
            decoderArgs(media, {
              inT: clip.in,
              speed: clip.speed,
              fps,
              plan: scaledPlan,
              frames: Math.max(1, toFrames(srcDuration(clip), fps)),
              file: this.file(media),
              useProxy: this.opts.useProxy,
              interpolate: clip.interpolate,
            }),
            media.name,
          );
      this.overlayDecoders.set(clip.id, d);
    }
    return d;
  }

  private async still(mediaId: ID): Promise<Image | undefined> {
    const m = this.p.media.get(mediaId);
    if (!m || m.kind !== 'image') return undefined;
    let img = this.images.get(mediaId);
    if (!img) {
      img = await loadImage(proxyFile(this.p, m));
      this.images.set(mediaId, img);
    }
    return img;
  }

  private layerOf(d: Decoder): LayerImage {
    return { image: d.canvas, region: d.plan.region, k: d.plan.outW / d.plan.region.w };
  }

  private provider(): FrameProvider {
    return {
      mediaSize: (id) => {
        const m = this.p.media.get(id);
        return m ? { width: m.width, height: m.height } : undefined;
      },
      layer: (ref) => {
        const m = this.p.media.get(ref.clip.mediaId);
        if (!m) return undefined;
        if (m.kind === 'image') {
          const img = this.images.get(m.id);
          return img ? { image: img, region: { x: 0, y: 0, w: m.width, h: m.height }, k: img.width / m.width } : undefined;
        }
        const d = ref.role === 'main' ? this.runs.get(ref.clip.id)?.decoder : this.overlayDecoders.get(ref.clip.id);
        return d ? this.layerOf(d) : undefined;
      },
      frozen: (seg) => {
        if (seg.clip.kind !== 'media') return undefined;
        const m = this.p.media.get(seg.clip.mediaId);
        if (m?.kind === 'image') {
          const img = this.images.get(m.id);
          return img ? { image: img, region: { x: 0, y: 0, w: m.width, h: m.height }, k: img.width / m.width } : undefined;
        }
        const f = this.frozen;
        return f && f.clipId === seg.clip.id ? { image: f.canvas, region: f.plan.region, k: f.plan.outW / f.plan.region.w } : undefined;
      },
      face: (id) => getFaces(this.p, id),
      stability: (id) => getStability(this.p, id),
      image: (id) => {
        const img = this.images.get(id);
        return img ? { image: img, width: img.width, height: img.height } : undefined;
      },
      lut: (name) => readLut(name),
      scratch: (w, h, slot = '') => {
        const key = `${w}x${h}:${slot}`;
        let s = this.scratch.get(key);
        if (!s) {
          const canvas = createCanvas(w, h);
          s = { canvas, ctx: canvas.getContext('2d') as unknown as Ctx2D };
          this.scratch.set(key, s);
        }
        return s;
      },
    };
  }

  /** Bring every source the frame at index `j` needs up to date. Must be called for j = 0, 1, 2, ... in order. */
  private async prepare(j: number): Promise<void> {
    const fps = this.doc.settings.fps;
    const t = j / fps;
    const seg = segAt(this.layout, t);

    if (seg && seg.clip.id !== this.mainClip) {
      // Entering a new main clip. If it arrives with a transition, keep the
      // last picture of the clip we are leaving.
      const prev = this.layout[seg.index - 1];
      if (prev && seg.clip.transition && prev.clip.kind === 'media') {
        const run = this.runs.get(prev.clip.id);
        if (run) {
          const copy = createCanvas(run.decoder.plan.outW, run.decoder.plan.outH);
          copy.getContext('2d').drawImage(run.decoder.canvas, 0, 0);
          this.frozen = { clipId: prev.clip.id, canvas: copy, plan: run.decoder.plan };
        }
      }
      // A decoder is finished once the timeline has moved past its last clip.
      const old = this.mainClip ? this.runs.get(this.mainClip) : undefined;
      const now = this.runs.get(seg.clip.id);
      if (old && old !== now) old.decoder.stop();
      this.mainClip = seg.clip.id;
      // Start the following run early so its first frame is ready at the cut.
      if (now && seg.index === now.lastIndex) {
        const next = this.layout[seg.index + 1];
        if (next) this.runs.get(next.clip.id)?.decoder.start();
      }
    }
    if (seg && seg.clip.kind === 'media') {
      const m = this.p.media.get(seg.clip.mediaId);
      if (m?.kind === 'image') await this.still(m.id);
      else await this.runs.get(seg.clip.id)?.decoder.advanceTo(sourceAt(seg.clip, t - seg.start));
    }

    const active = new Set<ID>();
    for (const o of overlaysAt(this.doc, t)) {
      const m = this.p.media.get(o.mediaId);
      if (!m) continue;
      if (m.kind === 'image') await this.still(m.id);
      else if (m.kind === 'video') {
        active.add(o.id);
        await this.overlayDecoder(o, m).advanceTo(sourceAt(o, t - o.start));
      }
    }
    for (const [id, d] of this.overlayDecoders) {
      if (!active.has(id)) {
        d.stop();
        this.overlayDecoders.delete(id);
      }
    }
    for (const g of this.doc.graphics) {
      if (g.template === 'image' && t >= g.start && t < g.start + g.duration) await this.still(String(g.props.mediaId ?? ''));
    }
  }

  /** Draw frame `j` and return its pixels (RGBA, top to bottom). Frames must be requested in order. */
  async frame(j: number): Promise<Buffer> {
    if (this.opts.signal?.aborted) throw new Error('aborted');
    await this.prepare(j);
    const ctx = this.canvas.getContext('2d');
    renderFrame(ctx as unknown as Ctx2D, this.doc, this.layout, j / this.doc.settings.fps, {
      provider: this.provider(),
      cards: this.cards,
      pixelScale: 1,
    });
    return this.canvas.data();
  }

  close(): void {
    for (const r of this.runs.values()) r.decoder.stop();
    for (const d of this.overlayDecoders.values()) d.stop();
    this.overlayDecoders.clear();
  }
}
