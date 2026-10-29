// Title normalisation + fuzzy matching used to group the same game across
// platforms/accounts and to suggest likely duplicates.

const PLATFORM_TAGS = [
  /\((?:ps4|ps5|ps3|ps vita|psvr2?|xbox one|xbox series x\|s|xbox series x|xbox 360|pc|windows|win10|steam|microsoft store)\)/g,
  /\b(?:ps4|ps5)\s*(?:&|and|\/)\s*(?:ps4|ps5)\b/g,
  /\s[-–—:]\s*(?:ps4|ps5)\s*(?:edition|version)?$/g,
  /\b(?:ps4|ps5)\s*(?:edition|version)\b/g,
  /\bfor windows(?: 10)?\b/g,
  /\b(?:windows|win10|xbox one|xbox series x\|s|xbox series x|xbox|pc)\s+(?:edition|version)\b/g,
  /\bplaystation\s*(?:4|5)\s*(?:edition|version)?\b/g,
];

const EDITION_SUFFIX = /[\s:–—-]+(?:the\s+)?(?:game of the year|goty|deluxe|digital deluxe|standard|complete|ultimate|gold|premium|definitive|enhanced|anniversary|legendary|special|collector'?s|director'?s cut|launch|day one|cross-gen|bundle)(?:\s+(?:edition|version|bundle|cut))?\s*$/;

const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

export function normalizeTitle(title) {
  let t = String(title || '')
    .replace(/[™®©℠]/g, '') // before NFKD, which spells ™ as "TM"
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .trim();
  for (const re of PLATFORM_TAGS) t = t.replace(re, ' ');
  // strip trailing edition suffixes repeatedly ("... Deluxe Edition - PS4")
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(/\s+/g, ' ').trim().replace(EDITION_SUFFIX, '');
    if (t === before) break;
  }
  t = t
    .replace(/&/g, ' and ')
    .replace(/\b(?:the)\b/g, ' ')
    // letters of every script stay ("ペルソナ5" and "ドラゴンクエスト5" are different games)
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
  // Arabic/roman numeral equivalence for common sequels (whole words only, in any script)
  t = t.replace(/(?<![\p{L}\p{N}\p{M}])(?:ii|iii|iv|v|vi|vii|viii|ix|x)(?![\p{L}\p{N}\p{M}])/gu, (m) => String(ROMAN[m]));
  return t || String(title || '').toLowerCase().trim();
}

/**
 * The account an imported copy's ext_id names ('' for none): import:<account>:<title>, or
 * import:<title>. The title part is the normalised title, or - written by an older version - the
 * lower-cased title itself when it had no Latin letters (and so may hold a ':').
 */
export function importedAccount(extId, title) {
  const rest = String(extId || '').replace(/^import:/, '');
  for (const n of [String(title || '').toLowerCase().trim(), normalizeTitle(title)]) {
    if (rest === n) return '';
    if (n && rest.endsWith(`:${n}`)) return rest.slice(0, -n.length - 1);
  }
  const i = rest.lastIndexOf(':');
  return i < 0 ? '' : rest.slice(0, i);
}

const bigramCache = new Map();
function bigrams(s) {
  const hit = bigramCache.get(s);
  if (hit) return hit;
  if (bigramCache.size > 200_000) bigramCache.clear();
  const out = computeBigrams(s);
  bigramCache.set(s, out);
  return out;
}

/** The string's bigrams (pairs of UTF-16 code units, whitespace removed) as sorted numbers, repeats kept. */
function computeBigrams(s) {
  const t = s.replace(/\s/g, '');
  const out = new Float64Array(Math.max(0, t.length - 1));
  for (let i = 0; i < out.length; i++) out[i] = t.charCodeAt(i) * 65536 + t.charCodeAt(i + 1);
  return out.sort();
}

// cached like bigrams: the duplicate finder compares each title with a few dozen neighbours
const numberCache = new Map();
function numbers(t) {
  let n = numberCache.get(t);
  if (n === undefined) {
    if (numberCache.size > 200_000) numberCache.clear();
    numberCache.set(t, n = (t.match(/\b\d+\b/g) || []).sort().join(' '));
  }
  return n;
}

/** Sørensen–Dice similarity of two (already normalised) strings, 0..1 */
export function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  // the size of the multiset intersection, merging the two sorted lists
  let inter = 0;
  for (let i = 0, j = 0; i < A.length && j < B.length;) {
    if (A[i] === B[j]) { inter++; i++; j++; } else if (A[i] < B[j]) i++; else j++;
  }
  return (2 * inter) / (A.length + B.length);
}

/**
 * Score how likely two normalised titles refer to the same game.
 * Prefix containment ("hades" vs "hades 2") is penalised when the remainder is a sequel number.
 */
export function matchScore(a, b) {
  if (a === b) return 1;
  // different numbers mean different games: sequels (civilization 5 / 6), episodes, volumes,
  // remakes (resident evil 2 / 3). Roman numerals are already digits after normalisation.
  if (numbers(a) !== numbers(b)) return Math.min(similarity(a, b), 0.5);
  const sim = similarity(a, b);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 5 && long.startsWith(short + ' ')) {
    const rest = long.slice(short.length + 1);
    if (/^\d+\b/.test(rest)) return Math.min(sim, 0.5); // sequel, not a duplicate
    return Math.max(sim, 0.82);
  }
  // a possessive publisher prefix ("sid meier s civilization 5" vs "civilization 5")
  if (short.length >= 5 && long.endsWith(' ' + short) && / s$/.test(long.slice(0, -short.length - 1))) return Math.max(sim, 0.82);
  return sim;
}
