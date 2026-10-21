// Long-run verification: ~6 months of tracked play across Steam, PlayStation and Xbox in one
// database, every kind of import, and exact consistency checks against a ground truth.
// Runs in a DST timezone so day buckets cross both clock changes.
process.env.TZ = process.env.LONGRUN_TZ || 'America/New_York';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { tx } from '../src/db.js';
import { applyItems, parseAccount } from '../src/services/sync.js';
import { importRows, parseCsv, exportChunks } from '../src/services/importer.js';
import { providers } from '../src/providers/index.js';
import { mergeEvidence, reinferMany } from '../src/services/inference.js';
import { flushRollups } from '../src/services/rollup.js';
import { rng } from './helpers/world.js';
import { nextRun } from '../src/services/schedule.js';
import { MIN, HOUR, DAY, makeTimeline, platforms, minutesByDay, minutesByMonth, misplacement } from './helpers/world.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const REPORT = !!process.env.LONGRUN_REPORT;
const say = (...a) => { if (REPORT) console.log(...a); };

function localAt(t, h) { const d = new Date(t); d.setHours(h, 0, 0, 0); return d.getTime(); }
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }

const NOW = Date.now();
const T0 = localAt(addDays(NOW, -183), 4);     // Steam + imports start
const END = localAt(addDays(NOW, -1), 4);       // ~6 months later
const PSN_AT = localAt(addDays(T0, 60), 4) + 7 * HOUR;  // PSN connected two months in (11:00)
const XBOX_AT = localAt(addDays(T0, 90), 4) + 9 * HOUR; // Xbox connected three months in (13:00)
const STEAM_GAMES = 30;
const PSN_GAMES = 12;
const XBOX_GAMES = 6;
const NEW_GAME = 27;   // bought and played 100 days in
const REFUNDED = 26;   // refunded 150 days in
const DUP_GAME = 3;    // also in the CSV spreadsheet -> double counted

// ---------------- ground truth ----------------
const steamTruth = makeTimeline({ seed: 11, from: T0 - 400 * DAY, to: END, games: STEAM_GAMES, legacyGames: [28, 29] })
  .filter((s) => s.game !== NEW_GAME && !(s.game === REFUNDED && s.start > T0 + 150 * DAY));
{
  // new purchase: first played the evening it was bought
  const d = localAt(addDays(T0, 100), 20);
  steamTruth.push({ game: NEW_GAME, start: d, end: d + 95 * MIN, minutes: 95 });
  // offline play during days 120-125, uploaded 25 days later (outside the 14-day counter)
  for (const s of steamTruth) if (s.start > T0 + 120 * DAY && s.start < T0 + 125 * DAY) s.uploadAt = T0 + 150 * DAY + 3 * HOUR;
  steamTruth.sort((a, b) => a.start - b.start);
}
const psnTruth = makeTimeline({ seed: 22, from: T0 - 500 * DAY, to: END, games: PSN_GAMES });
const xboxTruth = makeTimeline({ seed: 33, from: T0 - 300 * DAY, to: END, games: XBOX_GAMES });
const switchTruth = makeTimeline({ seed: 44, from: T0 - 600 * DAY, to: T0 - DAY, games: 5 });

let app; let db; let svc; let settings; let base;
const accounts = {};
const firstReport = { steam: new Map(), psn: new Map(), xbox: new Map() }; // ext -> minutes at first appearance
let steamLate = 0;
let runMs = 0;

const call = async (path, { method = 'GET', body } = {}) => {
  const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return res.json();
};

function acct(id) { return parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id)); }

function sync(platform, t, items, { complete = true } = {}) {
  const id = accounts[platform];
  const a = acct(id);
  // what each title reported when first seen in an import (initial sync or budget back-fill)
  const importing = !a.last_sync_at;
  for (const it of items) if (!firstReport[platform].has(it.extId) && (importing || it.backfill)) firstReport[platform].set(it.extId, it.playtimeMin);
  tx(db, () => {
    const s = applyItems(db, a, items, { settings: settings.all(), now: t, syncId: null, initial: !a.last_sync_at, complete });
    if (platform === 'steam') steamLate += s.late_minutes;
    const state = { ...a.state };
    if (s.calibration.start || s.calibration.end) {
      const prev = state.calibration?.last_played || { start: 0, end: 0 };
      state.calibration = { last_played: { start: prev.start + s.calibration.start, end: prev.end + s.calibration.end } };
    }
    db.prepare('UPDATE accounts SET last_sync_at = ?, state = ? WHERE id = ?').run(t, JSON.stringify(state), id);
  });
}

