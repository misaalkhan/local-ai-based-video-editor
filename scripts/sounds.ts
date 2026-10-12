// Fetches the comedy and reaction sound pack into library/sfx and writes pack.json
// with tags, a role and the moment each sound lands, so the assistant can time it to
// the picture. The files come from Mixkit (https://mixkit.co/license/#sfxFree): free
// to use in any video, including monetised ones, no attribution needed. Safe to rerun.
//
//   node scripts/sounds.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzePcm, decodePcm } from '../server/analyze.ts';
import { ENVELOPE_HOP } from '../shared/silence.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'library', 'sfx');

type Role = 'ui' | 'whoosh' | 'impact' | 'riser' | 'tone';

/** Mixkit id, name as the assistant will see it, tags it can be found by, and its role. */
const PACK: [number, string, string, Role][] = [
  [744, 'Sad trombone', 'fail, womp womp, disappointment, anticlimax, loser', 'tone'],
  [2876, 'Fail low tone', 'fail, wrong, bruh, nope, mistake', 'tone'],
  [473, 'Failure piano', 'fail, mistake, piano, falling down', 'tone'],
  [2894, 'Boing', 'boing, spring, bounce, surprise, cartoon, jump', 'impact'],
  [395, 'Slide whistle fall', 'slide whistle, falling, drop, descend, cartoon', 'tone'],
  [616, 'Toy whistle', 'whistle, cute, toy, attention', 'tone'],
  [2889, 'Splat', 'splat, squish, slapstick, hit, mess', 'impact'],
  [2151, 'Punch', 'punch, hit, slap, smack, impact', 'impact'],
  [2886, 'Clown horn', 'clown, honk, silly, circus, joke', 'tone'],
  [527, 'Sad party horn', 'sad horn, deflate, anticlimax, party, wah wah', 'tone'],
  [2359, 'Silly pop cluster', 'pops, bubbly, silly, multiple pops, cute', 'ui'],
  [2364, 'Hard pop', 'pop, click, appear, popup, snap', 'ui'],
  [2358, 'Cork pop', 'pop, cork, bottle, open, celebrate', 'ui'],
  [2882, 'Cartoon laugh', 'laugh, cartoon, giggle, funny', 'tone'],
  [2885, 'Giggling', 'giggle, laugh, cheeky, chuckle', 'tone'],
  [424, 'Laugh track', 'laugh track, audience laughing, sitcom, crowd laugh', 'tone'],
  [460, 'Big crowd laugh', 'big laugh, audience, hilarious, crowd', 'tone'],
  [422, 'Laugh and applause', 'laugh, applause, audience, show', 'tone'],
  [518, 'Cheer and applause', 'applause, cheer, win, celebrate, bravo', 'tone'],
  [462, 'Crowd cheering', 'crowd, cheer, victory, goal, stadium, hype', 'tone'],
  [2257, 'No no no', 'no, refuse, nope, cartoon voice, disagree', 'tone'],
  [391, 'Falling scream', 'scream, falling, fall, panic, aaah', 'tone'],
  [579, 'Rimshot', 'rimshot, ba dum tss, joke, punchline, drums', 'impact'],
  [2893, 'Bad joke drums', 'bad joke, rimshot, punchline, dad joke, drums', 'impact'],
  [566, 'Drum roll', 'drum roll, anticipation, reveal, wait for it', 'riser'],
  [577, 'Suspense drum roll', 'suspense, tension, drum roll, build', 'riser'],
  [948, 'Wrong buzzer', 'wrong, buzzer, error, nope, game show, incorrect', 'tone'],
  [950, 'Game show buzz', 'game show, wrong answer, buzz, eliminated', 'tone'],
  [600, 'Achievement bell', 'ding, correct, achievement, level up, right answer, success', 'tone'],
  [555, 'Win drums', 'win, success, tada, achievement, victory', 'impact'],
  [722, 'Fanfare', 'fanfare, tada, triumph, royal, announcement', 'tone'],
  [2902, 'Dramatic boom', 'boom, dramatic, impact, reveal, vine boom, bass drop', 'impact'],
  [2909, 'Trailer impact', 'trailer, impact, dramatic hit, cinematic, epic', 'impact'],
  [2299, 'Bass hit', 'bass, hit, boom, drop, thud', 'impact'],
  [565, 'Horror hit', 'horror, jump scare, hit, scary, shock', 'impact'],
  [492, 'Heartbeat suspense', 'heartbeat, suspense, tension, nervous, waiting', 'riser'],
  [490, 'Single heartbeat', 'heartbeat, thump, pulse', 'impact'],
  [1489, 'Air whoosh', 'whoosh, swoosh, transition, swipe, fast', 'whoosh'],
  [1490, 'Fast whoosh', 'whoosh, transition, quick, swish', 'whoosh'],
  [2608, 'Zoom vacuum', 'zoom, suck, vacuum, punch in, pull', 'whoosh'],
  [2350, 'Sparkle whoosh', 'sparkle, magic, shimmer, glitter, whoosh', 'whoosh'],
  [3082, 'Magic poof', 'poof, disappear, vanish, magic, puff', 'impact'],
  [2354, 'Message pop', 'notification, message, dm, text, alert', 'ui'],
  [2357, 'Bubble notification', 'popup, bubble, notification, comment, alert', 'ui'],
  [1368, 'Typewriter ding', 'typewriter, ding, type, text appears', 'ui'],
  [2925, 'Soap bubble', 'bubble, soft pop, plop', 'ui'],
  [1791, 'Kitchen ding', 'ding, bell, done, ready, timer', 'tone'],
  [2963, 'Short buzzer', 'buzzer, short, wrong, stop', 'tone'],
  [39, 'Crickets', 'crickets, awkward silence, silence, nobody laughed, cricket', 'tone'],
  [2209, 'Cartoon sneeze', 'sneeze, achoo, cartoon', 'tone'],
  [10, 'Hiccup', 'hiccup, cartoon, cute', 'tone'],
  [2194, 'Cartoon kiss', 'kiss, mwah, cute, love', 'tone'],
  [2891, 'Fart', 'fart, rude, juvenile, toot', 'tone'],
];

