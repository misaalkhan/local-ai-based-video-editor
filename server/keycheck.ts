// "Does this key work?" for the Settings dialog: one small request per
// service, with the service's own error turned into the next step (enable
// the API, fix the engine id, wait for the key to activate). The key being
// tested comes from the field, not the Keychain, so a key can be checked
// before it is saved.

export type Service = 'tenor' | 'freesound' | 'pexels' | 'pixabay' | 'google';

export interface KeyCheck {
  ok: boolean;
  message: string;
}

const KEY = /^[A-Za-z0-9_\-.:+/=]{8,512}$/;

async function probe(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const body = await r.text();
  return { status: r.status, body: body.slice(0, 2000) };
}

const googleError = (body: string): string => {
  try {
    const j = JSON.parse(body) as { error?: { message?: string; status?: string; details?: { reason?: string }[] } };
    return j.error?.message ?? j.error?.status ?? '';
  } catch {
    return '';
  }
};

/** Try the key against the service and say what to do next. */
export async function checkKey(service: Service, key: string, extra = ''): Promise<KeyCheck> {
  key = key.trim();
  extra = extra.trim();
  if (!key) return { ok: false, message: 'Paste the key first.' };
  if (!KEY.test(key)) return { ok: false, message: 'That does not look like a key: keys are letters, digits and -_.:+/= with no spaces. Copy it again without the surrounding text.' };
  try {
    switch (service) {
      case 'tenor': {
        const r = await probe(`https://tenor.googleapis.com/v2/search?q=hello&key=${encodeURIComponent(key)}&client_key=local-studio&limit=1`);
        if (r.status === 200) return { ok: true, message: 'Tenor works: GIF search is on.' };
        const why = googleError(r.body);
        if (/not been used|is disabled|not enabled/i.test(why)) return { ok: false, message: 'The key is valid, but the Tenor API is not enabled on its project yet. Open the Tenor API page in Google Cloud and press Enable, then test again (it can take a minute).' };
        if (/API key not valid|invalid/i.test(why)) return { ok: false, message: 'Google says the key is not valid. Copy it again from APIs & Services → Credentials; a brand-new key can take a minute to start working.' };
        return { ok: false, message: `Tenor answered ${r.status}${why ? `: ${why}` : ''}.` };
      }
      case 'google': {
        if (!extra) return { ok: false, message: 'Paste the search engine id (cx) as well; it comes from programmablesearchengine.google.com.' };
        const r = await probe(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(extra)}&q=sunset&searchType=image&num=1`);
        if (r.status === 200) {
          const n = (JSON.parse(r.body) as { items?: unknown[] }).items?.length ?? 0;
          return n ? { ok: true, message: 'Google image search works.' } : { ok: false, message: 'The key and engine answer, but the engine returns no pictures: in its settings turn on "Image search" and "Search the entire web".' };
        }
        const why = googleError(r.body);
        if (/not been used|is disabled|not enabled/i.test(why)) return { ok: false, message: 'The key is valid, but the Custom Search API is not enabled on its project yet. Open the Custom Search API page in Google Cloud and press Enable, then test again.' };
        if (/API key not valid|invalid/i.test(why)) return { ok: false, message: 'Google says the key is not valid. Copy it again from APIs & Services → Credentials, and check the key is not restricted to other APIs.' };
        if (/invalid argument|cx/i.test(why) || r.status === 400) return { ok: false, message: 'Google does not know that search engine id. Copy the "Search engine ID" from the engine\'s Overview page (not its name).' };
        if (r.status === 429) return { ok: false, message: 'The free 100 searches for today are used up; it resets at midnight Pacific time.' };
        return { ok: false, message: `Google answered ${r.status}${why ? `: ${why}` : ''}.` };
      }
      case 'pexels': {
        const r = await probe('https://api.pexels.com/v1/search?query=sunset&per_page=1', { authorization: key });
        if (r.status === 200) return { ok: true, message: 'Pexels works.' };
        return { ok: false, message: r.status === 401 ? 'Pexels does not accept that key. Copy it from pexels.com/api (Your API key).' : `Pexels answered ${r.status}.` };
      }
      case 'pixabay': {
        const r = await probe(`https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=sunset&per_page=3`);
        if (r.status === 200) return { ok: true, message: 'Pixabay works.' };
        return { ok: false, message: r.status === 400 || r.status === 401 ? 'Pixabay does not accept that key. It is shown at the top of pixabay.com/api/docs once you are logged in.' : `Pixabay answered ${r.status}.` };
      }
      case 'freesound': {
        const r = await probe(`https://freesound.org/apiv2/search/text/?query=pop&page_size=1&token=${encodeURIComponent(key)}`);
        if (r.status === 200) return { ok: true, message: 'Freesound works.' };
        return { ok: false, message: r.status === 401 ? 'Freesound does not accept that key. Use the "Client secret / API key" from freesound.org/apiv2/apply.' : `Freesound answered ${r.status}.` };
      }
    }
  } catch (err) {
    return { ok: false, message: `Could not reach the service: ${(err as Error).message}. Check the internet connection and try again.` };
  }
  return { ok: false, message: 'Unknown service.' };
}
