// Media import. A file is probed immediately so it shows up in the library,
// then prepared in the background:
//
//   thumbnail  -> proxy (small H.264 the browser can scrub smoothly)
//   filmstrip  -> loudness envelope + waveform -> transcript
//
// The original file is only ever read.

import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG } from './config.ts';
import { Queue, ffmpegProgress, run } from './proc.ts';
import { AUDIO_EXT, IMAGE_EXT, MEDIA_EXT, extOf, probe } from './probe.ts';
import { analyzePcm, decodePcm } from './analyze.ts';
import { transcribe, transcriptionAvailable } from './transcribe.ts';
import { analyzeFaces } from './faces.ts';
import { getProfile } from './studio.ts';
import { assignSpeakers, diarize, diarizerInstalled } from './diarize.ts';
import { HttpError, dropMedia, mediaDir, nextTag, patchMedia, putMedia, setTranscript } from './store.ts';
import type { Project } from './store.ts';
import type { ID, MediaAsset } from '../shared/types.ts';
import { activeRatio } from '../shared/silence.ts';
import { uid } from '../shared/ops.ts';

const proxyQueue = new Queue(2);
const analysisQueue = new Queue(2);
const whisperQueue = new Queue(1);
const controllers = new Map<string, AbortController>();

export const PROXY_MAX = 1280;
const STRIP_HEIGHT = 64;
const STRIP_MAX_TILES = 120;

export interface DecodeSpec {
  /** Options that go before `-i`. */
  input: string[];
  /** Filters that turn decoded frames into upright SDR pictures; empty or ends with a comma. */
  prefix: string;
}

/**
 * How to decode a file so every clip reaches the rest of the pipeline upright
 * and in standard dynamic range. HDR (iPhone HLG, PQ) goes through
 * VideoToolbox's converter, which keeps colours close to what QuickTime shows;
 * a plain software conversion comes out washed.
 */
export function decodeSpec(a: Pick<MediaAsset, 'hdr' | 'rotation'>, hardware = true): DecodeSpec {
  if (a.hdr) {
    const turn =
      a.rotation === 90 ? 'transpose=clock,' : a.rotation === 270 ? 'transpose=cclock,' : a.rotation === 180 ? 'hflip,vflip,' : '';
    return {
      input: ['-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld', '-noautorotate'],
      prefix: `scale_vt=color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le,${turn}`,
    };
  }
  return { input: hardware ? ['-hwaccel', 'videotoolbox'] : [], prefix: '' };
}

function key(p: Project, id: ID): string {
  return `${p.id}/${id}`;
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export function proxyFile(p: Project, a: MediaAsset): string {
  const dir = mediaDir(p, a.id);
  if (a.kind === 'video') return path.join(dir, 'proxy.mp4');
  if (a.kind === 'audio') return path.join(dir, 'proxy.m4a');
  return path.join(dir, a.hasAlpha ? 'proxy.png' : 'proxy.jpg');
}

/** The file the exporter reads pixels or samples from. */
export function sourceFile(p: Project, a: MediaAsset): string {
  return a.kind === 'image' ? proxyFile(p, a) : a.path;
}

export async function importMedia(
  p: Project,
  filePath: string,
  opts: { name?: string; managed?: boolean; id?: ID; origin?: MediaAsset['origin'] } = {},
): Promise<MediaAsset> {
  const abs = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new HttpError(400, `file not found: ${abs}`);
  }
  if (!stat.isFile()) throw new HttpError(400, `not a file: ${abs}`);
  if (!MEDIA_EXT.includes(extOf(abs))) throw new HttpError(400, `unsupported file type: .${extOf(abs)}`);
  const existing = [...p.media.values()].find((m) => m.path === abs && !opts.id);
  if (existing) return existing;
  let info;
  try {
    info = await probe(abs);
  } catch (err) {
    throw new HttpError(400, `could not read ${path.basename(abs)}: ${(err as Error).message.split('\n').pop()}`);
  }
  const id = opts.id ?? uid('m');
  fs.mkdirSync(mediaDir(p, id), { recursive: true });
  const asset: MediaAsset = {
    id,
    name: opts.name ?? path.basename(abs),
    kind: info.kind,
    path: abs,
    managed: !!opts.managed,
    size: stat.size,
    duration: info.duration,
    width: info.width,
    height: info.height,
    fps: info.fps,
    hasAudio: info.hasAudio,
    hasVideo: info.hasVideo,
    codec: info.codec,
    hdr: info.hdr,
    rotation: info.rotation,
    hasAlpha: info.hasAlpha,
    addedAt: Date.now(),
    proxy: 'pending',
    analysis: info.hasAudio ? 'pending' : 'skipped',
    transcript: info.hasAudio && opts.origin !== 'sfx' && opts.origin !== 'sequence' ? 'pending' : 'skipped',
    rev: 1,
    tag: nextTag(p),
  };
  if (opts.origin) asset.origin = opts.origin;
  putMedia(p, asset);
  void processMedia(p, id);
  return asset;
}

