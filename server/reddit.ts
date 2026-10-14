// What people are saying on Reddit, for scripts and commentary. Reddit's own
// site refuses requests from scripts, so threads and comments are read from
// the PullPush archive of Reddit (api.pullpush.io), which mirrors public posts
// and comments and answers plain requests. The digest keeps scores and dates
// so the assistant can tell a big thread from a stray one, and quotes short
// excerpts only: the words belong to the people who wrote them.

const BASE = 'https://api.pullpush.io/reddit/search';
const UA = 'LocalStudio/1.0 (local video editor; https://github.com/misaalkhan/local-ai-based-video-editor)';

interface Submission {
  id: string;
  title: string;
  subreddit: string;
  score: number;
  num_comments: number;
  created_utc: number;
  permalink?: string;
  selftext?: string;
  url?: string;
  author?: string;
  over_18?: boolean;
}

interface Comment {
  id: string;
  body: string;
  score: number;
  author?: string;
  created_utc: number;
}

export interface RedditThread {
  id: string;
  title: string;
  subreddit: string;
  score: number;
  comments: number;
  date: string;
  url: string;
  text: string;
  top: { score: number; text: string; author?: string }[];
  /** The archive's record of the post, for the pictures it carries (image posts, galleries, videos). */
  raw?: Record<string, unknown>;
}

export interface RedditQuery {
  query: string;
  subreddit?: string;
  /** Threads to return, 1-12. */
  limit?: number;
  /** Top comments per thread, 0-25. */
  comments?: number;
  /** Only threads newer than this many days. */
  days?: number;
  /** Only threads with at least this score. */
  minScore?: number;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Reddit archive answered ${r.status}`);
  return (await r.json()) as T;
}

const clean = (s: string, max: number) => {
  const t = s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const date = (utc: number) => new Date(utc * 1000).toISOString().slice(0, 10);

/** Threads matching the words, biggest first, each with its top comments. */
export async function searchReddit(q: RedditQuery): Promise<RedditThread[]> {
  const query = q.query.trim();
  if (!query) return [];
  const limit = Math.max(1, Math.min(12, q.limit ?? 6));
  const perThread = Math.max(0, Math.min(25, q.comments ?? 8));
  const params = new URLSearchParams({ size: String(Math.min(100, limit * 4)), sort_type: 'score', sort: 'desc' });
  if (q.subreddit) params.set('subreddit', q.subreddit.replace(/^r\//, ''));
  if (q.days) params.set('after', String(Math.floor(Date.now() / 1000 - q.days * 86400)));
  if (q.minScore) params.set('score', `>${Math.max(0, q.minScore - 1)}`);
  // Title matches are the good ones; the body search fills in when titles come up short.
  const byTitle = await getJson<{ data: Submission[] }>(`${BASE}/submission/?${params}&title=${encodeURIComponent(query)}`);
  let subs = byTitle.data ?? [];
  if (subs.length < limit) {
    const byText = await getJson<{ data: Submission[] }>(`${BASE}/submission/?${params}&q=${encodeURIComponent(query)}`);
    const have = new Set(subs.map((s) => s.id));
    subs = [...subs, ...(byText.data ?? []).filter((s) => !have.has(s.id))];
  }
  subs = subs.filter((s) => !s.over_18 && s.title).sort((a, b) => b.score - a.score || b.num_comments - a.num_comments).slice(0, limit);
  const threads = await Promise.all(
    subs.map(async (s): Promise<RedditThread> => {
      let top: { score: number; text: string }[] = [];
      if (perThread > 0 && s.num_comments > 0) {
        try {
          const c = await getJson<{ data: Comment[] }>(`${BASE}/comment/?link_id=${s.id}&size=${perThread}&sort_type=score&sort=desc`);
          top = (c.data ?? [])
            .filter((x) => x.body && x.body !== '[removed]' && x.body !== '[deleted]')
            .map((x) => ({ score: x.score, text: clean(x.body, 280), author: x.author && x.author !== '[deleted]' ? x.author : undefined }));
        } catch {
          // A thread without comments is still worth listing.
        }
      }
      return {
        id: s.id,
        title: clean(s.title, 200),
        subreddit: s.subreddit,
        score: s.score,
        comments: s.num_comments,
        date: date(s.created_utc),
        url: s.permalink ? `https://www.reddit.com${s.permalink}` : `https://www.reddit.com/comments/${s.id}`,
        text: clean(s.selftext ?? '', 400),
        top,
      };
    }),
  );
  return threads;
}

