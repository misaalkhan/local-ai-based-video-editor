// App-wide settings: which Claude model the assistants use, where exports go,
// and the free keys that turn on GIF, sound, stock and image search. Each key
// has a Test button that tries the service and says what to do next, and a
// link to the page where the key comes from, so setting one up is: open the
// page, copy, paste, test, save.

import { useEffect, useState } from 'react';
import type { Settings } from '../../shared/types.ts';
import { api } from '../api.ts';
import { fail, toast } from '../store.ts';
import { Button, Field, Modal, Select, TextInput } from '../ui.tsx';

type Service = 'tenor' | 'freesound' | 'pexels' | 'pixabay' | 'serpapi' | 'google';

interface KeyDef {
  service: Service;
  label: string;
  what: string;
  placeholder: string;
  /** Where the key comes from, as links and the one-line route to it. */
  steps: { text: string; href?: string }[];
}

const KEYS: KeyDef[] = [
  {
    service: 'tenor',
    label: 'Tenor API key',
    what: 'reaction GIFs (Memes and Girlypop tabs, the assistant\'s find_gif)',
    placeholder: 'paste a key to enable reaction GIFs',
    steps: [
      { text: 'Open the Tenor API page in Google Cloud', href: 'https://console.cloud.google.com/apis/library/tenor.googleapis.com' },
      { text: 'sign in with your Google account, create a project if it asks (any name), press Enable' },
      { text: 'then open Credentials', href: 'https://console.cloud.google.com/apis/credentials' },
      { text: 'Create credentials → API key, copy the key shown, paste it here.' },
    ],
  },
  {
    service: 'serpapi',
    label: 'Google image results (SerpApi)',
    what: 'pictures by prompt from the whole web for the assistant\'s search_images; without it, Reddit posts are searched',
    placeholder: 'paste your SerpApi private key',
    steps: [
      { text: 'Sign up at serpapi.com with an email', href: 'https://serpapi.com/users/sign_up' },
      { text: '(no card; 250 searches a month are free), then copy "Your Private API Key" from', href: 'https://serpapi.com/manage-api-key' },
      { text: 'and paste it here. Google itself no longer offers whole-web search to new engines, so this is the way to Google\'s image results.' },
    ],
  },
  {
    service: 'pexels',
    label: 'Pexels API key',
    what: 'stock video and photos, free to use with no credit',
    placeholder: 'paste a key to search Pexels',
    steps: [
      { text: 'Open pexels.com/api', href: 'https://www.pexels.com/api/' },
      { text: 'press Get started, sign up with an email or Google, and the key is shown on your API page.' },
    ],
  },
  {
    service: 'pixabay',
    label: 'Pixabay API key',
    what: 'stock video and photos, free to use with no credit',
    placeholder: 'paste a key to search Pixabay',
    steps: [
      { text: 'Open pixabay.com/api/docs', href: 'https://pixabay.com/api/docs/' },
      { text: 'sign up or log in, and your key is printed near the top of that page.' },
    ],
  },
  {
    service: 'freesound',
    label: 'Freesound API key',
    what: 'more sound effects (the Sounds tab\'s online search)',
    placeholder: 'paste a key to search for more sounds',
    steps: [
      { text: 'Make an account at freesound.org, then apply for a key', href: 'https://freesound.org/apiv2/apply' },
      { text: '(any name and description) and paste the Client secret / API key.' },
    ],
  },
  {
    service: 'google',
    label: 'Google engine (advanced)',
    what: 'image search over up to 50 sites you list yourself (Google ended whole-web engines in January 2026); not needed if SerpApi is set',
    placeholder: 'paste a Custom Search API key',
    steps: [
      { text: 'Enable the Custom Search API', href: 'https://console.cloud.google.com/apis/library/customsearch.googleapis.com' },
      { text: 'on the Tenor project (the same key works), then', href: 'https://programmablesearchengine.google.com/controlpanel/create' },
      { text: 'create an engine, add the sites it may search (reddit.com, en.wikipedia.org, people.com, eonline.com, tudum.com…), turn Image search on, and copy its Search engine ID into the second box.' },
    ],
  },
];

const isMasked = (v: string) => /^•+$/.test(v);