before(async () => {
  app = createApp({ dbFile: ':memory:', log: quiet, scheduler: false });
  db = app.app.db; svc = app.app.sync; settings = app.app.settings;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  for (const p of ['steam', 'psn', 'xbox']) {
    accounts[p] = Number(db.prepare('INSERT INTO accounts(platform, name, created_at, enabled, config) VALUES (?, ?, ?, 0, ?)').run(p, `My ${p}`, T0, JSON.stringify({ presence: p === 'xbox' ? 'off' : 'on' })).lastInsertRowid);
  }
  const t = Date.now();

  // ---------- imports at T0 ----------
  // Switch spreadsheet (CSV) with first/last played + launches, plus one Steam game duplicated
  const sw = [];
  for (let g = 0; g < 5; g++) {
    const s = switchTruth.filter((x) => x.game === g);
    if (!s.length) continue;
    const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
    sw.push(`"Switch Game ${g}",switch,${(s.reduce((a, x) => a + x.minutes, 0) / 60).toFixed(2)},${fmt(s[0].start)},${fmt(s.at(-1).end)},${s.length},completed`);
  }
  const dup = steamTruth.filter((s) => s.game === DUP_GAME && s.end <= T0);
  sw.push(`"Steam Game ${DUP_GAME}",steam,${(dup.reduce((a, x) => a + x.minutes, 0) / 60).toFixed(2)},,,,`);
  importRows(db, parseCsv(`title,platform,playtime_hours,first_played,last_played,play_count,status\n${sw.join('\n')}\n`), { settings: settings.all(), now: T0 });
  // JSON import with explicit sessions (+ more total than the sessions cover) - twice (idempotent)
  const retro = { games: [{ title: 'Retro Game', platform: 'emulator', playtime_minutes: 1500, last_played: new Date(T0 - 20 * DAY).toISOString(),
    sessions: Array.from({ length: 10 }, (_, i) => ({ started_at: new Date(T0 - (60 - i * 4) * DAY + 19 * HOUR).toISOString(), minutes: 45 })) }] };
  importRows(db, retro.games, { settings: settings.all(), now: T0 });
  importRows(db, retro.games, { settings: settings.all(), now: T0 });

  // ---------- six months of syncs and presence ----------
  const events = [];
  const DAILY = { schedule_mode: 'daily', schedule_time: '04:00' };
  const startAt = { steam: T0, psn: PSN_AT, xbox: XBOX_AT };
  for (const p of ['steam', 'psn', 'xbox']) {
    let n = nextRun(DAILY, startAt[p], startAt[p]);
    while (n <= END) { events.push({ t: n, kind: 'sync', p }); n = nextRun(DAILY, n, n); }
  }
  const truthOf = { steam: steamTruth, psn: psnTruth };
  for (const p of ['steam', 'psn']) {
    const iv = providers[p].profile.presence.interval_sec * 1000;
    for (const s of truthOf[p]) {
      if (s.start < startAt[p] || s.uploadAt) continue; // offline play is invisible to presence
      for (let q = Math.ceil((s.start - iv) / iv) * iv; q <= s.end + 2 * iv; q += iv) events.push({ t: q, kind: 'poll', p });
    }
  }
  events.sort((a, b) => a.t - b.t || (a.kind === 'sync' ? -1 : 1));
  const reportFor = (p, t) => (p === 'steam'
    ? platforms.steam.report(steamTruth, t, STEAM_GAMES, { refunded: new Set(t > T0 + 150 * DAY ? [REFUNDED] : []), owned: (g, tt) => g !== NEW_GAME || tt > T0 + 100 * DAY })
    : p === 'psn' ? platforms.psn.report(psnTruth, t, PSN_GAMES)
      : platforms.xbox.report(xboxTruth, t, XBOX_GAMES));

  // initial syncs: Steam at T0; PSN/Xbox when connected (Xbox defers titles over its hourly budget)
  sync('steam', T0, reportFor('steam', T0));
  let manualDone = false;
  const seenPoll = new Map();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!manualDone && e.t > T0 + 30 * DAY) {
      manualDone = true;
      const g = await call('/games', { method: 'POST', body: { title: 'Handheld Game' } });
      for (let k = 0; k < 5; k++) await call('/sessions', { method: 'POST', body: { game_id: g.id, minutes: 40 + k * 10, ended_at: localAt(addDays(T0, 31 + k), 13) } });
    }
    if (e.p === 'psn' && e.t < PSN_AT) continue;
    if (e.p === 'psn' && !acct(accounts.psn).last_sync_at) sync('psn', PSN_AT, reportFor('psn', PSN_AT));
    if (e.p === 'xbox' && !acct(accounts.xbox).last_sync_at) {
      sync('xbox', XBOX_AT, platforms.xbox.report(xboxTruth, XBOX_AT, XBOX_GAMES, { only: [0, 1] }), { complete: false });
      const deferred = new Set(Array.from({ length: XBOX_GAMES }, (_, g) => platforms.xbox.extId(g)).filter((x) => !['5000', '5001'].includes(x)));
      // next hour: budget available again -> deferred titles arrive, marked as back-fill
      sync('xbox', XBOX_AT + HOUR, platforms.xbox.report(xboxTruth, XBOX_AT + HOUR, XBOX_GAMES).map((it) => (deferred.has(it.extId) && !firstReport.xbox.has(it.extId) ? { ...it, backfill: true } : it)));
    }
    if (e.kind === 'sync') { sync(e.p, e.t, reportFor(e.p, e.t)); continue; }
    // presence poll
    const iv = providers[e.p].profile.presence.interval_sec;
    const playing = truthOf[e.p].filter((s) => s.start <= e.t && s.end > e.t && !s.uploadAt)
      .map((s) => ({ extId: (e.p === 'steam' ? platforms.steam : platforms.psn).extId(s.game) }));
    const a = acct(accounts[e.p]);
    svc.presenceState.set(a.id, { lastPoll: seenPoll.get(e.p) && e.t - seenPoll.get(e.p) <= iv * 1000 ? seenPoll.get(e.p) : e.t - iv * 1000 });
    const r = svc.applyPresence(a, playing, { intervalSec: iv, now: e.t });
    seenPoll.set(e.p, e.t);
    if (r.closed) {
      const at = e.t + providers[e.p].profile.presence.sync_after_sec * 1000;
      let j = i + 1;
      while (j < events.length && events[j].t < at) j++;
      events.splice(j, 0, { t: at, kind: 'sync', p: e.p });
    }
  }
  // final catch-up (everything reported, offline uploads included)
  for (const p of ['steam', 'psn', 'xbox']) sync(p, END + 2 * HOUR, reportFor(p, END + 2 * HOUR));
  runMs = Date.now() - t;
  say(`simulated ${events.length} events in ${runMs} ms`);
});
after(() => app?.close());

