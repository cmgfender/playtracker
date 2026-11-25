// Your own eras: stretches of your life you name ("College", "High school", "After the wedding"),
// each a legend of what you played in it. Kept in settings (key legend_eras), so they travel with
// backups and need no schema of their own.

import { HttpError } from '../../util.js';

const KEY = 'legend_eras';
const DISMISSED = 'legend_eras_dismissed';
const MAX = 60;
const pad = (n) => String(n).padStart(2, '0');

/** "2012", "2012-09" or "2012-09-01" as a day: the first of the period, or its last (`end`). Null when empty. */
function day(v, end, field) {
  if (v == null || v === '') return null;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(String(v).trim());
  if (!m) throw new HttpError(400, `${field} must be a date: 2012, 2012-09 or 2012-09-01`);
  const y = Number(m[1]); const mo = m[2] ? Number(m[2]) : (end ? 12 : 1);
  const last = new Date(y, mo, 0).getDate();
  const d = m[3] ? Number(m[3]) : (end ? last : 1);
  if (y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > last) throw new HttpError(400, `${field} is not a real date`);
  return `${y}-${pad(mo)}-${pad(d)}`;
}

function clean(body, was = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const name = 'name' in b ? String(b.name ?? '').trim().replace(/\s+/g, ' ') : was.name;
  if (!name) throw new HttpError(400, 'An era needs a name');
  if (name.length > 60) throw new HttpError(400, 'An era\'s name is at most 60 characters');
  const from = 'from' in b ? day(b.from, false, 'from') : was.from;
  if (!from) throw new HttpError(400, 'An era needs the date it began');
  const to = 'to' in b ? day(b.to, true, 'to') : (was.to ?? null);
  if (to && to < from) throw new HttpError(400, 'An era ends after it begins');
  const note = 'note' in b ? String(b.note ?? '').trim().slice(0, 200) : (was.note || '');
  return { name, from, to, note };
}

/** Your eras, oldest first: [{ id, name, from (YYYY-MM-DD), to (YYYY-MM-DD | null: still going), note }]. */
export function listEras(settings) {
  const v = settings.get(KEY);
  return (Array.isArray(v) ? v : []).filter((e) => e && e.id && e.name && e.from).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.id - b.id));
}

export function addEra(settings, body) {
  const all = listEras(settings);
  if (all.length >= MAX) throw new HttpError(400, `At most ${MAX} eras`);
  const era = { id: all.reduce((a, e) => Math.max(a, e.id), 0) + 1, ...clean(body) };
  settings.set({ [KEY]: [...all, era] });
  return era;
}

export function updateEra(settings, id, body) {
  const all = listEras(settings);
  const was = all.find((e) => e.id === id);
  if (!was) throw new HttpError(404, 'No such era');
  const era = { id, ...clean(body, was) };
  settings.set({ [KEY]: all.map((e) => (e.id === id ? era : e)) });
  return era;
}

export function removeEra(settings, id) {
  const all = listEras(settings);
  if (!all.some((e) => e.id === id)) throw new HttpError(404, 'No such era');
  settings.set({ [KEY]: all.filter((e) => e.id !== id) });
  return { ok: true };
}

// ---- eras found in your play, to adopt with one click

const ym = (k) => { const [y, m] = k.split('-').map(Number); return y * 12 + m - 1; };
const ymKey = (n) => `${Math.floor(n / 12)}-${pad((n % 12) + 1)}`;
const lastDay = (k) => { const [y, m] = k.split('-').map(Number); return `${k}-${pad(new Date(y, m, 0).getDate())}`; };

/** A game is a regular of a month with this share of its hours, and this many of them. */
const REGULAR_SHARE = 0.15;
const REGULAR_MINUTES = 6 * 60;
/** Months a game may be away inside its own stretch (a holiday, another release) before the stretch ends. */
const GAP_MONTHS = 2;
const MIN_MONTHS = 6;
/** Where play is entered by hand or imported: no place to have "years" in. */
const NOT_A_PLACE = new Set(['manual', 'import', 'custom']);
/** A platform owns a year with this share of its hours. */
const PLATFORM_SHARE = 0.7;

/** The keys of suggestions set aside. */
export const dismissedEras = (settings) => { const v = settings.get(DISMISSED); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; };
export function dismissEra(settings, key) {
  const k = String(key || '').slice(0, 80);
  if (!/^(?:game|platform):[\w-]+:\d{4}$/.test(k)) throw new HttpError(400, 'No such suggestion');
  settings.set({ [DISMISSED]: [...new Set([...dismissedEras(settings), k])].slice(-200) });
  return { ok: true };
}

/**
 * Stretches of a career that stand out by themselves, each one an era to adopt: the months one game
 * kept coming back and was played more than any other ("The Fortnite years"), and the years one platform
 * held nearly all the play ("The Xbox years", when another platform had its own). Not the ones an era of yours already covers, nor those set aside.
 * [{ key, name, from (YYYY-MM-DD), to (YYYY-MM-DD | null: still going), minutes, why, game?: { id, title, cover_url } }]
 */
