// Opening a link the user gives. A Reddit thread comes through the archive
// (reddit.com refuses scripts) with its pictures from i.redd.it; a YouTube
// video gives its title, channel, description, thumbnail and transcript when
// it has captions (the app client still hands those out); a public Google Doc
// gives its text; any other page gives readable text plus the pictures on it.
// Reading takes nothing into the project. addLinkMedia downloads the pictures
// or videos the user chose: the source address stays with each file, and what
// may be shown is the user's call, as it is for anything they drop in.

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { MediaAsset } from '../shared/types.ts';
import { classifyLink, unescapeHtml } from '../shared/links.ts';
import type { LinkInfo } from '../shared/links.ts';
import { describeThreads, readThread, topOfSubreddit } from './reddit.ts';
import type { RedditThread } from './reddit.ts';
import { importMedia } from './media.ts';
import { patchMedia } from './store.ts';
import type { Project } from './store.ts';
import { IMAGE_EXT, VIDEO_EXT } from './probe.ts';
import { getSecret } from './secrets.ts';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' };
const PAGE_BYTES = 6 * 1024 * 1024;
const FILE_BYTES = 80 * 1024 * 1024;
const MIN_IMAGE_BYTES = 12 * 1024;

export interface LinkPicture {
  /** Short id for add_link_media. */
  id: string;
  url: string;
  kind: 'image' | 'video';
  /** Where on the page it was: "post image", "gallery 2 of 5", "article image", "thumbnail". */
  where: string;
  alt?: string;
  width?: number;
  height?: number;
}

export interface LinkDigest {
  kind: LinkInfo['kind'] | 'image' | 'video';
  url: string;
  title: string;
  /** Readable text: the post and comments, the transcript, the article. */
  text: string;
  pictures: LinkPicture[];
  /** Something the assistant should pass on (a login wall, a cut transcript). */
  note?: string;
}

export interface ReadOptions {
  /** Reddit top comments to include. */
  comments?: number;
  /** Cut the text at this many characters. */
  maxChars?: number;
}

/** Pictures listed by the last reads, by id, for add_link_media. */
export const found = new Map<string, LinkPicture & { page: string; pageTitle: string }>();
let counter = 0;

const pictureId = () => `l${(++counter).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function remember(page: string, pageTitle: string, pics: Omit<LinkPicture, 'id'>[]): LinkPicture[] {
  const out: LinkPicture[] = [];
  const seen = new Set<string>();
  for (const p of pics) {
    const key = p.url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    const id = pictureId();
    const pic = { id, ...p };
    found.set(id, { ...pic, page, pageTitle });
    out.push(pic);
  }
  // Keep the map from growing without bound across a long session.
  if (found.size > 2000) for (const k of [...found.keys()].slice(0, 1000)) found.delete(k);
  return out;
}

async function fetchPage(url: string, extra: Record<string, string> = {}): Promise<{ status: number; type: string; body: string; url: string }> {
  const r = await fetch(url, { headers: { ...HEADERS, ...extra }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
  const type = (r.headers.get('content-type') ?? '').toLowerCase();
  const len = Number(r.headers.get('content-length') ?? '');
  if (len > PAGE_BYTES || /^(image|video|audio)\//.test(type)) {
    await r.body?.cancel().catch(() => undefined);
    return { status: r.status, type, body: '', url: r.url };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type, body: buf.subarray(0, PAGE_BYTES).toString('utf8'), url: r.url };
}

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

function cut(text: string, max: number): { text: string; note?: string } {
  if (text.length <= max) return { text };
  return { text: `${text.slice(0, max)}\n[… cut at ${max} characters of ${text.length}; ask for more with max_chars]`, note: `The text was cut at ${max} characters (of ${text.length}).` };
}

// ---------- Reddit ----------

function redditPictures(t: RedditThread): Omit<LinkPicture, 'id'>[] {
  const pics: Omit<LinkPicture, 'id'>[] = [];
  const raw = t.raw ?? {};
  const url = typeof raw.url === 'string' ? raw.url : '';
  if (/^https?:\/\/i\.redd\.it\/[a-z0-9]+\.(jpe?g|png|gif|webp)$/i.test(url)) pics.push({ url, kind: 'image', where: 'post image' });
  if (/^https?:\/\/v\.redd\.it\/[a-z0-9]+/i.test(url)) {
    const media = raw.media as { reddit_video?: { fallback_url?: string; width?: number; height?: number } } | undefined;
    const fb = media?.reddit_video?.fallback_url;
    if (fb) pics.push({ url: fb.split('?')[0], kind: 'video', where: 'post video (without its sound)', width: media?.reddit_video?.width, height: media?.reddit_video?.height });
  }
  const meta = raw.media_metadata as Record<string, { e?: string; m?: string; s?: { u?: string; x?: number; y?: number } }> | undefined;
  if (meta && typeof meta === 'object') {
    const order = Array.isArray((raw.gallery_data as { items?: { media_id: string }[] } | undefined)?.items) ? (raw.gallery_data as { items: { media_id: string }[] }).items.map((i) => i.media_id) : Object.keys(meta);
    let n = 0;
    for (const key of order) {
      const m = meta[key];
      if (!m || m.e !== 'Image') continue;
      n++;
      const ext = (m.m ?? 'image/jpeg').split('/')[1].replace('jpeg', 'jpg');
      pics.push({ url: `https://i.redd.it/${key}.${ext}`, kind: 'image', where: `gallery ${n} of ${order.length}`, width: m.s?.x, height: m.s?.y });
    }
  }
  // Pictures people linked in the post text and comments.
  const bodies = [t.text, ...t.top.map((c) => c.text)].join('\n');
  for (const m of bodies.matchAll(/https?:\/\/(?:i\.redd\.it|i\.imgur\.com)\/[A-Za-z0-9_-]+\.(?:jpe?g|png|gif|webp)/gi)) pics.push({ url: m[0], kind: 'image', where: 'linked in a comment' });
  return pics;
}

