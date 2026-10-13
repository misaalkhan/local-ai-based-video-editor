// The keyboard shortcuts, on the ? key.

import { setUi } from '../store.ts';
import { Modal } from '../ui.tsx';

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: 'Playing',
    keys: [
      ['Space', 'Play or pause'],
      ['← →', 'One frame back or forward'],
      ['Shift + ← →', 'Ten frames'],
      ['Home / End', 'Start or end'],
      ['Click the picture', 'Play or pause; drag a graphic or a punch-in to move it'],
      ['⌘ + scroll on the picture', 'Zoom the preview'],
    ],
  },
  {
    title: 'Editing',
    keys: [
      ['S or ⌘B', 'Split at the playhead'],
      ['Delete', 'Remove the selection (the main track closes the gap)'],
      ['⌘D', 'Duplicate the selection'],
      ['⌘Z / ⇧⌘Z', 'Undo and redo (each assistant message is one step)'],
      ['M', 'Drop a marker at the playhead'],
      ['Drag the grip at a cut', 'Roll the cut: one clip gives what the other takes'],
      ['Shift-click a marker', 'Remove it'],
      ['Esc', 'Deselect, or leave box-drawing'],
    ],
  },
  {
    title: 'Timeline',
    keys: [
      ['+ / −', 'Zoom the timeline'],
      ['Magnet', 'Snap to edges, markers and beats'],
      ['Drag from a panel', 'Drop clips, sounds, text and effects where they belong'],
    ],
  },
];

export function ShortcutsDialog() {
  return (
    <Modal title="Keyboard shortcuts" onClose={() => setUi({ showShortcuts: false })} width={560}>
      <div className="shortcuts">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3>{g.title}</h3>
            <dl>
              {g.keys.map(([k, what]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p className="hint">Press ? to show or hide this.</p>
      </div>
    </Modal>
  );
}
