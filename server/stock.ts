// Public footage and pictures, found by a prompt and brought into a project.
// Sources that need no key: Wikimedia Commons (CC and public-domain pictures
// and video), the Internet Archive (public-domain and CC films), NASA's image
// and video library (public domain) and Openverse (CC pictures). With a free
// key each: Pexels and Pixabay (free to use, no credit needed). Every result
// carries its licence and a credit line; the file is downloaded once, kept
// with the project, and prepared like any upload.

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { getSecret } from './secrets.ts';
import { importMedia } from './media.ts';
import { patchMedia } from './store.ts';
import type { Project } from './store.ts';
import type { MediaAsset } from '../shared/types.ts';

export type StockSource = 'commons' | 'archive' | 'nasa' | 'openverse' | 'pexels' | 'pixabay';
export type StockKind = 'video' | 'image';

export interface StockItem {
  /** `<source>:<id>`, stable across searches. */
  id: string;
  source: StockSource;
  kind: StockKind;
  title: string;
  /** A small picture to show in the results. */
  thumb: string;
  /** The file to download. */
  url: string;
  /** Where it lives on the web. */
  pageUrl: string;
  width?: number;
  height?: number;
  duration?: number;
  /** Bytes, when the source says. */
  size?: number;
  /** Short licence name: CC0, Public domain, CC BY 4.0, Pexels, Pixabay... */
  license: string;
  author?: string;
  /** The line to put in the post when the licence asks for one; empty when nothing is owed. */
  credit: string;
}

export interface StockQuery {
  q: string;
  kind?: StockKind | 'any';
  sources?: StockSource[];
  limit?: number;
}

const UA = 'LocalStudio/1.0 (local video editor; https://github.com/misaalkhan/local-ai-based-video-editor)';
const TIMEOUT = 15000;

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return (await r.json()) as T;
}

const FREE_LICENCES = /^(cc0|pdm|public domain|publicdomain|cc-pd|no restrictions)/i;

/** Licences the app accepts: public domain, CC0, and the attribution licences (credit kept). Anything with NC or ND is out. */
export function acceptable(license: string): boolean {
  const l = license.toLowerCase();
  if (/\b(nc|nd)\b|non-?commercial|no ?derivatives/.test(l)) return false;
  return /cc0|public domain|pdm|cc[- ]by|creativecommons|attribution|pexels|pixabay|nasa/.test(l) || FREE_LICENCES.test(l);
}

export function creditFor(license: string, author: string | undefined, title: string, pageUrl: string): string {
  if (FREE_LICENCES.test(license) || /^(pexels|pixabay|nasa)$/i.test(license)) return '';
  return `"${title}" by ${author || 'unknown'}, ${license}, ${pageUrl}`;
}

// ---------------------------------------------------------------------------
// Wikimedia Commons

interface CommonsPage {
  title: string;
  pageid: number;
  imageinfo?: {
    url: string;
    descriptionurl: string;
    thumburl?: string;
    width: number;
    height: number;
    size: number;
    mime: string;
    duration?: number;
    extmetadata?: Record<string, { value: string }>;
  }[];
  videoinfo?: CommonsPage['imageinfo'] & { derivatives?: { src: string; type: string; width: number; height: number; transcodekey?: string }[] }[];
}

