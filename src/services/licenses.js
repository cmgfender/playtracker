// Steam's licenses page (store.steampowered.com/account/licenses) lists every product with the
// date it was added to the account - the one date Steam's Web API never exposes. Pasting that
// table gives each game a start for its history window, turning "only last played is known"
// into a bounded first..last window.
import { normalizeTitle } from './titles.js';
import { mergeEvidence, reinferMany } from './inference.js';
import { flushRollups } from './rollup.js';
import { tx } from '../db.js';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const METHODS = /\s+(?:steam store|complimentary|retail|gift\/guest pass|gift|guest pass|steam|cd key|key|remove)\s*$/i;
const NOT_A_GAME = /\b(?:soundtrack|ost|artbook|art book|season pass|dlc|demo|beta|playtest|dedicated server|sdk|trailer|wallpaper)\b/i;

const at = (y, m, d) => new Date(y, m, d, 12).getTime();

function leadingDate(line) {
  let m = /^(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{4})\b/i.exec(line); // 20 Nov, 2015
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] != null) return { t: at(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]), rest: line.slice(m[0].length) };
  m = /^([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(line); // Nov 20, 2015
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] != null) return { t: at(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]), rest: line.slice(m[0].length) };
  m = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(line); // 2015-11-20
  if (m) return { t: at(+m[1], +m[2] - 1, +m[3]), rest: line.slice(m[0].length) };
  return null;
}

/** Parse pasted license rows into [{ date, title }] (header and unrecognised lines are skipped). */
export function parseLicenses(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const d = line && leadingDate(line);
    if (!d) continue;
    const parts = d.rest.split('\t').map((x) => x.trim()).filter(Boolean);
    let title = (parts.length > 1 ? parts.find((p) => !/^remove$/i.test(p)) : d.rest).trim();
    for (let i = 0; i < 2; i++) title = title.replace(METHODS, '').trim();
    if (title) out.push({ date: d.t, title });
  }
  return out;
}

/**
 * Match licenses to an account's games (exact normalised title, or a product name that is the
 * game's name plus an edition) and record the earliest date as the game's date added.
 */
export function applyLicenses(db, accountId, text, { settings = null } = {}) {
  const licenses = parseLicenses(text);
  const entries = db.prepare('SELECT id, title, baseline_min FROM entries WHERE account_id = ?').all(accountId);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const byNorm = new Map();
  for (const e of entries) {
    const k = normalizeTitle(e.title);
    if (!byNorm.has(k)) byNorm.set(k, []);
    byNorm.get(k).push(e);
  }
  const norms = [...byNorm.keys()].filter((k) => k.length >= 4).sort((a, b) => b.length - a.length);
  const earliest = new Map();
  const unmatched = [];
  for (const l of licenses) {
    if (NOT_A_GAME.test(l.title)) continue;
    const n = normalizeTitle(l.title);
    let hit = byNorm.get(n);
    if (!hit) {
      // an edition, never a sequel ("hades 2" is not an edition of "hades")
      const k = norms.find((x) => n.startsWith(`${x} `) && !/^\d+\b/.test(n.slice(x.length + 1)));
      hit = k ? byNorm.get(k) : null;
    }
    if (!hit) { unmatched.push(l.title); continue; }
    for (const e of hit) if (!earliest.has(e.id) || l.date < earliest.get(e.id)) earliest.set(e.id, l.date);
  }
  const dated = [];
  tx(db, () => {
    for (const [id, date] of earliest) {
      mergeEvidence(db, id, { date_added: date });
      if (byId.get(id).baseline_min > 0) dated.push(id);
    }
    flushRollups(db);
    reinferMany(db, dated, { settings });
    flushRollups(db);
  });
  return { licenses: licenses.length, matched: earliest.size, history_redated: dated.length, unmatched: unmatched.length, unmatched_sample: unmatched.slice(0, 20) };
}
