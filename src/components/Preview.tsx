import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { player } from '../engine/player.ts';
import { useElementSize, usePlayerTime, usePlaying } from '../hooks.ts';
import { fail, setUi, toast, useDerived, useDoc, useStore } from '../store.ts';
import { commit, edit, live } from '../actions.ts';
import { updateGraphic, updateZoom } from '../../shared/ops.ts';
import { clipGeometry, formatTime, framingAt, segAt, sourceAt } from '../../shared/timeline.ts';
import { api } from '../api.ts';
import { Icon } from '../icons.tsx';
import { IconButton, Menu, MenuItem } from '../ui.tsx';

const ZOOMS = [1, 1.5, 2, 3, 4];

/** Parts of a vertical frame that apps cover with their own buttons and captions (largest of Reels, TikTok and Shorts). */
const UNSAFE = { top: 220 / 1920, bottom: 480 / 1920, right: 150 / 1080 };

export function Preview() {
  const doc = useDoc()!;
  const derived = useDerived()!;
  const selection = useStore((s) => s.selection);
  const safeZones = useStore((s) => s.ui.safeZones);
  const media = useStore((s) => s.media);
  const projectId = useStore((s) => s.projectId)!;
  const pickBox = useStore((s) => s.pickBox);
  const faces = useStore((s) => s.faces);
  const stability = useStore((s) => s.stability);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [tracking, setTracking] = useState(false);
  const [stageRef, size] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const playing = usePlaying();
  const time = usePlayerTime(80);
  const [volume, setVolume] = useState(player.volume);

  /** Magnification of the picture: 1 fits it in the space, more lets you check details and place things exactly. */
  const [magnify, setMagnify] = useState(1);
  const { width: W, height: H, fps } = doc.settings;
  const scale = Math.max(0.01, Math.min((size.width - 40) / W, (size.height - 28) / H)) * magnify;
  const cssW = Math.max(60, Math.floor(W * scale));
  const cssH = Math.max(60, Math.floor(H * scale));

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    player.invalidate();
  }, [cssW, cssH]);

  useEffect(() => {
    if (canvasRef.current) player.attach(canvasRef.current);
    return () => player.detach();
  }, []);

  const graphic = selection?.kind === 'graphic' ? doc.graphics.find((g) => g.id === selection.id) : undefined;
  const zoom = selection?.kind === 'zoom' ? doc.zooms.find((z) => z.id === selection.id) : undefined;
  const handle = graphic && graphic.template !== 'progress' ? { x: graphic.x, y: graphic.y } : zoom ? { x: zoom.focusX, y: zoom.focusY } : null;

  /** A box drawn on the picture (fractions of the frame) to the same box in the main clip's source, with the clip and the moment. */
  const toSource = (b: { x: number; y: number; w: number; h: number }) => {
    const seg = segAt(derived.layout, player.time);
    if (!seg || seg.clip.kind !== 'media') return null;
    const m = media[seg.clip.mediaId];
    if (!m || m.kind !== 'video') return null;
    const clip = seg.clip;
    const sourceTime = sourceAt(clip, player.time - seg.start);
    const framing = framingAt(clip.framing, faces[m.id], sourceTime, clip.motion, player.time - seg.start);
    const strength = clip.fx?.stabilize ?? 0;
    const track = stability[m.id];
    const g = clipGeometry(m.width, m.height, W, H, framing, strength > 0 && track ? { track, t: sourceTime, strength } : undefined);
    const k = g.src.w / g.dst.w;
    const sx = (b.x * W - g.dst.x) * k + g.src.x;
    const sy = (b.y * H - g.dst.y) * k + g.src.y;
    return { media: m, sourceTime, cx: (sx + (b.w * W * k) / 2) / m.width, cy: (sy + (b.h * H * k) / 2) / m.height, w: (b.w * W * k) / m.width, h: (b.h * H * k) / m.height };
  };

  const trackBox = async (b: { x: number; y: number; w: number; h: number }) => {
    if (!pickBox) return;
    const src = toSource(b);
    if (!src) {
      toast('Put the playhead on a video clip first.');
      return;
    }
    setTracking(true);
    try {
      const tr = await api.track(projectId, src.media.id, { t: src.sourceTime, cx: src.cx, cy: src.cy, w: src.w, h: src.h });
      edit((d) => updateGraphic(d, pickBox.graphicId, { follow: { target: 'object', trackId: tr.id, anchor: 'above', offsetX: 0, offsetY: -0.03 } }), 'Follow object');
      toast(`Following "${tr.name}" for ${Math.round(tr.boxes.length * tr.interval)} s.`, 'success');
    } catch (err) {
      fail(err);
    } finally {
      setTracking(false);
      setBox(null);
      useStore.setState({ pickBox: null });
    }
  };

  // Drag on the picture to move the selected graphic, or the point a punch-in closes in on.
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (pickBox) {
      // Draw the box of the thing to follow.
      const rect = e.currentTarget.getBoundingClientRect();
      const x0 = (e.clientX - rect.left) / cssW;
      const y0 = (e.clientY - rect.top) / cssH;
      let last = { x: x0, y: y0, w: 0, h: 0 };
      const onMove = (ev: PointerEvent) => {
        const x1 = Math.min(1, Math.max(0, (ev.clientX - rect.left) / cssW));
        const y1 = Math.min(1, Math.max(0, (ev.clientY - rect.top) / cssH));
        last = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
        setBox(last);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (last.w > 0.02 && last.h > 0.02) void trackBox(last);
        else {
          setBox(null);
          toast('Drag a box around the thing to follow.');
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      return;
    }
    const start = { x: e.clientX, y: e.clientY };
    const target = graphic ? { kind: 'graphic' as const, id: graphic.id, x: graphic.x, y: graphic.y } : zoom ? { kind: 'zoom' as const, id: zoom.id, x: zoom.focusX, y: zoom.focusY } : null;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      if (!target) return;
      const x = Math.min(1.2, Math.max(-0.2, target.x + dx / cssW));
      const y = Math.min(1.2, Math.max(-0.2, target.y + dy / cssH));
      // Snap to the centre lines, which is where most things belong.
      const sx = Math.abs(x - 0.5) < 0.012 ? 0.5 : x;
      const sy = Math.abs(y - 0.5) < 0.012 ? 0.5 : y;
      if (target.kind === 'graphic') live((d) => updateGraphic(d, target.id, { x: sx, y: sy }));
      else live((d) => updateZoom(d, target.id, { focusX: Math.min(1, Math.max(0, sx)), focusY: Math.min(1, Math.max(0, sy)) }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved && target) commit('Move');
      else if (!moved) player.toggle();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Esc leaves the box-drawing mode.
  useEffect(() => {
    if (!pickBox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStore.setState({ pickBox: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickBox]);

  // Pinch or Cmd+wheel over the picture zooms it.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setMagnify((z) => Math.min(4, Math.max(1, z * Math.exp(-e.deltaY * 0.004))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [stageRef]);

  const preparing = Object.values(media).filter((m) => m.proxy === 'running' || m.proxy === 'pending');
  const vertical = H / W > 1.5;

  return (
    <section className="stage" ref={wrapRef}>
      <div className={`stage-canvas ${magnify > 1.001 ? 'zoomed' : ''}`} ref={stageRef}>
        <div className={`canvas-frame ${pickBox ? 'picking' : ''}`} style={{ width: cssW, height: cssH }} onPointerDown={onPointerDown}>
          <canvas ref={canvasRef} style={{ width: cssW, height: cssH }} />
          {safeZones && (
            <div className="safezones" aria-hidden="true">
              {vertical ? (
                <>
                  <div className="unsafe" style={{ top: 0, left: 0, right: 0, height: `${UNSAFE.top * 100}%` }} />
                  <div className="unsafe" style={{ bottom: 0, left: 0, right: 0, height: `${UNSAFE.bottom * 100}%` }} />
                  <div className="unsafe" style={{ top: `${UNSAFE.top * 100}%`, bottom: `${UNSAFE.bottom * 100}%`, right: 0, width: `${UNSAFE.right * 100}%` }} />
                </>
              ) : (
                <div className="title-safe" />
              )}
            </div>
          )}
          {handle && !pickBox && <div className="drag-handle" style={{ left: `${handle.x * 100}%`, top: `${handle.y * 100}%` }} />}
          {pickBox && !box && !tracking && <div className="stage-chip">Drag a box around the thing to follow (Esc cancels)</div>}
          {tracking && <div className="stage-chip">Following it through the footage…</div>}
          {box && <div className="pick-box" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }} />}
          {derived.duration === 0 && (
            <div className="stage-empty">
              <Icon name="media" size={24} />
              <strong>Nothing on the timeline yet</strong>
              <span>Click a clip on the left to add it, or tell the assistant what to make.</span>
            </div>
          )}
          {preparing.length > 0 && derived.duration > 0 && (
            <div className="stage-chip">
              Preparing preview{preparing[0].progress ? ` ${Math.round(preparing[0].progress * 100)}%` : '…'}
            </div>
          )}
        </div>
      </div>
      <div className="transport">
        <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Pause (space)' : 'Play (space)'} className="play-btn" size={18} onClick={() => player.toggle()} />
        <span className="timecode">
          {formatTime(time, true, fps)} <em>/ {formatTime(derived.duration, true, fps)}</em>
        </span>
        <span className="grow" />
        <Menu
          align="right"
          trigger={(_, toggle) => (
            <button type="button" className="pill-btn" onClick={toggle} title="Size of the picture in this window (pinch or ⌘ scroll over it)">
              {magnify <= 1.001 ? 'Fit' : `${Math.round(magnify * 100)}%`} <Icon name="down" size={12} />
            </button>
          )}
        >
          {(close) => (
            <>
              {ZOOMS.map((z) => (
                <MenuItem key={z} onClick={() => { close(); setMagnify(z); }}>
                  {z === 1 ? 'Fit' : `${z * 100}%`}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
        <IconButton icon="phone" label="Show the areas apps cover with their own buttons" active={safeZones} onClick={() => setUi({ safeZones: !safeZones })} />
        <div className="volume">
          <Icon name={volume === 0 ? 'mute' : 'volume'} size={15} />
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            aria-label="Preview volume"
            onChange={(e) => {
              const v = Number(e.target.value);
              setVolume(v);
              player.setVolume(v);
            }}
          />
        </div>
        <IconButton
          icon="fullscreen"
          label="Full screen"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else void wrapRef.current?.requestFullscreen();
          }}
        />
      </div>
    </section>
  );
}
