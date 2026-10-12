// Tool results are written for the assistant: they carry item ids, reminders
// and the names of other tools. This trims one down to what a person wants to
// read in a toast or in the chat's activity list.

const ITEM_ID = /\s*\(?\b[cgzkvua][a-z0-9]*\d[a-z0-9]*\b\)?/g;
const SNAKE = /\b[a-z]+_[a-z_]+\b/;

export function forPeople(text: string, max = 220): string {
  const first = (text.trim().split('\n')[0] ?? '').replaceAll('mcp__studio__', '').replace(/\s*It now reads:\s*$/, '');
  const kept = first
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !SNAKE.test(s) && !/^Timeline times after/.test(s))
    .join(' ')
    // Ids are eight characters, a letter first, with at least one digit; real words have none.
    .replace(ITEM_ID, (m) => (m.replace(/[()\s]/g, '').length === 8 ? '' : m))
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return kept.length > max ? `${kept.slice(0, max - 1)}…` : kept;
}