/** Pick up preparation that was interrupted by a restart. */
export function resumePending(p: Project): void {
  for (const a of p.media.values()) {
    const unfinished = [a.proxy, a.analysis, a.transcript].some((s) => s === 'pending' || s === 'running');
    if (unfinished && !controllers.has(key(p, a.id))) {
      if (!fs.existsSync(a.path)) {
        patchMedia(p, a.id, { proxy: 'error', analysis: 'error', transcript: 'error', error: 'The original file has moved or been deleted.' });
        continue;
      }
      void processMedia(p, a.id);
    }
  }
}

export function removeMedia(p: Project, id: ID): void {
  if (!p.media.has(id)) return;
  controllers.get(key(p, id))?.abort();
  controllers.delete(key(p, id));
  // Only this app's own folder for the file is removed (proxy, transcript, any
  // uploaded copy). Originals that were added in place are left alone.
  fs.rmSync(mediaDir(p, id), { recursive: true, force: true });
  dropMedia(p, id);
}

async function processMedia(p: Project, id: ID): Promise<void> {
  const k = key(p, id);
  controllers.get(k)?.abort();
  const ctl = new AbortController();
  controllers.set(k, ctl);
  const signal = ctl.signal;
  const get = () => p.media.get(id);
  const patch = (x: Partial<MediaAsset>) => patchMedia(p, id, x);
  const bump = () => (get()?.rev ?? 0) + 1;
  const a0 = get();
  if (!a0) return;
  const dir = mediaDir(p, id);
  fs.mkdirSync(dir, { recursive: true });

  const visual = async () => {
    const a = get();
    if (!a) return;
    try {
      if (a.kind === 'video') {
        await makeThumb(a, path.join(dir, 'thumb.jpg'), signal).then(
          () => patch({ rev: bump() }),
          (err) => console.error(`[media] thumbnail failed for ${a.name}:`, (err as Error).message),
        );
      }
      await proxyQueue.run(async () => {
        if (signal.aborted) return;
        patch({ proxy: 'running', stage: 'Preparing preview', progress: 0 });
        let last = 0;
        await makeProxy(p, get() ?? a, signal, (f) => {
          if (f - last >= 0.04) {
            last = f;
            patch({ progress: f });
          }
        });
      });
      if (signal.aborted) return;
      if (a.kind === 'image') await makeThumb({ ...a, path: proxyFile(p, a), hdr: false, rotation: 0 }, path.join(dir, 'thumb.jpg'), signal).catch(() => {});
      const strip = a.kind === 'video' ? await makeStrip(p, a, signal).catch(() => undefined) : undefined;
      patch({ proxy: 'done', progress: undefined, stage: undefined, rev: bump(), ...(strip ? { strip } : {}) });
      // Knowing where faces are lets reframing and graphics keep clear of them.
      if (a.kind === 'video' && a.duration <= 1800 && !a.origin) void analyzeFaces(p, id, signal);
    } catch (err) {
      if (signal.aborted) return;
      console.error(`[media] proxy failed for ${a.name}:`, (err as Error).message);
      patch({ proxy: 'error', error: `Could not prepare a preview: ${(err as Error).message.split('\n').pop()}`, progress: undefined, stage: undefined });
    }
  };

  const audio = async () => {
    const a = get();
    if (!a || !a.hasAudio) return;
    try {
      let pcm: Buffer | undefined;
      let envelope: Uint8Array | undefined;
      let duration = a.duration;
      await analysisQueue.run(async () => {
        if (signal.aborted) return;
        patch({ analysis: 'running' });
        pcm = await decodePcm(a.path, signal);
        const res = analyzePcm(pcm);
        fs.writeFileSync(path.join(dir, 'envelope.bin'), res.envelope);
        fs.writeFileSync(path.join(dir, 'peaks.bin'), res.peaks);
        p.envelopes.set(id, res.envelope);
        envelope = res.envelope;
        duration = res.duration || a.duration;
        patch({ analysis: 'done', soundRatio: Math.round(activeRatio(res.envelope) * 100) / 100, rev: bump() });
      });
      if (signal.aborted || !envelope || !pcm) return;
      if (get()?.transcript !== 'pending') return;
      if (!transcriptionAvailable()) {
        patch({ transcript: 'skipped', error: 'Speech-to-text is not installed (run npm run setup).' });
        return;
      }
      const job = { pcm, envelope };
      await whisperQueue.run(async () => {
        if (signal.aborted) return;
        patch({ transcript: 'running', stage: 'Transcribing', progress: 0 });
        const t = await transcribe({
          ...job,
          duration,
          workDir: path.join(dir, 'stt'),
          languages: getProfile().languages,
          signal,
          onProgress: (f) => patch({ progress: f }),
        });
        // Who said what: only worth it when there is enough speech for more than one voice to show.
        let speakers: number | undefined;
        if (t.words.length >= 8 && diarizerInstalled() && !signal.aborted) {
          patch({ stage: 'Telling speakers apart' });
          const turns = await diarize(job.pcm).catch(() => null);
          if (turns) speakers = assignSpeakers(t.words, turns);
        }
        setTranscript(p, id, { language: t.language, words: t.words });
        patch({
          transcript: 'done',
          language: t.language || undefined,
          wordCount: t.words.length,
          speakers,
          speechSeconds: t.speechSeconds !== undefined ? Math.round(t.speechSeconds * 10) / 10 : undefined,
          rev: bump(),
          ...(get()?.proxy === 'running' ? {} : { stage: undefined, progress: undefined }),
        });
      });
    } catch (err) {
      if (signal.aborted) return;
      console.error(`[media] audio analysis failed for ${a.name}:`, (err as Error).message);
      const cur = get();
      patch({
        analysis: cur?.analysis === 'done' ? 'done' : 'error',
        transcript: 'error',
        error: `Could not analyse the audio: ${(err as Error).message.split('\n').pop()}`,
      });
    }
  };

  await Promise.all([visual(), audio()]);
  if (controllers.get(k) === ctl) controllers.delete(k);
}

