// Text-to-speech for voiceover lines. Kokoro (through sherpa-onnx) when its
// model is installed: natural voices in several languages, all on this Mac.
// The voices built into macOS remain as the fallback and need no download.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { KOKORO_DIR } from './config.ts';
import { run } from './proc.ts';

export interface Voice {
  id: string;
  name: string;
}

/** Kokoro v1.0 voices in the order the model numbers them: id, language and a few words on the sound. */
const KOKORO: [string, string, string][] = [
  ['af_heart', 'en', 'Heart, US woman, warm'],
  ['af_bella', 'en', 'Bella, US woman, bright'],
  ['af_sarah', 'en', 'Sarah, US woman, calm'],
  ['af_nicole', 'en', 'Nicole, US woman, soft'],
  ['af_sky', 'en', 'Sky, US woman, clear'],
  ['am_adam', 'en', 'Adam, US man, deep'],
  ['am_michael', 'en', 'Michael, US man, friendly'],
  ['am_fenrir', 'en', 'Fenrir, US man, energetic'],
  ['bf_emma', 'en', 'Emma, UK woman, warm'],
  ['bf_isabella', 'en', 'Isabella, UK woman, poised'],
  ['bm_george', 'en', 'George, UK man, measured'],
  ['bm_lewis', 'en', 'Lewis, UK man, bright'],
  ['hf_alpha', 'hi', 'Alpha, Hindi woman'],
  ['hf_beta', 'hi', 'Beta, Hindi woman'],
  ['hm_omega', 'hi', 'Omega, Hindi man'],
  ['hm_psi', 'hi', 'Psi, Hindi man'],
  ['ef_dora', 'es', 'Dora, Spanish woman'],
  ['em_alex', 'es', 'Alex, Spanish man'],
  ['ff_siwis', 'fr', 'Siwis, French woman'],
  ['if_sara', 'it', 'Sara, Italian woman'],
  ['im_nicola', 'it', 'Nicola, Italian man'],
  ['pf_dora', 'pt', 'Dora, Portuguese woman'],
  ['pm_alex', 'pt', 'Alex, Portuguese man'],
  ['jf_alpha', 'ja', 'Alpha, Japanese woman'],
  ['zf_xiaoxiao', 'zh', 'Xiaoxiao, Chinese woman'],
  ['zm_yunxi', 'zh', 'Yunxi, Chinese man'],
];

/** Speaker numbers of the Kokoro v1.0 voice table (alphabetical, as the model ships them). */
const KOKORO_IDS = ['af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx', 'am_puck', 'am_santa', 'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily', 'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis', 'ef_dora', 'em_alex', 'ff_siwis', 'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi', 'if_sara', 'im_nicola', 'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo', 'pf_dora', 'pm_alex', 'pm_santa', 'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi', 'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang', 'em_santa'];

export function kokoroInstalled(): boolean {
  return fs.existsSync(path.join(KOKORO_DIR, 'model.int8.onnx')) && fs.existsSync(path.join(KOKORO_DIR, 'voices.bin'));
}

/** Joke and effect voices that ship with macOS and are useless for narration. */
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Wobble|Fred|Good News|Jester|Junior|Kathy|Organ|Superstar|Ralph|Trinoids|Whisper|Zarvox|Grandma|Grandpa|Rocko|Deranged|Hysterical|Pipe Organ|Princess)/;
const PREFERRED = ['Ava', 'Zoe', 'Evan', 'Nathan', 'Allison', 'Samantha', 'Tom', 'Susan', 'Daniel', 'Karen', 'Rishi', 'Tara', 'Aman', 'Flo', 'Eddy', 'Reed', 'Sandy', 'Shelley'];

let macVoices: Voice[] | null = null;

