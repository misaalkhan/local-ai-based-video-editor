import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChatMessage } from '../../shared/types.ts';
import { api } from '../api.ts';
import { keepLinks } from '../../shared/links.ts';
import { agentBusy, fail, toast, useStore } from '../store.ts';
import { importFiles } from '../actions.ts';
import { Icon, Spinner } from '../icons.tsx';
import { Button, IconButton } from '../ui.tsx';

const SUGGESTIONS = [
  'Cut the dead air and the ums, then add bold captions',
  'Make this a tight 30-second reel with a hook at the top',
  'Punch in on the key lines and add b-roll where it fits',
  'Reframe to vertical and keep my face centred',
];

const PLAN_SUGGESTIONS = [
  'Get to know me: ask about my account, audience and goals',
  'Go through my footage and tell me what we could make from it',
  'Plan next week: what to post, when, and why',
  'Here is a post I like; turn it into a style card',
];

/** Just enough formatting for the assistant's replies: paragraphs, bullet lists and **bold**. */
function Rich({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
      if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
      return part;
    });
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      const items = list;
      blocks.push(
        <ul key={blocks.length}>
          {items.map((li, i) => (
            <li key={i}>{inline(li)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) list.push(bullet[1]);
    else {
      flush();
      const heading = /^#{1,4}\s+(.*)$/.exec(line);
      if (heading) blocks.push(<p key={blocks.length}><strong>{inline(heading[1])}</strong></p>);
      else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    }
  }
  flush();
  return <div className="rich">{blocks}</div>;
}

function Assistant({ m, projectId, canUndo }: { m: ChatMessage; projectId: string; canUndo: boolean }) {
  const [open, setOpen] = useState(false);
  const running = m.status === 'running';
  const reviewing = m.status === 'reviewing';
  const actions = m.actions ?? [];
  return (
    <div className={`msg assistant ${m.reverted ? 'reverted' : ''}`}>
      {(running || reviewing) && (
        <div className="msg-status">
          <Spinner /> {reviewing ? 'Checking the result…' : actions.length ? 'Editing…' : 'Thinking…'}
        </div>
      )}
      {actions.length > 0 && (
        <ul className="actions">
          {actions.map((a) => (
            <li key={a.id} className={`action ${a.status}`}>
              {a.status === 'running' ? <Spinner size={12} /> : <Icon name={a.status === 'error' ? 'alert' : 'check'} size={13} />}
              <span>
                {a.label}
                {a.detail && <em>{a.detail}</em>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {m.text && <Rich text={m.text} />}
      {m.error && <div className="msg-error">{m.error}</div>}
      {m.status === 'stopped' && <div className="msg-note">Stopped.</div>}
      {m.reasoning && (
        <div className="reasoning">
          <button type="button" onClick={() => setOpen((o) => !o)}>
            <Icon name={open ? 'down' : 'right'} size={12} /> Why
          </button>
          {open && <Rich text={m.reasoning} />}
        </div>
      )}
      {!running && !reviewing && m.snapshot && (
        <div className="msg-foot">
          {m.reverted ? (
            <span className="msg-note">Undone</span>
          ) : !m.snapshot ? null : (
            <button
              type="button"
              className="linklike"
              disabled={!canUndo}
              onClick={() => api.undoMessage(projectId, m.id).then(() => toast('Undone. The project is back to how it was before that request.', 'success')).catch(fail)}
            >
              <Icon name="undo" size={12} /> Undo these changes
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatPanel({ mode = 'editor' }: { mode?: 'editor' | 'planner' } = {}) {
  const projectId = useStore((s) => s.projectId)!;
  const planner = mode === 'planner';
  const chat = useStore((s) => s.chat);
  const queued = useStore((s) => s.queued);
  const status = useStore((s) => s.status);
  const busy = useStore(agentBusy);
  const reviewing = chat[chat.length - 1]?.status === 'reviewing';
  const [text, setText] = useState('');
  const [attached, setAttached] = useState<{ id: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, queued]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(160, ta.scrollHeight)}px`;
  }, [text]);

  const send = async (value = text) => {
    const body = value.trim();
    if (!body || busy) return;
    setText('');
    const ids = attached.map((a) => a.id);
    setAttached([]);
    try {
      await api.sendChat(projectId, body, ids);
    } catch (err) {
      fail(err);
      setText(body);
    }
  };

  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    const added = await importFiles([...files]);
    setUploading(false);
    setAttached((cur) => [...cur, ...added.map((m) => ({ id: m.id, name: m.name }))]);
  };

  const off = status && !status.claude;

  return (
    <div className="chat">
      <div className="chat-list" ref={listRef}>
        {chat.length === 0 && !queued && (
          <div className="chat-empty">
            <span className="chat-empty-icon">
              <Icon name="sparkles" size={18} />
            </span>
            <strong>{planner ? 'Your planner' : 'Describe the edit you want'}</strong>
            <p>
              {planner
                ? 'It learns who you are, goes through your footage, keeps notes on what works on each platform, plans what to post and starts the edits. Nothing is posted for you.'
                : 'The assistant reads the transcript, makes the cuts, adds captions and graphics, then looks at the result and fixes what is off. Every request can be undone on its own.'}
            </p>
            <div className="suggestions">
              {(planner ? PLAN_SUGGESTIONS : SUGGESTIONS).map((s) => (
                <button key={s} type="button" onClick={() => send(s)} disabled={!!off}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {chat.map((m, i) =>
          m.role === 'user' ? (
            <div key={m.id} className="msg user">
              {m.text}
              {m.attachments && m.attachments.length > 0 && <span className="msg-attach"><Icon name="attach" size={11} /> {m.attachments.length} file{m.attachments.length > 1 ? 's' : ''}</span>}
            </div>
          ) : (
            <Assistant key={m.id} m={m} projectId={projectId} canUndo={!busy && !chat.slice(i + 1).some((x) => x.status === 'running')} />
          ),
        )}
        {queued && (
          <>
            <div className="msg user">{queued}</div>
            <div className="msg assistant">
              <div className="msg-status">
                <Spinner /> Getting your clips ready first. I will start as soon as they are transcribed.
              </div>
            </div>
          </>
        )}
      </div>

      <div className="composer">
        {off && <div className="composer-note">The <code>claude</code> command was not found, so the assistant is off. Everything else works.</div>}
        {attached.length > 0 && (
          <div className="chips small">
            {attached.map((a) => (
              <span className="chip" key={a.id}>
                <Icon name="attach" size={11} /> {a.name}
                <button type="button" aria-label="Remove" onClick={() => setAttached((cur) => cur.filter((x) => x.id !== a.id))}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={text}
          rows={1}
          placeholder={busy ? 'Working on it…' : planner ? 'Ask the planner, or tell it about yourself and your footage…' : 'Describe the edit you want, or paste a link…'}
          disabled={!!off}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            // Text copied from a document keeps its links only in the HTML flavour; put the addresses back so the assistant can open them.
            const merged = keepLinks(e.clipboardData.getData('text/html'), e.clipboardData.getData('text/plain'));
            if (!merged) return;
            e.preventDefault();
            const ta = e.currentTarget;
            setText(text.slice(0, ta.selectionStart) + merged + text.slice(ta.selectionEnd));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-row">
          <input ref={fileRef} type="file" multiple hidden accept="video/*,audio/*,image/*,.mov,.mkv,.heic" onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
          <IconButton icon="plus" label="Attach clips, music or images" onClick={() => fileRef.current?.click()} disabled={!!off} />
          {uploading && <Spinner />}
          {chat.length > 0 && !busy && !reviewing && (
            <button type="button" className="linklike" onClick={() => api.clearChat(projectId).catch(fail)} title="Start a fresh conversation. Your edits stay.">
              New chat
            </button>
          )}
          <span className="grow" />
          {busy || reviewing ? (
            <Button size="sm" icon="stop" onClick={() => api.stopChat(projectId).catch(fail)}>
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon="send" disabled={!text.trim() || !!off} onClick={() => send()}>
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