// ---------------- checks ----------------
const kindSum = (where, ...a) => db.prepare(`SELECT COALESCE(SUM(s.minutes), 0) m FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE ${where}`).get(...a).m;

test('every entry: sessions (tracked + dated history + undated) add up to the platform total', () => {
  const bad = db.prepare(`SELECT e.id, e.title, e.platform, e.playtime_min, COALESCE(SUM(s.minutes), 0) m FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id
    GROUP BY e.id HAVING m != e.playtime_min`).all();
  assert.deepEqual(bad, [], `mismatched entries: ${JSON.stringify(bad.slice(0, 5))}`);
});

test('rollups equal sessions; nothing pending', () => {
  const r = db.prepare('SELECT ROUND(SUM(minutes)) m FROM play_days').get().m;
  const s = db.prepare("SELECT SUM(minutes) m FROM sessions WHERE kind IN ('play', 'estimate')").get().m;
  assert.equal(r, s);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rollup_queue').get().n, 0);
});

test('per account: tracked play = everything after it was connected; history = everything before', () => {
  for (const p of ['steam', 'psn', 'xbox']) {
    const id = accounts[p];
    const final = new Map(db.prepare('SELECT ext_id, playtime_min FROM entries WHERE account_id = ?').all(id).map((r) => [r.ext_id, r.playtime_min]));
    const histExpected = [...firstReport[p].values()].reduce((a, x) => a + x, 0);
    const finalTotal = [...final.values()].reduce((a, x) => a + x, 0);
    const tracked = kindSum("e.account_id = ? AND s.kind = 'play'", id);
    const history = kindSum("e.account_id = ? AND s.source = 'inferred'", id);
    const late = kindSum("e.account_id = ? AND s.kind = 'baseline' AND s.source = 'sync'", id);
    say(`${p}: total ${finalTotal} | history ${history} (expected ${histExpected}) | tracked ${tracked} | late ${late}`);
    assert.equal(history, histExpected, `${p} history`);
    assert.equal(tracked + late, finalTotal - histExpected, `${p} tracked + late`);
  }
  // Steam offline play uploaded 25 days late is recognised as late, not crammed into a day
  const offline = steamTruth.filter((s) => s.uploadAt).reduce((a, s) => a + s.minutes, 0);
  assert.ok(offline > 0);
  assert.equal(steamLate, offline, 'offline minutes identified as late uploads');
});

