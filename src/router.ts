// Two screens, so the router is just the address bar.

import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();

export function navigate(path: string, replace = false): void {
  if (path === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  for (const l of listeners) l();
}

window.addEventListener('popstate', () => {
  for (const l of listeners) l();
});

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => location.pathname,
  );
}

/** The project id when the address is /p/<id>. */
export function projectIdFrom(path: string): string | null {
  const m = /^\/p\/([a-z0-9_-]+)\/?$/i.exec(path);
  return m ? m[1] : null;
}
