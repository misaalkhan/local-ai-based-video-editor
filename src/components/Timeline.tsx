// The multi-track timeline. Rows are laid out from the document: graphics on
// top, then captions, b-roll, punch-ins, the main track and audio. Items that
// overlap within a group get rows of their own, so nothing is ever hidden.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as RDragEvent, PointerEvent as RPointerEvent, ReactNode } from 'react';
import type { ID, MediaAsset, ProjectDoc, Selection, SelectionKind, SourceClip } from '../../shared/types.ts';
import { clamp, formatTime, isRemapped, layoutMain, localAt, snap, sourceAt, srcDuration } from '../../shared/timeline.ts';
import * as ops from '../../shared/ops.ts';
import { displayWord } from '../../shared/captions.ts';
import { player } from '../engine/player.ts';
import { getBeats, getPeaks, getStrip, onAssetLoaded } from '../engine/assets.ts';
import { usePlayerFrame, usePlayerTime, usePlaying } from '../hooks.ts';
import { agentBusy, commitDraft, select, setDraft, setUi, useDerived, useDoc, useStore } from '../store.ts';
import { currentDrag, deleteSelection, dropOnTimeline, dropRow, duplicateSelection, edit, mediaDur, runTool, splitAtPlayhead } from '../actions.ts';
import { Icon } from '../icons.tsx';
import type { IconName } from '../icons.tsx';
import { IconButton, Menu, MenuItem } from '../ui.tsx';

const LABEL_W = 96;
const RULER_H = 24;
const MIN_PPS = 4;
const MAX_PPS = 400;
const HEIGHTS = { graphic: 26, caption: 22, overlay: 42, zoom: 20, main: 62, audio: 34, music: 34 };

type RowKind = keyof typeof HEIGHTS;

interface Item {
  kind: SelectionKind | 'caption';
  id: string;
  start: number;
  end: number;
  label: string;
  tone: string;
  mediaId?: ID;
  inT?: number;
  speed?: number;
  volume?: number;
  muted?: boolean;
  color?: string;
  transition?: boolean;
  /** Keyframe times, seconds after the item starts. */
  keys?: number[];
  /** The clip itself when its time runs unevenly or backwards (a speed ramp, reverse). */
  clip?: SourceClip;
  badge?: string;
  /** Beat times of a music clip, seconds after it starts. */
  beats?: number[];
  /** A main clip with another after it: its cut can be rolled. */
  roll?: boolean;
}

/** Timeline positions (seconds after the item starts) of the beats inside a music clip. */
function beatTimes(a: ProjectDoc['audio'][number]): number[] | undefined {
  const { projectId, media } = useStore.getState();
  const m = projectId ? media[a.mediaId] : undefined;
  const b = m && projectId ? getBeats(projectId, m) : null;
  if (!b || !b.times.length) return undefined;
  const len = srcDuration(a);
  return b.times.filter((t) => t >= a.in && t <= a.out).map((t) => localAt(a, t)).filter((t) => t >= 0 && t <= len);
}

/** Timeline positions of a clip's speed-ramp points. */
function rampKeys(c: SourceClip): number[] {
  return (c.ramp ?? []).map((k) => localAt(c, k.t)).filter((t) => t >= 0 && t <= srcDuration(c));
}

/** What a clip with uneven or backward time shows in its label, and the clip for drawing its strip. */
function remap(c: SourceClip): Pick<Item, 'clip' | 'badge'> {
  if (!isRemapped(c)) return {};
  const parts = [c.reverse ? 'reverse' : '', c.ramp?.length ? 'ramp' : c.speed !== 1 ? `${c.speed.toFixed(2).replace(/0$/, '')}×` : ''].filter(Boolean);
  return { clip: c, badge: parts.join(' ') };
}

interface Row {
  key: string;
  kind: RowKind;
  label: string;
  icon: IconName;
  items: Item[];
}

