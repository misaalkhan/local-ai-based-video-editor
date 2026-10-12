// Devanagari to the Latin letters Hinglish is written in ("ladki", "accha",
// "kya hua"), for captions on Hindi and Hinglish speech. Common words get
// their usual spelling from a table; the rest is spelt out letter by letter
// with the silent inherent vowel dropped where Hindi drops it.

const DEVANAGARI = /[ऀ-ॿ]/;

export function hasDevanagari(text: string): boolean {
  return DEVANAGARI.test(text);
}

/** Words whose Hinglish spelling is a convention rather than a rule, and English words whisper wrote in Devanagari. */
const WORDS: Record<string, string> = {
  है: 'hai', हैं: 'hain', हूँ: 'hoon', हूं: 'hoon', हो: 'ho', था: 'tha', थी: 'thi', थे: 'the',
  नहीं: 'nahi', नही: 'nahi', में: 'mein', मैं: 'main', मैंने: 'maine', मुझे: 'mujhe', मेरा: 'mera', मेरी: 'meri', मेरे: 'mere',
  हम: 'hum', हमें: 'humein', हमारा: 'hamara', हमारी: 'hamari', हमारे: 'hamare', हमने: 'humne',
  तुम: 'tum', तुम्हारा: 'tumhara', तुम्हें: 'tumhe', आप: 'aap', आपका: 'aapka', आपकी: 'aapki', आपके: 'aapke', आपको: 'aapko',
  ये: 'ye', यह: 'yeh', वो: 'wo', वह: 'woh', वे: 'we', इस: 'is', उस: 'us', इसका: 'iska', उसका: 'uska', इसे: 'ise', उसे: 'use',
  क्या: 'kya', क्यों: 'kyun', क्योंकि: 'kyunki', कैसे: 'kaise', कैसा: 'kaisa', कैसी: 'kaisi', कहाँ: 'kahan', कहां: 'kahan',
  यहाँ: 'yahan', यहां: 'yahan', वहाँ: 'wahan', वहां: 'wahan', कब: 'kab', कौन: 'kaun', कितना: 'kitna', कितनी: 'kitni', कितने: 'kitne',
  और: 'aur', या: 'ya', तो: 'toh', भी: 'bhi', ही: 'hi', पर: 'par', से: 'se', का: 'ka', की: 'ki', के: 'ke', को: 'ko', ने: 'ne', पे: 'pe',
  कुछ: 'kuch', सब: 'sab', बहुत: 'bahut', थोड़ा: 'thoda', थोड़ी: 'thodi', थोड़े: 'thode', ज़्यादा: 'zyada', ज्यादा: 'zyada',
  अच्छा: 'accha', अच्छी: 'acchi', अच्छे: 'acche', ठीक: 'theek', सही: 'sahi', गलत: 'galat', बस: 'bas', अब: 'ab', अभी: 'abhi',
  फिर: 'phir', लेकिन: 'lekin', मतलब: 'matlab', अपना: 'apna', अपनी: 'apni', अपने: 'apne', एक: 'ek', दो: 'do', तीन: 'teen',
  चार: 'char', पाँच: 'paanch', पांच: 'paanch', छह: 'chhe', छे: 'chhe', सात: 'saat', आठ: 'aath', नौ: 'nau', दस: 'das',
  चाहिए: 'chahiye', चाहिये: 'chahiye', चलो: 'chalo', चलें: 'chalein', चले: 'chale', चला: 'chala', चली: 'chali', चल: 'chal',
  कर: 'kar', करो: 'karo', करें: 'karein', करना: 'karna', किया: 'kiya', रहा: 'raha', रही: 'rahi', रहे: 'rahe', गया: 'gaya', गयी: 'gayi', गई: 'gayi', गए: 'gaye', गये: 'gaye',
  आया: 'aaya', आयी: 'aayi', आई: 'aayi', आएगा: 'aayega', आएगी: 'aayegi', आएंगे: 'aayenge', जाएगा: 'jayega', जाएगी: 'jayegi', जाएंगे: 'jayenge',
  हाँ: 'haan', हां: 'haan', ना: 'na', यार: 'yaar', भाई: 'bhai', दोस्त: 'dost', दोस्तों: 'doston', लोग: 'log', लोगों: 'logon',
  आज: 'aaj', कल: 'kal', दिन: 'din', रात: 'raat', घर: 'ghar', बात: 'baat', साथ: 'saath', समय: 'samay', प्यार: 'pyaar', नया: 'naya', नयी: 'nayi', नई: 'nayi', नए: 'naye',
  पुराना: 'purana', बड़ा: 'bada', बड़ी: 'badi', बड़े: 'bade', छोटा: 'chhota', छोटी: 'chhoti', छोटे: 'chhote', सुंदर: 'sundar', सुन्दर: 'sundar',
  खाना: 'khana', पानी: 'paani', चाय: 'chai', गाना: 'gaana', मिल: 'mil', मिला: 'mila', मिली: 'mili', मिले: 'mile', देखो: 'dekho', देखा: 'dekha', देखते: 'dekhte',
  मिनट: 'minute', मिनिट: 'minute', वीडियो: 'video', फोटो: 'photo', फ़ोटो: 'photo', कैमरा: 'camera', कामरा: 'camera', रील: 'reel', रीलस: 'reels',
  साइकल: 'cycle', साइकिल: 'cycle', फोन: 'phone', फ़ोन: 'phone', मूवी: 'movie', फिल्म: 'film', फ़िल्म: 'film', कॉफी: 'coffee', कॉफ़ी: 'coffee',
  स्कूल: 'school', कॉलेज: 'college', ऑफिस: 'office', ऑफ़िस: 'office', टाइम: 'time', लाइक: 'like', शेयर: 'share', सब्सक्राइब: 'subscribe',
  फॉलो: 'follow', कमेंट: 'comment', लिंक: 'link', बायो: 'bio', ओके: 'ok', थैंक: 'thank', थैंक्स: 'thanks', यू: 'you', प्लीज: 'please', प्लीज़: 'please',
  सॉरी: 'sorry', हेलो: 'hello', हैलो: 'hello', बाय: 'bye', गाइज़: 'guys', गाइज: 'guys', इटली: 'Italy', इंडिया: 'India', दिल्ली: 'Delhi', मुंबई: 'Mumbai',
};

