// Franchises: the series your games belong to, as first-class things. The big ones are curated
// (src/data/franchises.js): every main entry in release order - the ones you don't own too - with
// spin-offs, remakes and collections, and the story order where the story is told out of order.
// The rest come from IGDB's franchises and the titles themselves (series.js), in release order
// by IGDB's dates.
//
// Your games are matched to curated entries by title; when one title names two games (Doom 1993
// and Doom 2016, Modern Warfare 2 and II) IGDB's release year decides. A collection you own
// (The Master Chief Collection) holds the entries it contains.

import { FRANCHISES } from '../data/franchises.js';
import { normalizeTitle } from './titles.js';
import { memo, dayKey } from './stats.js';
import { seriesOf } from './series.js';

const DAY = 86_400_000;
const FINISHED = new Set(['completed', 'beaten']);
const PLAYING_DAYS = 30;
const yearless = (t) => t.replace(/\s*\((?:19|20)\d{2}\)$/, '');
export const slug = (name) => normalizeTitle(name).replace(/\s+/g, '-') || 'series';

// the curated franchises, their entries keyed by normalised title
const CURATED = FRANCHISES.map((f) => ({
  ...f,
  curated: true,
  aliasKeys: new Set(f.aliases.map(normalizeTitle)),
  entries: f.entries.map(([year, title, kind = 'main', opts = {}], i) => ({
    i, year, title, kind, includes: opts.includes || [],
    keys: [...new Set([title, yearless(title), ...(opts.aka || [])].map(normalizeTitle))],
  })),
}));
const BY_KEY = new Map();
for (const f of CURATED) for (const e of f.entries) for (const k of e.keys) { if (!BY_KEY.has(k)) BY_KEY.set(k, []); BY_KEY.get(k).push({ f, e }); }
const BY_ALIAS = new Map();
for (const f of CURATED) for (const k of f.aliasKeys) if (!BY_ALIAS.has(k)) BY_ALIAS.set(k, f);
const BY_ID = new Map(CURATED.map((f) => [f.id, f]));

/** Every game with what the franchise pages show of it. */
function libraryGames(db, now) {
  const games = db.prepare(`SELECT g.id, g.title, g.cover_url, g.status, COALESCE(SUM(CASE WHEN e.excluded = 0 THEN e.playtime_min END), 0) minutes,
      GROUP_CONCAT(DISTINCT e.platform) platforms, MAX(e.last_played_at) last_played
    FROM games g JOIN entries e ON e.game_id = g.id GROUP BY g.id`).all();
  const meta = new Map(db.prepare('SELECT game_id, name, release_date FROM game_meta WHERE igdb_id IS NOT NULL').all().map((m) => [m.game_id, m]));
  const store = new Map();
  for (const r of db.prepare("SELECT game_id, MIN(json_extract(hist, '$.release_at')) t FROM entries WHERE json_extract(hist, '$.release_at') > 31536000000 GROUP BY game_id").all()) store.set(r.game_id, r.t);
  const days = new Map(db.prepare('SELECT game_id, MIN(day) first, MAX(day) last FROM play_days WHERE excluded = 0 GROUP BY game_id').all().map((r) => [r.game_id, r]));
  const sets = new Map(db.prepare(`SELECT e.game_id, COUNT(*) total, SUM(a.unlocked) unlocked, MAX(CASE WHEN a.unlocked = 1 AND a.grade = 'platinum' THEN 1 ELSE 0 END) plat
    FROM achievements a JOIN entries e ON e.id = a.entry_id WHERE e.excluded = 0 GROUP BY e.game_id`).all().map((r) => [r.game_id, r]));
  const tags = new Map();
  for (const t of db.prepare("SELECT game_id, name FROM game_tags WHERE kind = 'franchise'").all()) { if (!tags.has(t.game_id)) tags.set(t.game_id, []); tags.get(t.game_id).push(t.name); }
  const recent = dayKey(now - PLAYING_DAYS * DAY);
  return games.map((g) => {
    const m = meta.get(g.id);
    // IGDB's release is a calendar day at midnight UTC
    const igdb = m?.release_date > 31536000000 ? (() => { const d = new Date(m.release_date); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12).getTime(); })() : null;
    const release = store.get(g.id) ?? igdb;
    const d = days.get(g.id);
    const set = sets.get(g.id);
    const complete = !!(set && ((set.total > 0 && set.unlocked === set.total) || set.plat));
    const lastDay = d?.last || (g.last_played > 31536000000 ? dayKey(g.last_played) : null);
    const state = FINISHED.has(g.status) || complete ? 'finished' : g.status === 'dropped' ? 'dropped'
      : g.minutes > 0 && (g.status === 'playing' || (lastDay && lastDay >= recent)) ? 'playing' : g.minutes > 0 ? 'played' : 'owned';
    return {
      id: g.id, title: g.title, cover_url: g.cover_url, status: g.status, minutes: g.minutes, platforms: (g.platforms || '').split(',').filter(Boolean),
      first_day: d?.first || null, last_day: lastDay, release_at: release || null, release_year: release ? new Date(release).getFullYear() : null,
      igdb_name: m?.name || null, franchises: tags.get(g.id) || [], complete, state,
    };
  });
}