/** Spread items over as few rows as possible without overlaps. */
function pack(items: Item[]): Item[][] {
  const rows: Item[][] = [];
  for (const it of [...items].sort((a, b) => a.start - b.start)) {
    const row = rows.find((r) => r[r.length - 1].end <= it.start + 1e-6);
    if (row) row.push(it);
    else rows.push([it]);
  }
  return rows.length ? rows : [[]];
}

function graphicLabel(g: ProjectDoc['graphics'][number]): string {
  if (g.name) return g.name;
  const p = g.props as Record<string, unknown>;
  const text = p.text ?? p.title ?? p.emoji ?? g.template;
  return String(text).replace(/\s+/g, ' ').slice(0, 60);
}

function buildRows(doc: ProjectDoc, d: NonNullable<ReturnType<typeof useDerived>>, media: Record<ID, MediaAsset>): Row[] {
  const rows: Row[] = [];
  const name = (id: ID, fallback?: string) => fallback || media[id]?.name || 'Missing file';

  const graphics = pack(
    doc.graphics.map((g) => ({ kind: 'graphic' as const, id: g.id, start: g.start, end: g.start + g.duration, label: graphicLabel(g), tone: g.template === 'text' ? 'text' : 'graphic', keys: g.keyframes?.map((k) => k.t) })),
  );
  graphics.reverse().forEach((items, i, all) => rows.push({ key: `g${i}`, kind: 'graphic', label: all.length > 1 ? `Graphic ${all.length - i}` : 'Graphic', icon: 'layers', items }));

  rows.push({
    key: 'cc',
    kind: 'caption',
    label: 'Captions',
    icon: 'captions',
    items: doc.captions.enabled
      ? d.cards.map((c) => ({ kind: 'caption' as const, id: c.id, start: c.start, end: c.end, label: c.words.map((w) => displayWord(w.text, doc.captions)).join(' '), tone: 'caption' }))
      : [],
  });

  const overlays = pack(
    doc.overlays.map((o) => ({
      kind: 'overlay' as const, id: o.id, start: o.start, end: o.start + srcDuration(o), label: name(o.mediaId, o.name), tone: 'overlay',
      keys: [...(o.keyframes ?? []).map((k) => k.t), ...(o.motion ?? []).map((k) => k.t), ...rampKeys(o)],
      mediaId: o.mediaId, inT: o.in, speed: o.speed, volume: o.volume, muted: o.muted, ...remap(o),
    })),
  );
  overlays.reverse().forEach((items, i, all) => rows.push({ key: `o${i}`, kind: 'overlay', label: all.length > 1 ? `B-roll ${all.length - i}` : 'B-roll', icon: 'image', items }));

  rows.push({
    key: 'z',
    kind: 'zoom',
    label: 'Zoom',
    icon: 'target',
    items: doc.zooms.map((z) => ({ kind: 'zoom' as const, id: z.id, start: z.start, end: z.start + z.duration, label: `${z.scale.toFixed(2)}×${z.toScale ? `→${z.toScale.toFixed(2)}×` : ''}`, tone: 'zoom' })),
  });

  rows.push({
    key: 'main',
    kind: 'main',
    label: 'Main',
    icon: 'media',
    items: d.layout.map((seg) =>
      seg.clip.kind === 'color'
        ? { kind: 'main' as const, id: seg.clip.id, start: seg.start, end: seg.end, label: seg.clip.name ?? 'Colour card', tone: 'card', color: seg.clip.color, transition: !!seg.clip.transition && seg.index > 0, roll: seg.index < d.layout.length - 1 }
        : {
            kind: 'main' as const, id: seg.clip.id, start: seg.start, end: seg.end, label: name(seg.clip.mediaId, seg.clip.name), tone: 'main',
            mediaId: seg.clip.mediaId, inT: seg.clip.in, speed: seg.clip.speed, volume: seg.clip.volume, muted: seg.clip.muted, ...remap(seg.clip),
            transition: !!seg.clip.transition && seg.index > 0,
            keys: [...(seg.clip.motion ?? []).map((k) => k.t), ...rampKeys(seg.clip)],
            roll: seg.index < d.layout.length - 1,
          },
    ),
  });

  const audioItem = (a: ProjectDoc['audio'][number]): Item => ({
    kind: 'audio', id: a.id, start: a.start, end: Math.min(a.start + srcDuration(a), a.role === 'music' ? Math.max(d.duration, a.start + 0.5) : Infinity),
    label: name(a.mediaId, a.name), tone: a.role, mediaId: a.mediaId, inT: a.in, speed: a.speed, volume: a.volume, muted: a.muted, ...remap(a),
    keys: a.volumeKeys?.map((k) => k.t),
    beats: a.role === 'music' ? beatTimes(a) : undefined,
  });
  pack(doc.audio.filter((a) => a.role !== 'music').map(audioItem)).forEach((items, i) => rows.push({ key: `a${i}`, kind: 'audio', label: `Audio ${i + 1}`, icon: 'mic', items }));
  pack(doc.audio.filter((a) => a.role === 'music').map(audioItem)).forEach((items, i, all) => rows.push({ key: `m${i}`, kind: 'music', label: all.length > 1 ? `Music ${i + 1}` : 'Music', icon: 'music', items }));
  return rows;
}

