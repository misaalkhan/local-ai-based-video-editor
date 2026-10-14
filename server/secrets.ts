// API keys (Tenor, Freesound, Pexels, Pixabay, SerpApi, Google search) live in the macOS Keychain, not in a file: a
// copy of the data folder, a backup or a stray commit never carries them. The
// browser only ever sees whether a key is set. On other systems the keys come
// from the environment (STUDIO_TENOR_KEY, STUDIO_FREESOUND_KEY).

import { execFileSync } from 'node:child_process';

const SERVICE = 'Local Studio';
const cache = new Map<string, string>();
/** What an API key can look like; anything else is refused rather than quoted into a shell-like command. */
const KEY = /^[A-Za-z0-9_\-.:+/=]{8,512}$/;

const envName = (name: string) => `STUDIO_${name.toUpperCase()}_KEY`;

/** The key called `name` (tenor, freesound, pexels, pixabay, serpapi, google, googlecx), or '' when none is set. */
export function getSecret(name: string): string {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  let value = (process.env[envName(name)] ?? '').trim();
  if (!value && process.platform === 'darwin') {
    try {
      value = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      value = '';
    }
  }
  cache.set(name, value);
  return value;
}

/** Save or, with an empty value, remove a key. */
export function setSecret(name: string, value: string): void {
  value = value.trim();
  if (process.platform !== 'darwin') {
    throw new Error(`Keys are kept in the macOS Keychain. On this system set ${envName(name)} in the environment before starting the app.`);
  }
  if (!value) {
    try {
      execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', name], { stdio: 'ignore' });
    } catch {
      // Nothing to remove.
    }
    cache.set(name, '');
    return;
  }
  if (!KEY.test(value)) throw new Error('That does not look like an API key (letters, digits and -_.:+/= only).');
  // The command goes in on stdin, so the key never appears in the process list.
  execFileSync('security', ['-i'], { input: `add-generic-password -s "${SERVICE}" -a "${name}" -w "${value}" -U\n`, stdio: ['pipe', 'ignore', 'ignore'] });
  cache.set(name, value);
}

/** Where keys are kept, for the Settings dialog. */
export const SECRET_STORE = process.platform === 'darwin' ? 'keychain' : 'environment';