/** Re-run speech-to-text for one file (after installing whisper, or to retry). */
export function retranscribe(p: Project, id: ID): void {
  const a = p.media.get(id);
  if (!a || !a.hasAudio) return;
  patchMedia(p, id, { transcript: 'pending', analysis: 'pending', error: undefined });
  void processMedia(p, id);
}

async function makeThumb(a: MediaAsset, out: string, signal: AbortSignal): Promise<void> {
  const at = a.kind === 'video' ? Math.min(1, a.duration / 3) : 0;
  const spec = decodeSpec(a, false);
  await run(
    FFMPEG,
    ['-v', 'error', '-nostdin', '-y', ...spec.input, '-ss', at.toFixed(3), '-i', a.path, '-frames:v', '1', '-update', '1',
      '-vf', `${spec.prefix}scale=480:-2:force_original_aspect_ratio=decrease,format=yuvj420p`, '-q:v', '4', out],
    { signal },
  );
}

async function makeProxy(p: Project, a: MediaAsset, signal: AbortSignal, onProgress: (f: number) => void): Promise<void> {
  const out = proxyFile(p, a);
  const tmp = out.replace(/(\.\w+)$/, '.tmp$1');
  const base = ['-v', 'error', '-nostdin', '-y'];
  if (a.kind === 'image') {
    const vf = `scale='min(2560,iw)':'min(2560,ih)':force_original_aspect_ratio=decrease`;
    try {
      await run(FFMPEG, [...base, '-i', a.path, '-frames:v', '1', '-update', '1', '-vf', vf, ...(a.hasAlpha ? [] : ['-q:v', '2']), tmp], { signal });
    } catch (err) {
      if (signal.aborted) throw err;
      // HEIC and friends: let macOS convert.
      await run('/usr/bin/sips', ['-s', 'format', a.hasAlpha ? 'png' : 'jpeg', '--resampleHeightWidthMax', '2560', a.path, '--out', tmp], { signal });
    }
    fs.renameSync(tmp, out);
    return;
  }
  const audioArgs = ['-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', '-af', 'aresample=async=1:first_pts=0'];
  const tail = ['-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp];
  const progress = { onStdoutLine: ffmpegProgress((s) => onProgress(a.duration > 0 ? Math.min(1, s / a.duration) : 0)), signal };
  if (a.kind === 'audio') {
    await run(FFMPEG, [...base, '-i', a.path, '-vn', '-map', '0:a:0', ...audioArgs, ...tail], progress);
    fs.renameSync(tmp, out);
    return;
  }
  const fps = Math.max(12, Math.min(30, Math.round(a.fps) || 30));
  const scale = `scale=w='min(${PROXY_MAX},iw)':h='min(${PROXY_MAX},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  // Bitrate follows the picture size, so a small source does not get a bloated proxy.
  const k = Math.min(1, PROXY_MAX / Math.max(a.width, a.height, 1));
  const bitrate = Math.round(Math.min(6000, Math.max(700, (a.width * k * a.height * k * fps * 0.14) / 1000)));
  const build = (hardware: boolean): string[] => {
    const spec = decodeSpec(a, hardware);
    const encode = hardware
      ? ['-c:v', 'h264_videotoolbox', '-b:v', `${bitrate}k`, '-profile:v', 'high', '-allow_sw', '1']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'];
    return [
      ...base, ...spec.input, '-i', a.path, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `${spec.prefix}${scale},fps=${fps},format=yuv420p`,
      // A keyframe every half second keeps scrubbing in the browser instant.
      ...encode, '-g', String(Math.round(fps / 2)), '-pix_fmt', 'yuv420p',
      ...(a.hasAudio ? audioArgs : ['-an']), ...tail,
    ];
  };
  try {
    await run(FFMPEG, build(true), progress);
  } catch (err) {
    if (signal.aborted) throw err;
    if (a.hdr) throw err;
    await run(FFMPEG, build(false), progress);
  }
  fs.renameSync(tmp, out);
}

async function makeStrip(p: Project, a: MediaAsset, signal: AbortSignal): Promise<MediaAsset['strip']> {
  const proxy = proxyFile(p, a);
  const interval = Math.max(0.5, a.duration / STRIP_MAX_TILES);
  const count = Math.max(1, Math.min(STRIP_MAX_TILES, Math.ceil(a.duration / interval)));
  const tileH = STRIP_HEIGHT;
  const tileW = even((tileH * a.width) / Math.max(1, a.height));
  await run(
    FFMPEG,
    ['-v', 'error', '-nostdin', '-y', '-skip_frame', 'nokey', '-i', proxy, '-an',
      '-vf', `fps=1/${interval.toFixed(4)}:round=up,scale=${tileW}:${tileH},tile=${count}x1`,
      '-frames:v', '1', '-update', '1', '-q:v', '5', path.join(mediaDir(p, a.id), 'strip.jpg')],
    { signal },
  );
  return { interval, tileW, tileH, count };
}

export function isAudioName(name: string): boolean {
  return AUDIO_EXT.includes(extOf(name));
}

export function isImageName(name: string): boolean {
  return IMAGE_EXT.includes(extOf(name));
}