/** The curated entry a game is, if any: by title, then by IGDB's release year when a title names two. */
function entryOf(g) {
  const cands = BY_KEY.get(normalizeTitle(g.title)) || (g.igdb_name ? BY_KEY.get(normalizeTitle(g.igdb_name)) : null);
  if (!cands?.length) return null;
  if (g.release_year == null) return cands.reduce((a, b) => (b.e.year > a.e.year ? b : a)); // a modern copy, most likely
  const best = cands.reduce((a, b) => (Math.abs(b.e.year - g.release_year) < Math.abs(a.e.year - g.release_year) ? b : a));
  // a title IGDB knows under another name, years from the entry: another game of that name (a launcher, a remaster of its own)
  const named = g.igdb_name && best.e.keys.includes(normalizeTitle(g.igdb_name));
  return Math.abs(best.e.year - g.release_year) <= 3 || named ? best : null;
}

/** The curated franchise a game that is no curated entry belongs to: IGDB's franchise, else the title's beginning. */
function curatedOf(g) {
  for (const n of g.franchises) { const f = BY_ALIAS.get(normalizeTitle(n)); if (f) return f; }
  const key = normalizeTitle(g.title);
  for (const f of CURATED) if (f.prefix.some((p) => key === p || key.startsWith(`${p} `))) return f;
  return null;
}

/** Every franchise with games of yours: Map id -> record. */
export function franchiseIndex(db, { now = Date.now() } = {}) {
  return memo(db, `franchises:${dayKey(now)}`, () => {
    const games = libraryGames(db, now);
    const byGame = new Map(games.map((g) => [g.id, g]));
    const out = new Map();
    const record = (f) => {
      if (!out.has(f.id)) out.set(f.id, { id: f.id, name: f.name, curated: !!f.curated, def: f, matched: new Map(), extras: [] });
      return out.get(f.id);
    };
    const placed = new Set();
    for (const g of games) {
      const hit = entryOf(g);
      if (hit) {
        const r = record(hit.f);
        if (!r.matched.has(hit.e.i)) r.matched.set(hit.e.i, []);
        r.matched.get(hit.e.i).push(g);
        placed.add(g.id);
        continue;
      }
      const f = curatedOf(g);
      if (f) { record(f).extras.push(g); placed.add(g.id); }
    }
    // the rest: IGDB's franchises and the titles' series, in release order
    const series = seriesOf(db);
    const inferred = new Map();
    for (const [id, names] of series) {
      if (placed.has(id) || !byGame.has(id)) continue;
      for (const name of names) {
        const curated = BY_ALIAS.get(normalizeTitle(name));
        if (curated) { record(curated).extras.push(byGame.get(id)); placed.add(id); break; }
        const key = `s-${slug(name)}`;
        if (!inferred.has(key)) inferred.set(key, { id: key, name, curated: false, def: null, matched: new Map(), extras: [] });
        inferred.get(key).extras.push(byGame.get(id));
      }
    }
    for (const [k, r] of inferred) if (r.extras.length >= 2) out.set(k, r);
    for (const r of out.values()) build(r, now);
    return out;
  });
}

