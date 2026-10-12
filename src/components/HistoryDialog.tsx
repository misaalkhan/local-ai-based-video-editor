import { useState } from 'react';
import { api } from '../api.ts';
import { fail, setUi, toast, useStore } from '../store.ts';
import { formatDuration } from '../actions.ts';
import { Icon } from '../icons.tsx';
import { Button, Modal } from '../ui.tsx';

const when = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function HistoryDialog() {
  const projectId = useStore((s) => s.projectId)!;
  const snapshots = useStore((s) => s.snapshots);
  const history = useStore((s) => s.history);
  const [name, setName] = useState('');
  const [tab, setTab] = useState<'versions' | 'log'>('versions');
  const close = () => setUi({ showHistory: false });
  const save = () =>
    api
      .saveSnapshot(projectId, name)
      .then(() => {
        setName('');
        toast('Version saved', 'success');
      })
      .catch(fail);
  const list = [...snapshots].sort((a, b) => b.ts - a.ts);

  return (
    <Modal title="Version history" onClose={close} width={520}>
      <div className="tabs inline">
        <button type="button" className={tab === 'versions' ? 'on' : ''} onClick={() => setTab('versions')}>Versions</button>
        <button type="button" className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Edit log</button>
      </div>
      {tab === 'versions' ? (
        <>
          <div className="row">
            <input className="input" placeholder="Name this version, e.g. Before music" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
            <Button variant="primary" onClick={save}>Save version</Button>
          </div>
          {list.length === 0 ? (
            <div className="hint">Save a version before trying something risky. A version is also kept automatically before each request to the assistant.</div>
          ) : (
            <ul className="versions">
              {list.map((s) => (
                <li key={s.id}>
                  <Icon name={s.auto ? 'sparkles' : 'history'} size={14} />
                  <span className="grow">
                    <strong>{s.name}</strong>
                    <em>{when(s.ts)} · {formatDuration(s.duration)}</em>
                  </span>
                  <Button size="sm" onClick={() => api.restoreSnapshot(projectId, s.id).then(() => { toast('Restored. Undo brings back what you had.', 'success'); close(); }).catch(fail)}>Restore</Button>
                  {!s.auto && <Button size="sm" variant="ghost" icon="trash" onClick={() => api.deleteSnapshot(projectId, s.id).catch(fail)} aria-label="Delete version" />}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : history.length === 0 ? (
        <div className="hint">Edits made by the assistant and by clean-up tools are listed here with the reason for each.</div>
      ) : (
        <ul className="log">
          {[...history].reverse().map((h) => (
            <li key={h.id}>
              <span className={`log-by ${h.by}`}>{h.by === 'agent' ? 'Assistant' : 'You'}</span>
              <span className="grow">
                <strong>{h.op.replace(/_/g, ' ')}</strong>
                <em>{h.explain}</em>
              </span>
              <time>{when(h.ts)}</time>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
