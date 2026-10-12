// Checks that the cuts in a project sound right: renders the edited audio,
// transcribes it again, and compares what is heard with the words the
// timeline says were kept. A kept word that is no longer heard was clipped by
// a cut; a word that is heard but was meant to be cut left a remnant behind.
//
//   node scripts/cutcheck.ts <project id> [--keep-wav]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzePcm, decodePcm } from '../server/analyze.ts';
import { renderAudio } from '../server/export/audio.ts';
import { ensureDirs, getProject, getWords } from '../server/store.ts';
import { transcribe } from '../server/transcribe.ts';
import { normalizeWord, timelineWords } from '../shared/captions.ts';
import { contentDuration, layoutMain } from '../shared/timeline.ts';

interface Tok {
  text: string;
  norm: string;
  t: number;
}

/** Longest common subsequence alignment of two word lists. */
function align(a: Tok[], b: Tok[]): { missing: Tok[]; extra: Tok[]; matched: number } {
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i].norm === b[j].norm ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const missing: Tok[] = [];
  const extra: Tok[] = [];
  let i = 0;
  let j = 0;
  let matched = 0;
  while (i < n && j < m) {
    if (a[i].norm === b[j].norm) {
      matched++;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) missing.push(a[i++]);
    else extra.push(b[j++]);
  }
  while (i < n) missing.push(a[i++]);
  while (j < m) extra.push(b[j++]);
  return { missing, extra, matched };
}

const id = process.argv[2];
if (!id) {
  console.error('usage: node scripts/cutcheck.ts <project id> [--keep-wav]');
  process.exit(1);
}
ensureDirs();
const p = getProject(id);
const doc = p.doc;
const layout = layoutMain(doc);
const expected: Tok[] = timelineWords(doc, layout, (m) => getWords(p, m))
  .map((w) => ({ text: w.text.trim(), norm: normalizeWord(w.text), t: w.start }))
  .filter((w) => w.norm);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cutcheck-'));
const wav = path.join(work, 'mix.wav');
await renderAudio(p, { ...doc, audio: doc.audio.filter((a) => a.role === 'voice') }, wav);
const pcm = await decodePcm(wav);
const analysis = analyzePcm(pcm);
const heardT = await transcribe({ pcm, envelope: analysis.envelope, duration: contentDuration(doc), workDir: path.join(work, 'stt'), language: 'en' });
const heard: Tok[] = heardT.words.map((w) => ({ text: w.text.trim(), norm: normalizeWord(w.text), t: w.t0 })).filter((w) => w.norm);

const r = align(expected, heard);
const fmt = (xs: Tok[]) => xs.map((x) => `${x.t.toFixed(2)}s "${x.text}"`).join(', ') || '(none)';
console.log(`${doc.name}: ${contentDuration(doc).toFixed(2)}s, ${layout.length} segments`);
console.log(`expected ${expected.length} words, heard ${heard.length}, matched ${r.matched}`);
console.log(`kept but not heard (${r.missing.length}): ${fmt(r.missing)}`);
console.log(`heard but not expected (${r.extra.length}): ${fmt(r.extra)}`);
if (process.argv.includes('--keep-wav')) console.log(`audio: ${wav}`);
else fs.rmSync(work, { recursive: true, force: true });
process.exit(0);
