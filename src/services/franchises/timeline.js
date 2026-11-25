// A franchise's timeline: its entries in release order with your games on them, the versions and
// collections each entry stands through, its eras, totals, what to play next and the order you
// played it in. `r` is a record of franchiseIndex (src/services/franchises.js).

const PLAYED = new Set(['played', 'playing', 'finished', 'dropped']);
// which state speaks for an entry when several versions of it are yours
const RANK = { finished: 5, playing: 4, played: 3, dropped: 2, owned: 1, wanted: 0.5, missing: 0 };
// yours: anything but missing, or only on your wish list
const HAVE = (s) => s !== 'missing' && s !== 'wanted';
// (a game told in parts - see parts.js - is in it once for each: `uid` tells them apart, `id` is the game's)
const pub = (g) => g && ({ id: g.id, uid: g.uid || String(g.id), title: g.title, cover_url: g.cover_url, minutes: g.minutes, status: g.status, state: g.state, platforms: g.platforms, first_day: g.first_day, last_day: g.last_day, complete: g.complete,
  ...(g.part ? { part: g.part } : {}) });
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
export function build(r, now) {
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
      items.push({ key: `v${g.uid || g.id}`, year, title: g.title, kind: 'rerelease', curated: false, era: eraOfYear(eras, year), game: pub(g), others: [], addons: [], state: g.state, own: g.state,
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
        const s = v.kind === 'collection' ? (HAVE(v.own) ? 'owned' : 'missing') : v.own;
        if (HAVE(s) && (!best || RANK[s] > RANK[best.s])) best = { v, s };
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
  for (const it of items) if (it.game) games.set(it.game.uid, it.game);
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
  const rel = new Map(items.filter((it) => it.game).map((it) => [it.game.uid, it.year ?? 9999]));
  let inOrder = 0;
  for (let i = 1; i < yours.length; i++) if (rel.get(yours[i].uid) >= rel.get(yours[i - 1].uid)) inOrder++;
  // eras: their years, your games and play in each, how much of each one's main games you have played
  r.eras = eras.map((x, j) => {
    const its = items.filter((it) => it.era === j);
    // its years: of what came out in it (a remaster placed with the games it remasters came out later)
    const ys = (its.some((it) => !it.eraFixed) ? its.filter((it) => !it.eraFixed) : its).map((it) => it.year).filter((y) => y != null);
    const gs = [...new Map(its.filter((it) => it.game).map((it) => [it.game.uid, it.game])).values()];
    const m = its.filter((it) => it.kind === 'main');
    const fd = gs.map((g) => g.first_day).filter(Boolean).sort(); const ld = gs.map((g) => g.last_day).filter(Boolean).sort();
    return { index: j, name: x.name, note: x.note, from: ys.length ? Math.min(...ys) : x.from, to: ys.length ? Math.max(...ys) : x.from,
      main: { total: m.length, owned: m.filter((it) => HAVE(it.state)).length, played: m.filter(isPlayed).length, finished: m.filter((it) => it.state === 'finished').length },
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
  r.mainline = r.curated ? { total: main.length, owned: main.filter((it) => HAVE(it.state)).length, played: main.filter(isPlayed).length, finished: main.filter((it) => it.state === 'finished').length } : null;
  // what to play it as: the copy you have, else the version you own, else its newest version
  const playAs = (it) => {
    if (!it || HAVE(it.own)) return null;
    if (it.via) return it.via;
    const v = it.versions.filter((x) => x.kind !== 'collection').sort((a, b) => (b.year ?? 0) - (a.year ?? 0))[0];
    return v ? { game_id: null, title: v.title, kind: v.kind, year: v.year, key: v.key } : null;
  };
  const pa = playAs(nextItem);
  r.next = nextItem ? { title: nextItem.title, year: nextItem.year, kind: nextItem.kind, game_id: nextItem.game?.id ?? nextItem.via?.game_id ?? null, owned: HAVE(nextItem.state),
    via: nextItem.via?.title || null, play_as: pa && !nextItem.via ? { title: pa.title, year: pa.year, kind: pa.kind } : null, earlier: !!before } : null;
  r.your_order = { games: yours.map((g) => ({ id: g.id, title: g.title, first_day: g.first_day, year: rel.get(g.uid) === 9999 ? null : rel.get(g.uid) })), in_release_order: yours.length > 1 ? inOrder : null, pairs: Math.max(0, yours.length - 1) };
  r.story = r.def?.story ? r.def.story.map((t) => r.items.find((it) => it.curated && it.title === t)).filter(Boolean).map((it) => it.key) : null;
}