function KeyRow({ def, value, onChange, extra, onExtra }: { def: KeyDef; value: string; onChange: (v: string) => void; extra?: string; onExtra?: (v: string) => void }) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const test = () => {
    setTesting(true);
    setResult(null);
    api
      .testKey(def.service, value, extra)
      .then(setResult)
      .catch((err: Error) => setResult({ ok: false, message: err.message }))
      .finally(() => setTesting(false));
  };
  return (
    <div className="keyrow">
      <Field label={def.label} hint={value ? (isMasked(value) ? 'set, kept in your Keychain' : 'not saved yet') : def.what}>
        <div className="row">
          <TextInput value={value} placeholder={def.placeholder} onChange={(v) => { onChange(v); setResult(null); }} />
          <Button size="sm" onClick={test} disabled={testing || !value}>
            {testing ? 'Testing…' : 'Test'}
          </Button>
        </div>
      </Field>
      {def.service === 'google' && onExtra && (
        <Field label="Google search engine id" hint={extra ? (isMasked(extra) ? 'set' : 'not saved yet') : 'the Search engine ID (cx) of your engine'}>
          <TextInput value={extra ?? ''} placeholder="paste the Search engine ID" onChange={(v) => { onExtra(v); setResult(null); }} />
        </Field>
      )}
      {result && <div className={`keyrow-result ${result.ok ? 'ok' : 'bad'}`}>{result.message}</div>}
      <p className="hint keyrow-steps">
        {def.steps.map((s, i) => (
          <span key={i}>
            {i > 0 ? ' ' : ''}
            {s.href ? (
              <a href={s.href} target="_blank" rel="noreferrer">
                {s.text}
              </a>
            ) : (
              s.text
            )}
            {i < def.steps.length - 1 && !s.text.endsWith('.') ? ',' : ''}
          </span>
        ))}
      </p>
    </div>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [exportDefault, setExportDefault] = useState('');
  const [keys, setKeys] = useState<Record<Service, string>>({ tenor: '', freesound: '', pexels: '', pixabay: '', serpapi: '', google: '' });
  const [googleCx, setGoogleCx] = useState('');
  useEffect(() => {
    api
      .settings()
      .then((r) => {
        setS(r.settings);
        setExportDefault(r.exportDefault);
        setKeys({ tenor: r.settings.tenorKey, freesound: r.settings.freesoundKey ?? '', pexels: r.settings.pexelsKey ?? '', pixabay: r.settings.pixabayKey ?? '', serpapi: r.settings.serpapiKey ?? '', google: r.settings.googleKey ?? '' });
        setGoogleCx(r.settings.googleCx ?? '');
      })
      .catch(fail);
  }, []);
  const save = () => {
    if (!s) return;
    api
      .saveSettings({ assistantModel: s.assistantModel, exportDir: s.exportDir, tenorKey: keys.tenor, freesoundKey: keys.freesound, pexelsKey: keys.pexels, pixabayKey: keys.pixabay, serpapiKey: keys.serpapi, googleKey: keys.google, googleCx })
      .then(() => {
        toast('Settings saved.', 'success');
        onClose();
      })
      .catch(fail);
  };
  const setKey = (service: Service) => (v: string) => setKeys((k) => ({ ...k, [service]: v }));
  return (
    <Modal title="Settings" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={!s}>Save</Button></>}>
      {s && (
        <div className="settings-form">
          <Field label="Assistant model" hint="for editing and planning">
            <Select
              value={s.assistantModel}
              options={[
                { value: 'sonnet', label: 'Sonnet: fast, good for most edits' },
                { value: 'opus', label: 'Opus: best judgement, uses more of your plan' },
                { value: 'haiku', label: 'Haiku: cheapest, simpler edits' },
              ]}
              onChange={(v) => setS({ ...s, assistantModel: v as Settings['assistantModel'] })}
            />
          </Field>
          <Field label="Export folder" hint={`empty = ${exportDefault}`}>
            <TextInput value={s.exportDir} placeholder={exportDefault} onChange={(v) => setS({ ...s, exportDir: v })} />
          </Field>
          <h3 className="settings-heading">Free keys (optional)</h3>
          <p className="hint">
            Everything on your Mac works without a key. These turn on searches of outside services; each is free and takes a few minutes: open the link, copy the key, paste it, press Test, then Save. Clear a field to remove its key. Keys are saved in your Mac's Keychain (item "Local Studio"), never in a file, and never sent back to the browser.
          </p>
          {KEYS.map((def) => (
            <KeyRow key={def.service} def={def} value={keys[def.service]} onChange={setKey(def.service)} extra={def.service === 'google' ? googleCx : undefined} onExtra={def.service === 'google' ? setGoogleCx : undefined} />
          ))}
        </div>
      )}
    </Modal>
  );
}
