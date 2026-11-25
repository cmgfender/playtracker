// Franchises: the series your games belong to, as first-class things. The big ones are curated
// (src/data/franchises.js): every main entry in release order - the ones you don't own too - with
// spin-offs, remakes, remasters, re-releases and collections, the eras the series falls into, and the
// story order where the story is told out of order. The rest come from IGDB's franchises and the
// titles themselves (series.js), in release order by IGDB's dates.
//
// Your games are matched to curated entries by title; when one title names two games (Doom 1993
// and Doom 2016, Modern Warfare 2 and II) IGDB's release year decides. A game is also understood
// when it is
//  - a version of an entry: a remaster or re-release under the entry's name with a suffix
//    ("- Master Collection Version", "Remastered", "HD") or a later release under the same name
//    (the 2021 Pixel Remaster of Final Fantasy, Red Dead Redemption on PS4) - its own place in the
//    timeline, linked to the original
//  - a test build of an entry (a beta, an insider build, a public test server) or what comes with
//    it (bonus content, a soundtrack) - kept with the entry, which it does not count as played
//  - a mode or a platform's build of an entry (DOOM Eternal's BATTLEMODE, "- Xbox Series X|S") -
//    the entry itself
//  - a launcher or hub (the Call of Duty app holds every new Call of Duty): known store ids, or a
//    game named only after the series
// A version or a collection you own or played stands for its original: Resident Evil 2 is played
// when you played the 2019 remake; Halo 3 is in your library through The Master Chief Collection.

import { FRANCHISES } from '../data/franchises.js';
import { normalizeTitle } from './titles.js';
import { memo, dayKey } from './stats.js';
import { seriesOf } from './series.js';

const DAY = 86_400_000;
const FINISHED = new Set(['completed', 'beaten']);
const PLAYING_DAYS = 30;
export const KINDS = ['main', 'spinoff', 'remake', 'remaster', 'rerelease', 'collection'];
/** Kinds that are another version of an earlier entry (`of`). */
const VERSION_KINDS = new Set(['remake', 'remaster', 'rerelease']);
const yearless = (t) => String(t || '').replace(/\s*\((?:19|20)\d{2}\)$/, '');
export const slug = (name) => normalizeTitle(name).replace(/\s+/g, '-') || 'series';