const VOWELS: Record<string, string> = {
  अ: 'a', आ: 'aa', इ: 'i', ई: 'i', उ: 'u', ऊ: 'u', ऋ: 'ri', ए: 'e', ऐ: 'ai', ओ: 'o', औ: 'au', ऑ: 'o', ऍ: 'e',
};

/** Vowel signs: the vowel sound that replaces a consonant's inherent "a". */
const SIGNS: Record<string, string> = {
  'ा': 'aa', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e',
};

const CONSONANTS: Record<string, string> = {
  क: 'k', ख: 'kh', ग: 'g', घ: 'gh', ङ: 'n', च: 'ch', छ: 'chh', ज: 'j', झ: 'jh', ञ: 'n',
  ट: 't', ठ: 'th', ड: 'd', ढ: 'dh', ण: 'n', त: 't', थ: 'th', द: 'd', ध: 'dh', न: 'n',
  प: 'p', फ: 'ph', ब: 'b', भ: 'bh', म: 'm', य: 'y', र: 'r', ल: 'l', व: 'v', श: 'sh', ष: 'sh', स: 's', ह: 'h', ळ: 'l',
};

/** A nukta under a consonant gives it another sound (ज़ is "z", ड़ is "d"); NFC writes it as a separate mark. */
const NUKTA: Record<string, string> = { क: 'q', ख: 'kh', ग: 'g', ज: 'z', ड: 'd', ढ: 'dh', फ: 'f' };