export function suggestEras(db, settings, { today, platformName = (p) => p, limit = 4 } = {}) {
  const months = new Map(); // ym -> { total, games: Map id -> minutes, plats: Map }
  for (const r of db.prepare(`SELECT substr(day, 1, 7) k, game_id, platform, SUM(minutes) m FROM play_days WHERE excluded = 0 AND day <= ? GROUP BY k, game_id, platform`).all(today)) {
    if (!months.has(r.k)) months.set(r.k, { total: 0, games: new Map(), plats: new Map() });
    const x = months.get(r.k);
    x.total += r.m; x.games.set(r.game_id, (x.games.get(r.game_id) || 0) + r.m); x.plats.set(r.platform, (x.plats.get(r.platform) || 0) + r.m);
  }
  if (!months.size) return [];
  const nowYm = ym(today.slice(0, 7));
  const out = [];
  // the months a game was a regular of
  const led = new Map(); // game id -> [{ n, minutes }]
  for (const [k, x] of months) {
    for (const [id, m] of x.games) if (m >= REGULAR_MINUTES && m >= x.total * REGULAR_SHARE) { if (!led.has(id)) led.set(id, []); led.get(id).push({ n: ym(k), minutes: m }); }
  }
  // was it the most played game of a stretch of months?
  const leads = (id, from, to) => {
    const sum = new Map();
    for (let n = from; n <= to; n++) for (const [g, m] of months.get(ymKey(n))?.games || []) sum.set(g, (sum.get(g) || 0) + m);
    const mine = sum.get(id) || 0;
    for (const [g, m] of sum) if (g !== id && m > mine) return false;
    return true;
  };
  const title = db.prepare('SELECT id, title, cover_url FROM games WHERE id = ?');
  for (const [id, ms] of led) {
    ms.sort((a, b) => a.n - b.n);
    let run = [];
    const close = () => {
      const len = run.length ? run.at(-1).n - run[0].n + 1 : 0;
      if (len >= MIN_MONTHS && run.length >= len * 0.6 && leads(id, run[0].n, run.at(-1).n)) {
        const g = title.get(id);
        const minutes = Math.round(run.reduce((a, r) => a + r.minutes, 0));
        const going = run.at(-1).n >= nowYm - 1;
        if (g) out.push({ key: `game:${id}:${Math.floor(run[0].n / 12)}`, name: `The ${g.title} ${len >= 18 ? 'years' : 'months'}`, from: `${ymKey(run[0].n)}-01`, to: going ? null : lastDay(ymKey(run.at(-1).n)), minutes,
          why: `Your most played game for ${len} months`, game: g });
      }
      run = [];
    };
    for (const m of ms) { if (run.length && m.n - run.at(-1).n - 1 > GAP_MONTHS) close(); run.push(m); }
    close();
  }
  // the years a platform held: only when the record has more than one such platform (else it is the whole career)
  const years = new Map();
  for (const [k, x] of months) {
    const y = Number(k.slice(0, 4));
    if (!years.has(y)) years.set(y, { total: 0, plats: new Map() });
    const yr = years.get(y); yr.total += x.total;
    for (const [p, m] of x.plats) yr.plats.set(p, (yr.plats.get(p) || 0) + m);
  }
  const owner = [...years].sort((a, b) => a[0] - b[0]).map(([y, x]) => { let top = null; for (const [p, m] of x.plats) if (!top || m > top.m) top = { p, m }; return { y, p: top && top.m >= x.total * PLATFORM_SHARE && top.m >= 20 * 60 ? top.p : null, m: top?.m || 0 }; });
  const runs = [];
  for (const o of owner) { if (NOT_A_PLACE.has(o.p)) o.p = null; const last = runs.at(-1); if (o.p && last && last.p === o.p && last.to === o.y - 1) { last.to = o.y; last.minutes += o.m; } else if (o.p) runs.push({ p: o.p, from: o.y, to: o.y, minutes: o.m }); }
  if (new Set(runs.map((r) => r.p)).size > 1) {
    const thisYear = Number(today.slice(0, 4));
    for (const r of runs.filter((x) => x.to - x.from >= 1)) {
      out.push({ key: `platform:${r.p}:${r.from}`, name: `The ${platformName(r.p)} years`, from: `${r.from}-01-01`, to: r.to >= thisYear ? null : `${r.to}-12-31`, minutes: Math.round(r.minutes),
        why: `Nearly all you played from ${r.from} to ${r.to >= thisYear ? 'today' : r.to} was there` });
    }
  }
  // not what an era of yours already covers (most of the suggestion inside it), nor what was set aside
  const eras = listEras(settings);
  const gone = new Set(dismissedEras(settings));
  const days = (a, b) => Math.max(0, (new Date(`${b}T12:00`) - new Date(`${a}T12:00`)) / 86_400_000 + 1);
  const covered = (s) => eras.some((e) => {
    const sTo = s.to || today; const eTo = e.to || today;
    const both = days(s.from > e.from ? s.from : e.from, sTo < eTo ? sTo : eTo);
    return both >= days(s.from, sTo) * 0.6 && both >= days(e.from, eTo) * 0.6;
  });
  return out.filter((s) => !gone.has(s.key) && !covered(s)).sort((a, b) => b.minutes - a.minutes).slice(0, limit);
}
