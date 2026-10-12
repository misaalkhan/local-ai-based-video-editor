// The transcript as an editing surface: select words and cut them, and the
// video is cut with them. Words that are no longer in the video stay visible,
// struck through, so they can be brought back.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ID, MediaAsset, ProjectDoc, Range, TakeGroup, Word } from '../../shared/types.ts';
import type { MainSeg } from '../../shared/timeline.ts';
import * as ops from '../../shared/ops.ts';
import { findTakes } from '../../shared/takes.ts';
import { player } from '../engine/player.ts';
import { usePlayerTime, usePlaying } from '../hooks.ts';
import { useDerived, useDoc, useStore } from '../store.ts';
import { edit } from '../actions.ts';
import { Icon, Spinner } from '../icons.tsx';
import { Button, Empty, Menu, MenuItem } from '../ui.tsx';

interface TW {
  key: string;
  mediaId: ID;
  index: number;
  text: string;
  kept: boolean;
  /** Timeline position when the word is in the video. */
  time: number;
  end: number;
  unsure: boolean;
  /** Start a new paragraph before this word. */
  para: boolean;
  speaker?: number;
}

function firstAtOrAfter(words: Word[], t: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((words[mid].t0 + words[mid].t1) / 2 < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Every word of every file on the main track, in the order the video plays, with the cut ones in place. */
function buildTranscript(doc: ProjectDoc, layout: MainSeg[], words: Record<ID, Word[]>): TW[] {
  const cover: Record<ID, Range[]> = {};
  for (const seg of layout) {
    if (seg.clip.kind === 'media') (cover[seg.clip.mediaId] ??= []).push({ start: seg.clip.in, end: seg.clip.out });
  }
  const out: TW[] = [];
  let chars = 0;
  let lastKeptEnd = -1;
  const push = (mediaId: ID, i: number, w: Word, kept: boolean, time: number, end: number, forcePara: boolean) => {
    const key = `${mediaId}:${i}`;
    const text = doc.captions.edits[key] ?? w.text;
    const prev = out[out.length - 1];
    const pause = kept && lastKeptEnd >= 0 && time - lastKeptEnd > 0.9;
    const sentence = !!prev && /[.!?…]["')\]]?$/.test(prev.text) && chars > 180;
    const para = forcePara || pause || sentence;
    if (para) chars = 0;
    chars += text.length + 1;
    if (kept) lastKeptEnd = end;
    // A change of speaker starts its own paragraph, with the speaker's number shown on it.
    const turn = w.s !== undefined && prev?.speaker !== undefined && prev.speaker !== w.s && kept;
    out.push({ key, mediaId, index: i, text: text || w.text, kept, time, end, unsure: (w.p ?? 1) < 0.5, para: (para || turn) && out.length > 0, speaker: w.s });
  };
  for (const seg of layout) {
    const c = seg.clip;
    if (c.kind !== 'media') continue;
    const ws = words[c.mediaId];
    if (!ws?.length) continue;
    const spans = cover[c.mediaId];
    // Words cut from just before this clip: back to the previous surviving piece of the same file.
    let lower = 0;
    for (const r of spans) if (r.end <= c.in + 1e-6 && r.end > lower) lower = r.end;
    let first = true;
    for (let i = firstAtOrAfter(ws, lower); i < ws.length; i++) {
      const mid = (ws[i].t0 + ws[i].t1) / 2;
      if (mid >= c.in) break;
      push(c.mediaId, i, ws[i], false, -1, -1, false);
    }
    for (let i = firstAtOrAfter(ws, c.in); i < ws.length; i++) {
      const w = ws[i];
      if ((w.t0 + w.t1) / 2 >= c.out) break;
      const t = seg.start + (Math.max(w.t0, c.in) - c.in) / c.speed;
      const e = seg.start + (Math.min(w.t1, c.out) - c.in) / c.speed;
      push(c.mediaId, i, w, true, t, e, first && out.length > 0 && out[out.length - 1].mediaId !== c.mediaId);
      first = false;
    }
    // Words cut from after the last piece of this file.
    if (!spans.some((r) => r.start >= c.out - 1e-6)) {
      for (let i = firstAtOrAfter(ws, c.out); i < ws.length; i++) push(c.mediaId, i, ws[i], false, -1, -1, false);
    }
  }
  return out;
}

/** Consecutive word indices of one file, as inclusive ranges. */
function runs(items: TW[]): { mediaId: ID; from: number; to: number }[] {
  const out: { mediaId: ID; from: number; to: number }[] = [];
  for (const w of [...items].sort((a, b) => (a.mediaId === b.mediaId ? a.index - b.index : a.mediaId < b.mediaId ? -1 : 1))) {
    const last = out[out.length - 1];
    if (last && last.mediaId === w.mediaId && w.index === last.to + 1) last.to = w.index;
    else out.push({ mediaId: w.mediaId, from: w.index, to: w.index });
  }
  return out;
}

const COLLAPSE_OVER = 16;
const SENTENCE_END = /[.!?…]["')\]]?$/;

/** Lines said more than once in the files on the main track, with what was decided about them so far. */
function takeGroups(doc: ProjectDoc, words: Record<ID, Word[]>): TakeGroup[] {
  const out: TakeGroup[] = [];
  const seen = new Set<ID>();
  for (const c of doc.main) {
    if (c.kind !== 'media' || seen.has(c.mediaId)) continue;
    seen.add(c.mediaId);
    const ws = words[c.mediaId];
    if (!ws?.length) continue;
    for (const g of findTakes(c.mediaId, ws, () => '')) {
      const id = `t-${c.mediaId}-${g.takes[0].from}`;
      const saved = doc.takes.find((t) => t.mediaId === c.mediaId && t.takes[0]?.from === g.takes[0].from);
      out.push({ ...g, id: saved?.id ?? id, chosen: saved?.chosen ?? null, reason: saved?.reason });
    }
  }
  return out;
}

function Retakes({ groups, doc, words, media }: { groups: TakeGroup[]; doc: ProjectDoc; words: Record<ID, Word[]>; media: Record<ID, MediaAsset> }) {
  const [open, setOpen] = useState(false);
  if (!groups.length) return null;
  return (
    <div className="retakes">
      <button type="button" className="retakes-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="copy" size={13} />
        <span>
          {groups.length} line{groups.length > 1 ? 's were' : ' was'} said more than once
        </span>
        <Icon name={open ? 'down' : 'right'} size={12} />
      </button>
      {open &&
        groups.map((g) => {
          const ws = words[g.mediaId] ?? [];
          const m = media[g.mediaId];
          const kept = ops.wordsKept(doc, g.mediaId, ws);
          return (
            <div className="retake" key={g.id}>
              {g.takes.map((t, i) => {
                let n = 0;
                for (let k = t.from; k <= t.to; k++) if (kept[k]) n++;
                const inVideo = n > (t.to - t.from + 1) / 2;
                const only = inVideo && g.takes.every((o, j) => j === i || !kept.slice(o.from, o.to + 1).some(Boolean));
                return (
                  <div key={t.from} className={`retake-row ${inVideo ? 'in' : ''}`}>
                    <span className="retake-n">{i + 1}</span>
                    <span className="retake-text">{ws.slice(t.from, t.to + 1).map((w) => w.text).join(' ')}</span>
                    {only ? (
                      <em>Kept</em>
                    ) : (
                      <Button size="sm" disabled={!m} onClick={() => m && edit((d) => ops.chooseTake(d, g, i, ws, m), 'Choose take')} title="Keep this attempt and cut the others">
                        Keep this
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
    </div>
  );
}

export function TranscriptPanel() {
  const doc = useDoc()!;
  const derived = useDerived()!;
  const words = useStore((s) => s.words);
  const media = useStore((s) => s.media);
  const playing = usePlaying();
  const time = usePlayerTime(120);
  const list = useMemo(() => buildTranscript(doc, derived.layout, words), [doc, derived.layout, words]);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fixing, setFixing] = useState<string | null>(null);
  const [fixText, setFixText] = useState('');
  const dragging = useRef(false);
  const nowRef = useRef<HTMLSpanElement | null>(null);

  // A selection is by position, so it cannot survive the list changing under it.
  useEffect(() => setSel(null), [list.length]);

  const lo = sel ? Math.min(sel.a, sel.b) : -1;
  const hi = sel ? Math.max(sel.a, sel.b) : -1;
  const chosen = sel ? list.slice(lo, hi + 1) : [];
  const chosenKept = chosen.filter((w) => w.kept);
  const chosenCut = chosen.filter((w) => !w.kept);

  let nowIndex = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i].kept && list[i].time <= time + 0.01) nowIndex = i;
    else if (list[i].kept && list[i].time > time) break;
  }

  useEffect(() => {
    if (playing) nowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [nowIndex, playing]);

  const mediaLike = (id: ID): MediaAsset | undefined => media[id];

  const cut = () => {
    if (!chosenKept.length) return;
    const groups = runs(chosenKept);
    edit((d) => {
      let next = d;
      for (const g of groups) {
        const ws = words[g.mediaId];
        const m = mediaLike(g.mediaId);
        if (!ws || !m) continue;
        next = ops.removeSourceSpans(next, g.mediaId, [ops.wordSpan(ws, g.from, g.to, m.duration, { kept: ops.wordsKept(next, g.mediaId, ws) })]);
      }
      return ops.dropScraps(d, next, (id) => words[id]).doc;
    }, groups.length > 1 || chosenKept.length > 1 ? 'Cut words' : 'Cut word');
    setSel(null);
  };

  const restore = () => {
    if (!chosenCut.length) return;
    const groups = runs(chosenCut);
    edit((d) => {
      let next = d;
      for (const g of groups) {
        const ws = words[g.mediaId];
        const m = mediaLike(g.mediaId);
        if (!ws || !m) continue;
        next = ops.restoreSourceSpan(next, m, ops.wordRestoreSpan(ws, g.from, g.to, m.duration));
      }
      return next;
    }, 'Restore words');
    setSel(null);
  };

  // Moving: the selection travels with a little of the pause around it, so it does not land hard against its new neighbours.
  const keptList = useMemo(() => list.filter((w) => w.kept), [list]);
  const boundary = (left: TW | undefined, right: TW | undefined): number => {
    if (!left) return 0;
    if (!right) return derived.duration;
    const seam = derived.layout.find((seg) => seg.start > left.end - 1e-3 && seg.start < right.time + 1e-3);
    return seam ? seam.start : (left.end + right.time) / 2;
  };
  const move = (where: 'start' | 'earlier' | 'later') => {
    if (!chosenKept.length) return;
    const a = keptList.indexOf(chosenKept[0]);
    const b = keptList.indexOf(chosenKept[chosenKept.length - 1]);
    const start = boundary(keptList[a - 1], keptList[a]);
    const end = boundary(keptList[b], keptList[b + 1]);
    let to = 0;
    if (where === 'earlier') {
      // To the beginning of the sentence just before the selection.
      let q = a - 1;
      while (q > 0 && !SENTENCE_END.test(keptList[q - 1].text)) q--;
      if (q < 0) return;
      to = boundary(keptList[q - 1], keptList[q]);
    } else if (where === 'later') {
      // To the end of the sentence just after it.
      let q = b + 1;
      while (q < keptList.length - 1 && !SENTENCE_END.test(keptList[q].text)) q++;
      if (q >= keptList.length) return;
      to = boundary(keptList[q], keptList[q + 1]);
    }
    edit((d) => ops.moveMainRange(d, start, end, to), where === 'start' ? 'Move to the start' : 'Move');
    setSel(null);
  };
  const canMoveEarlier = chosenKept.length > 0 && keptList.indexOf(chosenKept[0]) > 0;
  const canMoveLater = chosenKept.length > 0 && keptList.indexOf(chosenKept[chosenKept.length - 1]) < keptList.length - 1;

  const groups = useMemo(() => takeGroups(doc, words), [doc, words]);

  const emphasised = new Set(doc.captions.emphasis ?? []);
  const toggleEmphasis = () => {
    const keys = chosenKept.map((w) => w.key);
    const allOn = keys.every((k) => emphasised.has(k));
    edit((d) => {
      const cur = new Set(d.captions.emphasis ?? []);
      for (const k of keys) {
        if (allOn) cur.delete(k);
        else cur.add(k);
      }
      return ops.setCaptions(d, { emphasis: [...cur] });
    }, 'Emphasis');
  };

  const startFix = () => {
    if (chosen.length !== 1) return;
    setFixing(chosen[0].key);
    setFixText(chosen[0].text);
  };
  const applyFix = () => {
    const key = fixing;
    setFixing(null);
    if (!key) return;
    const value = fixText.trim();
    edit((d) => ops.setCaptions(d, { edits: { [key]: value } }), 'Fix word');
  };

  const pending = Object.values(media).some((m) => (m.transcript === 'pending' || m.transcript === 'running') && doc.main.some((c) => c.kind === 'media' && c.mediaId === m.id));

  if (!list.length) {
    return (
      <div className="transcript">
        {pending ? (
          <div className="empty">
            <Spinner size={18} />
            <strong>Transcribing…</strong>
            <p>The words appear here as soon as they are ready.</p>
          </div>
        ) : (
          <Empty icon="transcript" title="No transcript yet">
            Put a clip with speech on the main track. You can then cut the video by deleting words here.
          </Empty>
        )}
      </div>
    );
  }

  // Group into paragraphs, and long cut stretches into a collapsible run.
  const nodes: React.ReactNode[] = [];
  let para: React.ReactNode[] = [];
  const flush = () => {
    if (para.length) nodes.push(<p key={nodes.length}>{para}</p>);
    para = [];
  };
  let i = 0;
  while (i < list.length) {
    const w = list[i];
    if (w.para) flush();
    // The first kept word of a paragraph shows who is talking, when that is known.
    if (!para.length && w.kept && w.speaker !== undefined) para.push(<span key={`s${w.key}`} className="speaker">{`Speaker ${w.speaker}`}</span>);
    if (!w.kept) {
      let j = i;
      while (j + 1 < list.length && !list[j + 1].kept && !list[j + 1].para) j++;
      const len = j - i + 1;
      const id = list[i].key;
      if (len > COLLAPSE_OVER && !expanded.has(id) && !(sel && hi >= i && lo <= j)) {
        para.push(
          <button key={`c${id}`} type="button" className="cut-run" onClick={() => setExpanded((s) => new Set(s).add(id))} title="Show the words that were cut here">
            {len} words cut
          </button>,
        );
        i = j + 1;
        continue;
      }
    }
    const idx = i;
    const selected = sel !== null && idx >= lo && idx <= hi;
    para.push(
      <span
        key={w.key}
        ref={idx === nowIndex ? nowRef : undefined}
        className={`w ${w.kept ? '' : 'cut'} ${selected ? 'sel' : ''} ${idx === nowIndex ? 'now' : ''} ${w.unsure ? 'unsure' : ''} ${emphasised.has(w.key) ? 'strong' : ''}`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragging.current = true;
          setSel(e.shiftKey && sel ? { a: sel.a, b: idx } : { a: idx, b: idx });
          if (w.kept && !e.shiftKey) player.seek(w.time);
        }}
        onPointerEnter={() => {
          if (dragging.current) setSel((s) => (s ? { a: s.a, b: idx } : s));
        }}
      >
        {fixing === w.key ? (
          <input
            className="w-input"
            autoFocus
            value={fixText}
            size={Math.max(3, fixText.length)}
            onChange={(e) => setFixText(e.target.value)}
            onBlur={applyFix}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') applyFix();
              if (e.key === 'Escape') setFixing(null);
            }}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          w.text
        )}{' '}
      </span>,
    );
    i++;
  }
  flush();

  return (
    <div
      className="transcript"
      tabIndex={0}
      onPointerUp={() => (dragging.current = false)}
      onPointerLeave={() => (dragging.current = false)}
      onKeyDown={(e) => {
        if (fixing) return;
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          e.stopPropagation();
          cut();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          setSel(null);
        }
      }}
    >
      <div className="transcript-hint">Select words and press delete to cut them from the video. Struck-through words can be brought back.</div>
      <Retakes groups={groups} doc={doc} words={words} media={media} />
      <div className="transcript-body">{nodes}</div>
      {sel && chosen.length > 0 && (
        <div className="transcript-bar">
          <span>
            {chosen.length} word{chosen.length > 1 ? 's' : ''}
          </span>
          <span className="grow" />
          {chosenKept.length > 0 && (
            <Button size="sm" icon="split" onClick={cut}>
              Cut
            </Button>
          )}
          {chosenCut.length > 0 && (
            <Button size="sm" icon="undo" onClick={restore}>
              Restore
            </Button>
          )}
          {chosenKept.length > 0 && (
            <Button size="sm" onClick={toggleEmphasis} title="Keep these words in the accent colour in captions">
              <Icon name="sparkles" size={13} /> Emphasise
            </Button>
          )}
          {chosen.length === 1 && (
            <Button size="sm" icon="edit" onClick={startFix} title="Correct how this word is written in captions">
              Fix
            </Button>
          )}
          {chosenKept.length > 0 && (canMoveEarlier || canMoveLater) && (
            <Menu
              align="right"
              up
              trigger={(_, toggle) => (
                <Button size="sm" onClick={toggle} title="Move these words to another place in the video">
                  Move <Icon name="down" size={12} />
                </Button>
              )}
            >
              {(close) => (
                <>
                  {canMoveEarlier && <MenuItem onClick={() => { close(); move('start'); }}>To the very start</MenuItem>}
                  {canMoveEarlier && <MenuItem onClick={() => { close(); move('earlier'); }}>One sentence earlier</MenuItem>}
                  {canMoveLater && <MenuItem onClick={() => { close(); move('later'); }}>One sentence later</MenuItem>}
                </>
              )}
            </Menu>
          )}
        </div>
      )}
    </div>
  );
}
