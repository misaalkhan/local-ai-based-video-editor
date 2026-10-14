// Runs one chat turn: starts the `claude` CLI in headless mode with the
// editor's tools attached, follows its event stream, and mirrors what it does
// into the chat message the user is watching.
//
// A turn has two phases. In the first the assistant makes the edit and
// replies. In the second, which runs after the reply is already on screen, it
// looks at rendered frames of its own work and fixes what it finds.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_MODEL, CLAUDE, DATA_DIR, HOST, PORT, ROOT } from '../config.ts';
import type { Project } from '../store.ts';
import { HttpError, addMessage, commitDoc, createSnapshot, emit, readSnapshot, setPendingRequest, updateMessage } from '../store.ts';
import type { ChatAction, ChatMessage, ID, MediaAsset } from '../../shared/types.ts';
import { uid } from '../../shared/ops.ts';
import { forPeople } from '../../shared/text.ts';
import { MCP_PREFIX, TOOL_MAP, qualify } from '../tools/index.ts';
import { PLANNER_PROMPT, REVIEW_PROMPT, SYSTEM_PROMPT, buildPlannerPrompt, buildPrompt } from './prompt.ts';
import { getProfile, getSettings } from '../studio.ts';
import { seen } from '../tools/tools.ts';

export interface Run {
  projectId: ID;
  messageId: ID;
  token: string;
  child: ChildProcess | null;
  controller: AbortController;
  stopped: boolean;
  /** Tools called so far in this turn, to decide whether a visual review is worthwhile. */
  used: Set<string>;
  /** The planner runs on the footage library; the editor everywhere else. */
  planner: boolean;
}

const runs = new Map<ID, Run>();
const byToken = new Map<string, Run>();

/** Edits whose result is worth looking at before calling the job done. */
const VISUAL = new Set(['add_text', 'add_motion_graphic', 'add_broll', 'set_reframe', 'add_zoom', 'set_aspect', 'add_title_card', 'add_keyframes', 'reorder_segments', 'keep_only', 'add_clip', 'add_transition']);
const TURN_LIMIT_MS = 12 * 60 * 1000;

export function runForToken(token: string | undefined): Run | undefined {
  return token ? byToken.get(token) : undefined;
}

export function isRunning(projectId: ID): boolean {
  return runs.has(projectId);
}

/** The assistant should start from a clean slate: none of this session's Claude Code state. */
function childEnv(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keep = /^CLAUDE_CODE_(OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY)$/;
  for (const [k, v] of Object.entries(process.env)) {
    if ((k.startsWith('CLAUDE') && !keep.test(k)) || k === 'ANTHROPIC_MODEL') continue;
    env[k] = v;
  }
  env.STUDIO_URL = `http://${HOST}:${PORT}`;
  env.STUDIO_TOKEN = token;
  return env;
}

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  message?: { content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }[] };
}

interface Outcome {
  text: string;
  notes: string[];
  sessionId?: string;
  error?: string;
}

function firstLine(content: unknown): string {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join(' ');
  return forPeople(text);
}