// Suffixes on a store's title, matched on the title as it is (before normalising). Each strips one
// trailing part, joined by a dash, a colon or brackets or just a space.
const tail = (words) => new RegExp(`\\s*(?:[-–—:|]\\s*|\\(\\s*|\\[\\s*)?(?:${words})\\s*[)\\]]?\\s*$`, 'i');
/** A test build: a beta, an insider build, a public test server, a demo. Not the game. */
const TEST = tail("(?:(?:open|closed|public|private|early|multiplayer|technical|tech|network|stress|downloadable|playable) )*(?:beta|alpha|insider|demo|trial|playtest|test server|test|preview|server slam)|pts");
/** What comes with a game and is not one: bonus content, a soundtrack, an art book. */
const BONUS = tail("bonus content|digital bonus content|soundtrack|original soundtrack|ost|art ?book|digital art ?book|friend'?s pass");
/** A mode or a platform's build of the same game. */
const SAME = tail("battlemode|multiplayer|campaign|base game|full game|xbox series x ?\\| ?s|xbox series x|xbox one|xbox 360|windows 10|windows pc|windows|pc|ps4|ps5|nintendo switch 2 edition|nintendo switch edition|for (?:xbox one|xbox series x ?\\| ?s|xbox 360|pc)|(?:[\\w'’]+ ){0,2}edition");
/** One episode of an episodic game ("- Episode 1: Zer0 Sum", "(Episode One)"): the game. */
const EPISODE = /\s*[(\-–—:]+\s*episode\s+(?:\d+|one|two|three|four|five|six)\b.*$/i;
/** A brand in front of the series' own name ("EA SPORTS FIFA 16"). */
const BRAND = /^(?:ea sports|ea sports™|2k sports|2k)\s+/i;
/** A version: remastered, remade or released again with its name kept. */
const VERSION = tail("(?:the )?(?:hd )?remaster(?:ed)?|pixel remaster|master collection version|hd remix|hd edition|hd|classic edition|classic|redux|reforged|resurrected|remake|reimagined|vr");
const strip = (t, re) => { let s = t; for (let i = 0; i < 2; i++) { const n = s.replace(re, '').trim(); if (n === s || !n) break; s = n; } return s; };

// the curated franchises, their entries keyed by normalised title
const CURATED = FRANCHISES.map((f) => {
  const entries = f.entries.map(([year, title, kind = 'main', opts = {}], i) => ({
    i, year, title, kind, includes: opts.includes || [], ofTitles: [].concat(opts.of || []), partial: !!opts.partial, eraName: opts.era || null,
    keys: [...new Set([title, yearless(title), ...(opts.aka || [])].map(normalizeTitle))],
  }));
  const byTitle = new Map(entries.map((e) => [e.title, e]));
  for (const e of entries) {
    e.of = e.ofTitles.map((t) => byTitle.get(t)?.i).filter((x) => x != null);
    e.inc = e.includes.map((t) => byTitle.get(t)?.i).filter((x) => x != null);
  }
  // the originals a version comes down to: a remaster of a remake is a version of the original
  const rootsOf = (e, seen) => (!e.of.length || seen.has(e.i) ? [e.i] : (seen.add(e.i), [...new Set(e.of.flatMap((j) => rootsOf(entries[j], seen)))]));
  for (const e of entries) e.roots = VERSION_KINDS.has(e.kind) && e.of.length ? rootsOf(e, new Set()) : [];
  // eras: each from its first entry up to the next era's first, in release order
  const eras = (f.eras || []).map(([start, name, note]) => ({ start: byTitle.get(start)?.i ?? -1, name, note })).filter((x) => x.start >= 0).sort((a, b) => a.start - b.start);
  for (const e of entries) {
    let k = 0;
    eras.forEach((x, j) => { if (x.start <= e.i) k = j; });
    const named = e.eraName ? eras.findIndex((x) => x.name === e.eraName) : -1;
    e.era = eras.length ? (named >= 0 ? named : k) : null;
  }
  for (const x of eras) x.from = entries[x.start].year;
  const hubs = (f.hubs || []).map((h) => ({ ...h, idset: new Set(Object.entries(h.ids || {}).flatMap(([p, ids]) => ids.map((id) => `${p}:${id}`))) }));
  return { ...f, curated: true, aliasKeys: new Set(f.aliases.map(normalizeTitle)), prefix: f.prefix.map(normalizeTitle), entries, eras, hubs };
});
const BY_KEY = new Map();
for (const f of CURATED) for (const e of f.entries) for (const k of e.keys) { if (!BY_KEY.has(k)) BY_KEY.set(k, []); BY_KEY.get(k).push({ f, e }); }
const BY_ALIAS = new Map();
for (const f of CURATED) for (const k of f.aliasKeys) if (!BY_ALIAS.has(k)) BY_ALIAS.set(k, f);
const BY_ID = new Map(CURATED.map((f) => [f.id, f]));
// the prefixes by their first word: a title is checked against the few that can start it
const PREFIXES = new Map();
for (const f of CURATED) for (const p of f.prefix) { const w = p.split(' ')[0]; if (!PREFIXES.has(w)) PREFIXES.set(w, []); PREFIXES.get(w).push({ f, p }); }
const WITH_HUBS = CURATED.filter((f) => f.hubs.length);

/** Every game with what the franchise pages show of it. */
function libraryGames(db, now) {
  const games = db.prepare(`SELECT g.id, g.title, g.cover_url, g.status, COALESCE(SUM(CASE WHEN e.excluded = 0 THEN e.playtime_min END), 0) minutes,
      GROUP_CONCAT(DISTINCT e.platform) platforms, MAX(e.last_played_at) last_played
    FROM games g JOIN entries e ON e.game_id = g.id GROUP BY g.id`).all();
  const meta = new Map(db.prepare('SELECT game_id, name, release_date FROM game_meta WHERE igdb_id IS NOT NULL').all().map((m) => [m.game_id, m]));
  const store = new Map();
  for (const r of db.prepare("SELECT game_id, MIN(json_extract(hist, '$.release_at')) t FROM entries WHERE json_extract(hist, '$.release_at') > 31536000000 GROUP BY game_id").all()) store.set(r.game_id, r.t);
  const ids = new Map();
  for (const r of db.prepare('SELECT game_id, platform, ext_id FROM entries').all()) { if (!ids.has(r.game_id)) ids.set(r.game_id, []); ids.get(r.game_id).push(`${r.platform}:${r.ext_id}`); }
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
      igdb_name: m?.name || null, franchises: tags.get(g.id) || [], complete, state, ids: ids.get(g.id) || [],
    };
  });
}

