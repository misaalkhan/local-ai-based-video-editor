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
  useEffect(() => {
    api.settings().then((r) => {
      setS(r.settings);
      setExportDefault(r.exportDefault);
      setKey(r.settings.tenorKey);
      setFsKey(r.settings.freesoundKey ?? '');
    }).catch(fail);
  }, []);
  const save = () => {
    if (!s) return;
    api.saveSettings({ assistantModel: s.assistantModel, exportDir: s.exportDir, tenorKey: key, freesoundKey: fsKey })
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
          <Field label="Tenor API key" hint="turns on GIF search">
            <TextInput value={key} placeholder="paste a key to enable reaction GIFs" onChange={setKey} />
          </Field>
          <p className="hint">
            A Tenor key is free: in Google Cloud Console create a project, enable the Tenor API and make an API key. GIFs are searched only when you or the assistant ask for one.
          </p>
          <Field label="Freesound API key" hint="turns on sound search">
            <TextInput value={fsKey} placeholder="paste a key to search for more sounds" onChange={setFsKey} />
          </Field>
          <p className="hint">
            A Freesound key is free: sign in at freesound.org, open "API keys" in your account and create one. Only CC0 and CC BY sounds are shown; a CC BY sound keeps its credit line for your caption.
          </p>
        </div>
      )}
    </Modal>
  );
}