test('tracked play matches the truth day by day (DST included)', () => {
  const rows = (id) => db.prepare("SELECT p.day, SUM(p.minutes) m FROM play_days p JOIN entries e ON e.id = p.entry_id WHERE p.estimated = 0 AND e.account_id = ? GROUP BY p.day").all(id);
  const check = (p, truth, from, limit) => {
    const exp = minutesByDay(truth.filter((s) => s.start >= from && !s.uploadAt));
    const got = new Map(rows(accounts[p]).map((r) => [r.day, r.m]));
    const err = misplacement(exp, got);
    say(`${p}: tracked minutes on the wrong day ${(err * 100).toFixed(2)}%`);
    assert.ok(err < limit, `${p} misplaced ${(err * 100).toFixed(1)}%`);
  };
  check('steam', steamTruth, T0, 0.02);    // presence
  check('psn', psnTruth, PSN_AT, 0.02);    // presence
  check('xbox', xboxTruth, XBOX_AT + HOUR, 0.12); // daily, no presence
  // presence-backed sessions are one per real session
  const exact = db.prepare("SELECT COUNT(*) n FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.account_id = ? AND s.confidence = 'exact'").get(accounts.psn).n;
  const real = psnTruth.filter((s) => s.start >= PSN_AT).length;
  assert.ok(exact >= real * 0.97, `psn exact ${exact} vs ${real}`);
});