/**
 * The curated entry a normalised title names, told apart by the game's release year when it names
 * two. `how` is 'title' (the entry itself) or 'version' (a later release under its name). `igdbKey`,
 * when given, is what IGDB calls the game: a later release IGDB knows by another name is not a
 * version of the entry (the Call of Duty app is not the 2003 game).
 */
function matchKey(key, g, igdbKey) {
  const cands = key && BY_KEY.get(key);
  if (!cands?.length) return null;
  const y = g.release_year;
  if (y == null) return { hit: cands.reduce((a, b) => (b.e.year > a.e.year ? b : a)), how: 'title' }; // a modern copy, most likely
  const best = cands.reduce((a, b) => (Math.abs(b.e.year - y) < Math.abs(a.e.year - y) ? b : a));
  const d = y - best.e.year;
  if (Math.abs(d) <= 3) return { hit: best, how: 'title' };
  const named = igdbKey != null && best.e.keys.includes(igdbKey);
  if (d > 3 && (igdbKey == null || named)) {
    // a later release under the entry's name that is one of its curated versions (Steam sells the
    // Resident Evil HD Remaster as "Resident Evil"): that version
    const { f, e } = best;
    const kin = (x) => x.of.includes(e.i) || x.roots.includes(e.i) || (e.roots.length && e.roots.some((r) => x.roots.includes(r)));
    const near = f.entries.filter((x) => x !== e && VERSION_KINDS.has(x.kind) && kin(x) && Math.abs(x.year - y) <= 1);
    if (near.length) return { hit: { f, e: near.reduce((a, b) => (Math.abs(b.year - y) < Math.abs(a.year - y) ? b : a)) }, how: 'title' };
    return { hit: best, how: 'version' };
  }
  return d < 0 && named ? { hit: best, how: 'title' } : null;
}

/** What a game is in the curated franchises: { f, e, how: title|version|test|bonus } or { f, hub, how: 'hub' }, or null. */
function entryOf(g) {
  for (const f of WITH_HUBS) for (const hub of f.hubs) if (g.ids.some((id) => hub.idset.has(id))) return { f, hub, how: 'hub' };
  const igdbKey = g.igdb_name ? normalizeTitle(yearless(g.igdb_name)) : null;
  const as = (m, how) => m && { f: m.hit.f, e: m.hit.e, how: how || m.how };
  const title = yearless(g.title);
  const tries = [title, title.replace(EPISODE, ''), title.replace(BRAND, ''), g.igdb_name && yearless(g.igdb_name)].filter((t, i, a) => t && a.indexOf(t) === i);
  for (const raw of tries) {
    const fromIgdb = raw !== title && raw === (g.igdb_name && yearless(g.igdb_name));
    const exact = matchKey(normalizeTitle(raw), g, fromIgdb ? null : igdbKey);
    if (exact) return as(exact);
    // a test build: matched without a year (a beta comes out before its game)
    const t = strip(raw, TEST);
    if (t !== raw) { const m = matchKey(normalizeTitle(strip(t, SAME)), { ...g, release_year: null }); if (m) return as(m, 'test'); }
    const b = strip(raw, BONUS);
    if (b !== raw) { const m = matchKey(normalizeTitle(b), { ...g, release_year: null }); if (m) return as(m, 'bonus'); }
    // a mode, or a platform's build: the game itself, whenever that build came out
    const s = strip(raw, SAME);
    if (s !== raw) { const k = normalizeTitle(s); const m = matchKey(k, g, null) || matchKey(k, { ...g, release_year: null }); if (m) return as(m, 'title'); }
    // a remaster or re-release under the original's name: a version, unless it came out with it
    const v = strip(s, VERSION);
    if (v !== s) {
      const m = matchKey(normalizeTitle(v), g);
      if (m) return as(m, g.release_year != null && g.release_year - m.hit.e.year <= 1 && m.how === 'title' ? 'title' : 'version');
    }
  }
  return null;
}

