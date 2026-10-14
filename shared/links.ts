// Links the user gives the assistant. Two jobs, shared by the browser and the
// server: telling what a link points at (a Reddit thread, a YouTube video, a
// Google Doc, a plain page), and keeping the addresses when rich text is
// pasted into the chat box. A paste from a document carries its links only in
// the HTML flavour; the plain text that lands in a textarea keeps the words
// and drops the addresses, so "Netflix Tudum — reunion recap" arrives with
// nothing to open. keepLinks puts the address back after each linked phrase.

export type LinkKind = 'reddit' | 'subreddit' | 'youtube' | 'gdoc' | 'page';

export interface LinkInfo {
  kind: LinkKind;
  url: string;
  /** Reddit thread id, YouTube video id, Google Doc id, or subreddit name. */
  id?: string;
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** What the link points at. Throws on something that is not a web address. */
export function classifyLink(raw: string): LinkInfo {
  const given = raw.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(given)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http' && scheme !== 'https') throw new Error(`Only http and https links can be opened, not ${scheme}:`);
  let url: URL;
  try {
    url = new URL(scheme ? given : `https://${given}`);
  } catch {
    throw new Error(`"${raw}" is not a web address.`);
  }
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') throw new Error(`"${raw}" is not a web address.`);
  const host = url.hostname.replace(/^(www|old|new|m|np)\./, '').toLowerCase();
  const path = url.pathname;
  const href = url.toString();
  if (host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'redd.it') {
    const thread = /\/comments\/([a-z0-9]{4,10})\b/i.exec(path) ?? (host === 'redd.it' ? /^\/([a-z0-9]{4,10})\b/i.exec(path) : null);
    if (thread) return { kind: 'reddit', url: href, id: thread[1].toLowerCase() };
    const sub = /^\/r\/([A-Za-z0-9_]{2,30})\/?$/.exec(path);
    if (sub) return { kind: 'subreddit', url: href, id: sub[1] };
    return { kind: 'reddit', url: href };
  }
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be' || host === 'youtube-nocookie.com') {
    let id = host === 'youtu.be' ? path.slice(1).split('/')[0] : url.searchParams.get('v') ?? '';
    if (!id) {
      const m = /^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})/.exec(path);
      if (m) id = m[1];
    }
    if (YT_ID.test(id)) return { kind: 'youtube', url: href, id };
    return { kind: 'page', url: href };
  }
  if (host === 'docs.google.com') {
    const m = /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/.exec(path);
    if (m) return { kind: 'gdoc', url: href, id: m[1] };
  }
  return { kind: 'page', url: href };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTML entities to characters, for text taken out of markup. */
export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Google Docs wraps outgoing links as google.com/url?q=…; unwrap them. */
function unwrap(href: string): string {
  try {
    const u = new URL(href);
    if (u.hostname === 'www.google.com' && u.pathname === '/url') return u.searchParams.get('q') ?? href;
  } catch {
    // Not an absolute address; keep it as given.
  }
  return href;
}

/**
 * The plain text of a paste with the address of every link written after the
 * words that carried it, or null when the HTML adds no link the plain text
 * did not already have. Anchors are matched in order, so repeated labels
 * ("here", "link") each get their own address.
 */
export function keepLinks(html: string, plain: string): string | null {
  if (!html || !plain) return null;
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let out = plain;
  let cursor = 0;
  let changed = false;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const href = unwrap(unescapeHtml(m[1] ?? m[2] ?? m[3] ?? '').trim());
    if (!/^https?:\/\//i.test(href)) continue;
    const label = unescapeHtml(m[4].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    if (!label || label === href || out.includes(href)) continue;
    const at = out.indexOf(label, cursor);
    if (at < 0) continue;
    const end = at + label.length;
    out = `${out.slice(0, end)} (${href})${out.slice(end)}`;
    cursor = end + href.length + 3;
    changed = true;
  }
  return changed ? out : null;
}

/** Every web address in a piece of text, in order, without duplicates. */
export function findLinks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>()"'\]]+/gi)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}
