import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { player } from './engine/player.ts';

/** Whether the preview is playing. */
export function usePlaying(): boolean {
  return useSyncExternalStore(
    (cb) => player.subscribe(cb),
    () => player.playing,
  );
}

/** Current time, updated at most every `interval` ms. Use it for labels, not for per-frame motion. */
export function usePlayerTime(interval = 100): number {
  const [t, setT] = useState(player.time);
  const last = useRef(0);
  useEffect(() => {
    return player.subscribe(() => {
      const now = performance.now();
      if (now - last.current >= interval || !player.playing) {
        last.current = now;
        setT(player.time);
      }
    });
  }, [interval]);
  return t;
}

/** Run a callback on every player update without re-rendering React (for the playhead). */
export function usePlayerFrame(fn: () => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ref.current();
    return player.subscribe(() => ref.current());
  }, []);
}

export function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}
