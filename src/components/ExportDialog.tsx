import { useEffect, useState } from 'react';
import { ASPECTS, aspectOf } from '../../shared/types.ts';
import { api } from '../api.ts';
import { fail, setUi, toast, useDerived, useDoc, useStore } from '../store.ts';
import { player } from '../engine/player.ts';
import { formatBytes, formatDuration } from '../actions.ts';
import { Icon } from '../icons.tsx';
import { Button, Field, Modal, Segmented, Select, Toggle } from '../ui.tsx';

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
  const [allFormats, setAllFormats] = useState(false);
  const [queue, setQueue] = useState<string[]>([]);
  const [cover, setCover] = useState<string | null>(null);
  const close = () => setUi({ showExport: false });

  /** The frame at the playhead, saved as a picture next to the videos. */
  const saveCover = async () => {
    try {
      const r = await api.cover(projectId, player.time, width);
      setCover(r.path);
      toast(`Cover saved: ${r.path.replace(/^\/Users\/[^/]+/, '~')}`, 'success');
    } catch (err) {
      fail(err, 'Cover');
    }
  };

  const base = ASPECTS[aspect] ?? { width: doc.settings.width, height: doc.settings.height };
  const k = Number(size) / Math.min(base.width, base.height);
  const width = Math.round((base.width * k) / 2) * 2;
  const height = Math.round((base.height * k) / 2) * 2;
  const running = job?.status === 'running';

  const sizeFor = (a: string) => {
    const b = ASPECTS[a] ?? { width: doc.settings.width, height: doc.settings.height };
    const kk = Number(size) / Math.min(b.width, b.height);
    return { width: Math.round((b.width * kk) / 2) * 2, height: Math.round((b.height * kk) / 2) * 2 };
  };

  const start = async () => {
    setStarting(true);
    try {
      const formats = allFormats ? [aspect, ...Object.keys(ASPECTS).filter((a) => a !== aspect)] : [aspect];
      setQueue(formats.slice(1));
      useStore.setState({ exportJob: await api.startExport(projectId, { ...sizeFor(formats[0]), quality }) });
    } catch (err) {
      fail(err, 'Export');
    } finally {
      setStarting(false);
    }
  };

  // When one format is done, the next in the queue starts.
  const nextFormat = queue[0];
  const jobStatus = job?.status;
  const jobId = job?.id;
  useEffect(() => {
    if (jobStatus !== 'done' || !nextFormat) return;
    setQueue((q) => q.slice(1));
    void api
      .startExport(projectId, { ...sizeFor(nextFormat), quality })
      .then((j) => useStore.setState({ exportJob: j }))
      .catch((err) => fail(err, 'Export'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobStatus, jobId]);

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
          <strong>{nextFormat ? `Done; ${nextFormat} is next` : 'Your video is ready'}</strong>
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
          <div className="row wrap">
            <Toggle checked={allFormats} onChange={setAllFormats} label="Every format (9:16, 16:9, 1:1, 4:5), one after another" />
          </div>
          <div className="row wrap">
            <Button size="sm" icon="image" disabled={empty} onClick={() => void saveCover()}>
              Save the frame at the playhead as a picture
            </Button>
            {cover && <code className="hint" title={cover}>{cover.split('/').pop()}</code>}
          </div>
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
