import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as RPointerEvent } from 'react';
import { player } from '../engine/player.ts';
import { useElementSize, usePlayerTime, usePlaying } from '../hooks.ts';
import { setUi, useDerived, useDoc, useStore } from '../store.ts';
import { commit, live } from '../actions.ts';
import { updateGraphic, updateZoom } from '../../shared/ops.ts';
import { formatTime } from '../../shared/timeline.ts';
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

  // Drag on the picture to move the selected graphic, or the point a punch-in closes in on.
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
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
        <div className="canvas-frame" style={{ width: cssW, height: cssH }} onPointerDown={onPointerDown}>
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
          {handle && <div className="drag-handle" style={{ left: `${handle.x * 100}%`, top: `${handle.y * 100}%` }} />}
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