async function readReddit(info: LinkInfo, opts: ReadOptions): Promise<LinkDigest> {
  if (info.kind === 'subreddit' && info.id) {
    const threads = await topOfSubreddit(info.id, 30, 10);
    return { kind: 'subreddit', url: info.url, title: `r/${info.id}, biggest threads of the last 30 days`, text: describeThreads(threads), pictures: [] };
  }
  let id = info.id;
  if (!id) {
    // A share link (reddit.com/r/x/s/abc) only reveals the thread when followed.
    const r = await fetch(info.url, { headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(15000) }).catch(() => null);
    const loc = r?.headers.get('location') ?? '';
    const m = /\/comments\/([a-z0-9]{4,10})\b/i.exec(loc);
    if (m) id = m[1].toLowerCase();
    else throw new Error('This Reddit link does not name the thread. Open it in the browser and paste the full address, the one with /comments/ in it.');
  }
  const t = await readThread(id, opts.comments ?? 12);
  if (!t) throw new Error(`The Reddit archive has no thread ${id}. The newest hours are sometimes missing; paste the post and the comments you want instead.`);
  const pictures = remember(t.url, t.title, redditPictures(t));
  const body = describeThreads([t]);
  const { text, note } = cut(body, opts.maxChars ?? 12000);
  return { kind: 'reddit', url: t.url, title: t.title, text, pictures, note };
}

// ---------- YouTube ----------

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string; author?: string; lengthSeconds?: string; shortDescription?: string; viewCount?: string; videoId?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: { baseUrl: string; languageCode: string; kind?: string; name?: { simpleText?: string; runs?: { text: string }[] } }[] } };
  microformat?: { playerMicroformatRenderer?: { publishDate?: string; uploadDate?: string } };
}