/**
 * The curated franchise a game that is no curated entry belongs to: the title's beginning (the
 * longest prefix wins: "Super Mario Kart" is Mario Kart's, not Super Mario's), else IGDB's franchise
 * - the title first, as IGDB tags a Persona game with Megami Tensei as well as Persona.
 */
function curatedOf(g) {
  const key = normalizeTitle(g.title);
  let best = null;
  for (const { f, p } of PREFIXES.get(key.split(' ')[0]) || []) if ((key === p || key.startsWith(`${p} `)) && (!best || p.length > best.p.length)) best = { f, p };
  if (best) return best.f;
  for (const n of g.franchises) { const f = BY_ALIAS.get(normalizeTitle(n)); if (f) return f; }
  return null;
}

const record = (out, f) => {
  if (!out.has(f.id)) out.set(f.id, { id: f.id, name: f.name, curated: !!f.curated, def: f, matched: new Map(), versions: [], addons: new Map(), hubs: [], extras: [] });
  return out.get(f.id);
};

/** Every franchise with games of yours: Map id -> record. */
export function franchiseIndex(db, { now = Date.now() } = {}) {
  return memo(db, `franchises:${dayKey(now)}`, () => {
    const games = libraryGames(db, now);
    const byGame = new Map(games.map((g) => [g.id, g]));
    const out = new Map();
    const placed = new Set();
    for (const g of games) {
      const hit = entryOf(g);
      if (hit) {
        const r = record(out, hit.f);
        if (hit.how === 'hub') r.hubs.push({ g, hub: hit.hub });
        else if (hit.how === 'version') r.versions.push({ g, e: hit.e });
        else {
          const add = hit.how === 'test' || hit.how === 'bonus';
          const map = add ? r.addons : r.matched;
          if (!map.has(hit.e.i)) map.set(hit.e.i, []);
          map.get(hit.e.i).push(add ? { ...g, addon: hit.how } : g);
        }
        placed.add(g.id);
        continue;
      }
      const f = curatedOf(g);
      if (f) {
        // a game named only after the series (an app, a hub): IGDB's year for it is a guess
        if (f.aliasKeys.has(normalizeTitle(yearless(g.title)))) record(out, f).hubs.push({ g, hub: null });
        else record(out, f).extras.push(g);
        placed.add(g.id);
      }
    }
    // the rest: IGDB's franchises and the titles' series, in release order
    const series = seriesOf(db);
    const inferred = new Map();
    for (const [id, names] of series) {
      if (placed.has(id) || !byGame.has(id)) continue;
      for (const name of names) {
        const curated = BY_ALIAS.get(normalizeTitle(name));
        if (curated) { record(out, curated).extras.push(byGame.get(id)); placed.add(id); break; }
        const key = `s-${slug(name)}`;
        if (!inferred.has(key)) inferred.set(key, { id: key, name, curated: false, def: null, matched: new Map(), versions: [], addons: new Map(), hubs: [], extras: [] });
        inferred.get(key).extras.push(byGame.get(id));
      }
    }
    for (const [k, r] of inferred) if (r.extras.length >= 2) out.set(k, r);
    for (const r of out.values()) build(r, now);
    return out;
  });
}