test('history is dated before tracking began, never spikes, and lands in the right months', () => {
  // no estimate on/after the entry's tracking start
  const late = db.prepare(`SELECT e.title, MAX(s.window_end) w, json_extract(e.hist, '$.tracking_start') ts FROM sessions s JOIN entries e ON e.id = s.entry_id
    WHERE s.kind = 'estimate' GROUP BY e.id HAVING w > ts`).all();
  assert.deepEqual(late, [], JSON.stringify(late.slice(0, 5).map((x) => ({ ...x, w: new Date(x.w).toISOString(), ts: new Date(x.ts).toISOString() }))));
  // no day of estimated history above the library-wide cap (+ chunk smoothing)
  const maxDay = db.prepare('SELECT MAX(m) m FROM (SELECT SUM(minutes) m FROM play_days WHERE estimated = 1 GROUP BY day)').get().m;
  say(`busiest day of estimated history: ${Math.round(maxDay)} min`);
  assert.ok(maxDay <= 720 * 1.35, `estimated day of ${Math.round(maxDay)} min`);
  // nothing lands on the import/connection days as a burst
  for (const t of [T0, PSN_AT, XBOX_AT]) {
    const d = new Date(t); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const m = db.prepare('SELECT COALESCE(SUM(minutes), 0) m FROM play_days WHERE estimated = 1 AND day = ?').get(k).m;
    assert.ok(m <= 720, `import day ${k} has ${Math.round(m)} estimated minutes`);
  }
  // month-level accuracy of dated history vs where the play really happened
  const monthErr = (p, truth, cut) => {
    const exp = minutesByMonth(minutesByDay(truth.filter((s) => s.end <= cut && !s.legacy)));
    const got = minutesByMonth(new Map(db.prepare("SELECT p.day, SUM(p.minutes) m FROM play_days p JOIN entries e ON e.id = p.entry_id WHERE p.estimated = 1 AND e.account_id IS ? AND e.platform = ? GROUP BY p.day")
      .all(p === 'switch' ? null : accounts[p], p).map((r) => [r.day, r.m])));
    return misplacement(exp, got);
  };
  const errs = { psn: monthErr('psn', psnTruth, PSN_AT), switch: monthErr('switch', switchTruth, T0), steam: monthErr('steam', steamTruth, T0), xbox: monthErr('xbox', xboxTruth, XBOX_AT) };
  say(`history in the wrong month: ${Object.entries(errs).map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`).join(', ')}`);
  assert.ok(errs.psn < 0.45 && errs.switch < 0.45, 'first/last-played history lands mostly in the right months');
  // Steam legacy titles (no timestamps) stay undated, not charted
  const legacy = db.prepare("SELECT COALESCE(SUM(s.minutes),0) m FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.ext_id IN ('1028','1029') AND s.kind = 'baseline'").get().m;
  assert.equal(legacy, steamTruth.filter((s) => s.legacy).reduce((a, s) => a + s.minutes, 0));
});

test('achievement unlock times (enrichment) sharpen Steam history dating', () => {
  const steamMonths = () => {
    const exp = minutesByMonth(minutesByDay(steamTruth.filter((s) => s.end <= T0 && !s.legacy)));
    const got = minutesByMonth(new Map(db.prepare("SELECT p.day, SUM(p.minutes) m FROM play_days p JOIN entries e ON e.id = p.entry_id WHERE p.estimated = 1 AND e.account_id = ? GROUP BY p.day").all(accounts.steam).map((r) => [r.day, r.m])));
    return misplacement(exp, got);
  };
  const before_ = steamMonths();
  // like GetPlayerAchievements: an unlock during roughly a third of real sessions
  const r = rng(7);
  const ids = [];
  tx(db, () => {
    for (const e of db.prepare('SELECT id, ext_id FROM entries WHERE account_id = ? AND baseline_min > 0').all(accounts.steam)) {
      const g = Number(e.ext_id) - 1000;
      const anchors = steamTruth.filter((s) => s.game === g && s.end <= T0 && !s.legacy && r() < 0.33).map((s) => s.start + Math.floor(r() * s.minutes) * MIN);
      if (anchors.length) { mergeEvidence(db, e.id, { anchors }); ids.push(e.id); }
    }
    flushRollups(db);
    reinferMany(db, ids, { settings: settings.all() });
    flushRollups(db);
  });
  const after_ = steamMonths();
  say(`steam history in the wrong month: ${(before_ * 100).toFixed(1)}% -> ${(after_ * 100).toFixed(1)}% with achievement times`);
  assert.ok(after_ < before_ * 0.75, `achievements should clearly help (${before_} -> ${after_})`);
  // still consistent
  const bad = db.prepare('SELECT e.id FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes),0) != e.playtime_min').all();
  assert.deepEqual(bad, []);
});

test('imports: CSV + JSON (re-imported) + manual sessions are counted once, with the right split', () => {
  const retro = db.prepare("SELECT e.playtime_min p, (SELECT SUM(minutes) FROM sessions WHERE entry_id = e.id AND kind = 'play') t FROM entries e WHERE e.title = 'Retro Game'").get();
  assert.equal(retro.p, 1500);
  assert.equal(retro.t, 450, 'explicit sessions imported once');
  const sw = db.prepare("SELECT SUM(playtime_min) m FROM entries WHERE platform = 'switch'").get().m;
  const swTruth = switchTruth.reduce((a, s) => a + s.minutes, 0);
  assert.ok(Math.abs(sw - swTruth) <= 5, `switch ${sw} vs ${swTruth}`); // hours rounded to 2 decimals in the CSV
  const manual = db.prepare("SELECT SUM(minutes) m FROM sessions WHERE source = 'manual'").get().m;
  assert.equal(manual, 40 + 50 + 60 + 70 + 80);
});

test('duplicates: the CSV copy of a Steam game is flagged; excluding it fixes the totals', async () => {
  const d = await call('/duplicates');
  const flag = d.double_counted.find((x) => x.game.title === `Steam Game ${DUP_GAME}`);
  assert.ok(flag, 'flagged as double counted');
  const before_ = (await call('/stats/lifetime')).total_minutes;
  await call(`/entries/${flag.suggest_exclude}`, { method: 'PATCH', body: { excluded: true } });
  const after_ = (await call('/stats/lifetime')).total_minutes;
  const dupMin = db.prepare('SELECT playtime_min FROM entries WHERE id = ?').get(flag.suggest_exclude).playtime_min;
  assert.equal(before_ - after_, dupMin);
  assert.equal(db.prepare('SELECT account_id FROM entries WHERE id = ?').get(flag.suggest_exclude).account_id, null, 'the import copy is the one excluded');
  // lifetime now equals everything that was really played
  const truthTotal = [steamTruth, psnTruth, xboxTruth, switchTruth].flat().reduce((a, s) => a + s.minutes, 0) + 1500 + 300;
  assert.ok(Math.abs(after_ - truthTotal) <= 10, `lifetime ${after_} vs truth ${truthTotal}`);
});

test('stats API, year in review, heatmap and lifetime agree with the database', async () => {
  const all = await call('/stats?range=all&estimates=include');
  const tracked = await call('/stats?range=all&estimates=exclude');
  const rollIn = db.prepare('SELECT ROUND(SUM(minutes)) m FROM play_days WHERE excluded = 0').get().m;
  const rollTr = db.prepare('SELECT ROUND(SUM(minutes)) m FROM play_days WHERE excluded = 0 AND estimated = 0').get().m;
  assert.ok(Math.abs(all.total_minutes - rollIn) <= 1);
  assert.ok(Math.abs(tracked.total_minutes - rollTr) <= 1);
  assert.equal(all.estimated_minutes + all.tracked_minutes, all.total_minutes);
  assert.equal(tracked.sessions, db.prepare("SELECT COUNT(*) n FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE s.kind = 'play' AND e.excluded = 0").get().n);
  for (const y of await call('/stats/years')) {
    const yr = await call(`/stats/year/${y}`);
    const months = yr.months.reduce((a, m) => a + m.minutes, 0);
    const heat = Object.values((await call(`/stats/heatmap?year=${y}`)).days).reduce((a, m) => a + m, 0);
    assert.ok(Math.abs(months - yr.total_minutes) <= 12, `${y}: months ${months} vs ${yr.total_minutes}`);
    assert.ok(Math.abs(heat - yr.total_minutes) <= 366, `${y}: heatmap ${heat} vs ${yr.total_minutes}`);
  }
  const life = await call('/stats/lifetime');
  const sumEntries = db.prepare('SELECT SUM(playtime_min) m FROM entries WHERE excluded = 0').get().m;
  assert.equal(life.total_minutes, sumEntries);
  const week = await call('/stats?range=week&estimates=exclude');
  assert.equal(week.estimated_minutes, 0);
  say(`lifetime ${Math.round(life.total_minutes / 60)}h = tracked ${Math.round(life.tracked_minutes / 60)}h + dated history ${Math.round(life.estimated_minutes / 60)}h + undated ${Math.round(life.baseline_minutes / 60)}h; simulation took ${runMs} ms`);
});

test('export -> import into a fresh instance preserves lifetime, tracked sessions and exclusions', async () => {
  const json = [...exportChunks(db, 'json')].join('');
  const data = JSON.parse(json);
  const fresh = createApp({ dbFile: ':memory:', log: quiet, scheduler: false });
  try {
    importRows(fresh.app.db, data.games, { settings: fresh.app.settings.all() });
    const life = (d) => d.prepare('SELECT SUM(playtime_min) m FROM entries WHERE excluded = 0').get().m;
    const play = (d) => d.prepare("SELECT SUM(s.minutes) m FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE s.kind = 'play' AND e.excluded = 0").get().m;
    assert.equal(life(fresh.app.db), life(db), 'lifetime');
    assert.equal(play(fresh.app.db), play(db), 'tracked minutes');
    assert.equal(fresh.app.db.prepare('SELECT COUNT(*) n FROM entries WHERE excluded = 1').get().n, 1, 'exclusion kept');
    const bad = fresh.app.db.prepare('SELECT e.id FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes),0) != e.playtime_min').all();
    assert.deepEqual(bad, []);
  } finally { fresh.close(); }
});