/** Caption lines as [m:ss] text, from YouTube's timedtext XML (format 3). */
export function parseTimedText(xml: string): string[] {
  const lines: string[] = [];
  for (const m of xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const t = /\bt="(\d+)"/.exec(m[1]);
    const text = unescapeHtml(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push(`[${fmtTime(Number(t?.[1] ?? 0) / 1000)}] ${text}`);
  }
  return lines;
}

async function readYouTube(info: LinkInfo, opts: ReadOptions): Promise<LinkDigest> {
  const id = info.id!;
  const client = { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en', gl: 'US' };
  const androidUa = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip';
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': androidUa, 'x-youtube-client-name': '3', 'x-youtube-client-version': client.clientVersion },
    body: JSON.stringify({ context: { client }, videoId: id, contentCheckOk: true, racyCheckOk: true }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`YouTube answered ${r.status}.`);
  const pr = (await r.json()) as PlayerResponse;
  const d = pr.videoDetails ?? {};
  const status = pr.playabilityStatus?.status;
  if (!d.title) throw new Error(`YouTube gave nothing for ${id}${pr.playabilityStatus?.reason ? `: ${pr.playabilityStatus.reason}` : ''}.`);
  const length = Number(d.lengthSeconds ?? 0);
  const views = Number(d.viewCount ?? 0);
  const date = pr.microformat?.playerMicroformatRenderer?.publishDate ?? pr.microformat?.playerMicroformatRenderer?.uploadDate ?? '';
  const head = [`Title: ${d.title}`, `Channel: ${d.author ?? '?'}${length ? ` · ${fmtTime(length)}` : ''}${views ? ` · ${views.toLocaleString('en-US')} views` : ''}${date ? ` · ${date.slice(0, 10)}` : ''}`];
  if (d.shortDescription) head.push(`Description: ${d.shortDescription.replace(/\s+/g, ' ').slice(0, 1200)}`);
  let transcript = '';
  let note: string | undefined;
  const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (status && status !== 'OK' && !tracks.length) note = `YouTube reports the video as ${status.toLowerCase().replace(/_/g, ' ')}${pr.playabilityStatus?.reason ? ` (${pr.playabilityStatus.reason})` : ''}; no transcript came back.`;
  const pick = tracks.find((t) => t.languageCode === 'en' && t.kind !== 'asr') ?? tracks.find((t) => t.languageCode.startsWith('en')) ?? tracks.find((t) => t.kind !== 'asr') ?? tracks[0];
  if (pick) {
    const cr = await fetch(pick.baseUrl, { headers: { 'user-agent': androidUa }, signal: AbortSignal.timeout(20000) }).catch(() => null);
    const xml = cr && cr.ok ? await cr.text() : '';
    const lines = parseTimedText(xml);
    const lang = pick.name?.simpleText ?? pick.name?.runs?.map((x) => x.text).join('') ?? pick.languageCode;
    if (lines.length) transcript = `Transcript (${lang}${pick.kind === 'asr' ? ', auto-generated' : ''}, ${lines.length} lines):\n${lines.join('\n')}`;
    else note = 'The video lists captions but YouTube did not hand them out this time; try again in a minute, or paste the transcript from the "Show transcript" button.';
  } else if (!note) {
    note = 'The video has no captions, so there is no transcript; the description is all the text it offers.';
  }
  const pictures = remember(info.url, d.title, [
    { url: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, kind: 'image', where: 'thumbnail', alt: d.title, width: 1280, height: 720 },
  ]);
  const body = cut(`${head.join('\n')}${transcript ? `\n\n${transcript}` : ''}`, opts.maxChars ?? 20000);
  return { kind: 'youtube', url: info.url, title: d.title, text: body.text, pictures, note: body.note ?? note };
}

// ---------- Google Docs ----------

async function readGoogleDoc(info: LinkInfo, opts: ReadOptions): Promise<LinkDigest> {
  const r = await fetch(`https://docs.google.com/document/d/${info.id}/export?format=txt`, { headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  if (r.status >= 300 && r.status < 400) {
    await r.body?.cancel().catch(() => undefined);
    throw new Error('This Google Doc is private to its owner. Share it as "Anyone with the link" (viewer) or paste its text into the chat.');
  }
  if (!r.ok) throw new Error(`Google Docs answered ${r.status}; share the document as "Anyone with the link" or paste its text.`);
  const raw = (await r.text()).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  const title = raw.split('\n')[0]?.slice(0, 120) || 'Google Doc';
  const { text, note } = cut(raw, opts.maxChars ?? 30000);
  return { kind: 'gdoc', url: info.url, title, text, pictures: [], note };
}

// ---------- Any page ----------

const BLOCK = /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|section|article|blockquote|pre|figure|figcaption|dd|dt|table|header|footer|main|aside|nav|hr)\b[^>]*>/gi;
const DROP = /<(script|style|noscript|svg|template|iframe|form|button|select|textarea)\b[\s\S]*?<\/\1>/gi;
const WALL = /just a moment|access denied|attention required|are you a human|verify you are human|enable javascript and cookies|pardon our interruption|request blocked|captcha/i;
const LOGIN_HOSTS = ['instagram.com', 'tiktok.com', 'x.com', 'twitter.com', 'facebook.com', 'threads.net', 'netflix.com', 'pinterest.com'];

function meta(html: string, key: string): string {
  const re = new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  if (!tag) return '';
  const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  return unescapeHtml(c?.[1] ?? c?.[2] ?? '').trim();
}

/** The readable part of a page: its title, summary line and body text. */
export function htmlToText(html: string): { title: string; description: string; body: string } {
  const title = unescapeHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim() || meta(html, 'og:title');
  const description = meta(html, 'description') || meta(html, 'og:description') || meta(html, 'twitter:description');
  // News sites put the whole article in structured data; that beats scraping the layout.
  let ld = '';
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = /"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(m[1]);
    if (body) {
      try {
        const s = JSON.parse(`"${body[1]}"`) as string;
        if (s.length > ld.length) ld = s;
      } catch {
        // Malformed structured data; fall through to the layout.
      }
    }
  }
  const doc = html.replace(/<!--[\s\S]*?-->/g, '').replace(DROP, ' ').replace(/<head\b[\s\S]*?<\/head>/i, ' ');
  const article = [...doc.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0] ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(doc)?.[1];
  let region = article ?? doc;
  region = region.replace(/<(nav|aside|footer|header)\b[\s\S]*?<\/\1>/gi, ' ');
  const text = unescapeHtml(
    region
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(BLOCK, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const body = ld.length > text.length * 0.6 ? ld.replace(/\s*\n\s*/g, '\n').trim() : text;
  return { title, description, body };
}

function absolute(src: string, base: string): string | null {
  try {
    const u = new URL(src.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const SKIP_IMAGE = /logo|icon|sprite|avatar|badge|button|pixel|tracker|spacer|blank|placeholder|loading|emoji|flag|arrow|\.svg(?:$|\?)|1x1|data:image/i;

/** Wikipedia and Commons thumbnails point at the full picture. */
export function fullWikimedia(url: string): string {
  const wm = /^https?:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/([a-z]+)\/thumb\/([^/]+\/[^/]+\/[^/]+)\/\d+px-[^/?]+(?:\?.*)?$/.exec(url);
  return wm ? `https://upload.wikimedia.org/wikipedia/${wm[1]}/${wm[2]}` : url;
}

/** The pictures on a page: lead image first, then the ones in the content, biggest first where sizes are known. */
export function pagePictures(html: string, base: string): Omit<LinkPicture, 'id'>[] {
  const out: Omit<LinkPicture, 'id'>[] = [];
  const seen = new Set<string>();
  const add = (src: string | undefined, where: string, alt?: string, width?: number, height?: number) => {
    if (!src) return;
    let url = absolute(src, base);
    if (!url || seen.has(url) || SKIP_IMAGE.test(url)) return;
    if ((width && width < 120) || (height && height < 100)) return;
    if (alt && /^(icon|logo|avatar|thumbnail)$/i.test(alt.trim())) return;
    const full = fullWikimedia(url);
    if (full !== url) {
      url = full;
      width = undefined;
      height = undefined;
      if (SKIP_IMAGE.test(url) || seen.has(url)) return;
    }
    const ext = (new URL(url).pathname.split('.').pop() ?? '').toLowerCase();
    const kind: LinkPicture['kind'] = VIDEO_EXT.includes(ext) && ext !== 'gif' ? 'video' : 'image';
    seen.add(url);
    out.push({ url, kind, where, alt: alt?.replace(/\s+/g, ' ').trim().slice(0, 120) || undefined, width, height });
  };
  add(meta(html, 'og:image') || meta(html, 'og:image:url') || meta(html, 'twitter:image'), 'lead image', meta(html, 'og:image:alt'), Number(meta(html, 'og:image:width')) || undefined, Number(meta(html, 'og:image:height')) || undefined);
  const doc = html.replace(/<!--[\s\S]*?-->/g, '').replace(DROP, ' ');
  const region = [...doc.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0] ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(doc)?.[1] ?? doc;
  const attr = (tag: string, name: string) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    return unescapeHtml(m?.[1] ?? m?.[2] ?? m?.[3] ?? '');
  };
  const bestOfSrcset = (srcset: string) => {
    let best: { url: string; w: number } | null = null;
    for (const part of srcset.split(',')) {
      const [u, d] = part.trim().split(/\s+/);
      if (!u) continue;
      const w = d?.endsWith('w') ? Number(d.slice(0, -1)) : d?.endsWith('x') ? Number(d.slice(0, -1)) * 1000 : 0;
      if (!best || w > best.w) best = { url: u, w };
    }
    return best?.url;
  };
  for (const m of region.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const srcset = attr(tag, 'srcset') || attr(tag, 'data-srcset');
    const src = (srcset && bestOfSrcset(srcset)) || attr(tag, 'data-src') || attr(tag, 'data-lazy-src') || attr(tag, 'data-original') || attr(tag, 'src');
    const w = Number(attr(tag, 'width')) || undefined;
    const h = Number(attr(tag, 'height')) || undefined;
    add(src, 'in the page', attr(tag, 'alt'), w, h);
  }
  for (const m of region.matchAll(/<video\b[^>]*>([\s\S]*?)<\/video>/gi)) {
    const src = attr(m[0], 'src') || attr(/<source\b[^>]*>/i.exec(m[1])?.[0] ?? '', 'src');
    if (src) add(src, 'video in the page');
  }
  // Big file links (photo galleries, wikis) point straight at the picture.
  for (const m of region.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+\.(?:jpe?g|png|webp)(?:\?[^"']*)?)["'][^>]*>/gi)) {
    // A wiki's File: page is a web page about the picture, not the picture; the <img> next to it was taken already.
    if (/\/(?:wiki\/)?(?:File|Datei|Fichier|Archivo):/i.test(m[1])) continue;
    add(m[1], 'linked picture');
  }
  return out.slice(0, 60);
}

async function readPage(info: LinkInfo, opts: ReadOptions): Promise<LinkDigest> {
  const host = new URL(info.url).hostname.replace(/^www\./, '');
  const r = await fetchPage(info.url);
  if (/^image\//.test(r.type)) {
    const pictures = remember(info.url, info.url, [{ url: r.url, kind: 'image', where: 'the link itself' }]);
    return { kind: 'image', url: info.url, title: path.basename(new URL(r.url).pathname), text: `A picture (${r.type}). Use add_link_media with its id to put it in the project.`, pictures };
  }
  if (/^video\//.test(r.type)) {
    const pictures = remember(info.url, info.url, [{ url: r.url, kind: 'video', where: 'the link itself' }]);
    return { kind: 'video', url: info.url, title: path.basename(new URL(r.url).pathname), text: `A video file (${r.type}). Use add_link_media with its id to put it in the project.`, pictures };
  }
  if (/^application\/pdf/.test(r.type)) throw new Error('That link is a PDF. Save it and paste the part you need; the assistant reads web pages, not PDFs.');
  const page = htmlToText(r.body);
  const wall = r.status === 403 || r.status === 429 || r.status === 503 || WALL.test(page.title) || (r.status >= 400 && !page.body);
  if (wall) throw new Error(`${host} refused the request (status ${r.status}${page.title ? `, "${page.title.slice(0, 60)}"` : ''}): the site blocks scripts. Open it in the browser and paste the text, or save the pictures and attach them.`);
  if (r.status >= 400) throw new Error(`${host} answered ${r.status}.`);
  const pictures = remember(r.url, page.title || host, pagePictures(r.body, r.url));
  const parts = [`Title: ${page.title || '(none)'}`];
  if (page.description) parts.push(`Summary: ${page.description}`);
  if (page.body) parts.push('', page.body);
  const { text, note } = cut(parts.join('\n'), opts.maxChars ?? 12000);
  let warn = note;
  const thin = page.body.length < 400;
  if (thin && LOGIN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) warn = `${host} shows almost nothing to a script without a signed-in browser; the title, summary and lead picture above are what it gave. For the rest, paste the caption or comments, or save the pictures and attach them.`;
  else if (thin) warn = 'The page gave very little text to a script (it may build itself with JavaScript); paste the text if you need it.';
  return { kind: 'page', url: r.url, title: page.title || host, text, pictures, note: warn };
}

/** Read what a link points at; nothing is downloaded into the project. */
export async function readLink(url: string, opts: ReadOptions = {}): Promise<LinkDigest> {
  const info = classifyLink(url);
  if (info.kind === 'reddit' || info.kind === 'subreddit') return readReddit(info, opts);
  if (info.kind === 'youtube') return readYouTube(info, opts);
  if (info.kind === 'gdoc') return readGoogleDoc(info, opts);
  return readPage(info, opts);
}

// ---------- Image search ----------

export interface ImageHit extends LinkPicture {
  /** The page the picture sits on. */
  page: string;
  pageTitle: string;
  host: string;
  /** Where the hit came from: Google results through SerpApi, a Google engine, or a Reddit post. */
  via: 'serpapi' | 'google' | 'reddit';
}

/** Which image searches are on: Reddit always; Google results need a SerpApi key or a Google engine. */
export function imageSearchSources(): string[] {
  const out = ['reddit'];
  if (getSecret('serpapi')) out.unshift('serpapi');
  else if (getSecret('google') && getSecret('googlecx')) out.unshift('google');
  return out;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Google image results through SerpApi (the user's key; 250 searches a month are free). */
async function serpapiImages(q: string, limit: number): Promise<ImageHit[]> {
  const key = getSecret('serpapi');
  const params = new URLSearchParams({ engine: 'google_images', q, api_key: key, safe: 'active', num: String(Math.min(50, Math.max(10, limit))) });
  const r = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(25000) });
  const body = (await r.json().catch(() => ({}))) as { images_results?: { original?: string; original_width?: number; original_height?: number; title?: string; link?: string; source?: string }[]; error?: string };
  if (!r.ok) throw new Error(r.status === 401 ? 'SerpApi does not accept the key in Settings.' : r.status === 429 ? 'The SerpApi free searches for this month are used up.' : `SerpApi answered ${r.status}${body.error ? `: ${body.error}` : ''}.`);
  const hits: ImageHit[] = [];
  for (const it of (body.images_results ?? []).slice(0, limit)) {
    if (!it.original || !/^https?:\/\//.test(it.original)) continue;
    const page = it.link && /^https?:\/\//.test(it.link) ? it.link : it.original;
    const host = it.source || hostOf(page);
    const [pic] = remember(page, it.title ?? host, [{ url: it.original, kind: 'image', where: `found on ${host}`, alt: it.title, width: it.original_width, height: it.original_height }]);
    if (pic) hits.push({ ...pic, page, pageTitle: it.title ?? host, host, via: 'serpapi' });
  }
  return hits;
}

/** Image results from a Google Programmable Search Engine (the user's key and engine; new engines search up to 50 sites of the user's choice). */
async function googleImages(q: string, limit: number): Promise<ImageHit[]> {
  const params = new URLSearchParams({ key: getSecret('google'), cx: getSecret('googlecx'), q, searchType: 'image', num: String(Math.max(1, Math.min(10, limit))), safe: 'active', imgSize: 'large' });
  const r = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, { signal: AbortSignal.timeout(20000) });
  const body = (await r.json().catch(() => ({}))) as { items?: { title?: string; link: string; displayLink?: string; image?: { contextLink?: string; width?: number; height?: number } }[]; error?: { message?: string } };
  if (!r.ok) throw new Error(`Google image search answered ${r.status}${body.error?.message ? `: ${body.error.message}` : ''}. Check the key and the engine id in Settings.`);
  const hits: ImageHit[] = [];
  for (const it of body.items ?? []) {
    if (!it.link || !/^https?:\/\//.test(it.link)) continue;
    const page = it.image?.contextLink ?? it.link;
    const host = it.displayLink || hostOf(page);
    const [pic] = remember(page, it.title ?? host, [{ url: it.link, kind: 'image', where: `found on ${host}`, alt: it.title, width: it.image?.width, height: it.image?.height }]);
    if (pic) hits.push({ ...pic, page, pageTitle: it.title ?? host, host, via: 'google' });
  }
  return hits;
}

interface ArchivePost {
  id: string;
  title?: string;
  subreddit?: string;
  score?: number;
  num_comments?: number;
  permalink?: string;
  url?: string;
  over_18?: boolean;
  media_metadata?: Record<string, { e?: string; m?: string; s?: { x?: number; y?: number } }>;
  gallery_data?: { items?: { media_id: string }[] };
}

/**
 * Pictures people posted on Reddit about the subject, through the archive:
 * image posts and galleries (i.redd.it serves them to anyone), biggest
 * threads first. For a show or a public figure this is where fans put the
 * screenshots and photos.
 */
async function redditImages(q: string, limit: number): Promise<ImageHit[]> {
  const archive = async (field: 'title' | 'q') => {
    const params = new URLSearchParams({ [field]: q, size: '60', sort_type: 'score', sort: 'desc', score: '>4' });
    const r = await fetch(`https://api.pullpush.io/reddit/search/submission/?${params}`, { headers: { 'user-agent': 'LocalStudio/1.0 (local video editor)', accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`The Reddit archive answered ${r.status}.`);
    return ((await r.json()) as { data?: ArchivePost[] }).data ?? [];
  };
  // Titles that carry the words are the real matches; the body search only fills in when they run short.
  let posts = await archive('title');
  if (posts.length < limit * 2) {
    const have = new Set(posts.map((p) => p.id));
    posts = [...posts, ...(await archive('q')).filter((p) => !have.has(p.id))];
  }
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const hits: ImageHit[] = [];
  for (const s of posts.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    if (s.over_18 || !s.title || (s.score ?? 0) < 5) continue;
    // Spam lands in throwaway subreddits with random names; skip those and anything adult by name.
    if (!s.subreddit || /^[a-z0-9]{9,}$/.test(s.subreddit) || /nsfw|porn|gonewild|xxx/i.test(s.subreddit)) continue;
    const t = s.title.toLowerCase();
    if (words.length > 1 && words.filter((w) => t.includes(w)).length < Math.ceil(words.length / 2)) continue;
    const page = s.permalink ? `https://www.reddit.com${s.permalink}` : `https://www.reddit.com/comments/${s.id}`;
    const title = s.title.replace(/\s+/g, ' ').trim();
    const pics: Omit<LinkPicture, 'id'>[] = [];
    const url = s.url ?? '';
    if (/^https?:\/\/(?:i\.redd\.it|i\.imgur\.com)\/[A-Za-z0-9_-]+\.(?:jpe?g|png|webp)$/i.test(url)) pics.push({ url, kind: 'image', where: `Reddit post in r/${s.subreddit} (${s.score ?? 0} points)`, alt: title });
    if (s.media_metadata) {
      const order = s.gallery_data?.items?.map((i) => i.media_id) ?? Object.keys(s.media_metadata);
      let n = 0;
      for (const key of order) {
        const m = s.media_metadata[key];
        if (!m || m.e !== 'Image') continue;
        n++;
        const ext = (m.m ?? 'image/jpeg').split('/')[1].replace('jpeg', 'jpg');
        pics.push({ url: `https://i.redd.it/${key}.${ext}`, kind: 'image', where: `Reddit gallery ${n} of ${order.length} in r/${s.subreddit} (${s.score ?? 0} points)`, alt: title, width: m.s?.x, height: m.s?.y });
        if (n >= 3) break;
      }
    }
    if (!pics.length) continue;
    for (const pic of remember(page, title, pics)) hits.push({ ...pic, page, pageTitle: title, host: 'reddit.com', via: 'reddit' });
    if (hits.length >= limit) break;
  }
  return hits.slice(0, limit);
}

/**
 * Pictures for a prompt. Google results come through SerpApi with the user's
 * key, or a Google engine of their own (Google's whole-web engines ended in
 * January 2026); Reddit image posts come without any key. Each hit is
 * remembered so add_link_media can download it with its source kept.
 */
export async function searchImages(q: string, limit = 10): Promise<{ hits: ImageHit[]; errors: string[] }> {
  const n = Math.max(1, Math.min(30, limit));
  const sources = imageSearchSources();
  const errors: string[] = [];
  const runs: Promise<ImageHit[]>[] = [];
  if (sources.includes('serpapi')) runs.push(serpapiImages(q, n));
  else if (sources.includes('google')) runs.push(googleImages(q, n));
  runs.push(redditImages(q, n));
  const settled = await Promise.allSettled(runs);
  const lists: ImageHit[][] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') lists.push(s.value);
    else errors.push((s.reason as Error).message);
  }
  // Web results first, Reddit after, up to the limit; the web list is the richer one when it exists.
  const hits: ImageHit[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const h of list) {
      if (seen.has(h.url) || hits.length >= n) continue;
      seen.add(h.url);
      hits.push(h);
    }
  }
  return { hits, errors };
}

/** A picture or video at an address the user dropped or pasted, straight into the project. */
export async function addUrlMedia(p: Project, url: string, page?: string, title?: string): Promise<MediaAsset> {
  const src = url.trim();
  if (src.startsWith('data:')) {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(src);
    if (!m) throw new Error('That is not a picture the editor can read.');
    const ext = extFromType(m[1], 'https://x/y');
    if (!ext) throw new Error(`That picture is ${m[1]}, which the editor cannot import.`);
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < MIN_IMAGE_BYTES) throw new Error('That is a small thumbnail. Open the full-size picture (click the result first) and drag that one.');
    const dir = path.join(p.dir, 'links');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `dropped-${Date.now().toString(36)}.${ext}`);
    fs.writeFileSync(file, buf);
    const asset = await importMedia(p, file, { name: (title || 'Dropped picture').slice(0, 70), managed: true, origin: 'link' });
    if (page) patchMedia(p, asset.id, { sourceUrl: page, credit: `Source: ${hostOf(page) || page}` });
    return asset;
  }
  const info = classifyLink(fullWikimedia(src));
  const from = page && /^https?:\/\//.test(page) ? page : info.url;
  const [pic] = remember(from, title || hostOf(from) || from, [{ url: info.url, kind: /\.(mp4|webm|mov)(\?|$)/i.test(info.url) ? 'video' : 'image', where: page ? 'dropped from a page' : 'the link itself', alt: title }]);
  if (!pic) throw new Error('Nothing to add.');
  return addLinkMedia(p, pic.id);
}

/** The digest as text for the assistant. */
export function describeLink(d: LinkDigest): string {
  const kind = { reddit: 'Reddit thread', subreddit: 'subreddit', youtube: 'YouTube video', gdoc: 'Google Doc', page: 'web page', image: 'picture', video: 'video file' }[d.kind];
  const lines = [`LINK ${d.url}`, `Kind: ${kind}`];
  if (d.kind !== 'youtube' && d.kind !== 'page') lines.push(`Title: ${d.title}`);
  lines.push('', d.text);
  if (d.pictures.length) {
    lines.push('', `PICTURES on it (add_link_media with the ids you want; the source stays with each file):`);
    for (const p of d.pictures) lines.push(`  ${p.id}  ${p.kind === 'video' ? 'video' : 'image'}  ${p.where}${p.width && p.height ? `  ${p.width}x${p.height}` : ''}${p.alt ? `  "${p.alt}"` : ''}  ${p.url.length > 90 ? `${p.url.slice(0, 87)}…` : p.url}`);
  } else if (d.kind === 'page' || d.kind === 'reddit') {
    lines.push('', 'No pictures found on it.');
  }
  if (d.note) lines.push('', `Note: ${d.note}`);
  return lines.join('\n');
}

const extFromType = (type: string, url: string): string => {
  const t = type.split(';')[0].trim().toLowerCase();
  const byType: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/heic': 'heic', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
  if (byType[t]) return byType[t];
  const ext = (new URL(url).pathname.split('.').pop() ?? '').toLowerCase();
  return [...IMAGE_EXT, ...VIDEO_EXT].includes(ext) ? ext : '';
};

/** Download one listed picture or video into the project. */
export async function addLinkMedia(p: Project, id: string, onProgress?: (done: number, total?: number) => void): Promise<MediaAsset> {
  const pic = found.get(id);
  if (!pic) throw new Error(`No picture with id "${id}" in the last read_link results; call read_link first.`);
  const dir = path.join(p.dir, 'links');
  fs.mkdirSync(dir, { recursive: true });
  const r = await fetch(pic.url, { headers: { ...HEADERS, accept: 'image/avif,image/webp,image/*,video/*,*/*;q=0.8', referer: pic.page }, redirect: 'follow', signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!r.ok || !r.body) {
    await r.body?.cancel().catch(() => undefined);
    throw new Error(`${new URL(pic.url).host} answered ${r.status} for that picture.`);
  }
  const type = r.headers.get('content-type') ?? '';
  const ext = extFromType(type, pic.url);
  if (!ext) {
    await r.body.cancel().catch(() => undefined);
    throw new Error(`That link is ${type.split(';')[0] || 'not a picture or video'}, which the editor cannot import.`);
  }
  const total = Number(r.headers.get('content-length') ?? '') || undefined;
  if (total && total > FILE_BYTES) throw new Error(`That file is ${(total / 1048576).toFixed(0)} MB, more than the ${FILE_BYTES / 1048576} MB limit.`);
  const safe = `${new URL(pic.page).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-')}-${id}`;
  const file = path.join(dir, `${safe}.${ext}`);
  const existing = [...p.media.values()].find((m) => m.path === file);
  if (existing) return existing;
  const tmp = `${file}.part`;
  let done = 0;
  const counter = new (await import('node:stream')).Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      if (done > FILE_BYTES) return cb(new Error(`That file is larger than the ${FILE_BYTES / 1048576} MB limit.`));
      onProgress?.(done, total);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(r.body as never), counter, fs.createWriteStream(tmp));
    if (pic.kind === 'image' && done < MIN_IMAGE_BYTES) throw new Error('That picture is tiny (an icon or a placeholder), so it was not added.');
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  const label = pic.alt || (pic.where === 'thumbnail' ? `${pic.pageTitle} (thumbnail)` : `${pic.pageTitle} (${pic.where})`);
  const asset = await importMedia(p, file, { name: label.slice(0, 70), managed: true, origin: 'link' });
  const host = new URL(pic.page).hostname.replace(/^www\./, '');
  patchMedia(p, asset.id, {
    insights: { summary: `From a link the user gave: ${pic.where} on "${pic.pageTitle}" (${host})${pic.alt ? `: ${pic.alt}` : ''}`, tags: [host, 'from link'], at: Date.now() },
    credit: `Source: ${pic.pageTitle} (${host})`,
    sourceUrl: pic.page,
  });
  return { ...asset, credit: `Source: ${pic.pageTitle} (${host})`, sourceUrl: pic.page };
}