function runClaude(p: Project, run: Run, prompt: string, resume: string | undefined, onUpdate: () => void, actions: ChatAction[], live: { text: string }): Promise<Outcome> {
  // Both assistants may read the web when the user allows it (Plan page): the planner for platform news,
  // the editor for research behind a script. Reddit threads and public footage have their own tools.
  const web = getProfile().allowWeb;
  return new Promise((resolve) => {
    if (!CLAUDE) {
      resolve({ text: '', notes: [], error: 'The claude command-line tool was not found on this Mac.' });
      return;
    }
    const cwd = path.join(DATA_DIR, 'assistant');
    fs.mkdirSync(cwd, { recursive: true });
    const mcp = {
      mcpServers: {
        studio: { command: process.execPath, args: [path.join(ROOT, 'server', 'agent', 'mcp.ts')], env: { STUDIO_URL: `http://${HOST}:${PORT}`, STUDIO_TOKEN: run.token } },
      },
    };
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--model', process.env.STUDIO_MODEL ?? getSettings().assistantModel ?? AGENT_MODEL,
      '--system-prompt', qualify(run.planner ? PLANNER_PROMPT : SYSTEM_PROMPT),
      '--tools', web ? 'WebSearch,WebFetch' : '',
      '--mcp-config', JSON.stringify(mcp), '--strict-mcp-config',
      '--allowedTools', web ? 'mcp__studio,WebSearch,WebFetch' : 'mcp__studio',
      '--setting-sources', 'project',
      '--disable-slash-commands',
    ];
    if (resume) args.push('--resume', resume);
    const child = spawn(CLAUDE, args, { cwd, env: childEnv(run.token), stdio: ['pipe', 'pipe', 'pipe'] });
    run.child = child;
    const out: Outcome = { text: '', notes: [] };
    let buffer = '';
    let stderr = '';
    const debug = process.env.STUDIO_DEBUG_AGENT ? fs.createWriteStream(path.join(cwd, `${run.messageId}-${resume ? 'review' : 'edit'}.jsonl`)) : null;

    const onEvent = (e: StreamEvent) => {
      if (e.session_id) out.sessionId = e.session_id;
      if (e.type === 'assistant') {
        for (const block of e.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) {
            out.notes.push(block.text.trim());
            live.text = block.text.trim();
          } else if (block.type === 'tool_use' && block.id) {
            const name = (block.name ?? '').replace(MCP_PREFIX, '');
            run.used.add(name);
            const def = TOOL_MAP.get(name);
            actions.push({ id: block.id, tool: name, label: def ? def.label(block.input ?? {}) : name, status: 'running' });
          }
        }
        onUpdate();
      } else if (e.type === 'user') {
        for (const block of e.message?.content ?? []) {
          if (block.type !== 'tool_result') continue;
          const a = actions.find((x) => x.id === block.tool_use_id);
          if (!a) continue;
          a.status = block.is_error ? 'error' : 'done';
          const def = TOOL_MAP.get(a.tool);
          if (block.is_error || !def?.readOnly) a.detail = firstLine(block.content);
        }
        onUpdate();
      } else if (e.type === 'result') {
        if (e.is_error || (e.subtype && e.subtype !== 'success')) out.error = e.result || `The assistant stopped early (${e.subtype ?? 'error'}).`;
        else out.text = (e.result ?? '').trim();
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        debug?.write(line + '\n');
        try {
          onEvent(JSON.parse(line) as StreamEvent);
        } catch {
          // not an event line
        }
      }
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 4000) stderr += c.toString();
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), TURN_LIMIT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ...out, error: `Could not start the assistant: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      debug?.end();
      run.child = null;
      for (const a of actions) if (a.status === 'running') a.status = 'error';
      if (!out.text && !out.error && !run.stopped) {
        const hint = /login|api key|authenticat|credential/i.test(stderr) ? ' Open a terminal, run `claude` once and sign in, then try again.' : '';
        out.error = `The assistant ended without a reply${code ? ` (exit code ${code})` : ''}.${hint}${stderr.trim() ? ` ${stderr.trim().split('\n').pop()}` : ''}`;
      }
      resolve(out);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

export function startTurn(p: Project, text: string, attachmentIds: ID[] = []): ChatMessage {
  seen.delete(p.id);
  const request = text.trim();
  if (!request) throw new HttpError(400, 'Say what you would like done.');
  if (runs.has(p.id)) throw new HttpError(409, 'The assistant is still working on the previous request.');
  const earlier = [...p.chat];
  const attachments = attachmentIds.map((id) => p.media.get(id)).filter((m): m is MediaAsset => !!m);
  const planner = p.id === 'library';
  addMessage(p, { id: uid('u'), role: 'user', text: request, ts: Date.now(), attachments: attachments.map((m) => m.id) });
  // The planner changes the plan, not the timeline, so there is nothing to snapshot.
  const snapshot = planner ? null : createSnapshot(p, `Before: ${request.slice(0, 48)}`, true);
  const message = addMessage(p, { id: uid('a'), role: 'assistant', text: '', ts: Date.now(), status: 'running', actions: [], ...(snapshot ? { snapshot: snapshot.id } : {}) });
  const run: Run = { projectId: p.id, messageId: message.id, token: crypto.randomBytes(24).toString('hex'), child: null, controller: new AbortController(), stopped: false, used: new Set(), planner };
  runs.set(p.id, run);
  byToken.set(run.token, run);
  if (p.pending) setPendingRequest(p, null);
  void execute(p, run, planner ? buildPlannerPrompt(earlier, request, attachments) : buildPrompt(p, earlier, request, attachments));
  return message;
}

async function execute(p: Project, run: Run, prompt: string): Promise<void> {
  const actions: ChatAction[] = [];
  const live = { text: '' };
  const push = (patch: Partial<ChatMessage> = {}) => updateMessage(p, run.messageId, { actions: actions.map((a) => ({ ...a })), ...patch });
  const startRev = p.rev;
  try {
    const first = await runClaude(p, run, prompt, undefined, () => push({ text: live.text }), actions, live);
    if (run.stopped) {
      push({ status: 'stopped', text: first.text || live.text });
      return;
    }
    if (first.error) {
      push({ status: 'error', error: first.error, text: first.text || live.text });
      return;
    }
    // Everything the assistant said along the way, other than its final reply, is its reasoning.
    const notes = first.notes.filter((n) => n !== first.text);
    const reasoning = notes.join('\n\n') || undefined;
    const changed = p.rev !== startRev;
    const review = !run.planner && changed && first.sessionId && process.env.STUDIO_REVIEW !== 'off' && [...run.used].some((t) => VISUAL.has(t));
    if (!review) {
      push({ status: 'done', text: first.text, reasoning });
      return;
    }
    // The reply is shown now; the visual check carries on behind it.
    push({ status: 'reviewing', text: first.text, reasoning });
    const before = p.rev;
    const count = actions.length;
    const second = await runClaude(p, run, qualify(REVIEW_PROMPT), first.sessionId, () => push(), actions, live);
    if (run.stopped) {
      push({ status: 'stopped' });
      return;
    }
    const fixed = p.rev !== before;
    // The review is only worth reporting when it changed something or found something it could not fix.
    const note = second.text.trim();
    const tail = note && (fixed || !/^looks good\W*$/i.test(note)) ? `\n\n**After checking the result:** ${note}` : '';
    // Looking at frames is not worth listing unless it led to a change.
    if (!fixed) actions.splice(count);
    push({ status: 'done', text: first.text + tail });
    if (fixed) emit(p, 'toast', { text: 'The assistant adjusted your project after reviewing the result. You can undo it from that message in the chat.', messageId: run.messageId });
  } catch (err) {
    push({ status: 'error', error: (err as Error).message });
  } finally {
    runs.delete(p.id);
    byToken.delete(run.token);
  }
}

export function stopTurn(p: Project): void {
  const run = runs.get(p.id);
  if (!run) return;
  run.stopped = true;
  run.controller.abort();
  run.child?.kill('SIGTERM');
}

/** Put the project back to how it was before a request, and mark that request (and later ones) as undone. */
export function undoTurn(p: Project, messageId: ID): number {
  if (runs.has(p.id)) throw new HttpError(409, 'Wait for the assistant to finish, or stop it first.');
  const i = p.chat.findIndex((m) => m.id === messageId);
  const m = p.chat[i];
  if (!m || !m.snapshot) throw new HttpError(404, 'Nothing to undo for that message.');
  const doc = readSnapshot(p, m.snapshot);
  createSnapshot(p, 'Before undo', true);
  const rev = commitDoc(p, { ...doc, name: p.doc.name }, { source: 'restore', label: 'Undo assistant changes' });
  for (const later of p.chat.slice(i)) {
    if (later.role === 'assistant' && later.snapshot && !later.reverted) updateMessage(p, later.id, { reverted: true });
  }
  return rev;
}
