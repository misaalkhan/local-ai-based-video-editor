// The fonts bundled in /fonts. The browser loads them with @font-face and the
// exporter registers the same files, so text measures and renders alike in both.

export interface FontFile {
  family: string;
  weight: number;
  file: string;
}

export const FONT_FILES: FontFile[] = [
  { family: 'Inter', weight: 500, file: 'Inter-500.ttf' },
  { family: 'Inter', weight: 600, file: 'Inter-600.ttf' },
  { family: 'Inter', weight: 700, file: 'Inter-700.ttf' },
  { family: 'Inter', weight: 800, file: 'Inter-800.ttf' },
  { family: 'Montserrat', weight: 700, file: 'Montserrat-700.ttf' },
  { family: 'Montserrat', weight: 800, file: 'Montserrat-800.ttf' },
  { family: 'Montserrat', weight: 900, file: 'Montserrat-900.ttf' },
  { family: 'Poppins', weight: 600, file: 'Poppins-600.ttf' },
  { family: 'Poppins', weight: 700, file: 'Poppins-700.ttf' },
  { family: 'Poppins', weight: 800, file: 'Poppins-800.ttf' },
  { family: 'Anton', weight: 400, file: 'Anton-400.ttf' },
  { family: 'Bebas Neue', weight: 400, file: 'BebasNeue-400.ttf' },
  { family: 'Playfair Display', weight: 700, file: 'PlayfairDisplay-700.ttf' },
  { family: 'Playfair Display', weight: 900, file: 'PlayfairDisplay-900.ttf' },
  { family: 'Bangers', weight: 400, file: 'Bangers-400.ttf' },
  { family: 'Luckiest Guy', weight: 400, file: 'LuckiestGuy-400.ttf' },
  { family: 'Permanent Marker', weight: 400, file: 'PermanentMarker-400.ttf' },
  { family: 'Pacifico', weight: 400, file: 'Pacifico-400.ttf' },
  { family: 'Lobster', weight: 400, file: 'Lobster-400.ttf' },
  { family: 'Dancing Script', weight: 700, file: 'DancingScript-700.ttf' },
  { family: 'Caveat', weight: 700, file: 'Caveat-700.ttf' },
  { family: 'Oswald', weight: 700, file: 'Oswald-700.ttf' },
  { family: 'Archivo Black', weight: 400, file: 'ArchivoBlack-400.ttf' },
  { family: 'Righteous', weight: 400, file: 'Righteous-400.ttf' },
  { family: 'Fredoka', weight: 700, file: 'Fredoka-700.ttf' },
  { family: 'Bungee', weight: 400, file: 'Bungee-400.ttf' },
  { family: 'Alfa Slab One', weight: 400, file: 'AlfaSlabOne-400.ttf' },
  { family: 'DM Serif Display', weight: 400, file: 'DMSerifDisplay-400.ttf' },
  { family: 'Shrikhand', weight: 400, file: 'Shrikhand-400.ttf' },
  { family: 'Comfortaa', weight: 700, file: 'Comfortaa-700.ttf' },
  { family: 'Yellowtail', weight: 400, file: 'Yellowtail-400.ttf' },
  { family: 'Space Grotesk', weight: 700, file: 'SpaceGrotesk-700.ttf' },
  { family: 'Cormorant Garamond', weight: 700, file: 'CormorantGaramond-700.ttf' },
  { family: 'Space Mono', weight: 700, file: 'SpaceMono-700.ttf' },
];

export const FONT_FAMILIES = [...new Set(FONT_FILES.map((f) => f.family))];

/** What each face is for, in the words a creator would use. Shown in the app and given to the assistant. */
export const FONT_NOTES: Record<string, string> = {
  Inter: 'clean, neutral; captions and small labels',
  Montserrat: 'bold geometric; the default caption and hook face',
  Poppins: 'friendly rounded; captions, explainers',
  Anton: 'tall and heavy, the Impact look; meme captions, big titles',
  'Bebas Neue': 'tall condensed caps; titles, sports, hype',
  'Playfair Display': 'editorial serif; fashion, luxury, quotes',
  Bangers: 'comic book shout; memes, jokes, reactions',
  'Luckiest Guy': 'chunky cartoon; playful, kids, food',
  'Permanent Marker': 'hand-written marker; notes, casual callouts',
  Pacifico: 'retro script; summer, travel, lifestyle',
  Lobster: 'bold script; cafes, cosy, vintage',
  'Dancing Script': 'elegant script; weddings, beauty, soft moments',
  Caveat: 'quick handwriting; personal asides, diary',
  Oswald: 'condensed bold; news, fitness, strong statements',
  'Archivo Black': 'very heavy grotesque; one-word titles, hype',
  Righteous: 'retro futuristic; tech, gaming, music',
  Fredoka: 'soft rounded bold; wholesome, pets, kids',
  Bungee: 'street signage; streetwear, bold urban',
  'Alfa Slab One': 'heavy slab; western, rugged, coffee',
  'DM Serif Display': 'high-contrast serif; magazine, luxury',
  Shrikhand: 'juicy display; food, fun, Bollywood colour',
  Comfortaa: 'rounded geometric; calm, wellness, minimal',
  Yellowtail: 'brush script; signatures, celebration',
  'Space Grotesk': 'modern tech grotesque; startups, product',
  'Cormorant Garamond': 'classic serif; poetry, heritage, elegance',
  'Space Mono': 'typewriter monospace; code, logs, dry humour',
};

export function weightsOf(family: string): number[] {
  return FONT_FILES.filter((f) => f.family === family).map((f) => f.weight);
}

/** Closest bundled weight, so a missing weight never falls back to synthetic bold. */
export function nearestWeight(family: string, weight: number): number {
  const ws = weightsOf(family);
  if (!ws.length) return weight;
  return ws.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best), ws[0]);
}

/**
 * System fonts tried, in order, for characters the bundled fonts lack (emoji,
 * Devanagari, Arabic, CJK and so on). They are named explicitly because the
 * exporter's canvas, unlike a browser, does not fall back to them on its own.
 */
const FALLBACKS = [
  'Apple Color Emoji',
  'Kohinoor Devanagari',
  'Geeza Pro',
  'Kohinoor Bangla',
  'Gurmukhi MN',
  'Gujarati Sangam MN',
  'Tamil Sangam MN',
  'Kohinoor Telugu',
  'Hiragino Sans',
  'Apple SD Gothic Neo',
  'Thonburi',
  'Arial Hebrew',
  'Helvetica Neue',
  'Arial Unicode MS',
]
  .map((f) => `"${f}"`)
  .join(', ');

/** A canvas `font` string for a bundled family, with emoji and other-script fallbacks. */
export function fontString(family: string, weight: number, px: number): string {
  const fam = FONT_FAMILIES.includes(family) ? family : 'Inter';
  return `${nearestWeight(fam, weight)} ${px.toFixed(2)}px "${fam}", ${FALLBACKS}, sans-serif`;
}
