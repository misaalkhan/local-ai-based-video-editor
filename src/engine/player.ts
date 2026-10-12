// Real-time preview. Plays the proxies through ordinary <video>/<audio>
// elements kept in step with a clock, and paints every frame through the same
// renderFrame() the exporter uses.
//
// The main track uses two video elements. While one plays the current clip the
// other is already parked on the first frame of the next, so a jump cut is a
// swap rather than a seek.

import { parseCube } from '../../shared/color.ts';
import type { Lut3D } from '../../shared/color.ts';
import type { FaceTrack, ID, MediaAsset, ProjectDoc, SourceClip } from '../../shared/types.ts';
import { renderFrame } from '../../shared/draw.ts';
import type { FrameProvider, LayerImage } from '../../shared/draw.ts';
import type { Ctx2D, DrawableImage } from '../../shared/graphics.ts';
import { clamp, clipGainAt, segAt, srcDuration, transitionLength } from '../../shared/timeline.ts';
import type { MainSeg, VisualRef } from '../../shared/timeline.ts';
import type { Derived } from '../store.ts';

export interface PlayerData {
  projectId: ID;
  doc: ProjectDoc;
  media: Record<ID, MediaAsset>;
  faces: Record<ID, FaceTrack>;
  derived: Derived;
}

interface Slot {
  el: HTMLVideoElement | HTMLAudioElement;
  gain: GainNode | null;
  /** `${mediaId}:${proxy state}` of the loaded source. */
  src: string | null;
  clipId: ID | null;
  /** A seek that could not be issued yet. */
  target: number | null;
  /** Holding the last frame of this clip for a transition. */
  frozen: boolean;
}

const LOOKAHEAD = 1.2;

export class Player {
  time = 0;
  playing = false;
  private data: PlayerData | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private listeners = new Set<() => void>();
  private raf = 0;
  private lastWall = 0;
  private dirty = true;
  private lastDraw = 0;
  private stallSince = 0;
  private audioCtx: AudioContext | null = null;
  private master: GainNode | null = null;
  private main: Slot[] = [];
  private active = 0;
  private overlays = new Map<ID, Slot>();
  private audios = new Map<ID, Slot>();
  private spare: { video: Slot[]; audio: Slot[] } = { video: [], audio: [] };
  private images = new Map<string, HTMLImageElement>();
  private scratch = new Map<string, { canvas: HTMLCanvasElement; ctx: Ctx2D }>();
  volume = 1;
  private editing: ID | null = null;

  // ---- public API

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  get duration(): number {
    return this.data?.derived.duration ?? 0;
  }