const PLAYED = new Set(['played', 'playing', 'finished', 'dropped']);
const pub = (g) => g && ({ id: g.id, title: g.title, cover_url: g.cover_url, minutes: g.minutes, status: g.status, state: g.state, platforms: g.platforms, first_day: g.first_day, last_day: g.last_day, complete: g.complete });

/** A franchise's timeline in release order, its totals, what to play next and the order you played it in. */
function build(r, now) {
  const items = [];
  if (r.curated) {
    // the entries a collection you own holds, when you own them no other way
    const via = new Map();
    for (const e of r.def.entries) {
      const owned = (r.matched.get(e.i) || [])[0];
      if (e.kind === 'collection' && owned) for (const t of e.includes) { const inc = r.def.entries.find((x) => x.title === t); if (inc && !via.has(inc.i)) via.set(inc.i, owned); }
    }
    for (const e of r.def.entries) {
      const gs = r.matched.get(e.i) || [];
      // two copies of one entry (a game the library keeps apart): the most played speaks for it
      const g = gs.sort((a, b) => b.minutes - a.minutes)[0] || null;
      const v = !g && via.get(e.i);
      items.push({ key: `e${e.i}`, year: e.year, title: e.title, kind: e.kind, curated: true, game: pub(g), others: gs.slice(1).map((x) => ({ id: x.id, title: x.title })),
        via: v ? { game_id: v.id, title: v.title } : null, state: g ? g.state : v ? 'owned' : 'missing' });
    }
  }
  // games of the franchise that are no curated entry, placed by their release (or first play)
  for (const g of r.extras) {
    const year = g.release_year ?? (g.first_day ? Number(g.first_day.slice(0, 4)) : null);
    items.push({ key: `g${g.id}`, year, title: g.title, kind: r.curated ? 'other' : 'main', curated: false, game: pub(g), others: [], via: null, state: g.state, release_at: g.release_at });
  }
  items.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || (a.curated && b.curated ? Number(a.key.slice(1)) - Number(b.key.slice(1)) : a.curated ? -1 : b.curated ? 1 : (a.release_at || 0) - (b.release_at || 0)));
  const games = new Map();
  for (const it of items) if (it.game) games.set(it.game.id, it.game);
  const list = [...games.values()];
  const firsts = list.map((g) => g.first_day).filter(Boolean).sort();
  const lasts = list.map((g) => g.last_day).filter(Boolean).sort();
  const main = items.filter((it) => it.kind === 'main');
  const isPlayed = (it) => PLAYED.has(it.state);
  // next: in release order, the first main entry (or remake) not played yet after the last one you
  // played; with none after it, the closest one before it (Final Fantasy VII Remake for a Rebirth
  // player, Halo 5 for an Infinite one); with nothing played, the first
  const story = items.filter((it) => it.kind === 'main' || it.kind === 'remake');
  let lastDone = -1;
  story.forEach((it, i) => { if (isPlayed(it)) lastDone = i; });
  const after = story.slice(lastDone + 1).find((it) => !isPlayed(it));
  const earlier = after ? [] : story.slice(0, Math.max(0, lastDone)).reverse().filter((it) => !isPlayed(it));
  // (of the same kind first: a remake after a remake - the Final Fantasy VII Remake project)
  const before = earlier.find((it) => it.kind === story[lastDone]?.kind) || earlier[0] || null;
  const nextItem = after || before || null;
  // the order you played it in: its games by first play, and how much of it followed the release order
  const yours = list.filter((g) => g.first_day).sort((a, b) => (a.first_day < b.first_day ? -1 : 1));
  const rel = new Map(items.filter((it) => it.game).map((it) => [it.game.id, it.year ?? 9999]));
  let inOrder = 0;
  for (let i = 1; i < yours.length; i++) if (rel.get(yours[i].id) >= rel.get(yours[i - 1].id)) inOrder++;
  r.items = items;
  r.totals = {
    games: list.length, played: list.filter((g) => g.minutes > 0).length, finished: list.filter((g) => g.state === 'finished').length,
    minutes: list.reduce((a, g) => a + g.minutes, 0), first_day: firsts[0] || null, last_day: lasts.at(-1) || null,
    released: items.length ? { from: items.find((it) => it.year)?.year ?? null, to: [...items].reverse().find((it) => it.year)?.year ?? null } : null,
  };
  r.mainline = r.curated ? { total: main.length, owned: main.filter((it) => it.state !== 'missing').length, played: main.filter(isPlayed).length, finished: main.filter((it) => it.state === 'finished').length } : null;
  r.next = nextItem ? { title: nextItem.title, year: nextItem.year, kind: nextItem.kind, game_id: nextItem.game?.id ?? nextItem.via?.game_id ?? null, owned: nextItem.state !== 'missing', via: nextItem.via?.title || null, earlier: !!before } : null;
  r.your_order = { games: yours.map((g) => ({ id: g.id, title: g.title, first_day: g.first_day, year: rel.get(g.id) === 9999 ? null : rel.get(g.id) })), in_release_order: yours.length > 1 ? inOrder : null, pairs: Math.max(0, yours.length - 1) };
  r.story = r.def?.story ? r.def.story.map((t) => items.find((it) => it.curated && it.title === t)).filter(Boolean).map((it) => it.key) : null;
}

