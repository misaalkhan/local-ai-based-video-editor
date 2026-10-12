// Loads the bundled fonts into the page so canvas text matches the exporter.

import { FONT_FILES } from '../../shared/fonts.ts';
import { player } from './player.ts';

let started = false;

export function loadFonts(): void {
  if (started) return;
  started = true;
  const css = FONT_FILES.map(
    (f) => `@font-face{font-family:"${f.family}";font-weight:${f.weight};font-style:normal;font-display:block;src:url("/fonts/${f.file}") format("truetype");}`,
  ).join('\n');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  // Canvas does not wait for fonts, so ask for each one and repaint as they arrive.
  for (const f of FONT_FILES) {
    document.fonts
      .load(`${f.weight} 24px "${f.family}"`)
      .then(() => player.invalidate())
      .catch(() => {});
  }
}