async function commons(q: string, kind: StockKind | 'any', limit: number): Promise<StockItem[]> {
  const kinds: StockKind[] = kind === 'any' ? ['video', 'image'] : [kind];
  const out: StockItem[] = [];
  for (const k of kinds) {
    const search = `${q} ${k === 'video' ? 'filetype:video' : 'filetype:bitmap'}`;
    const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${encodeURIComponent(search)}&gsrnamespace=6&gsrlimit=${Math.min(50, limit)}&prop=videoinfo&viprop=url|size|mime|extmetadata|derivatives&viurlwidth=480`;
    const data = await getJson<{ query?: { pages?: Record<string, CommonsPage> } }>(url);
    for (const page of Object.values(data.query?.pages ?? {})) {
      const info = page.videoinfo?.[0] ?? page.imageinfo?.[0];
      if (!info) continue;
      const meta = info.extmetadata ?? {};
      const license = (meta.LicenseShortName?.value || meta.License?.value || '').replace(/<[^>]+>/g, '').trim();
      if (!license || !acceptable(license)) continue;
      const isVideo = info.mime.startsWith('video/');
      if ((k === 'video') !== isVideo) continue;
      const author = (meta.Artist?.value ?? '').replace(/<[^>]+>/g, '').trim() || undefined;
      const title = page.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
      let file = info.url;
      let width = info.width;
      let height = info.height;
      let size: number | undefined = info.size;
      if (isVideo) {
        // The original when it is a reasonable size, otherwise the largest transcode up to 1080p.
        const ders = (page.videoinfo?.[0] as { derivatives?: { src: string; type: string; width: number; height: number; transcodekey?: string }[] } | undefined)?.derivatives ?? [];
        const pick = ders.filter((d) => d.transcodekey && /\.(mp4|webm|mov)$/.test(d.src) && Math.max(d.width, d.height) <= 1920).sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height) || (/\.webm$/.test(a.src) ? -1 : 1))[0];
        if (pick && (info.size > 150 * 1048576 || Math.max(info.width, info.height) > 1920)) {
          file = pick.src;
          width = pick.width;
          height = pick.height;
          size = undefined;
        }
      } else if (info.thumburl && info.width > 2000) {
        // Big photos are brought in at a size the frame can use.
        file = info.thumburl.replace(/\/480px-/, '/1920px-');
        width = 1920;
        height = Math.round((info.height * 1920) / info.width);
        size = undefined;
      }
      out.push({
        id: `commons:${page.pageid}`,
        source: 'commons',
        kind: isVideo ? 'video' : 'image',
        title,
        thumb: info.thumburl ?? info.url,
        url: file,
        pageUrl: info.descriptionurl,
        width,
        height,
        duration: info.duration,
        size,
        license,
        author,
        credit: creditFor(license, author, title, info.descriptionurl),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internet Archive

interface ArchiveDoc {
  identifier: string;
  title?: string;
  creator?: string | string[];
  licenseurl?: string;
  downloads?: number;
  mediatype: string;
}

export function archiveLicence(url: string | undefined): string {
  if (!url) return '';
  if (/publicdomain\/zero/.test(url)) return 'CC0';
  if (/publicdomain/.test(url)) return 'Public domain';
  const m = /licenses\/(by[a-z-]*)\/([\d.]+)/.exec(url);
  if (m) return `CC ${m[1].toUpperCase()} ${m[2]}`;
  return '';
}

async function archive(q: string, kind: StockKind | 'any', limit: number): Promise<StockItem[]> {
  const types = kind === 'any' ? '(mediatype:movies OR mediatype:image)' : kind === 'video' ? 'mediatype:movies' : 'mediatype:image';
  // The licence filter is loose on purpose (by-nc matches *by* too); the strict check is on the licence we read back.
  const query = `${types} AND (${q.replace(/["()]/g, ' ').trim()}) AND (licenseurl:*publicdomain* OR licenseurl:*zero* OR licenseurl:*by*)`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=licenseurl&fl[]=downloads&fl[]=mediatype&rows=${Math.min(40, limit)}&output=json`;
  const data = await getJson<{ response?: { docs: ArchiveDoc[] }; error?: string }>(url);
  if (!data.response) throw new Error(data.error ?? 'no answer');
  const docs = data.response.docs.filter((d) => acceptable(archiveLicence(d.licenseurl)));
  // Each item is a folder of files; pick the one worth downloading.
  const items = await Promise.all(
    docs.slice(0, Math.min(12, limit)).map(async (d): Promise<StockItem | null> => {
      try {
        type ArchiveFile = { name: string; format?: string; size?: string; width?: string; height?: string; length?: string };
        const meta = await getJson<{ result?: ArchiveFile[]; files?: ArchiveFile[] }>(`https://archive.org/metadata/${d.identifier}/files`);
        const files = meta.result ?? meta.files ?? [];
        const isVideo = d.mediatype === 'movies';
        const pick = isVideo
          ? files.filter((f) => /\.mp4$/i.test(f.name)).sort((a, b) => (/512kb/i.test(a.name) ? -1 : 1) - (/512kb/i.test(b.name) ? -1 : 1) || Number(a.size ?? 0) - Number(b.size ?? 0))[0] ?? files.find((f) => /\.(ogv|webm|m4v|mov)$/i.test(f.name))
          : files.filter((f) => /\.(jpe?g|png)$/i.test(f.name) && !/_thumb|__ia_thumb/i.test(f.name)).sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0))[0];
        if (!pick) return null;
        const license = archiveLicence(d.licenseurl);
        const author = Array.isArray(d.creator) ? d.creator[0] : d.creator;
        const title = d.title ?? d.identifier;
        const pageUrl = `https://archive.org/details/${d.identifier}`;
        // Lengths come as seconds or as mm:ss / h:mm:ss.
        const length = pick.length ? (pick.length.includes(':') ? pick.length.split(':').reduce((acc, x) => acc * 60 + Number(x), 0) : Number(pick.length)) : undefined;
        return {
          id: `archive:${d.identifier}`,
          source: 'archive',
          kind: isVideo ? 'video' : 'image',
          title,
          thumb: `https://archive.org/services/img/${d.identifier}`,
          url: `https://archive.org/download/${d.identifier}/${encodeURIComponent(pick.name).replace(/%2F/g, '/')}`,
          pageUrl,
          width: pick.width ? Number(pick.width) : undefined,
          height: pick.height ? Number(pick.height) : undefined,
          duration: Number.isFinite(length) ? length : undefined,
          size: pick.size ? Number(pick.size) : undefined,
          license,
          author,
          credit: creditFor(license, author, title, pageUrl),
        };
      } catch {
        return null;
      }
    }),
  );
  return items.filter((x): x is StockItem => !!x);
}

// ---------------------------------------------------------------------------
// NASA image and video library (public domain)

interface NasaItem {
  href: string;
  data: { nasa_id: string; title: string; media_type: 'image' | 'video' | 'audio'; description?: string; date_created?: string; photographer?: string; center?: string }[];
  links?: { href: string; rel: string; render?: string }[];
}

async function nasa(q: string, kind: StockKind | 'any', limit: number): Promise<StockItem[]> {
  const types = kind === 'any' ? 'image,video' : kind;
  const data = await getJson<{ collection: { items: NasaItem[] } }>(`https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}&media_type=${types}&page_size=${Math.min(50, limit)}`);
  const items = data.collection.items.slice(0, Math.min(16, limit));
  const out = await Promise.all(
    items.map(async (it): Promise<StockItem | null> => {
      const d = it.data[0];
      if (!d || (d.media_type !== 'image' && d.media_type !== 'video')) return null;
      try {
        const assets = await getJson<string[]>(it.href);
        const file = d.media_type === 'video' ? assets.find((a) => /~medium\.mp4$/i.test(a)) ?? assets.find((a) => /~small\.mp4$/i.test(a)) ?? assets.find((a) => /\.mp4$/i.test(a)) : assets.find((a) => /~large\.(jpe?g|png)$/i.test(a)) ?? assets.find((a) => /~orig\.(jpe?g|png)$/i.test(a)) ?? assets.find((a) => /\.(jpe?g|png)$/i.test(a));
        if (!file) return null;
        const pageUrl = `https://images.nasa.gov/details/${d.nasa_id}`;
        return {
          id: `nasa:${d.nasa_id}`,
          source: 'nasa',
          kind: d.media_type,
          title: d.title,
          thumb: it.links?.find((l) => l.rel === 'preview')?.href ?? file,
          url: file.replace(/^http:/, 'https:'),
          pageUrl,
          license: 'Public domain (NASA)',
          author: d.photographer || d.center || 'NASA',
          credit: '',
        };
      } catch {
        return null;
      }
    }),
  );
  return out.filter((x): x is StockItem => !!x);
}

// ---------------------------------------------------------------------------
// Openverse (CC pictures)

interface OpenverseResult {
  id: string;
  title?: string;
  url: string;
  thumbnail?: string;
  creator?: string;
  license: string;
  license_version?: string;
  foreign_landing_url?: string;
  width?: number;
  height?: number;
  filesize?: number;
}

async function openverse(q: string, limit: number): Promise<StockItem[]> {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license=cc0,pdm,by,by-sa&page_size=${Math.min(50, limit)}&mature=false`;
  const data = await getJson<{ results: OpenverseResult[] }>(url);
  return data.results.map((r) => {
    const license = r.license === 'cc0' ? 'CC0' : r.license === 'pdm' ? 'Public domain' : `CC ${r.license.toUpperCase()} ${r.license_version ?? ''}`.trim();
    const title = r.title ?? 'Untitled';
    const pageUrl = r.foreign_landing_url ?? `https://openverse.org/image/${r.id}`;
    return {
      id: `openverse:${r.id}`,
      source: 'openverse' as const,
      kind: 'image' as const,
      title,
      thumb: r.thumbnail ?? r.url,
      url: r.url,
      pageUrl,
      width: r.width,
      height: r.height,
      size: r.filesize,
      license,
      author: r.creator,
      credit: creditFor(license, r.creator, title, pageUrl),
    };
  });
}

// ---------------------------------------------------------------------------
// Pexels and Pixabay (free keys)

async function pexels(q: string, kind: StockKind | 'any', limit: number): Promise<StockItem[]> {
  const key = getSecret('pexels');
  if (!key) return [];
  const out: StockItem[] = [];
  const n = Math.min(40, limit);
  if (kind !== 'image') {
    const data = await getJson<{ videos: { id: number; url: string; image: string; duration: number; width: number; height: number; user: { name: string }; video_files: { link: string; width: number; height: number; file_type: string; quality: string }[] }[] }>(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=${n}`, { authorization: key });
    for (const v of data.videos ?? []) {
      const file = v.video_files.filter((f) => f.file_type === 'video/mp4' && Math.max(f.width, f.height) <= 1920).sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height))[0] ?? v.video_files[0];
      if (!file) continue;
      out.push({ id: `pexels:v${v.id}`, source: 'pexels', kind: 'video', title: `Pexels video ${v.id}`, thumb: v.image, url: file.link, pageUrl: v.url, width: file.width, height: file.height, duration: v.duration, license: 'Pexels', author: v.user?.name, credit: '' });
    }
  }
  if (kind !== 'video') {
    const data = await getJson<{ photos: { id: number; url: string; alt?: string; width: number; height: number; photographer: string; src: { large2x: string; large: string; medium: string } }[] }>(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${n}`, { authorization: key });
    for (const p of data.photos ?? []) out.push({ id: `pexels:p${p.id}`, source: 'pexels', kind: 'image', title: p.alt || `Pexels photo ${p.id}`, thumb: p.src.medium, url: p.src.large2x, pageUrl: p.url, width: p.width, height: p.height, license: 'Pexels', author: p.photographer, credit: '' });
  }
  return out;
}

async function pixabay(q: string, kind: StockKind | 'any', limit: number): Promise<StockItem[]> {
  const key = getSecret('pixabay');
  if (!key) return [];
  const out: StockItem[] = [];
  const n = Math.min(50, Math.max(3, limit));
  if (kind !== 'image') {
    const data = await getJson<{ hits: { id: number; pageURL: string; tags: string; duration: number; user: string; videos: Record<string, { url: string; width: number; height: number; size: number; thumbnail?: string }> }[] }>(`https://pixabay.com/api/videos/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&per_page=${n}&safesearch=true`);
    for (const v of data.hits ?? []) {
      const file = v.videos.medium ?? v.videos.small ?? v.videos.large;
      if (!file) continue;
      out.push({ id: `pixabay:v${v.id}`, source: 'pixabay', kind: 'video', title: v.tags, thumb: file.thumbnail ?? v.videos.tiny?.thumbnail ?? '', url: file.url, pageUrl: v.pageURL, width: file.width, height: file.height, duration: v.duration, size: file.size, license: 'Pixabay', author: v.user, credit: '' });
    }
  }
  if (kind !== 'video') {
    const data = await getJson<{ hits: { id: number; pageURL: string; tags: string; user: string; previewURL: string; webformatURL: string; largeImageURL: string; imageWidth: number; imageHeight: number }[] }>(`https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(q)}&image_type=photo&per_page=${n}&safesearch=true`);
    for (const p of data.hits ?? []) out.push({ id: `pixabay:p${p.id}`, source: 'pixabay', kind: 'image', title: p.tags, thumb: p.webformatURL, url: p.largeImageURL, pageUrl: p.pageURL, width: p.imageWidth, height: p.imageHeight, license: 'Pixabay', author: p.user, credit: '' });
  }
  return out;
}

// ---------------------------------------------------------------------------

export const STOCK_SOURCES: { id: StockSource; name: string; note: string; key?: string }[] = [
  { id: 'pexels', name: 'Pexels', note: 'Stock video and photos, free to use (needs a free key)', key: 'pexels' },
  { id: 'pixabay', name: 'Pixabay', note: 'Stock video and photos, free to use (needs a free key)', key: 'pixabay' },
  { id: 'commons', name: 'Wikimedia Commons', note: 'Public-domain and Creative Commons pictures and video' },
  { id: 'archive', name: 'Internet Archive', note: 'Public-domain and Creative Commons films' },
  { id: 'nasa', name: 'NASA', note: 'Space, Earth and science, public domain' },
  { id: 'openverse', name: 'Openverse', note: 'Creative Commons pictures from across the web' },
];

/** Which sources are usable now: the keyed ones only with a key. */
export function availableSources(): StockSource[] {
  return STOCK_SOURCES.filter((s) => !s.key || getSecret(s.key)).map((s) => s.id);
}

/** The results of the last searches, so a pick can refer to an item by id. */
const seen = new Map<string, StockItem>();

export async function searchStock(query: StockQuery): Promise<{ items: StockItem[]; errors: string[] }> {
  const q = query.q.trim();
  if (!q) return { items: [], errors: [] };
  const kind = query.kind ?? 'any';
  const limit = Math.max(1, Math.min(60, query.limit ?? 24));
  const wanted = (query.sources?.length ? query.sources : availableSources()).filter((s) => availableSources().includes(s));
  const errors: string[] = [];
  const per = Math.max(4, Math.ceil(limit / Math.max(1, wanted.length)) + 2);
  const runs = wanted.map(async (s): Promise<StockItem[]> => {
    try {
      if (s === 'commons') return await commons(q, kind, per);
      if (s === 'archive') return await archive(q, kind, per);
      if (s === 'nasa') return await nasa(q, kind, per);
      if (s === 'openverse') return kind === 'video' ? [] : await openverse(q, per);
      if (s === 'pexels') return await pexels(q, kind, per);
      if (s === 'pixabay') return await pixabay(q, kind, per);
      return [];
    } catch (err) {
      errors.push(`${STOCK_SOURCES.find((x) => x.id === s)?.name ?? s}: ${(err as Error).message}`);
      return [];
    }
  });
  const lists = await Promise.all(runs);
  // Interleave the sources so one does not crowd out the rest, free-to-use first within each.
  const items: StockItem[] = [];
  const queues = lists.map((l) => l.sort((a, b) => Number(!!a.credit) - Number(!!b.credit)));
  while (items.length < limit && queues.some((l) => l.length)) for (const l of queues) if (l.length && items.length < limit) items.push(l.shift()!);
  for (const it of items) seen.set(it.id, it);
  if (seen.size > 2000) {
    const keep = [...seen.entries()].slice(-800);
    seen.clear();
    for (const [k, v] of keep) seen.set(k, v);
  }
  return { items, errors };
}

export function stockItem(id: string): StockItem | undefined {
  return seen.get(id);
}

/** Largest file the app will fetch (a transcoded archive film can be bigger than this). */
const MAX_BYTES = 600 * 1024 * 1024;

function extFor(item: StockItem): string {
  const m = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(item.url);
  const ext = (m?.[1] ?? '').toLowerCase();
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv', 'jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  return item.kind === 'video' ? 'mp4' : 'jpg';
}

/** Download an item into the project and start preparing it like an upload. */
export async function addStock(p: Project, item: StockItem, onProgress?: (done: number, total?: number) => void): Promise<MediaAsset> {
  const dir = path.join(p.dir, 'stock');
  fs.mkdirSync(dir, { recursive: true });
  const safe = item.id.replace(/[^a-z0-9]+/gi, '-');
  const file = path.join(dir, `${safe}.${extFor(item)}`);
  const existing = [...p.media.values()].find((m) => m.path === file);
  if (existing) return existing;
  if (!fs.existsSync(file)) {
    const r = await fetch(item.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10 * 60 * 1000), redirect: 'follow' });
    if (!r.ok || !r.body) throw new Error(`${new URL(item.url).host} answered ${r.status}`);
    const total = Number(r.headers.get('content-length') ?? '') || item.size;
    if (total && total > MAX_BYTES) throw new Error(`"${item.title}" is ${(total / 1048576).toFixed(0)} MB, more than the ${MAX_BYTES / 1048576} MB limit.`);
    const tmp = `${file}.part`;
    let done = 0;
    const counter = new (await import('node:stream')).Transform({
      transform(chunk, _enc, cb) {
        done += chunk.length;
        if (done > MAX_BYTES) return cb(new Error(`"${item.title}" is larger than the ${MAX_BYTES / 1048576} MB limit.`));
        onProgress?.(done, total || undefined);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(r.body as never), counter, fs.createWriteStream(tmp));
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
  const name = `${item.title.slice(0, 60)}${item.kind === 'video' ? '' : ''}`.trim() || item.id;
  const asset = await importMedia(p, file, { name, managed: true, origin: 'stock' });
  const tags = [STOCK_SOURCES.find((s) => s.id === item.source)?.name ?? item.source, item.license].filter(Boolean);
  patchMedia(p, asset.id, {
    insights: { summary: `${item.kind === 'video' ? 'Stock video' : 'Stock picture'}: ${item.title}${item.author ? ` (by ${item.author})` : ''}`, tags: tags.slice(0, 6), at: Date.now() },
    credit: item.credit,
    sourceUrl: item.pageUrl,
  });
  return { ...asset, credit: item.credit, sourceUrl: item.pageUrl };
}