fs.mkdirSync(DIR, { recursive: true });
const entries = [];
for (const [id, name, tags, role] of PACK) {
  const file = path.join(DIR, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.mp3`);
  if (!fs.existsSync(file)) {
    const url = `https://assets.mixkit.co/active_storage/sfx/${id}/${id}-preview.mp3`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) {
      console.log(`could not fetch ${name} (${res.status})`);
      continue;
    }
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(path.relative(ROOT, file));
  }
  // The moment the sound lands: its loudest 10 ms, which gets lined up with the picture.
  const a = analyzePcm(await decodePcm(file));
  let hit = 0;
  let best = -1;
  a.envelope.forEach((v, i) => {
    if (v > best) {
      best = v;
      hit = i * ENVELOPE_HOP;
    }
  });
  // A long bed (laughter, crickets, a drum roll's run-up) starts at the cue; a short hit lands its peak on it.
  if (a.duration > 4 && role !== 'impact' && !/roll/i.test(name)) hit = 0;
  entries.push({ id: `pack-${id}`, name, tags: tags.split(/\s*,\s*/), role, file: path.basename(file), duration: Math.round(a.duration * 100) / 100, hit: Math.round(hit * 1000) / 1000, source: 'pack' });
}
fs.writeFileSync(path.join(DIR, 'pack.json'), JSON.stringify(entries, null, 1));
fs.writeFileSync(
  path.join(DIR, 'LICENSE-pack.txt'),
  `The files listed in pack.json come from Mixkit (https://mixkit.co) under the Mixkit Sound Effects Free License
(https://mixkit.co/license/#sfxFree): free to use in any video, including monetised ones, without attribution.
They may not be redistributed on their own as a sound library.
`,
);
console.log(`${entries.length} sounds in the pack`);
process.exit(0);