interface View {
  left: number;
  width: number;
}

/** Filmstrip and/or waveform for a clip, drawn only for the part that is on screen. */
function ClipArt({ projectId, media, item, x, width, height, pps, view, mode }: {
  projectId: ID; media: MediaAsset; item: Item; x: number; width: number; height: number; pps: number; view: View; mode: 'film' | 'wave';
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => onAssetLoaded(() => setTick((n) => n + 1)), []);
  const margin = 300;
  const a = Math.max(0, Math.floor((view.left - margin - x) / 100) * 100);
  const b = Math.min(width, Math.ceil((view.left + view.width + margin - x) / 100) * 100);
  const w = Math.max(0, b - a);
  const inT = item.inT ?? 0;
  const speed = item.speed ?? 1;
  const gain = item.muted ? 0 : Math.min(1.4, item.volume ?? 1);
  const remapped = item.clip;
  /** Source time under a point of the item, seconds after its start. */
  const srcAt = (local: number) => (remapped ? sourceAt(remapped, local) : inT + local * speed);

  useEffect(() => {
    const c = ref.current;
    if (!c || w <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(w * dpr);
    c.height = Math.round(height * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    const strip = mode === 'film' && media.strip ? getStrip(projectId, media) : null;
    if (strip && media.strip) {
      const s = media.strip;
      const slot = s.tileW * (height / s.tileH);
      for (let px = Math.floor(a / slot) * slot; px < b; px += slot) {
        const t = srcAt((px + slot / 2) / pps);
        const idx = clamp(Math.floor(t / s.interval), 0, s.count - 1);
        ctx.drawImage(strip, idx * s.tileW, 0, s.tileW, s.tileH, px - a, 0, slot + 0.5, height);
      }
    }
    const pk = media.hasAudio ? getPeaks(projectId, media) : null;
    if (pk) {
      const film = mode === 'film';
      const band = film ? Math.min(18, height * 0.3) : height - 8;
      if (film) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, height - band - 2, w, band + 2);
      }
      ctx.fillStyle = film ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.72)';
      for (let px = 0; px < w; px++) {
        const [t0, t1] = [srcAt((a + px) / pps), srcAt((a + px + 1) / pps)].sort((u, v) => u - v);
        const i0 = Math.max(0, Math.floor(t0 * 100));
        const i1 = Math.min(pk.data.length, Math.max(i0 + 1, Math.ceil(t1 * 100)));
        let m = 0;
        for (let i = i0; i < i1; i++) if (pk.data[i] > m) m = pk.data[i];
        const h = Math.max(film ? 0 : 1, Math.min(1, (m / pk.max) * gain) * band);
        if (film) ctx.fillRect(px, height - h, 1, h);
        else ctx.fillRect(px, (height - h) / 2, 1, h);
      }
    }
  }, [a, w, height, pps, inT, speed, gain, media, mode, projectId, tick, b, remapped]);

  if (w <= 0) return null;
  return <canvas ref={ref} className="clip-art" style={{ left: a, width: w, height }} />;
}

