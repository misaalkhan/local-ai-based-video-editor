import type { Router } from '../http.ts';
import { HttpError, clearChat, getProject } from '../store.ts';
import { ToolError, callTool, qualify, toolsFor } from '../tools/index.ts';
import { isRunning, runForToken, startTurn, stopTurn, undoTurn } from './runner.ts';

export function register(r: Router): void {
  r.post('/api/projects/:pid/chat', async (c) => {
    const p = getProject(c.params.pid);
    const body = await c.body<{ text?: string; attachments?: string[] }>();
    startTurn(p, String(body.text ?? ''), Array.isArray(body.attachments) ? body.attachments.map(String) : []);
    c.json({ ok: true }, 202);
  });

  r.post('/api/projects/:pid/chat/stop', (c) => {
    stopTurn(getProject(c.params.pid));
    c.json({ ok: true });
  });

  r.post('/api/projects/:pid/chat/clear', (c) => {
    const p = getProject(c.params.pid);
    if (isRunning(p.id)) throw new HttpError(409, 'Wait for the assistant to finish first.');
    clearChat(p);
    c.json({ ok: true });
  });

  r.post('/api/projects/:pid/chat/:mid/undo', (c) => {
    c.json({ rev: undoTurn(getProject(c.params.pid), c.params.mid) });
  });

  // ---- called by the MCP bridge that the claude CLI starts

  r.get('/internal/agent/tools', (c) => {
    const run = runForToken(String(c.req.headers['x-studio-token'] ?? ''));
    if (!run) throw new HttpError(403, 'unknown session');
    c.json({ tools: toolsFor(run.projectId).map((t) => ({ name: t.name, description: qualify(t.description), inputSchema: JSON.parse(qualify(JSON.stringify(t.schema))) })) });
  });

  r.post('/internal/agent/call', async (c) => {
    const run = runForToken(String(c.req.headers['x-studio-token'] ?? ''));
    if (!run) throw new HttpError(403, 'unknown session');
    const body = await c.body<{ tool?: string; args?: Record<string, unknown> }>();
    const p = getProject(run.projectId);
    try {
      const result = await callTool({ p, by: 'agent', messageId: run.messageId, signal: run.controller.signal }, String(body.tool ?? ''), body.args);
      c.json({ text: qualify(result.text), images: (result.images ?? []).map((i) => ({ mime: i.mime, data: i.data.toString('base64') })) });
    } catch (err) {
      if (err instanceof ToolError) c.json({ text: qualify(err.message), isError: true });
      else {
        console.error(`[agent] tool ${body.tool} failed:`, err);
        c.json({ text: `The editor hit an internal error running this: ${(err as Error).message}`, isError: true });
      }
    }
  });
}