const VIRAMA = '्';
const NUKTA_SIGN = '़';
const ANUSVARA = 'ं';
const CHANDRABINDU = 'ँ';
const VISARGA = 'ः';
const LABIALS = new Set(['p', 'ph', 'b', 'bh', 'm']);

interface Unit {
  /** Latin letters of the consonant, or '' for an independent vowel. */
  cons: string;
  /** The vowel that follows, '' for a bare consonant (virama), or 'a' for the inherent vowel. */
  vowel: string;
  inherent: boolean;
  /** Nasal mark after the vowel. */
  nasal: boolean;
}

function parse(word: string): Unit[] {
  const units: Unit[] = [];
  const chars = Array.from(word.normalize('NFC'));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    let cons = CONSONANTS[ch];
    if (chars[i + 1] === NUKTA_SIGN) {
      cons = NUKTA[ch] ?? cons;
      i++;
    }
    if (cons !== undefined) {
      const u: Unit = { cons, vowel: 'a', inherent: true, nasal: false };
      const next = chars[i + 1];
      if (next === VIRAMA) {
        u.vowel = '';
        u.inherent = false;
        i++;
      } else if (next !== undefined && SIGNS[next] !== undefined) {
        u.vowel = SIGNS[next];
        u.inherent = false;
        i++;
      }
      units.push(u);
    } else if (VOWELS[ch] !== undefined) {
      units.push({ cons: '', vowel: VOWELS[ch], inherent: false, nasal: false });
    } else if (ch === ANUSVARA || ch === CHANDRABINDU) {
      if (units.length) units[units.length - 1].nasal = true;
    } else if (ch === VISARGA) {
      units.push({ cons: 'h', vowel: '', inherent: false, nasal: false });
    }
    // Anything else (punctuation, digits, Latin letters) is handled by the caller.
  }
  return units;
}

/** Spell one Devanagari word by rule. */
function spell(word: string): string {
  const units = parse(word);
  if (!units.length) return word;
  // Hindi drops the inherent vowel at the end of a word, and in the middle of
  // one when the syllables on both sides carry a vowel of their own (लड़की is
  // "ladki", not "ladaki"). Decided from the end so each decision can see the
  // one after it.
  const keep = units.map((u) => u.vowel !== '');
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i];
    if (!u.inherent) continue;
    const last = i === units.length - 1;
    const prevHasVowel = i > 0 && keep[i - 1];
    const nextHasVowel = i + 1 < units.length && keep[i + 1];
    if (last || (prevHasVowel && nextHasVowel && !u.nasal)) keep[i] = false;
  }
  // A single consonant keeps its vowel: क is "ka", not "k".
  if (units.length === 1 && units[0].cons) keep[0] = true;
  let out = '';
  let firstVowel = true;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    out += u.cons;
    if (keep[i]) {
      let v = u.vowel;
      // The long "aa" is written double in a word's first syllable (aaj, baat) and single after it (hamara, chahiye).
      if (v === 'aa' && !firstVowel) v = 'a';
      out += v;
      firstVowel = false;
    }
    if (u.nasal) {
      const next = units[i + 1]?.cons ?? '';
      out += LABIALS.has(next) ? 'm' : 'n';
    }
  }
  return out;
}

/** The table with its keys in NFC, the form the text is matched in (NFC splits nukta letters into two marks). */
const KNOWN = new Map(Object.entries(WORDS).map(([k, v]) => [k.normalize('NFC'), v]));

function romanizeWord(word: string): string {
  const nfc = word.normalize('NFC');
  return KNOWN.get(nfc) ?? spell(nfc);
}

/** Replace every Devanagari word in a text; Latin words, digits and punctuation stay as they are. */
export function romanizeDevanagari(text: string): string {
  if (!hasDevanagari(text)) return text;
  return text
    .replace(/[।॥]/g, '.')
    .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966))
    .replace(/[ऀ-ॿ]+/g, (m) => romanizeWord(m));
}