function Ruler({ pps, view, duration, fps }: { pps: number; view: View; duration: number; fps: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || view.width <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(view.width * dpr);
    c.height = Math.round(RULER_H * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, RULER_H);
    const steps = [1 / fps, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => s * pps >= 72) ?? 600;
    const minor = major / (major >= 1 ? 5 : 2);
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const t0 = Math.floor(view.left / pps / minor) * minor;
    const t1 = (view.left + view.width) / pps;
    for (let t = t0; t <= t1 + minor; t += minor) {
      const px = t * pps - view.left;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.fillStyle = t > duration + 1e-6 ? 'rgba(255,255,255,0.12)' : isMajor ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.18)';
      ctx.fillRect(Math.round(px), isMajor ? RULER_H - 9 : RULER_H - 5, 1, isMajor ? 9 : 5);
      if (isMajor) {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        const tt = Math.round(t * 1000) / 1000;
        const label = major < 1 ? `${formatTime(tt)}.${String(Math.round((tt % 1) * 100)).padStart(2, '0')}` : formatTime(tt);
        ctx.fillText(label, px + 4, 4);
      }
    }
  }, [pps, view.left, view.width, duration, fps]);
  return <canvas ref={ref} className="tl-ruler-canvas" style={{ left: view.left, width: view.width, height: RULER_H }} />;
}