async function listMacVoices(): Promise<Voice[]> {
  if (macVoices) return macVoices;
  try {
    const r = await run('/usr/bin/say', ['-v', '?']);
    const voices: (Voice & { rank: number })[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = /^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s+#/.exec(line);
      if (!m) continue;
      const [, id, locale] = m;
      if (!locale.startsWith('en_') || NOVELTY.test(id)) continue;
      const base = id.replace(/\s*\(.*$/, '');
      const better = /Premium|Enhanced/.test(id);
      const rank = (better ? -100 : 0) + (PREFERRED.indexOf(base) >= 0 ? PREFERRED.indexOf(base) : 50) + (locale === 'en_US' ? 0 : 0.5);
      const accent = { en_US: 'US', en_GB: 'UK', en_AU: 'Australian', en_IN: 'Indian', en_IE: 'Irish', en_ZA: 'South African' }[locale] ?? locale.slice(3);
      voices.push({ id, name: `${base}${better ? ' (enhanced)' : ''} · ${accent} (system voice)`, rank });
    }
    macVoices = voices.sort((a, b) => a.rank - b.rank).map(({ id, name }) => ({ id, name }));
  } catch {
    macVoices = [];
  }
  return macVoices;
}

export async function listVoices(): Promise<Voice[]> {
  const kokoro = kokoroInstalled() ? KOKORO.map(([id, , name]) => ({ id, name })) : [];
  return [...kokoro, ...(await listMacVoices())];
}

interface Tts {
  sampleRate: number;
  generate(req: { text: string; sid: number; speed: number }): { samples: Float32Array; sampleRate: number };
}

let kokoro: Promise<Tts | null> | null = null;

function loadKokoro(): Promise<Tts | null> {
  if (!kokoro) {
    kokoro = (async () => {
      if (!kokoroInstalled()) return null;
      try {
        const require = createRequire(import.meta.url);
        const sherpa = require('sherpa-onnx-node') as { OfflineTts: new (config: unknown) => Tts };
        return new sherpa.OfflineTts({
          model: {
            kokoro: {
              model: path.join(KOKORO_DIR, 'model.int8.onnx'),
              voices: path.join(KOKORO_DIR, 'voices.bin'),
              tokens: path.join(KOKORO_DIR, 'tokens.txt'),
              dataDir: path.join(KOKORO_DIR, 'espeak-ng-data'),
              dictDir: path.join(KOKORO_DIR, 'dict'),
              lexicon: ['lexicon-us-en.txt', 'lexicon-zh.txt'].map((f) => path.join(KOKORO_DIR, f)).join(','),
            },
            numThreads: 2,
            debug: false,
          },
          maxNumSentences: 1,
        });
      } catch (err) {
        console.error('[tts] could not load Kokoro:', (err as Error).message);
        return null;
      }
    })();
  }
  return kokoro;
}

function writeWav(file: string, samples: Float32Array, sampleRate: number): void {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

/** Speak `text` into a mono WAV file. */
export async function synthesize(text: string, voiceId: string | undefined, outWav: string, signal?: AbortSignal): Promise<void> {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('nothing to say');
  const want = (voiceId ?? '').trim();
  const kokoroVoice = KOKORO.find(([id, , name]) => id === want || name.toLowerCase().startsWith(want.toLowerCase().split(/[ ,]/)[0] + ','));
  const tts = kokoroInstalled() && (!want || kokoroVoice) ? await loadKokoro() : null;
  if (tts) {
    const id = kokoroVoice?.[0] ?? KOKORO[0][0];
    const sid = Math.max(0, KOKORO_IDS.indexOf(id));
    const out = tts.generate({ text: clean, sid, speed: 1.0 });
    if (!out.samples.length) throw new Error('the voice produced no audio');
    writeWav(outWav, out.samples, out.sampleRate);
    return;
  }
  const voices = await listMacVoices();
  if (!voices.length) throw new Error('no text-to-speech voice is available on this Mac');
  const voice = voices.find((v) => v.id === want || v.name.toLowerCase().startsWith(want.toLowerCase() + ' ')) ?? voices[0];
  await run('/usr/bin/say', ['-v', voice.id, '--file-format=WAVE', '--data-format=LEI16@48000', '-o', outWav, clean], { signal });
  if (!fs.existsSync(outWav) || fs.statSync(outWav).size < 1000) throw new Error('the voice produced no audio');
}
