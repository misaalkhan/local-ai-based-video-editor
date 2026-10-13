import { useEffect, useState } from 'react';
import { ASPECTS, aspectOf } from '../../shared/types.ts';
import { setSettings } from '../../shared/ops.ts';
import { api } from '../api.ts';
import { navigate } from '../router.ts';
import { agentBusy, fail, redo, setUi, undo, useDoc, useStore } from '../store.ts';
import { edit } from '../actions.ts';
import { Icon } from '../icons.tsx';
import { Button, IconButton, Menu, MenuItem } from '../ui.tsx';

export function TopBar() {
  const doc = useDoc()!;
  const projectId = useStore((s) => s.projectId)!;
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);
  const undoLabel = useStore((s) => s.undoStack[s.undoStack.length - 1]?.label);
  const busy = useStore(agentBusy);
  const connected = useStore((s) => s.connected);
  const [name, setName] = useState(doc.name);
  useEffect(() => setName(doc.name), [doc.name]);

  const rename = () => {
    const next = name.trim();
    if (!next) return setName(doc.name);
    if (next !== doc.name) api.renameProject(projectId, next).catch(fail);
  };
  const aspect = aspectOf(doc.settings);

  return (
    <header className="topbar">
      <button type="button" className="brand brand-btn" onClick={() => navigate('/')} title="All projects">
        <span className="brand-mark">
          <Icon name="play" size={11} />
        </span>
      </button>
      <input
        className="title-input"
        value={name}
        aria-label="Project name"
        onChange={(e) => setName(e.target.value)}
        onBlur={rename}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        spellCheck={false}
      />
      <Menu
        trigger={(_, toggle) => (
          <button type="button" className="pill-btn" onClick={toggle} title="Format">
            {aspect} <Icon name="down" size={13} />
          </button>
        )}
      >
        {(close) => (
          <>
            {Object.entries(ASPECTS).map(([k, v]) => (
              <MenuItem
                key={k}
                icon={k === aspect ? 'check' : undefined}
                hint={`${v.width}×${v.height}`}
                onClick={() => {
                  close();
                  if (k !== aspect) edit((d) => setSettings(d, { width: v.width, height: v.height }), `Format ${k}`);
                }}
              >
                {k} {v.label}
              </MenuItem>
            ))}
          </>
        )}
      </Menu>
      <div className="topbar-group">
        <IconButton icon="undo" label={canUndo ? `Undo ${undoLabel ?? ''} (⌘Z)` : 'Nothing to undo'} disabled={!canUndo || busy} onClick={undo} />
        <IconButton icon="redo" label="Redo (⇧⌘Z)" disabled={!canRedo || busy} onClick={redo} />
        <IconButton icon="history" label="Version history" onClick={() => setUi({ showHistory: true })} />
        <IconButton icon="more" label="Keyboard shortcuts (?)" onClick={() => setUi({ showShortcuts: true })} />
      </div>
      <span className="grow" />
      {!connected && (
        <span className="offline" title="The editor lost its connection to the local server. Is it still running?">
          <Icon name="alert" size={13} /> Reconnecting…
        </span>
      )}
      <Button variant="primary" icon="download" onClick={() => setUi({ showExport: true })}>
        Export
      </Button>
    </header>
  );
}