export function Timeline() {
  const doc = useDoc()!;
  const derived = useDerived()!;
  const media = useStore((s) => s.media);
  const projectId = useStore((s) => s.projectId)!;
  const selection = useStore((s) => s.selection);
  const ui = useStore((s) => s.ui);
  const busy = useStore(agentBusy);
  const playing = usePlaying();
  const time = usePlayerTime(100);
  const pps = ui.pxPerSec;
  const fps = doc.settings.fps;

  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ left: 0, width: 800 });
  const [height, setHeight] = useState(300);
  const pendingScroll = useRef<number | null>(null);
  /** Where something dragged from a side panel would land. */
  const [drop, setDrop] = useState<{ time: number; row: string } | null>(null);

  const [assetTick, setAssetTick] = useState(0);
  useEffect(() => onAssetLoaded(() => setAssetTick((n) => n + 1)), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => buildRows(doc, derived, media), [doc, derived, media, assetTick]);
  const total = Math.max(derived.duration + 8, (view.width - LABEL_W) / pps);
  const contentW = total * pps;

  // ---- viewport tracking

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setView((v) => {
      const next = { left: el.scrollLeft, width: el.clientWidth };
      return Math.abs(next.left - v.left) < 1 && next.width === v.width ? v : next;
    });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const setPps = (next: number, anchorPx?: number) => {
    const el = scrollRef.current;
    const value = clamp(next, MIN_PPS, MAX_PPS);
    if (el) {
      const x = anchorPx ?? (el.clientWidth - LABEL_W) / 2;
      const t = (el.scrollLeft + x) / pps;
      pendingScroll.current = t * value - x;
    }
    setUi({ pxPerSec: value });
  };

  useLayoutEffect(() => {
    if (pendingScroll.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = Math.max(0, pendingScroll.current);
      pendingScroll.current = null;
    }
  }, [pps]);

  // Pinch or Cmd+wheel zooms around the pointer.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cur = useStore.getState().ui.pxPerSec;
      const value = clamp(cur * Math.exp(-e.deltaY * 0.0045), MIN_PPS, MAX_PPS);
      const x = e.clientX - rect.left - LABEL_W;
      const t = (el.scrollLeft + x) / cur;
      pendingScroll.current = t * value - x;
      setUi({ pxPerSec: value });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const fit = () => {
    const el = scrollRef.current;
    if (!el || derived.duration <= 0) return;
    pendingScroll.current = 0;
    setUi({ pxPerSec: clamp((el.clientWidth - LABEL_W - 24) / derived.duration, MIN_PPS, MAX_PPS) });
  };

  // Fit once when a project with content first appears.
  const fitted = useRef(false);
  useEffect(() => {
    if (!fitted.current && derived.duration > 0 && view.width > 200) {
      fitted.current = true;
      fit();
    }
  }, [derived.duration, view.width]);

  // ---- playhead (moved without re-rendering React)

  usePlayerFrame(() => {
    const el = playheadRef.current;
    if (el) el.style.transform = `translateX(${LABEL_W + player.time * useStore.getState().ui.pxPerSec}px)`;
    const sc = scrollRef.current;
    if (sc && player.playing) {
      const x = player.time * useStore.getState().ui.pxPerSec;
      const right = sc.scrollLeft + sc.clientWidth - LABEL_W;
      if (x > right - 40 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 80);
    }
  });
  useLayoutEffect(() => {
    if (playheadRef.current) playheadRef.current.style.transform = `translateX(${LABEL_W + player.time * pps}px)`;
  }, [pps]);

  // ---- pointer interactions

  const timeAt = (clientX: number): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - LABEL_W + el.scrollLeft) / pps);
  };

  const scrub = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    select(null);
    const wasPlaying = player.playing;
    player.pause();
    player.seek(snap(Math.min(timeAt(e.clientX), derived.duration), fps));
    const onMove = (ev: PointerEvent) => player.seek(snap(Math.min(timeAt(ev.clientX), derived.duration), fps));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (wasPlaying) player.play();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /** Drag the cut between two main clips: one gives what the other takes, nothing else moves. */
  const startRoll = (e: RPointerEvent, item: Item) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const state = useStore.getState();
    const origin = state.doc;
    if (!origin || agentBusy(state)) return;
    const index = layoutMain(origin).findIndex((s) => s.clip.id === item.id);
    if (index < 0 || index >= origin.main.length - 1) return;
    const x0 = e.clientX;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      setDraft(ops.rollCut(origin, index, (ev.clientX - x0) / pps, mediaDur));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) commitDraft('Roll the cut');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const startDrag = (e: RPointerEvent, item: Item, mode: 'move' | 'start' | 'end') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (item.kind === 'caption') {
      player.seek(item.start);
      setUi({ right: 'transcript' });
      return;
    }
    const sel = { kind: item.kind, id: item.id } as NonNullable<Selection>;
    select(sel);
    const state = useStore.getState();
    const origin = state.doc;
    if (!origin || agentBusy(state)) return;
    const kind = item.kind;
    const x0 = e.clientX;
    const grabOffset = timeAt(e.clientX) - item.start;
    const dur = item.end - item.start;
    const md = item.mediaId ? mediaDur(item.mediaId) : undefined;
    // Things an edge can snap to: the playhead, the start, markers, and every other edge.
    const points: number[] = [0, player.time, ...(origin.markers ?? []).map((m) => m.t)];
    for (const s of layoutMain(origin)) if (s.clip.id !== item.id) points.push(s.start, s.end);
    for (const o of origin.overlays) if (o.id !== item.id) points.push(o.start, o.start + srcDuration(o));
    for (const a of origin.audio) {
      if (a.id === item.id) continue;
      points.push(a.start, a.start + srcDuration(a));
      // The beats of the music, so cuts and effects can land on them.
      if (a.role === 'music') for (const t of beatTimes(a) ?? []) points.push(a.start + t);
    }
    for (const g of origin.graphics) if (g.id !== item.id) points.push(g.start, g.start + g.duration);
    for (const z of origin.zooms) if (z.id !== item.id) points.push(z.start, z.start + z.duration);
    const near = (t: number): number | null => {
      if (!useStore.getState().ui.snap) return null;
      let best: number | null = null;
      for (const p of points) if (Math.abs(p - t) * pps <= 7 && (best === null || Math.abs(p - t) < Math.abs(best - t))) best = p;
      return best;
    };
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      const dt = (ev.clientX - x0) / pps;
      let next: ProjectDoc;
      if (kind === 'main') {
        if (mode === 'move') {
          // Reorder: count the other clips whose middle lies left of the pointer.
          const t = timeAt(ev.clientX);
          const others = layoutMain(origin).filter((s) => s.clip.id !== item.id);
          let index = 0;
          let acc = 0;
          for (const s of others) {
            const len = s.end - s.start;
            if (t > acc + len / 2) index++;
            acc += len;
          }
          next = ops.moveMain(origin, item.id, index);
        } else {
          const edge = mode === 'start' ? item.start + dt : item.end + dt;
          next = ops.trimMain(origin, item.id, mode, near(edge) ?? edge, md);
        }
      } else if (mode === 'move') {
        let start = timeAt(ev.clientX) - grabOffset;
        const s1 = near(start);
        const s2 = near(start + dur);
        if (s1 !== null) start = s1;
        else if (s2 !== null) start = s2 - dur;
        next = ops.moveTimed(origin, kind, item.id, Math.max(0, start));
      } else {
        const edge = mode === 'start' ? item.start + dt : item.end + dt;
        next = ops.trimTimed(origin, kind, item.id, mode, near(edge) ?? edge, md);
      }
      setDraft(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) commitDraft(mode === 'move' ? (kind === 'main' ? 'Reorder' : 'Move') : 'Trim');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const hoveredRow = (e: RDragEvent): string | null => (e.target as HTMLElement).closest<HTMLElement>('.tl-row')?.dataset.kind ?? null;

  const onDragOver = (e: RDragEvent) => {
    const p = currentDrag();
    if (!p || busy) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const row = dropRow(p, hoveredRow(e));
    const time = snap(timeAt(e.clientX), fps);
    setDrop((d) => (d && d.row === row && Math.abs(d.time - time) < 1e-6 ? d : { time, row }));
  };

  const onDrop = (e: RDragEvent) => {
    const p = currentDrag();
    setDrop(null);
    if (!p) return;
    e.preventDefault();
    dropOnTimeline(p, timeAt(e.clientX), hoveredRow(e));
  };

  const resizeStart = (e: RPointerEvent) => {
    const y0 = e.clientY;
    const h0 = height;
    const onMove = (ev: PointerEvent) => setHeight(clamp(h0 + (y0 - ev.clientY), 160, Math.round(window.innerHeight * 0.65)));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const canSplit = derived.duration > 0;
  const hasSel = !!selection && selection.kind !== 'caption';

  const renderItem = (row: Row, item: Item): ReactNode => {
    const x = item.start * pps;
    const w = Math.max(2, (item.end - item.start) * pps);
    // Skip items that are far off screen.
    if (x + w < view.left - 400 || x > view.left + view.width + 400) return null;
    const m = item.mediaId ? media[item.mediaId] : undefined;
    const h = HEIGHTS[row.kind] - 4;
    const selected = selection?.id === item.id && selection.kind === item.kind;
    const art = !!m && m.kind !== 'image' && (row.kind === 'main' || row.kind === 'overlay' || row.kind === 'audio' || row.kind === 'music');
    return (
      <div
        key={item.id}
        className={`tl-item tone-${item.tone} ${selected ? 'selected' : ''} ${item.muted ? 'muted' : ''} ${w < (art ? 64 : 26) ? 'tiny' : ''}`}
        style={{ left: x, width: w, height: h, background: item.color }}
        onPointerDown={(e) => startDrag(e, item, 'move')}
        title={`${item.label}  ·  ${formatTime(item.end - item.start, true, fps)}`}
      >
        {art && m && (
          <ClipArt projectId={projectId} media={m} item={item} x={x + LABEL_W} width={w} height={h} pps={pps} view={view} mode={m.kind === 'video' ? 'film' : 'wave'} />
        )}
        {item.transition && <span className="tl-transition" title="Transition"><Icon name="transition" size={11} /></span>}
        {item.keys?.map((t, i) => (
          <span key={i} className="tl-key" style={{ left: Math.min(w - 4, Math.max(2, t * pps)) }} title={`Keyframe at ${t.toFixed(2)} s`} />
        ))}
        {pps >= 24 && item.beats?.map((t, i) => <span key={`b${i}`} className="tl-beat" style={{ left: t * pps }} />)}
        <span className="tl-item-label">
          {item.muted && <Icon name="mute" size={11} />}
          {item.badge ? <b>{item.badge}</b> : item.speed !== undefined && item.speed !== 1 && <b>{item.speed.toFixed(2).replace(/0$/, '')}×</b>}
          {item.label}
        </span>
        {item.kind !== 'caption' && w > 14 && (
          <>
            <span className="tl-handle l" onPointerDown={(e) => startDrag(e, item, 'start')} />
            <span className="tl-handle r" onPointerDown={(e) => startDrag(e, item, 'end')} />
          </>
        )}
      </div>
    );
  };

  return (
    <section className="timeline" style={{ height }} aria-label="Timeline">
      <div className="tl-resize" onPointerDown={resizeStart} />
      <div className="tl-toolbar">
        <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Pause (space)' : 'Play (space)'} onClick={() => player.toggle()} />
        <span className="timecode small">
          {formatTime(time, true, fps)} <em>/ {formatTime(derived.duration, true, fps)}</em>
        </span>
        <span className="tl-sep" />
        <IconButton icon="split" label="Split at the playhead (S)" disabled={!canSplit || busy} onClick={splitAtPlayhead} />
        <IconButton icon="copy" label="Duplicate (⌘D)" disabled={!hasSel || busy} onClick={duplicateSelection} />
        <IconButton icon="trash" label="Delete (⌫)" disabled={!hasSel || busy} onClick={deleteSelection} />
        <span className="tl-sep" />
        <IconButton icon="ripple" label={ui.ripple ? 'Ripple delete is on: deleting a main clip closes the gap' : 'Ripple delete is off'} active={ui.ripple} onClick={() => setUi({ ripple: !ui.ripple })} />
        <IconButton icon="magnet" label={ui.snap ? 'Snapping is on' : 'Snapping is off'} active={ui.snap} onClick={() => setUi({ snap: !ui.snap })} />
        <span className="tl-sep" />
        <Menu
          trigger={(_, toggle) => (
            <button type="button" className="pill-btn" onClick={toggle} disabled={busy || !doc.main.length}>
              <Icon name="sparkles" size={13} /> Clean up <Icon name="down" size={12} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon="wave" onClick={() => { close(); void runTool('remove_silences', {}); }}>Remove silences</MenuItem>
              <MenuItem icon="mic" onClick={() => { close(); void runTool('remove_fillers', { aggressiveness: 0 }); }}>Remove “um” and “uh”</MenuItem>
              <MenuItem icon="mic" onClick={() => { close(); void runTool('remove_fillers', { aggressiveness: 1 }); }}>Remove fillers and stumbles</MenuItem>
              <MenuItem icon="captions" onClick={() => { close(); void runTool('set_captions', { enabled: true }); setUi({ left: 'captions' }); }}>Add captions</MenuItem>
              <MenuItem icon="music" onClick={() => { close(); void runTool('cut_to_beat', {}); }} hint="needs music">Cut clips to the beat</MenuItem>
            </>
          )}
        </Menu>
        <span className="grow" />
        <IconButton icon="zoomOut" label="Zoom out (−)" onClick={() => setPps(pps / 1.4)} />
        <input
          className="tl-zoom"
          type="range"
          min={Math.log(MIN_PPS)}
          max={Math.log(MAX_PPS)}
          step={0.01}
          value={Math.log(pps)}
          aria-label="Timeline zoom"
          onChange={(e) => setPps(Math.exp(Number(e.target.value)))}
        />
        <IconButton icon="zoomIn" label="Zoom in (+)" onClick={() => setPps(pps * 1.4)} />
        <button type="button" className="pill-btn" onClick={fit} title="Fit the whole video in view">Fit</button>
      </div>

      <div
        className={`tl-scroll ${busy ? 'locked' : ''}`}
        ref={scrollRef}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null);
        }}
      >
        <div className="tl-grid" style={{ width: LABEL_W + contentW }}>
          <div className="tl-ruler" style={{ height: RULER_H }}>
            <div className="tl-corner" style={{ width: LABEL_W }} />
            <div className="tl-ruler-lane" style={{ width: contentW }} onPointerDown={scrub}>
              <Ruler pps={pps} view={{ left: view.left, width: Math.max(0, view.width - LABEL_W) }} duration={derived.duration} fps={fps} />
              {(doc.markers ?? []).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="tl-marker"
                  style={{ left: m.t * pps, background: m.color ?? '#ffd166' }}
                  title={`${m.label || 'Marker'} at ${formatTime(m.t, true, fps)}. Click to go there, shift-click to remove.`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    if (e.shiftKey) edit((d) => ops.removeMarker(d, m.id), 'Remove marker');
                    else player.seek(m.t);
                  }}
                >
                  {m.label && pps > 12 ? <span>{m.label}</span> : null}
                </button>
              ))}
            </div>
          </div>
          {rows.map((row) => (
            <div key={row.key} data-kind={row.kind} className={`tl-row tl-row-${row.kind} ${drop && drop.row === row.kind ? 'drop' : ''}`} style={{ height: HEIGHTS[row.kind] }}>
              <div className="tl-label" style={{ width: LABEL_W }}>
                <Icon name={row.icon} size={13} />
                <span>{row.label}</span>
                {row.kind === 'caption' && (
                  <button
                    type="button"
                    className={`tl-eye ${doc.captions.enabled ? 'on' : ''}`}
                    title={doc.captions.enabled ? 'Hide captions' : 'Show captions'}
                    onClick={() => edit((d) => ops.setCaptions(d, { enabled: !d.captions.enabled }), 'Toggle captions')}
                  >
                    <Icon name="eye" size={12} />
                  </button>
                )}
              </div>
              <div className="tl-lane" style={{ width: contentW }} onPointerDown={scrub}>
                {row.items.map((it) => renderItem(row, it))}
                {row.kind === 'main' &&
                  row.items
                    .filter((it) => it.roll && it.end - it.start > 14 / pps)
                    .map((it) => <span key={`roll-${it.id}`} className="tl-roll" style={{ left: it.end * pps }} title="Drag to roll the cut: this clip gives what the next one takes" onPointerDown={(e) => startRoll(e, it)} />)}
                {row.kind === 'main' && !row.items.length && <span className="tl-hint">Add a clip to start the main track</span>}
                {row.kind === 'caption' && !doc.captions.enabled && <span className="tl-hint">Captions are off</span>}
              </div>
            </div>
          ))}
          <div className="tl-end" style={{ left: LABEL_W + derived.duration * pps }} />
          {drop && <div className="tl-drop" style={{ left: LABEL_W + drop.time * pps }} />}
          <div className="tl-playhead" ref={playheadRef}>
            <span />
          </div>
        </div>
      </div>
      {busy && <div className="tl-busy"><Icon name="sparkles" size={13} /> The assistant is editing…</div>}
    </section>
  );
}
