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

import { normalizeTitle } from './titles.js';
import { memo, dayKey } from './stats.js';
import { seriesOf } from './series.js';
import { BY_ALIAS, BY_ID, yearless, slug } from './franchises/catalog.js';
import { entryOf, curatedOf } from './franchises/match.js';
import { libraryGames } from './franchises/library.js';
import { build } from './franchises/timeline.js';

// The parts, each on its own: franchises/catalog.js (the curated data, prepared), franchises/match.js
// (what a game is: RULES for store titles), franchises/library.js (your games), franchises/timeline.js
// (a franchise's timeline, eras, next and your order). The data: src/data/franchises/, one file each.
export { KINDS, slug, CURATED_IDS } from './franchises/catalog.js';
export { matchTitle } from './franchises/match.js';

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