const summary = (r) => {
  const covers = [...r.items].filter((it) => it.game?.cover_url).sort((a, b) => b.game.minutes - a.game.minutes).slice(0, 4).map((it) => it.game.cover_url);
  return { id: r.id, name: r.name, curated: r.curated, ...r.totals, mainline: r.mainline, next: r.next, covers };
};

/** Every franchise with a game of yours, most played first. `q` filters by name. */
export function franchiseList(db, { q = '', limit = 500, now = Date.now() } = {}) {
  const want = normalizeTitle(q);
  const all = [...franchiseIndex(db, { now }).values()].filter((r) => r.totals.games > 0 && (!want || normalizeTitle(r.name).includes(want)));
  all.sort((a, b) => b.totals.minutes - a.totals.minutes || b.totals.games - a.totals.games || a.name.localeCompare(b.name));
  return { total: all.length, curated: all.filter((r) => r.curated).length, items: all.slice(0, limit).map(summary) };
}

/** One franchise by its id or its name (a series' name, an alias of a curated one), or null. */
export function franchiseDetail(db, key, { now = Date.now() } = {}) {
  const idx = franchiseIndex(db, { now });
  const k = String(key || '');
  const r = idx.get(k) || idx.get(BY_ALIAS.get(normalizeTitle(k))?.id) || idx.get(`s-${slug(k)}`) || [...idx.values()].find((x) => normalizeTitle(x.name) === normalizeTitle(k));
  if (!r) {
    // a curated franchise you own nothing of yet: its timeline, all of it missing
    const f = BY_ID.get(k) || BY_ALIAS.get(normalizeTitle(k));
    if (!f) return null;
    const empty = { id: f.id, name: f.name, curated: true, def: f, matched: new Map(), extras: [] };
    build(empty, now);
    return detail(empty);
  }
  return detail(r);
}

const detail = (r) => ({ ...summary(r), items: r.items, your_order: r.your_order, story: r.story });

/** The franchise a game is part of, with its place in it and the entries either side (release order). */
export function gameFranchise(db, gameId, { now = Date.now() } = {}) {
  for (const r of franchiseIndex(db, { now }).values()) {
    const i = r.items.findIndex((it) => it.game?.id === gameId || it.game && it.others?.some((o) => o.id === gameId));
    if (i < 0) continue;
    const ref = (it) => (it ? { title: it.title, year: it.year, game_id: it.game?.id ?? null, state: it.state } : null);
    const it = r.items[i];
    const mains = r.items.filter((x) => x.kind === 'main');
    const pos = mains.indexOf(it);
    // either side: of a main game (or a remake), the main games and remakes around it - Halo 5 before
    // Halo Infinite, not the spin-off between them; of anything else, its neighbours
    const line = it.kind === 'main' || it.kind === 'remake' ? r.items.filter((x) => x.kind === 'main' || x.kind === 'remake') : r.items;
    const j = line.indexOf(it);
    return { id: r.id, name: r.name, curated: r.curated, kind: it.kind, year: it.year, position: pos >= 0 ? pos + 1 : null, of: mains.length, index: i + 1, count: r.items.length,
      prev: ref(line[j - 1]), next: ref(line[j + 1]), mainline: r.mainline };
  }
  return null;
}

export const CURATED_IDS = CURATED.map((f) => f.id);
