// App-wide settings: which Claude model the assistants use, where exports go,
// and the key that turns GIF search on.

import { useEffect, useState } from 'react';
import type { Settings } from '../../shared/types.ts';
import { api } from '../api.ts';
import { fail, toast } from '../store.ts';
import { Button, Field, Modal, Select, TextInput } from '../ui.tsx';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [exportDefault, setExportDefault] = useState('');
  const [key, setKey] = useState('');
  const [fsKey, setFsKey] = useState('');
  const [pexels, setPexels] = useState('');
  const [pixabay, setPixabay] = useState('');
  useEffect(() => {
    api.settings().then((r) => {
      setS(r.settings);
      setExportDefault(r.exportDefault);
      setKey(r.settings.tenorKey);
      setFsKey(r.settings.freesoundKey ?? '');
      setPexels(r.settings.pexelsKey ?? '');
      setPixabay(r.settings.pixabayKey ?? '');
    }).catch(fail);
  }, []);
  const save = () => {
    if (!s) return;
    api.saveSettings({ assistantModel: s.assistantModel, exportDir: s.exportDir, tenorKey: key, freesoundKey: fsKey, pexelsKey: pexels, pixabayKey: pixabay })
      .then(() => {
        toast('Settings saved.', 'success');
        onClose();
      })
      .catch(fail);
  };
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
          <Field label="Tenor API key" hint={key && /^•+$/.test(key) ? 'set, kept in your Keychain' : 'turns on GIF search'}>
            <TextInput value={key} placeholder="paste a key to enable reaction GIFs" onChange={setKey} />
          </Field>
          <p className="hint">
            A Tenor key is free: in Google Cloud Console create a project, enable the Tenor API and make an API key (the README has the steps). GIFs are searched only when you or the assistant ask for one. Clear the field to remove the key.
          </p>
          <Field label="Freesound API key" hint={fsKey && /^•+$/.test(fsKey) ? 'set, kept in your Keychain' : 'turns on sound search'}>
            <TextInput value={fsKey} placeholder="paste a key to search for more sounds" onChange={setFsKey} />
          </Field>
          <p className="hint">
            A Freesound key is free: sign in at freesound.org, open "API keys" in your account and create one. Only CC0 and CC BY sounds are shown; a CC BY sound keeps its credit line for your caption.
          </p>
          <Field label="Pexels API key" hint={pexels && /^•+$/.test(pexels) ? 'set, kept in your Keychain' : 'stock video and photos'}>
            <TextInput value={pexels} placeholder="paste a key to search Pexels" onChange={setPexels} />
          </Field>
          <Field label="Pixabay API key" hint={pixabay && /^•+$/.test(pixabay) ? 'set, kept in your Keychain' : 'stock video and photos'}>
            <TextInput value={pixabay} placeholder="paste a key to search Pixabay" onChange={setPixabay} />
          </Field>
          <p className="hint">
            Pexels and Pixabay keys are free and instant: sign up at pexels.com/api and pixabay.com/api/docs, copy the key. Their footage is free to use in your videos with no credit. Find footage also searches Wikimedia Commons, Openverse, the Internet Archive and NASA without any key.
          </p>
          <p className="hint">Keys are saved in your Mac's Keychain (item "Local Studio"), never in a file, and never sent back to the browser. Everything else in Settings is a plain preference.</p>
        </div>
      )}
    </Modal>
  );
}