const PLAYED = new Set(['played', 'playing', 'finished', 'dropped']);
// which state speaks for an entry when several versions of it are yours
const RANK = { finished: 5, playing: 4, played: 3, dropped: 2, owned: 1, missing: 0 };
const pub = (g) => g && ({ id: g.id, title: g.title, cover_url: g.cover_url, minutes: g.minutes, status: g.status, state: g.state, platforms: g.platforms, first_day: g.first_day, last_day: g.last_day, complete: g.complete });
const ref = (it) => ({ key: it.key, title: it.title, year: it.year, kind: it.kind, state: it.state, game_id: it.game?.id ?? null });
const firstYear = (g) => (g.first_day ? Number(g.first_day.slice(0, 4)) : g.last_day ? Number(g.last_day.slice(0, 4)) : null);

/** The era a year falls in, for what is not a curated entry: the last era begun by then. */
function eraOfYear(eras, year) {
  if (!eras.length) return null;
  let k = 0;
  if (year != null) eras.forEach((x, j) => { if (x.from <= year) k = j; });
  else k = eras.length - 1;
  return k;
}

/** A franchise's timeline in release order, its eras, totals, what to play next and the order you played it in. */
function build(r, now) {
  const items = [];
  const eras = r.def?.eras || [];
  if (r.curated) {
    for (const e of r.def.entries) {
      const gs = (r.matched.get(e.i) || []).sort((a, b) => b.minutes - a.minutes);
      // two copies of one entry (a game the library keeps apart): the most played speaks for it
      const g = gs[0] || null;
      items.push({ key: `e${e.i}`, year: e.year, title: e.title, kind: e.kind, curated: true, era: e.era, eraFixed: !!e.eraName, game: pub(g), others: gs.slice(1).map((x) => ({ id: x.id, title: x.title })),
        addons: (r.addons.get(e.i) || []).map((x) => ({ id: x.id, title: x.title, minutes: x.minutes, kind: x.addon })), state: g ? g.state : 'missing', own: g ? g.state : 'missing',
        via: null, of: [], versions: [], partial: e.partial, entry: e });
    }
    // versions found in the library (a later release under the entry's name, a "Remastered")
    for (const { g, e } of r.versions) {
      const year = g.release_year ?? firstYear(g);
      items.push({ key: `v${g.id}`, year, title: g.title, kind: 'rerelease', curated: false, era: eraOfYear(eras, year), game: pub(g), others: [], addons: [], state: g.state, own: g.state,
        via: null, of: [], versions: [], partial: false, release_at: g.release_at, ofEntry: e.i });
    }
  }
  // launchers and hubs: placed when they began (or when you first played them)
  for (const { g, hub } of r.hubs) {
    const year = hub?.from ?? firstYear(g) ?? g.release_year;
    items.push({ key: `h${g.id}`, year, title: hub?.title || g.title, kind: 'hub', curated: false, era: eraOfYear(eras, year), game: pub(g), others: [], addons: [], state: g.state, own: g.state,
      via: null, of: [], versions: [], partial: false, note: hub?.note || null });
  }
  // games of the franchise that are no curated entry, placed by their release (or first play)
  for (const g of r.extras) {
    const year = g.release_year ?? firstYear(g);
    items.push({ key: `g${g.id}`, year, title: g.title, kind: r.curated ? 'other' : 'main', curated: false, era: eraOfYear(eras, year), game: pub(g), others: [], addons: [], state: g.state, own: g.state,
      via: null, of: [], versions: [], partial: false, release_at: g.release_at });
  }
  const byEntry = new Map(items.filter((it) => it.entry).map((it) => [it.entry.i, it]));
  if (r.curated) {
    // versions: what each one is a version of, and each original's versions
    for (const it of items) {
      // (a version found in the library of a remaster is a version of the remaster's original)
      const target = it.ofEntry != null ? r.def.entries[it.ofEntry] : null;
      const roots = it.entry ? it.entry.roots : target ? (target.roots.length ? target.roots : [target.i]) : [];
      const direct = it.entry ? it.entry.of : target ? [target.i] : [];
      it.of = direct.map((j) => byEntry.get(j)).filter(Boolean).map((o) => ({ key: o.key, title: o.title, year: o.year }));
      if (it.partial) continue; // a remake of part of it (the Final Fantasy VII Remake project) stands for none of it
      for (const j of roots) byEntry.get(j)?.versions.push(it);
    }
    // collections: what they hold, and through which version
    for (const it of items) {
      if (it.kind !== 'collection') continue;
      for (const j of it.entry.inc) {
        const inc = byEntry.get(j);
        if (!inc) continue;
        it.of.push({ key: inc.key, title: inc.title, year: inc.year });
        for (const root of inc.entry.roots.length ? inc.entry.roots.map((x) => byEntry.get(x)).filter(Boolean) : [inc]) if (!root.versions.includes(it)) root.versions.push(it);
        if (inc.entry.roots.length && !inc.versions.includes(it)) inc.versions.push(it); // a remaster it holds (Halo 2: Anniversary in the collection)
      }
    }
    // an entry you have no copy of stands where its best version stands: played as the remake, in the collection
    for (const it of items) {
      if (!it.entry) continue;
      let best = null;
      for (const v of it.versions) {
        // a collection holds its games: in your library through it, played or not (which of them you played it does not say)
        const s = v.kind === 'collection' ? (v.own !== 'missing' ? 'owned' : 'missing') : v.own;
        if (s !== 'missing' && (!best || RANK[s] > RANK[best.s])) best = { v, s };
      }
      if (best && RANK[best.s] > RANK[it.own]) {
        it.state = best.s;
        it.via = { game_id: best.v.game?.id ?? null, title: best.v.title, kind: best.v.kind, year: best.v.year, key: best.v.key };
      }
    }
  }
  items.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || (a.curated && b.curated ? a.entry.i - b.entry.i : a.curated ? -1 : b.curated ? 1 : (a.release_at || 0) - (b.release_at || 0)));
  // the games of yours, each once (a beta or bonus content counts its time, not as a game)
  const games = new Map();
  for (const it of items) if (it.game) games.set(it.game.id, it.game);
  const list = [...games.values()];
  const addonMinutes = items.reduce((a, it) => a + it.addons.reduce((b, t) => b + t.minutes, 0), 0);
  const firsts = list.map((g) => g.first_day).filter(Boolean).sort();
  const lasts = list.map((g) => g.last_day).filter(Boolean).sort();
  const main = items.filter((it) => it.kind === 'main');
  const isPlayed = (it) => PLAYED.has(it.state);
  // next: in release order, the first main game (or part of a remake told in parts) not played
  // yet - played in any version - after the last one you played; with none after it, the closest
  // one before it (Final Fantasy VII Remake for a Rebirth player, Halo 5 for an Infinite one);
  // with nothing played, the first
  const story = items.filter((it) => it.kind === 'main' || (it.kind === 'remake' && it.partial));
  let lastDone = -1;
  story.forEach((it, i) => { if (isPlayed(it)) lastDone = i; });
  const after = story.slice(lastDone + 1).find((it) => !isPlayed(it));
  const earlier = after ? [] : story.slice(0, Math.max(0, lastDone)).reverse().filter((it) => !isPlayed(it));
  // (of the same kind first: a part of the remake after a part of the remake)
  const before = earlier.find((it) => it.kind === story[lastDone]?.kind) || earlier[0] || null;
  const nextItem = after || before || null;
  // the order you played it in: its games by first play, and how much of it followed the release order
  const yours = list.filter((g) => g.first_day).sort((a, b) => (a.first_day < b.first_day ? -1 : 1));
  const rel = new Map(items.filter((it) => it.game).map((it) => [it.game.id, it.year ?? 9999]));
  let inOrder = 0;
  for (let i = 1; i < yours.length; i++) if (rel.get(yours[i].id) >= rel.get(yours[i - 1].id)) inOrder++;
  // eras: their years, your games and play in each, how much of each one's main games you have played
  r.eras = eras.map((x, j) => {
    const its = items.filter((it) => it.era === j);
    // its years: of what came out in it (a remaster placed with the games it remasters came out later)
    const ys = (its.some((it) => !it.eraFixed) ? its.filter((it) => !it.eraFixed) : its).map((it) => it.year).filter((y) => y != null);
    const gs = [...new Map(its.filter((it) => it.game).map((it) => [it.game.id, it.game])).values()];
    const m = its.filter((it) => it.kind === 'main');
    const fd = gs.map((g) => g.first_day).filter(Boolean).sort(); const ld = gs.map((g) => g.last_day).filter(Boolean).sort();
    return { index: j, name: x.name, note: x.note, from: ys.length ? Math.min(...ys) : x.from, to: ys.length ? Math.max(...ys) : x.from,
      main: { total: m.length, owned: m.filter((it) => it.state !== 'missing').length, played: m.filter(isPlayed).length, finished: m.filter((it) => it.state === 'finished').length },
      games: gs.length, minutes: gs.reduce((a, g) => a + g.minutes, 0) + its.reduce((a, it) => a + it.addons.reduce((b, t) => b + t.minutes, 0), 0), first_day: fd[0] || null, last_day: ld.at(-1) || null };
  });
  const top = r.eras.reduce((a, x) => (x.minutes > (a?.minutes || 0) ? x : a), null);
  r.your_era = top ? top.index : null;
  r.items = items.map(({ entry, ofEntry, own, partial, versions, eraFixed, ...it }) => ({ ...it, ...(partial ? { partial: true } : {}), versions: versions.map(ref) }));
  r.totals = {
    games: list.length, played: list.filter((g) => g.minutes > 0).length, finished: list.filter((g) => g.state === 'finished').length,
    minutes: list.reduce((a, g) => a + g.minutes, 0) + addonMinutes, first_day: firsts[0] || null, last_day: lasts.at(-1) || null,
    released: items.length ? { from: items.find((it) => it.year)?.year ?? null, to: [...items].reverse().find((it) => it.year)?.year ?? null } : null,
  };
  r.mainline = r.curated ? { total: main.length, owned: main.filter((it) => it.state !== 'missing').length, played: main.filter(isPlayed).length, finished: main.filter((it) => it.state === 'finished').length } : null;
  // what to play it as: the copy you have, else the version you own, else its newest version
  const playAs = (it) => {
    if (!it || it.own !== 'missing') return null;
    if (it.via) return it.via;
    const v = it.versions.filter((x) => x.kind !== 'collection').sort((a, b) => (b.year ?? 0) - (a.year ?? 0))[0];
    return v ? { game_id: null, title: v.title, kind: v.kind, year: v.year, key: v.key } : null;
  };
  const pa = playAs(nextItem);
  r.next = nextItem ? { title: nextItem.title, year: nextItem.year, kind: nextItem.kind, game_id: nextItem.game?.id ?? nextItem.via?.game_id ?? null, owned: nextItem.state !== 'missing',
    via: nextItem.via?.title || null, play_as: pa && !nextItem.via ? { title: pa.title, year: pa.year, kind: pa.kind } : null, earlier: !!before } : null;
  r.your_order = { games: yours.map((g) => ({ id: g.id, title: g.title, first_day: g.first_day, year: rel.get(g.id) === 9999 ? null : rel.get(g.id) })), in_release_order: yours.length > 1 ? inOrder : null, pairs: Math.max(0, yours.length - 1) };
  r.story = r.def?.story ? r.def.story.map((t) => r.items.find((it) => it.curated && it.title === t)).filter(Boolean).map((it) => it.key) : null;
}

