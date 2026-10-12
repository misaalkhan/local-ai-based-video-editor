// What the home screen hands to the editor when a project is started from a
// drop and a prompt: the files still to import and the request to run once
// they are ready.

export interface PendingStart {
  projectId: string;
  files: File[];
  paths: string[];
  prompt: string;
}

let pending: PendingStart | null = null;

export function setPending(p: PendingStart): void {
  pending = p;
}

export function takePending(projectId: string): PendingStart | null {
  if (pending && pending.projectId === projectId) {
    const p = pending;
    pending = null;
    return p;
  }
  return null;
}
