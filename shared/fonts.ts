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
  // The girlypop pack.
  { family: 'Great Vibes', weight: 400, file: 'GreatVibes-400.ttf' },
  { family: 'Sacramento', weight: 400, file: 'Sacramento-400.ttf' },
  { family: 'Satisfy', weight: 400, file: 'Satisfy-400.ttf' },
  { family: 'Cookie', weight: 400, file: 'Cookie-400.ttf' },
  { family: 'Parisienne', weight: 400, file: 'Parisienne-400.ttf' },
  { family: 'Kaushan Script', weight: 400, file: 'KaushanScript-400.ttf' },
  { family: 'Grand Hotel', weight: 400, file: 'GrandHotel-400.ttf' },
  { family: 'Playball', weight: 400, file: 'Playball-400.ttf' },
  { family: 'Shadows Into Light', weight: 400, file: 'ShadowsIntoLight-400.ttf' },
  { family: 'Indie Flower', weight: 400, file: 'IndieFlower-400.ttf' },
  { family: 'Gochi Hand', weight: 400, file: 'GochiHand-400.ttf' },
  { family: 'Amatic SC', weight: 700, file: 'AmaticSC-700.ttf' },
  { family: 'Chewy', weight: 400, file: 'Chewy-400.ttf' },
  { family: 'Sniglet', weight: 800, file: 'Sniglet-800.ttf' },
  { family: 'Baloo 2', weight: 800, file: 'Baloo2-800.ttf' },
  { family: 'Bubblegum Sans', weight: 400, file: 'BubblegumSans-400.ttf' },
  { family: 'Fuzzy Bubbles', weight: 700, file: 'FuzzyBubbles-700.ttf' },
  { family: 'Borel', weight: 400, file: 'Borel-400.ttf' },
  { family: 'Emilys Candy', weight: 400, file: 'EmilysCandy-400.ttf' },
  { family: 'Princess Sofia', weight: 400, file: 'PrincessSofia-400.ttf' },
  { family: 'Cherry Cream Soda', weight: 400, file: 'CherryCreamSoda-400.ttf' },
  { family: 'Twinkle Star', weight: 400, file: 'TwinkleStar-400.ttf' },
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
  // The girlypop pack: cute, soft and girly.
  'Great Vibes': 'flowing calligraphy; coquette, weddings, luxury, girly titles',
  Sacramento: 'thin airy script; love notes, soft moments, diary',
  Satisfy: 'casual brush script; summer, lifestyle, girls trip',
  Cookie: 'sweet rounded script; bakery, cute, pastel',
  Parisienne: 'French cafe script; coquette, romance, Paris, bows',
  'Kaushan Script': 'bold brush script; Barbie-pink energy, fashion, sass',
  'Grand Hotel': 'vintage diner script; retro, cafes, fifties',
  Playball: 'bouncy varsity script; cheer, sporty, retro',
  'Shadows Into Light': 'neat handwriting; to-do lists, girly notes, captions in a diary',
  'Indie Flower': 'bubbly handwriting; cute, scrapbook, doodles',
  'Gochi Hand': 'marker handwriting; Burn Book notes, callouts, gossip',
  'Amatic SC': 'tall hand lettering; boho, wedding signs, soft minimal',
  Chewy: 'chunky bubble letters; bubblegum, Y2K, playful hooks',
  Sniglet: 'soft rounded bold; kawaii, toys, cute labels and stickers',
  'Baloo 2': 'round friendly bold; stickers, pastel hooks, kids',
  'Bubblegum Sans': 'bubbly casual display; candy, cartoons, fun',
  'Fuzzy Bubbles': 'soft bubble handwriting; kawaii, sweet, soft girl',
  Borel: 'rounded cursive; princess, school, cute',
  'Emilys Candy': 'candy-shop lettering; sweets, Y2K, princess',
  'Princess Sofia': 'frilly fairy-tale script; princess, tiaras, glitter',
  'Cherry Cream Soda': 'fifties soda-shop lettering; retro diner, cherry, cute',
  'Twinkle Star': 'sparkly script with stars; magic, dreams, girlypop titles',
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
