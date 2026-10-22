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

export function normalizeTitle(title) {
  let t = String(title || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[™®©℠]/g, '')
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
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Arabic/roman numeral equivalence for common sequels
  t = t.replace(/\b(ii|iii|iv|v|vi|vii|viii|ix|x)\b/g, (m) => String({ ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 }[m]));
  return t || String(title || '').toLowerCase().trim();
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

function computeBigrams(s) {
  const t = s.replace(/\s/g, '');
  const out = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/** Sørensen–Dice similarity of two (already normalised) strings, 0..1 */
export function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) { total += n; if (B.has(g)) inter += Math.min(n, B.get(g)); }
  for (const n of B.values()) total += n;
  return (2 * inter) / total;
}

/**
 * Score how likely two normalised titles refer to the same game.
 * Prefix containment ("hades" vs "hades 2") is penalised when the remainder is a sequel number.
 */
export function matchScore(a, b) {
  if (a === b) return 1;
  const sim = similarity(a, b);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 5 && long.startsWith(short + ' ')) {
    const rest = long.slice(short.length + 1);
    if (/^\d+\b/.test(rest)) return Math.min(sim, 0.5); // sequel, not a duplicate
    return Math.max(sim, 0.82);
  }
  return sim;
}
