import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Called with each complete line of stdout. */
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Written to stdin, which is then closed. */
  input?: string | Buffer;
  /** Keep stdout as a Buffer instead of decoding it. */
  binary?: boolean;
  maxStderr?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stdoutBuffer?: Buffer;
  stderr: string;
}

export class ProcError extends Error {
  code: number;
  stderr: string;
  constructor(cmd: string, code: number, stderr: string) {
    const tail = stderr.trim().split('\n').slice(-6).join('\n');
    super(`${cmd} exited with code ${code}${tail ? `:\n${tail}` : ''}`);
    this.code = code;
    this.stderr = stderr;
  }
}

function lineSplitter(onLine: (line: string) => void) {
  let rest = '';
  return (chunk: Buffer | string) => {
    rest += chunk.toString();
    // ffmpeg rewrites its progress line with carriage returns.
    const parts = rest.split(/\r?\n|\r/);
    rest = parts.pop() ?? '';
    for (const p of parts) onLine(p);
  };
}

/** Run a command to completion. Rejects on a non-zero exit code or when aborted. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const spawnOpts: SpawnOptions = { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] };
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, spawnOpts);
    } catch (err) {
      reject(err);
      return;
    }
    const out: Buffer[] = [];
    let stderr = '';
    const maxStderr = opts.maxStderr ?? 200_000;
    const outLines = opts.onStdoutLine ? lineSplitter(opts.onStdoutLine) : null;
    const errLines = opts.onStderrLine ? lineSplitter(opts.onStderrLine) : null;
    child.stdout?.on('data', (c: Buffer) => {
      if (outLines) outLines(c);
      else out.push(c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < maxStderr) stderr += c.toString();
      else stderr = stderr.slice(-maxStderr / 2) + c.toString();
      errLines?.(c);
    });
    const onAbort = () => child.kill('SIGKILL');
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const buf = Buffer.concat(out);
      if (code === 0) resolve({ code: 0, stdout: opts.binary ? '' : buf.toString(), stdoutBuffer: opts.binary ? buf : undefined, stderr });
      else reject(new ProcError(cmd.split('/').pop() ?? cmd, code ?? -1, stderr));
    });
    child.stdin?.on('error', () => {});
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** Runs at most `limit` tasks at a time, in the order they were added. */
export class Queue {
  private active = 0;
  private waiting: (() => void)[] = [];
  private limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/** Parse ffmpeg's `-progress pipe:1` output into seconds of output written so far. */
export function ffmpegProgress(onSeconds: (s: number) => void): (line: string) => void {
  return (line) => {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
    if (m) onSeconds(Number(m[1]) / 1e6);
  };
}
