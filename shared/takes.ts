// Finding repeated attempts at the same line. Raw recordings are full of them:
// a sentence started, abandoned and started again, or said twice to get it right.

import type { ID, TakeGroup, Word } from './types.ts';
import { normalizeWord } from './captions.ts';

interface Utterance {
  from: number;
  to: number;
  tokens: string[];
}

const SENTENCE_END = /[.!?…]["')\]]?$/;

/** Split a file's words into utterances at sentence ends and pauses. */
export function utterances(words: Word[], pause = 0.6): Utterance[] {
  const out: Utterance[] = [];
  let start = 0;
  for (let i = 0; i < words.length; i++) {
    const last = i === words.length - 1;
    const gap = last ? Infinity : words[i + 1].t0 - words[i].t1;
    if (last || gap >= pause || SENTENCE_END.test(words[i].text)) {
      const tokens = words.slice(start, i + 1).map((w) => normalizeWord(w.text)).filter(Boolean);
      if (tokens.length) out.push({ from: start, to: i, tokens });
      start = i + 1;
    }
  }
  return out;
}

function bigrams(tokens: string[]): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) s.add(`${tokens[i]} ${tokens[i + 1]}`);
  return s;
}

/** How alike two utterances are, 0..1. A shorter one that opens the longer counts as a match (a false start). */
export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 2) {
    let same = 0;
    while (same < short.length && short[same] === long[same]) same++;
    // Allow the last word of an abandoned attempt to be half-said or different.
    if (same >= Math.max(2, short.length - 1)) return 0.9;
  }
  if (short.length < 4) return 0;
  const x = bigrams(a);
  const y = bigrams(b);
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / Math.max(1, Math.min(x.size, y.size));
}

/** Group utterances of one file that look like attempts at the same line. */
export function findTakes(mediaId: ID, words: Word[], makeId: () => string): TakeGroup[] {
  const us = utterances(words);
  const parent = us.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < us.length; i++) {
    // Retakes come close together; do not pair lines from opposite ends of a recording.
    for (let j = i + 1; j < Math.min(us.length, i + 5); j++) {
      if (similarity(us[i].tokens, us[j].tokens) >= 0.6) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, Utterance[]>();
  us.forEach((u, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(u);
  });
  const out: TakeGroup[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    out.push({ id: makeId(), mediaId, takes: g.map((u) => ({ from: u.from, to: u.to })), chosen: null });
  }
  return out;
}
