// A minimal MCP server over stdio. The `claude` CLI starts this as a child
// process; it exposes the editor's tools by forwarding each call to the
// running Local Studio server, which owns the project.
//
// Environment: STUDIO_URL (http://127.0.0.1:PORT), STUDIO_TOKEN (identifies
// the chat turn this session belongs to).

import readline from 'node:readline';

const url = process.env.STUDIO_URL ?? '';
const token = process.env.STUDIO_TOKEN ?? '';

interface Rpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function handle(msg: Rpc): Promise<void> {
  // Notifications carry no id and get no reply.
  if (msg.id === undefined) return;
  try {
    switch (msg.method) {
      case 'initialize':
        send({
          id: msg.id,
          result: {
            protocolVersion: (msg.params?.protocolVersion as string) ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'studio', version: '1.0.0' },
          },
        });
        return;
      case 'ping':
        send({ id: msg.id, result: {} });
        return;
      case 'tools/list': {
        const { tools } = await api<{ tools: unknown[] }>('/internal/agent/tools');
        send({ id: msg.id, result: { tools } });
        return;
      }
      case 'tools/call': {
        const r = await api<{ text: string; isError?: boolean; images?: { mime: string; data: string }[] }>('/internal/agent/call', {
          tool: msg.params?.name,
          args: msg.params?.arguments ?? {},
        });
        const content: Record<string, unknown>[] = [{ type: 'text', text: r.text }];
        for (const img of r.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mime });
        send({ id: msg.id, result: { content, isError: !!r.isError } });
        return;
      }
      default:
        send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  } catch (err) {
    if (msg.method === 'tools/call') {
      send({ id: msg.id, result: { content: [{ type: 'text', text: `The editor could not run this: ${(err as Error).message}` }], isError: true } });
    } else send({ id: msg.id, error: { code: -32603, message: (err as Error).message } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  try {
    void handle(JSON.parse(text) as Rpc);
  } catch {
    // ignore lines that are not JSON
  }
});
rl.on('close', () => process.exit(0));
