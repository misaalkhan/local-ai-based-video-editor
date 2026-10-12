import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.STUDIO_DATA ?? path.join(ROOT, 'data');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const FONTS_DIR = path.join(ROOT, 'fonts');
export const DIST_DIR = path.join(ROOT, 'dist');
/** Finished videos go to Documents so they are backed up with the rest of the user's work. */
export const EXPORT_DIR = process.env.STUDIO_EXPORTS ?? path.join(os.homedir(), 'Documents', 'Local Studio');
export const PORT = Number(process.env.PORT ?? 4747);
export const HOST = '127.0.0.1';

export const WHISPER_MODEL =
  process.env.STUDIO_WHISPER_MODEL ?? path.join(ROOT, 'models', 'ggml-large-v3-turbo-q5_0.bin');
export const VAD_MODEL = path.join(ROOT, 'models', 'ggml-silero-v5.1.2.bin');
/** Places each word on the audio (wav2vec2, English). Without it word times come from whisper alone. */
export const ALIGN_MODEL = process.env.STUDIO_ALIGN_MODEL ?? path.join(ROOT, 'models', 'wav2vec2-base-960h.onnx');
export const ALIGN_VOCAB = path.join(ROOT, 'models', 'wav2vec2-base-960h.vocab.json');
/** RNNoise weights for ffmpeg's arnndn filter; without them noise reduction falls back to a spectral gate. */
export const RNNOISE_MODEL = path.join(ROOT, 'models', 'sh.rnnn');
/** Speaker labels: who speaks when (pyannote segmentation + a speaker embedding model, through sherpa-onnx). */
export const DIARIZE_SEGMENTATION = path.join(ROOT, 'models', 'pyannote-segmentation-3-0.onnx');
export const DIARIZE_EMBEDDING = path.join(ROOT, 'models', '3dspeaker-campplus-zh-en.onnx');
/** Kokoro voices for voiceover (English, Hindi, Spanish, French, Italian, Portuguese, Japanese, Chinese). */
export const KOKORO_DIR = path.join(ROOT, 'models', 'kokoro-multi-lang-v1_0');
/** Model alias passed to the `claude` CLI for the chat editor. */
export const AGENT_MODEL = process.env.STUDIO_MODEL ?? 'sonnet';

const SEARCH = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), '/usr/bin'];

/** Find a command-line tool even when the server was not started from a login shell. */
export function findBinary(name: string, envVar?: string): string | null {
  const fromEnv = envVar ? process.env[envVar] : undefined;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...SEARCH];
  for (const dir of dirs) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

export const FFMPEG = findBinary('ffmpeg', 'FFMPEG') ?? 'ffmpeg';
export const FFPROBE = findBinary('ffprobe', 'FFPROBE') ?? 'ffprobe';
export const WHISPER = findBinary('whisper-cli', 'WHISPER_CLI');
export const WHISPER_VAD = findBinary('whisper-vad-speech-segments');
export const CLAUDE = findBinary('claude', 'CLAUDE_CLI');

export function toolStatus() {
  return {
    ffmpeg: !!findBinary('ffmpeg', 'FFMPEG'),
    whisper: !!WHISPER && fs.existsSync(WHISPER_MODEL),
    whisperBinary: !!WHISPER,
    whisperModel: fs.existsSync(WHISPER_MODEL),
    alignModel: fs.existsSync(ALIGN_MODEL) && fs.existsSync(ALIGN_VOCAB),
    speakers: fs.existsSync(DIARIZE_SEGMENTATION) && fs.existsSync(DIARIZE_EMBEDDING),
    kokoro: fs.existsSync(path.join(KOKORO_DIR, 'model.int8.onnx')),
    claude: !!CLAUDE,
    exportDir: EXPORT_DIR,
    model: AGENT_MODEL,
  };
}
