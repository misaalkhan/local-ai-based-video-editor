import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { setSettings } from '../../shared/ops.ts';
import { player } from '../engine/player.ts';
import { useDoc, useStore } from '../store.ts';
import { addToTimeline, draggable, edit, formatDuration, importFromDisk, looksLikeMusic, runTool } from '../actions.ts';
import { Icon, Spinner } from '../icons.tsx';
import { Button, Field, Section, Select, Toggle } from '../ui.tsx';

export function MusicPanel() {
  const doc = useDoc()!;
  const media = useStore((s) => s.media);
  const [voices, setVoices] = useState<{ id: string; name: string }[]>([]);
  const [voice, setVoice] = useState('');
  const [line, setLine] = useState('');
  const [working, setWorking] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    api
      .voices()
      .then((v) => {
        setVoices(v);
        if (v[0]) setVoice(v[0].id);
      })
      .catch(() => {});
    return () => audio.current?.pause();
  }, []);

  const preview = (url: string) => {
    audio.current?.pause();
    audio.current = new Audio(url);
    audio.current.volume = 0.8;
    void audio.current.play().catch(() => {});
  };

  const music = Object.values(media).filter((m) => m.kind === 'audio' && !m.origin && looksLikeMusic(m));
  const a = doc.settings.audio;

  return (
    <div className="panel">
      <header className="panel-head">
        <h2>Music and voice</h2>
      </header>
      <div className="panel-body">
        <Section title="Music" action={<Button size="sm" icon="plus" onClick={() => void importFromDisk()}>Add</Button>}>
          {music.length === 0 ? (
            <div className="hint">Add a music file and it will play under the video, ducking automatically whenever someone speaks.</div>
          ) : (
            <div className="list">
              {music.map((m) => (
                <button key={m.id} type="button" className="list-item" onClick={() => addToTimeline(m, 'music')} {...draggable({ kind: 'media', id: m.id })}>
                  <span className="list-icon"><Icon name="music" size={15} /></span>
                  <span className="list-text">
                    <strong>{m.name}</strong>
                    <em>{formatDuration(m.duration)}</em>
                  </span>
                  <Icon name="plus" size={14} />
                </button>
              ))}
            </div>
          )}
        </Section>

        <Section title="Voiceover">
          {voices.length === 0 ? (
            <div className="hint">No text-to-speech voice is installed yet. Run <code>npm run setup</code> to add one.</div>
          ) : (
            <>
              <textarea className="input" rows={3} placeholder="Type a line to have it spoken at the playhead…" value={line} onChange={(e) => setLine(e.target.value)} />
              <div className="row">
                <Select value={voice} options={voices.map((v) => ({ value: v.id, label: v.name }))} onChange={setVoice} />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!line.trim() || working}
                  onClick={async () => {
                    setWorking(true);
                    const ok = await runTool('add_voiceover', { text: line.trim(), voice, start: player.time });
                    setWorking(false);
                    if (ok) setLine('');
                  }}
                >
                  {working ? <Spinner size={11} /> : <Icon name="mic" size={13} />} Speak
                </Button>
              </div>
            </>
          )}
        </Section>

        <Section title="Final mix">
          <Toggle checked={a.normalize} onChange={(v) => edit((d) => setSettings(d, { audio: { ...d.settings.audio, normalize: v } }), 'Loudness')} label="Bring the export to a standard loudness" />
          {a.normalize && (
            <Field label="Target">
              <Select
                value={String(a.targetLufs)}
                options={[
                  { value: '-14', label: '−14 LUFS · Reels, TikTok, YouTube' },
                  { value: '-16', label: '−16 LUFS · podcasts' },
                  { value: '-23', label: '−23 LUFS · broadcast' },
                ]}
                onChange={(v) => edit((d) => setSettings(d, { audio: { ...d.settings.audio, targetLufs: Number(v) } }), 'Loudness target')}
              />
            </Field>
          )}
          <Toggle checked={a.denoise} onChange={(v) => edit((d) => setSettings(d, { audio: { ...d.settings.audio, denoise: v } }), 'Noise reduction')} label="Reduce background noise in speech" />
          <Toggle checked={!!a.enhance} onChange={(v) => edit((d) => setSettings(d, { audio: { ...d.settings.audio, enhance: v } }), 'Voice clean-up')} label="Make the voice clearer (less rumble, more presence, steadier level)" />
          <div className="hint">These apply when you export. The preview plays the mix without them.</div>
        </Section>
      </div>
    </div>
  );
}