  setData(data: PlayerData | null): void {
    this.data = data;
    if (!data) {
      this.pause();
      return;
    }
    if (this.time > this.duration) this.time = this.duration;
    this.dirty = true;
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.dirty = true;
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  detach(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas = null;
    this.ctx = null;
    this.pause();
  }

  /** Stop everything and drop the media elements (when leaving a project). */
  dispose(): void {
    this.detach();
    for (const s of [...this.main, ...this.overlays.values(), ...this.audios.values(), ...this.spare.video, ...this.spare.audio]) {
      s.el.pause();
      s.el.removeAttribute('src');
      s.el.load();
    }
    this.main = [];
    this.overlays.clear();
    this.audios.clear();
    this.spare = { video: [], audio: [] };
    this.images.clear();
    this.data = null;
    this.time = 0;
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** The graphic being edited, if any. */
  setEditing(id: ID | null): void {
    if (id === this.editing) return;
    this.editing = id;
    this.dirty = true;
  }

  play(): void {
    if (!this.data || this.duration <= 0) return;
    if (this.time >= this.duration - 0.02) this.time = 0;
    void this.ensureAudio()?.resume();
    this.playing = true;
    this.lastWall = performance.now();
    this.stallSince = 0;
    this.notify();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    for (const s of [...this.main, ...this.overlays.values(), ...this.audios.values()]) s.el.pause();
    this.dirty = true;
    this.notify();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number): void {
    this.time = clamp(t, 0, Math.max(0, this.duration));
    this.dirty = true;
    this.lastWall = performance.now();
    this.notify();
  }

  /** Step by whole frames while paused. */
  step(frames: number): void {
    const fps = this.data?.doc.settings.fps ?? 30;
    this.pause();
    this.seek(Math.round(this.time * fps + frames) / fps);
  }

  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.volume;
  }

  // ---- audio plumbing

  private ensureAudio(): AudioContext | null {
    if (this.audioCtx) return this.audioCtx;
    try {
      this.audioCtx = new AudioContext({ latencyHint: 'interactive' });
      this.master = this.audioCtx.createGain();
      this.master.gain.value = this.volume;
      // A gentle limiter so stacked clips do not clip harshly while previewing.
      const limiter = this.audioCtx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 3;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      this.master.connect(limiter);
      limiter.connect(this.audioCtx.destination);
    } catch {
      this.audioCtx = null;
    }
    return this.audioCtx;
  }

  private makeSlot(kind: 'video' | 'audio'): Slot {
    const el = document.createElement(kind);
    el.preload = 'auto';
    if (el instanceof HTMLVideoElement) {
      el.playsInline = true;
      el.disablePictureInPicture = true;
    }
    const slot: Slot = { el, gain: null, src: null, clipId: null, target: null, frozen: false };
    const ac = this.ensureAudio();
    if (ac && this.master) {
      try {
        const node = ac.createMediaElementSource(el);
        slot.gain = ac.createGain();
        slot.gain.gain.value = 0;
        node.connect(slot.gain);
        slot.gain.connect(this.master);
      } catch {
        slot.gain = null;
      }
    }
    const flush = () => {
      if (slot.target !== null && !el.seeking && el.readyState >= 1) {
        const t = slot.target;
        slot.target = null;
        el.currentTime = t;
      }
      this.dirty = true;
    };
    el.addEventListener('seeked', flush);
    el.addEventListener('loadedmetadata', flush);
    el.addEventListener('loadeddata', () => (this.dirty = true));
    return slot;
  }

  private setGain(slot: Slot, value: number): void {
    const v = Math.max(0, value);
    if (slot.gain && this.audioCtx) slot.gain.gain.setTargetAtTime(v, this.audioCtx.currentTime, 0.012);
    else slot.el.volume = Math.min(1, v);
  }

  private load(slot: Slot, media: MediaAsset): void {
    const key = `${media.id}:${media.proxy}`;
    if (slot.src === key || !this.data) return;
    slot.src = key;
    slot.target = null;
    slot.el.src = `/api/projects/${this.data.projectId}/media/${media.id}/proxy?r=${media.proxy}`;
  }

  private seekTo(slot: Slot, t: number): void {
    const el = slot.el;
    const fps = this.data?.doc.settings.fps ?? 30;
    if (el.seeking || el.readyState < 1) {
      slot.target = t;
      return;
    }
    if (Math.abs(el.currentTime - t) < 0.4 / fps) return;
    slot.target = null;
    el.currentTime = t;
  }

  private quiet(slot: Slot): void {
    if (!slot.el.paused) slot.el.pause();
    this.setGain(slot, 0);
    slot.clipId = null;
    slot.frozen = false;
  }

  /** Park a slot, paused, on a given frame of a clip. */
  private park(slot: Slot, clip: SourceClip, media: MediaAsset, sourceTime: number, frozen = false): void {
    this.load(slot, media);
    if (!slot.el.paused) slot.el.pause();
    this.setGain(slot, 0);
    slot.clipId = clip.id;
    slot.frozen = frozen;
    this.seekTo(slot, sourceTime);
  }

  /** Keep a slot showing (and sounding) the right moment of its clip. */
  private drive(slot: Slot, clip: SourceClip, expected: number, gain: number): void {
    const el = slot.el;
    slot.frozen = false;
    if (this.playing) {
      if (el.paused) {
        if (Math.abs(el.currentTime - expected) > 0.08) this.seekTo(slot, expected);
        if (!el.seeking && slot.target === null && el.readyState >= 2) {
          el.playbackRate = clip.speed;
          void el.play().catch(() => {});
        }
      } else {
        const drift = el.currentTime - expected;
        if (Math.abs(drift) > 0.3) this.seekTo(slot, expected);
        else el.playbackRate = clip.speed * (Math.abs(drift) > 0.045 ? (drift > 0 ? 0.96 : 1.04) : 1);
      }
    } else {
      if (!el.paused) el.pause();
      this.seekTo(slot, expected);
    }
    this.setGain(slot, gain);
  }

  // ---- keeping elements in step with the timeline

  private isVideo(mediaId: ID): MediaAsset | null {
    const m = this.data?.media[mediaId];
    return m && m.kind === 'video' ? m : null;
  }

  private syncMain(layout: MainSeg[], t: number): void {
    if (!this.data) return;
    if (!this.main.length) this.main = [this.makeSlot('video'), this.makeSlot('video')];
    const seg = segAt(layout, t);
    let a = this.main[this.active];
    let b = this.main[1 - this.active];
    const media = seg && seg.clip.kind === 'media' ? this.isVideo(seg.clip.mediaId) : null;

    if (seg && seg.clip.kind === 'media' && media) {
      const clip = seg.clip;
      const expected = clip.in + (t - seg.start) * clip.speed;
      if (a.clipId !== clip.id || a.frozen) {
        const prev = layout[seg.index - 1];
        const continues =
          prev &&
          prev.clip.kind === 'media' &&
          a.clipId === prev.clip.id &&
          !a.frozen &&
          prev.clip.mediaId === clip.mediaId &&
          prev.clip.speed === clip.speed &&
          Math.abs(prev.clip.out - clip.in) < 0.02;
        if (continues) a.clipId = clip.id;
        else if (b.clipId === clip.id && !b.frozen) {
          // The standby is already parked on this clip: swap.
          this.quiet(a);
          this.active = 1 - this.active;
          [a, b] = [b, a];
        } else {
          this.load(a, media);
          a.clipId = clip.id;
          a.frozen = false;
          this.seekTo(a, expected);
        }
      }
      this.drive(a, clip, expected, clipGainAt(clip, seg.start, t));
    } else if (a.clipId) this.quiet(a);

    // The other element either holds the outgoing frame of a transition or
    // gets ready for whatever video comes next.
    const inTransition = seg && seg.index > 0 && t < seg.start + transitionLength(layout, seg.index);
    if (inTransition && seg) {
      const from = layout[seg.index - 1];
      const fm = from.clip.kind === 'media' ? this.isVideo(from.clip.mediaId) : null;
      if (from.clip.kind === 'media' && fm) {
        const last = Math.max(from.clip.in, from.clip.out - from.clip.speed / this.data.doc.settings.fps);
        if (b.clipId !== from.clip.id || !b.frozen) this.park(b, from.clip, fm, last, true);
      }
      return;
    }
    const startIndex = seg ? seg.index + 1 : layout.findIndex((s) => s.start >= t);
    if (startIndex < 0) return;
    for (let i = startIndex; i < layout.length && i < startIndex + 3; i++) {
      const next = layout[i];
      if (next.clip.kind !== 'media') continue;
      const nm = this.isVideo(next.clip.mediaId);
      if (!nm) continue;
      const cur = seg?.clip;
      const contiguous =
        i === startIndex &&
        cur &&
        cur.kind === 'media' &&
        cur.mediaId === next.clip.mediaId &&
        cur.speed === next.clip.speed &&
        Math.abs(cur.out - next.clip.in) < 0.02;
      if (!contiguous && (b.clipId !== next.clip.id || b.frozen)) this.park(b, next.clip, nm, next.clip.in);
      break;
    }
  }

  private syncTimed(
    kind: 'video' | 'audio',
    pool: Map<ID, Slot>,
    clips: (SourceClip & { start: number })[],
    t: number,
    gainOf: (clip: SourceClip & { start: number }) => number,
  ): void {
    if (!this.data) return;
    const wanted = new Set<ID>();
    for (const clip of clips) {
      const end = clip.start + srcDuration(clip);
      if (t < clip.start - LOOKAHEAD || t >= end) continue;
      const media = this.data.media[clip.mediaId];
      if (!media || media.kind === 'image' || (kind === 'video' && media.kind !== 'video')) continue;
      wanted.add(clip.id);
      let slot = pool.get(clip.id);
      if (!slot) {
        slot = this.spare[kind].pop() ?? this.makeSlot(kind);
        pool.set(clip.id, slot);
      }
      this.load(slot, media);
      slot.clipId = clip.id;
      if (t < clip.start) {
        if (!slot.el.paused) slot.el.pause();
        this.setGain(slot, 0);
        this.seekTo(slot, clip.in);
      } else this.drive(slot, clip, clip.in + (t - clip.start) * clip.speed, gainOf(clip));
    }
    for (const [id, slot] of pool) {
      if (wanted.has(id)) continue;
      this.quiet(slot);
      pool.delete(id);
      this.spare[kind].push(slot);
    }
  }

  private sync(): void {
    const d = this.data;
    if (!d) return;
    const t = this.time;
    this.syncMain(d.derived.layout, t);
    this.syncTimed('video', this.overlays, d.doc.overlays, t, (c) => clipGainAt(c, c.start, t));
    this.syncTimed('audio', this.audios, d.doc.audio, t, (c) => {
      const music = (c as { role?: string }).role === 'music';
      const duck = music && (c as { duck?: boolean }).duck !== false ? d.derived.duck : undefined;
      return clipGainAt(c, c.start, t, music ? { music: true, duck, contentEnd: d.derived.duration } : {});
    });
    // Stills used as clips or graphics.
    for (const m of Object.values(d.media)) {
      if (m.kind !== 'image' || m.proxy !== 'done') continue;
      const key = `${m.id}:${m.rev}`;
      if (!this.images.has(key)) {
        const img = new Image();
        img.onload = () => (this.dirty = true);
        img.src = `/api/projects/${d.projectId}/media/${m.id}/proxy?r=${m.rev}`;
        this.images.set(key, img);
      }
    }
  }

  /** True while the picture that should be playing is not ready, so the clock should wait for it. */
  private stalled(): boolean {
    const a = this.main[this.active];
    if (!a || !a.clipId || a.frozen) return false;
    const el = a.el;
    return el.seeking || a.target !== null || el.readyState < 3;
  }

  // ---- drawing

  private imageFor(mediaId: ID): HTMLImageElement | undefined {
    const m = this.data?.media[mediaId];
    if (!m) return undefined;
    const img = this.images.get(`${m.id}:${m.rev}`);
    return img && img.complete && img.naturalWidth > 0 ? img : undefined;
  }

  private layerOf(slot: Slot | undefined, media: MediaAsset): LayerImage | undefined {
    if (!slot) return undefined;
    const el = slot.el as HTMLVideoElement;
    if (el.readyState < 2 || !el.videoWidth) return undefined;
    return { image: el, region: { x: 0, y: 0, w: media.width, h: media.height }, k: el.videoWidth / media.width };
  }

  private provider(): FrameProvider {
    const d = this.data!;
    return {
      mediaSize: (id) => {
        const m = d.media[id];
        return m ? { width: m.width, height: m.height } : undefined;
      },
      layer: (ref: VisualRef) => {
        const m = d.media[ref.clip.mediaId];
        if (!m) return undefined;
        if (m.kind === 'image') {
          const img = this.imageFor(m.id);
          return img ? { image: img, region: { x: 0, y: 0, w: m.width, h: m.height }, k: img.naturalWidth / m.width } : undefined;
        }
        if (ref.role === 'main') {
          const a = this.main[this.active];
          return a && a.clipId === ref.clip.id && !a.frozen ? this.layerOf(a, m) : undefined;
        }
        return this.layerOf(this.overlays.get(ref.clip.id), m);
      },
      frozen: (seg) => {
        if (seg.clip.kind !== 'media') return undefined;
        const m = d.media[seg.clip.mediaId];
        const b = this.main[1 - this.active];
        return m && b && b.frozen && b.clipId === seg.clip.id ? this.layerOf(b, m) : undefined;
      },
      face: (id) => d.faces[id],
      image: (id): DrawableImage | undefined => {
        const img = this.imageFor(id);
        return img ? { image: img, width: img.naturalWidth, height: img.naturalHeight } : undefined;
      },
      scratch: (w, h, slot = '') => {
        const key = `${w}x${h}:${slot}`;
        let s = this.scratch.get(key);
        if (!s) {
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          // Grades read the pixels back every frame, so keep this canvas on the CPU.
          s = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) as unknown as Ctx2D };
          this.scratch.set(key, s);
        }
        return s;
      },
      lut: (name) => this.lutFor(name),
    };
  }

  /** LUTs by name: fetched once; the frame is redrawn when one arrives. */
  private luts = new Map<string, Lut3D | null>();
  private lutFor(name: string): Lut3D | null | undefined {
    if (this.luts.has(name)) return this.luts.get(name);
    this.luts.set(name, null);
    fetch(`/api/library/luts/${encodeURIComponent(name)}/file`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        this.luts.set(name, parseCube(text));
        this.invalidate();
      })
      .catch(() => this.luts.set(name, null));
    return undefined;
  }

  /** Whether every video frame the current moment needs has arrived. */
  private framesReady(): boolean {
    const d = this.data;
    if (!d) return true;
    const seg = segAt(d.derived.layout, this.time);
    if (seg && seg.clip.kind === 'media' && this.isVideo(seg.clip.mediaId)) {
      const a = this.main[this.active];
      if (!a || a.clipId !== seg.clip.id || a.el.seeking || a.target !== null || a.el.readyState < 2) return false;
    }
    for (const [, slot] of this.overlays) {
      const clip = d.doc.overlays.find((o) => o.id === slot.clipId);
      if (!clip || this.time < clip.start) continue;
      if (slot.el.seeking || slot.target !== null || slot.el.readyState < 2) return false;
    }
    return true;
  }

  private draw(now: number): void {
    const d = this.data;
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;
    if (!d) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    // While a seek is in flight keep the previous picture rather than flashing black.
    if (!this.framesReady() && now - this.lastDraw < 350) return;
    this.lastDraw = now;
    const scale = canvas.width / d.doc.settings.width;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    renderFrame(ctx as unknown as Ctx2D, d.doc, d.derived.layout, this.time, {
      provider: this.provider(),
      cards: d.derived.cards,
      pixelScale: scale,
      // While paused, the selected graphic is shown complete even on its first frame, so it can be seen and placed.
      settled: this.playing ? undefined : this.editing ?? undefined,
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.dirty = false;
  }

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    if (!this.data) return;
    if (this.playing) {
      const dt = Math.min(0.1, (now - this.lastWall) / 1000);
      this.lastWall = now;
      // Wait for a picture that is not ready, but never for long: a broken
      // file must not freeze the whole timeline.
      if (this.stalled()) {
        if (!this.stallSince) this.stallSince = now;
        if (now - this.stallSince > 1500) this.time += dt;
      } else {
        this.stallSince = 0;
        this.time += dt;
      }
      if (this.time >= this.duration) {
        this.time = this.duration;
        this.sync();
        this.pause();
      }
      this.notify();
    }
    this.sync();
    const busy = [...this.main, ...this.overlays.values()].some((s) => s.clipId && (s.el.seeking || s.target !== null));
    if (this.playing || this.dirty || busy) this.draw(now);
  };
}

export const player = new Player();
