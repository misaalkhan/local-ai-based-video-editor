import path from 'node:path';
import { FFPROBE } from './config.ts';
import { run } from './proc.ts';
import type { MediaKind } from '../shared/types.ts';

export const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts', '3gp', 'mpg', 'mpeg', 'wmv', 'flv', 'gif', 'ts'];
export const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'aiff', 'aif', 'wma', 'caf'];
export const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'avif'];
export const MEDIA_EXT = [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT];

export function extOf(file: string): string {
  return path.extname(file).slice(1).toLowerCase();
}

export interface ProbeInfo {
  kind: MediaKind;
  duration: number;
  /** Display size, rotation and pixel aspect applied. */
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
  codec?: string;
  audioCodec?: string;
  /** HLG or PQ transfer: needs converting to SDR before it is shown or mixed with other footage. */
  hdr: boolean;
  /** Degrees the stored picture must be turned clockwise to stand upright (0, 90, 180, 270). */
  rotation: number;
  hasAlpha: boolean;
}

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  pix_fmt?: string;
  color_transfer?: string;
  sample_aspect_ratio?: string;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
}

function rate(s: string | undefined): number {
  if (!s) return 0;
  const [a, b] = s.split('/').map(Number);
  if (!a || !Number.isFinite(a)) return 0;
  return b ? a / b : a;
}

export async function probe(file: string): Promise<ProbeInfo> {
  const r = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const data = JSON.parse(r.stdout) as { streams?: FfStream[]; format?: { duration?: string; format_name?: string } };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const ext = extOf(file);
  let duration = Number(data.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  if (!Number.isFinite(duration)) duration = 0;

  const stillFormat = /image2|_pipe|png|jpeg|webp|bmp|tiff/.test(data.format?.format_name ?? '');
  const isImage = IMAGE_EXT.includes(ext) || (!!video && !audio && stillFormat && duration < 0.2);
  let kind: MediaKind;
  if (isImage && video) kind = 'image';
  else if (video) kind = 'video';
  else if (audio) kind = 'audio';
  else throw new Error('no video, audio or image found in this file');

  let width = video?.width ?? 0;
  let height = video?.height ?? 0;
  const sar = (video?.sample_aspect_ratio ?? '1:1').split(':').map(Number);
  if (sar.length === 2 && sar[0] > 0 && sar[1] > 0 && sar[0] !== sar[1]) width = Math.round((width * sar[0]) / sar[1]);
  // The display matrix holds a counter-clockwise angle; the legacy `rotate` tag is already clockwise.
  const matrixRot = video?.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
  const clockwise = matrixRot !== undefined ? -matrixRot : Number(video?.tags?.rotate ?? 0) || 0;
  const rotation = ((Math.round(clockwise / 90) * 90) % 360 + 360) % 360;
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];

  return {
    kind,
    duration: kind === 'image' ? 0 : duration,
    width,
    height,
    fps: kind === 'video' ? rate(video?.avg_frame_rate) || rate(video?.r_frame_rate) || 30 : 0,
    hasAudio: !!audio && kind !== 'image',
    hasVideo: !!video,
    codec: video?.codec_name,
    audioCodec: audio?.codec_name,
    hdr: ['smpte2084', 'arib-std-b67'].includes(video?.color_transfer ?? ''),
    rotation,
    hasAlpha: /^(rgba|bgra|argb|abgr|ya8|yuva|gbrap|pal8)/.test(video?.pix_fmt ?? ''),
  };
}
