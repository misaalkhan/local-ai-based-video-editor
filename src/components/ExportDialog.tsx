import { useState } from 'react';
import { ASPECTS, aspectOf } from '../../shared/types.ts';
import { api } from '../api.ts';
import { fail, setUi, useDerived, useDoc, useStore } from '../store.ts';
import { formatBytes, formatDuration } from '../actions.ts';
import { Icon } from '../icons.tsx';
import { Button, Field, Modal, Segmented, Select } from '../ui.tsx';

type Quality = 'high' | 'standard' | 'small';

export function ExportDialog() {
  const doc = useDoc()!;
  const derived = useDerived()!;
  const projectId = useStore((s) => s.projectId)!;
  const job = useStore((s) => s.exportJob);
  const status = useStore((s) => s.status);
  const [aspect, setAspect] = useState(aspectOf(doc.settings));
  const [size, setSize] = useState('1080');
  const [quality, setQuality] = useState<Quality>('high');
  const [starting, setStarting] = useState(false);
  const close = () => setUi({ showExport: false });

  const base = ASPECTS[aspect] ?? { width: doc.settings.width, height: doc.settings.height };
  const k = Number(size) / Math.min(base.width, base.height);
  const width = Math.round((base.width * k) / 2) * 2;
  const height = Math.round((base.height * k) / 2) * 2;
  const running = job?.status === 'running';

  const start = async () => {
    setStarting(true);
    try {
      useStore.setState({ exportJob: await api.startExport(projectId, { width, height, quality }) });
    } catch (err) {
      fail(err, 'Export');
    } finally {
      setStarting(false);
    }
  };

  const empty = derived.duration <= 0;

  return (
    <Modal
      title="Export video"
      onClose={close}
      footer={
        running ? (
          <Button onClick={() => job && api.cancelExport(projectId, job.id).catch(fail)}>Cancel export</Button>
        ) : job?.status === 'done' ? (
          <>
            <Button onClick={() => useStore.setState({ exportJob: null })}>Export another</Button>
            <Button variant="primary" icon="folder" onClick={() => job.path && api.reveal(job.path).catch(fail)}>
              Show in Finder
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close}>Close</Button>
            <Button variant="primary" icon="download" disabled={empty || starting} onClick={start}>
              Export
            </Button>
          </>
        )
      }
    >
      {running && job ? (
        <div className="export-progress">
          <strong>{job.stage}</strong>
          <div className="bar">
            <i style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
          <span>{Math.round(job.progress * 100)}% · {job.width}×{job.height}</span>
        </div>
      ) : job?.status === 'done' ? (
        <div className="export-done">
          <span className="export-check">
            <Icon name="check" size={20} />
          </span>
          <strong>Your video is ready</strong>
          <code title={job.path}>{job.path}</code>
          <span>
            {job.width}×{job.height} · {formatDuration(job.duration ?? 0)}
            {job.size ? ` · ${formatBytes(job.size)}` : ''}
          </span>
          <video src={`/api/projects/${projectId}/export/${job.id}/file`} controls playsInline />
        </div>
      ) : (
        <>
          {job?.status === 'error' && <div className="notice error"><Icon name="alert" size={15} /><div>{job.error ?? 'The export failed.'}</div></div>}
          {job?.status === 'cancelled' && <div className="hint">The last export was cancelled.</div>}
          {empty && <div className="hint">There is nothing on the timeline to export yet.</div>}
          <Field label="Format">
            <Segmented value={aspect} options={Object.keys(ASPECTS).map((a) => ({ value: a, label: a }))} onChange={setAspect} />
          </Field>
          {aspect !== aspectOf(doc.settings) && (
            <div className="hint">This exports a {aspect} version without changing the project. Clips are re-cropped around the same focus point; check that text still sits where you want it.</div>
          )}
          <Field label="Resolution">
            <Select
              value={size}
              options={[
                { value: '720', label: '720p' },
                { value: '1080', label: '1080p (recommended)' },
                { value: '1440', label: '1440p' },
                { value: '2160', label: '4K' },
              ]}
              onChange={setSize}
            />
          </Field>
          <Field label="Quality">
            <Segmented value={quality} options={[{ value: 'high', label: 'High' }, { value: 'standard', label: 'Standard' }, { value: 'small', label: 'Small file' }]} onChange={setQuality} />
          </Field>
          <div className="kv">
            <span>Output</span>
            <b>{width}×{height} · {doc.settings.fps} fps · MP4 (H.264)</b>
            <span>Length</span>
            <b>{formatDuration(derived.duration)}</b>
            <span>Saved to</span>
            <b title={status?.exportDir}>{status?.exportDir.replace(/^\/Users\/[^/]+/, '~') ?? 'Documents/Local Studio'}</b>
          </div>
        </>
      )}
    </Modal>
  );
}