const summary = (r) => {
  const covers = [...r.items].filter((it) => it.game?.cover_url).sort((a, b) => b.game.minutes - a.game.minutes).slice(0, 4).map((it) => it.game.cover_url);
  const era = r.your_era != null ? r.eras[r.your_era] : null;
  return { id: r.id, name: r.name, curated: r.curated, ...r.totals, mainline: r.mainline, next: r.next, covers, era_count: r.eras.length, your_era: era ? { index: era.index, name: era.name, from: era.from, to: era.to } : null };
};

/** Every franchise with a game of yours, most played first. `q` filters by name. */
export function franchiseList(db, { q = '', limit = 500, now = Date.now() } = {}) {
  const want = normalizeTitle(q);
  const all = [...franchiseIndex(db, { now }).values()].filter((r) => r.totals.games > 0 && (!want || normalizeTitle(r.name).includes(want)));
  all.sort((a, b) => b.totals.minutes - a.totals.minutes || b.totals.games - a.totals.games || a.name.localeCompare(b.name));
  return { total: all.length, curated: all.filter((r) => r.curated).length, items: all.slice(0, limit).map(summary) };
}

const empty = (f) => ({ id: f.id, name: f.name, curated: true, def: f, matched: new Map(), versions: [], addons: new Map(), hubs: [], extras: [] });