/** The threads as text for the assistant. */
export function describeThreads(threads: RedditThread[]): string {
  if (!threads.length) return 'No threads found. Try fewer or different words, or name the subreddit.';
  return threads
    .map((t, i) => {
      const author = typeof t.raw?.author === 'string' && t.raw.author !== '[deleted]' ? ` · by u/${t.raw.author}` : '';
      const head = `${i + 1}. r/${t.subreddit} · ${t.date} · ${t.score} points · ${t.comments} comments${author}\n   "${t.title}"\n   ${t.url}`;
      const body = t.text ? `\n   Post: ${t.text}` : '';
      const comments = t.top.length ? `\n   Top comments (score, u/name):\n${t.top.map((c) => `   - (${c.score}${c.author ? `, u/${c.author}` : ''}) ${c.text}`).join('\n')}` : '';
      return head + body + comments;
    })
    .join('\n\n');
}

/** One thread by its id (from a reddit.com/…/comments/<id>/… link), with its top comments. */
export async function readThread(id: string, comments = 12): Promise<RedditThread | null> {
  const r = await getJson<{ data: Submission[] }>(`${BASE}/submission/?ids=${encodeURIComponent(id)}`);
  const s = (r.data ?? []).find((x) => x.id === id) ?? r.data?.[0];
  if (!s) return null;
  let top: { score: number; text: string }[] = [];
  const perThread = Math.max(0, Math.min(50, comments));
  if (perThread > 0 && s.num_comments > 0) {
    try {
      const c = await getJson<{ data: Comment[] }>(`${BASE}/comment/?link_id=${s.id}&size=${perThread}&sort_type=score&sort=desc`);
      top = (c.data ?? []).filter((x) => x.body && x.body !== '[removed]' && x.body !== '[deleted]').map((x) => ({ score: x.score, text: clean(x.body, 400), author: x.author && x.author !== '[deleted]' ? x.author : undefined }));
    } catch {
      // The post alone is still worth reading.
    }
  }
  return {
    id: s.id,
    title: clean(s.title, 300),
    subreddit: s.subreddit,
    score: s.score,
    comments: s.num_comments,
    date: date(s.created_utc),
    url: s.permalink ? `https://www.reddit.com${s.permalink}` : `https://www.reddit.com/comments/${s.id}`,
    text: clean(s.selftext ?? '', 3000),
    top,
    raw: s as unknown as Record<string, unknown>,
  };
}

/** The biggest threads of a subreddit over the last `days` days. */
export async function topOfSubreddit(subreddit: string, days = 30, limit = 10): Promise<RedditThread[]> {
  const params = new URLSearchParams({ subreddit: subreddit.replace(/^r\//, ''), size: String(Math.min(50, limit * 2)), sort_type: 'score', sort: 'desc', after: String(Math.floor(Date.now() / 1000 - days * 86400)) });
  const r = await getJson<{ data: Submission[] }>(`${BASE}/submission/?${params}`);
  return (r.data ?? [])
    .filter((s) => !s.over_18 && s.title)
    .sort((a, b) => b.score - a.score || b.num_comments - a.num_comments)
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      title: clean(s.title, 200),
      subreddit: s.subreddit,
      score: s.score,
      comments: s.num_comments,
      date: date(s.created_utc),
      url: s.permalink ? `https://www.reddit.com${s.permalink}` : `https://www.reddit.com/comments/${s.id}`,
      text: clean(s.selftext ?? '', 300),
      top: [],
    }));
}