/** One franchise by its id or its name (a series' name, an alias of a curated one), or null. */
export function franchiseDetail(db, key, { now = Date.now() } = {}) {
  const idx = franchiseIndex(db, { now });
  const k = String(key || '');
  const r = idx.get(k) || idx.get(BY_ALIAS.get(normalizeTitle(k))?.id) || idx.get(`s-${slug(k)}`) || [...idx.values()].find((x) => normalizeTitle(x.name) === normalizeTitle(k));
  if (!r) {
    // a curated franchise you own nothing of yet: its timeline, all of it missing
    const f = BY_ID.get(k) || BY_ALIAS.get(normalizeTitle(k));
    if (!f) return null;
    const blank = empty(f);
    build(blank, now);
    return detail(blank);
  }
  return detail(r);
}

const detail = (r) => ({ ...summary(r), eras: r.eras, items: r.items, your_order: r.your_order, story: r.story });

/** The franchise a game is part of: its place in it, its era, what it is a version of, and the entries either side (release order). */
export function gameFranchise(db, gameId, { now = Date.now() } = {}) {
  for (const r of franchiseIndex(db, { now }).values()) {
    let addon = null; // a beta or bonus content of the entry
    let i = r.items.findIndex((it) => it.game?.id === gameId || (it.game && it.others?.some((o) => o.id === gameId)));
    if (i < 0) { i = r.items.findIndex((it) => it.addons?.some((t) => t.id === gameId)); if (i >= 0) addon = r.items[i].addons.find((t) => t.id === gameId).kind; }
    if (i < 0) continue;
    const near = (it) => (it ? { title: it.title, year: it.year, game_id: it.game?.id ?? it.via?.game_id ?? null, state: it.state } : null);
    const it = r.items[i];
    const mains = r.items.filter((x) => x.kind === 'main');
    const pos = mains.indexOf(it);
    // either side: of a main game (or a part of a remake), the main games around it - Halo 5 before
    // Halo Infinite, not the spin-off between them; of a version, the main games around its original;
    // of anything else, its neighbours
    const line = r.items.filter((x) => x.kind === 'main' || (x.kind === 'remake' && x.partial));
    const anchor = line.includes(it) ? it : it.of?.length && !['collection'].includes(it.kind) ? r.items.find((x) => x.key === it.of[0].key) : null;
    const j = anchor ? line.indexOf(anchor) : -1;
    const around = j >= 0 ? [line[j - 1], line[j + 1]] : [r.items[i - 1], r.items[i + 1]];
    const era = it.era != null ? r.eras[it.era] : null;
    return { id: r.id, name: r.name, curated: r.curated, kind: it.kind, year: it.year, title: it.title, addon, position: pos >= 0 ? pos + 1 : null, of: mains.length, index: i + 1, count: r.items.length,
      prev: near(around[0]), next: near(around[1]), mainline: r.mainline, era: era ? { name: era.name, note: era.note, from: era.from, to: era.to, index: era.index } : null, eras: r.eras.length,
      version_of: it.kind !== 'collection' ? it.of || [] : [], holds: it.kind === 'collection' ? it.of : [], versions: it.versions || [], via: it.via || null, note: it.note || null };
  }
  return null;
}

export const CURATED_IDS = CURATED.map((f) => f.id);
