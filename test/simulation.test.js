// Ground-truth simulation: a known play history is reported by simulated platforms that
// behave like the real ones (Steam writes totals on exit and stamps last-played at launch;
// PlayStation reports with a 15-minute lag plus launch counts; Xbox flushes minutes
// periodically during play). The real sync engine processes those reports and the
// recorded sessions are compared against the truth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, tx } from '../src/db.js';
import { Settings } from '../src/services/settings.js';
import { applyItems, parseAccount, SyncService } from '../src/services/sync.js';
import { modelFor } from '../src/services/model.js';
import { providers } from '../src/providers/index.js';
import { nextRun } from '../src/services/schedule.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** True sessions: local evenings, some crossing midnight, some long, never overlapping. */
function makeTruth({ seed, start, days, games, longSessions = false }) {
  const r = rng(seed);
  const sessions = [];
  for (let d = 0; d < days; d++) {
    if (r() < 0.25) continue;
    const midnight = new Date(start); midnight.setDate(midnight.getDate() + d);
    let t = midnight.getTime() + (17 + r() * 5) * HOUR;
    const n = 1 + (r() < 0.35 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const dur = Math.round(longSessions ? 60 + r() * 300 : 20 + r() * 220);
      const game = Math.floor(r() * games);
      sessions.push({ game, start: Math.round(t), end: Math.round(t) + dur * MIN, minutes: dur });
      t += dur * MIN + (30 + r() * 90) * MIN;
    }
  }
  return sessions;
}

// ---- simulated platform behaviour ----------------------------------------------------
const PLATFORMS = {
  steam: {
    report(truth, t, games) {
      return Array.from({ length: games }, (_, g) => {
        const done = truth.filter((s) => s.game === g && s.end <= t);
        const started = truth.filter((s) => s.game === g && s.start <= t);
        const total = done.reduce((a, s) => a + s.minutes, 0);
        const recent = done.filter((s) => s.end > t - 14 * DAY).reduce((a, s) => a + s.minutes, 0);
        return { extId: `s${g}`, title: `Steam Game ${g}`, playtimeMin: total, recentMin: recent, lastPlayedAt: started.at(-1)?.start ?? null, devices: { windows: total, deck: 0, offline: 0 } };
      });
    },
  },
  psn: {
    lag: 15 * MIN,
    report(truth, t, games) {
      const seenBy = t - 15 * MIN;
      return Array.from({ length: games }, (_, g) => {
        const done = truth.filter((s) => s.game === g && s.end <= seenBy);
        return {
          extId: `PPSA0${g}_00`, title: `PS Game ${g}`, playtimeMin: done.reduce((a, s) => a + s.minutes, 0),
          lastPlayedAt: done.at(-1)?.end ?? null, firstPlayedAt: done[0]?.start ?? null, playCount: done.length, groupKey: `psn-concept:${g}`,
        };
      });
    },
  },
  xbox: {
    report(truth, t, games) {
      const seenBy = t - 10 * MIN;
      return Array.from({ length: games }, (_, g) => {
        let total = 0;
        let last = null;
        for (const s of truth.filter((x) => x.game === g && x.start <= t)) {
          // minutes flushed in 5-minute steps while playing, reflected 10 minutes late
          const played = Math.min(s.minutes, Math.max(0, Math.floor((seenBy - s.start) / (5 * MIN)) * 5));
          total += s.end <= seenBy ? s.minutes : played;
          last = Math.min(t, s.end);
        }
        return { extId: `${1000 + g}`, title: `Xbox Game ${g}`, playtimeMin: total, lastPlayedAt: last };
      });
    },
  },
};

/**
 * Drive one account through simulated time: scheduled syncs, optional presence polling
 * (with syncs triggered after a session ends, like the real scheduler does).
 */
function simulate({ platform, truth, games, start, days, schedule, presence }) {
  const db = openDb(':memory:');
  const settings = new Settings(db);
  settings.set({ min_session_minutes: 1 });
  const svc = new SyncService({ db, settings, log: quiet });
  const accId = Number(db.prepare('INSERT INTO accounts(platform, name, created_at, enabled) VALUES (?, ?, 0, 0)').run(platform, platform).lastInsertRowid);
  const acct = () => parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(accId));
  const sim = PLATFORMS[platform];
  const profile = providers[platform].profile;
  const events = [];
  const at = (t, kind) => events.push({ t, kind });

  const sync = (t) => {
    const a = acct();
    const items = sim.report(truth, t, games);
    tx(db, () => {
      const s = applyItems(db, a, items, { settings: settings.all(), now: t, syncId: null, initial: !a.last_sync_at });
      const state = { ...a.state };
      if (s.calibration.start || s.calibration.end) {
        const prev = state.calibration?.last_played || { start: 0, end: 0 };
        state.calibration = { last_played: { start: prev.start + s.calibration.start, end: prev.end + s.calibration.end } };
      }
      db.prepare('UPDATE accounts SET last_sync_at = ?, state = ? WHERE id = ?').run(t, JSON.stringify(state), accId);
    });
  };

  // first sync before any play: nothing is history, everything later is tracked
  sync(start);
  let next = nextRun(schedule, start, start);
  while (next < start + (days + 1) * DAY) { at(next, 'sync'); next = nextRun(schedule, next, next); }
  if (presence) for (let t = start + profile.presence.interval_sec * 1000; t < start + (days + 1) * DAY; t += profile.presence.interval_sec * 1000) at(t, 'poll');
  events.sort((a, b) => a.t - b.t);

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.kind === 'sync') { sync(e.t); continue; }
    const playing = truth.filter((s) => s.start <= e.t && s.end > e.t).map((s) => ({ extId: sim.report(truth, e.t, games)[s.game].extId }));
    const r = svc.applyPresence(acct(), playing, { intervalSec: profile.presence.interval_sec, now: e.t });
    svc.presenceState.set(accId, { lastPoll: e.t });
    if (r.closed) {
      // the scheduler syncs shortly after a session ends
      const t = e.t + profile.presence.sync_after_sec * 1000;
      let j = i + 1;
      while (j < events.length && events[j].t < t) j++;
      events.splice(j, 0, { t, kind: 'sync' });
    }
  }
  sync(start + (days + 2) * DAY); // final catch-up
  return { db, acct };
}

// the player's own (local) days, as the app counts them
const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function trueDays(truth) {
  const m = new Map();
  for (const s of truth) {
    for (let t = s.start; t < s.end; t += MIN) m.set(dayKey(t), (m.get(dayKey(t)) || 0) + 1);
  }
  return m;
}
function recordedDays(db) {
  return new Map(db.prepare('SELECT day, SUM(minutes) m FROM play_days WHERE estimated = 0 GROUP BY day').all().map((r) => [r.day, r.m]));
}
/** Share of minutes attributed to the wrong day (0 = perfect). */
function misplaced(truth, db) {
  const a = trueDays(truth);
  const b = recordedDays(db);
  let err = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) err += Math.abs((a.get(k) || 0) - (b.get(k) || 0));
  return err / 2 / truth.reduce((x, s) => x + s.minutes, 0);
}

const START = new Date(2026, 0, 5).getTime(); // local midnight: the test holds in any time zone
const DAILY = { schedule_mode: 'daily', schedule_time: '04:00' };
const scenarios = [
  { platform: 'steam', schedule: DAILY, presence: true },
  { platform: 'steam', schedule: DAILY, presence: false },
  { platform: 'psn', schedule: DAILY, presence: true },
  { platform: 'psn', schedule: DAILY, presence: false },
  { platform: 'xbox', schedule: { schedule_mode: 'hours', schedule_every: 1 }, presence: true, longSessions: true },
  { platform: 'xbox', schedule: DAILY, presence: false },
  { platform: 'steam', schedule: { schedule_mode: 'weekly', schedule_weekday: 1, schedule_time: '04:00' }, presence: false },
];

const SEEDS = (process.env.SIM_SEEDS || '1,2,3').split(',').map(Number);
for (const sc of scenarios) for (const seed of SEEDS) {
  const label = `${sc.platform} · ${sc.schedule.schedule_mode}${sc.schedule.schedule_every ? sc.schedule.schedule_every : ''} · ${sc.presence ? 'presence' : 'no presence'} · seed ${seed}`;
  test(`simulation: ${label}`, () => {
    const games = 3;
    const days = 21;
    const truth = makeTruth({ seed: seed * 1000 + sc.platform.length * 7 + (sc.presence ? 1 : 0), start: START, days, games, longSessions: sc.longSessions });
    const { db, acct } = simulate({ ...sc, truth, games, start: START, days });
    const trueTotal = truth.reduce((a, s) => a + s.minutes, 0);
    const rec = db.prepare("SELECT COUNT(*) n, SUM(minutes) m FROM sessions WHERE kind = 'play'").get();
    const other = db.prepare("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE kind != 'play'").get().m;

    if (process.env.SIM_DEBUG && rec.m !== trueTotal) {
      for (const t of truth) {
        const near = db.prepare("SELECT minutes, kind, confidence, started_at, ended_at, note FROM sessions WHERE started_at BETWEEN ? AND ? OR (window_start <= ? AND window_end >= ?)").all(t.start - 30 * MIN, t.end, t.start, t.end);
        const got = near.reduce((a, x) => a + x.minutes, 0);
        if (got !== t.minutes) console.log('TRUE', new Date(t.start).toISOString(), t.game, t.minutes, 'REC', JSON.stringify(near.map((x) => [x.minutes, x.kind, x.confidence, x.started_at && new Date(x.started_at).toISOString(), x.note])));
      }
      console.log('other', db.prepare("SELECT kind, SUM(minutes) m, note FROM sessions WHERE kind != 'play' GROUP BY kind, note").all());
    }
    // 1) every minute accounted for exactly once, nothing invented
    assert.equal(rec.m, trueTotal, 'tracked minutes equal true minutes');
    assert.equal(other, 0, 'no history / undated minutes during normal tracking');

    // 2) never in the future, never overlapping, ordered
    const ses = db.prepare("SELECT * FROM sessions WHERE kind = 'play' AND started_at IS NOT NULL ORDER BY started_at").all();
    if (process.env.SIM_DEBUG) for (let i = 1; i < ses.length; i++) if (ses[i].started_at < ses[i - 1].ended_at - 6 * MIN) {
      const f = (x) => `${x.minutes}m ${x.confidence} ${new Date(x.started_at).toISOString()}→${new Date(x.ended_at).toISOString()} entry${x.entry_id}`;
      console.log('OVERLAP', f(ses[i - 1]), '|', f(ses[i]));
      console.log('TRUTH', truth.filter((t) => Math.abs(t.start - ses[i].started_at) < 12 * HOUR).map((t) => `g${t.game} ${new Date(t.start).toISOString()}→${new Date(t.end).toISOString()}`).join(' ; '));
    }
    for (let i = 1; i < ses.length; i++) assert.ok(ses[i].started_at >= ses[i - 1].ended_at - 6 * MIN, `sessions overlap at ${new Date(ses[i].started_at).toISOString()}`);
    assert.ok(ses.every((s) => s.ended_at <= START + (days + 2) * DAY), 'no session in the future');

    const err = misplaced(truth, db);
    if (process.env.SIM_DAYS) {
      const a = trueDays(truth); const b = recordedDays(db);
      for (const k of [...new Set([...a.keys(), ...b.keys()])].sort()) if (Math.abs((a.get(k) || 0) - (b.get(k) || 0)) > 20) console.log('DAY', k, 'true', a.get(k) || 0, 'rec', Math.round(b.get(k) || 0), truth.filter((t) => dayKey(t.start) === k || dayKey(t.end) === k).map((t) => `g${t.game} ${new Date(t.start).toISOString().slice(11, 16)}+${t.minutes}`).join(' '));
      for (const x of db.prepare("SELECT minutes, confidence, started_at, window_start, window_end, note FROM sessions WHERE kind='play' ORDER BY sort_time").all()) console.log('SES', x.minutes, x.confidence, x.started_at ? new Date(x.started_at).toISOString() : '-', new Date(x.window_start).toISOString(), new Date(x.window_end).toISOString(), x.note || '');
    }
    if (process.env.SIM_REPORT) console.log(`REPORT ${label}: ${truth.length} sessions, ${trueTotal} min, recorded ${rec.n} sessions, misplaced ${(err * 100).toFixed(2)}%`);
    const model = modelFor(providers[sc.platform], acct());
    if (sc.presence) {
      // 3) presence: one recorded session per real session, within a poll interval
      assert.equal(rec.n, truth.length, 'one session per real session');
      for (const t of truth) {
        const m = ses.find((s) => Math.abs(s.started_at - t.start) <= providers[sc.platform].profile.presence.interval_sec * 1000);
        assert.ok(m, `session starting ${new Date(t.start).toISOString()} recorded with exact times`);
        assert.equal(m.confidence, 'exact');
      }
      assert.ok(err < 0.02, `minutes on the right day (misplaced ${(err * 100).toFixed(1)}%)`);
      // 4) the model learned what last-played means on this platform
      if (sc.platform === 'steam') { assert.equal(model.lastPlayed, 'start'); assert.ok(model.calibrated); }
      if (sc.platform === 'psn') { assert.equal(model.lastPlayed, 'end'); assert.ok(model.calibrated); }
    } else {
      if (sc.platform === 'psn') assert.equal(rec.n, truth.length, 'launch counter gives the right number of sessions');
      if (sc.platform === 'steam' && sc.schedule.schedule_mode === 'daily') {
        // last-played = launch time: single-session evenings start exactly at the real start
        const pinned = ses.filter((s) => s.confidence === 'pinned');
        assert.ok(pinned.length > truth.length / 3);
        for (const p of pinned) assert.ok(truth.some((t) => t.start === p.started_at), `pinned start ${new Date(p.started_at).toISOString()} is a real launch time`);
      }
      // weekly reports without presence carry no day-level information: placement is an estimate
      const limit = sc.schedule.schedule_mode === 'weekly' ? 0.6 : 0.12;
      assert.ok(err < limit, `misplaced ${(err * 100).toFixed(1)}% of minutes (limit ${limit * 100}%)`);
    }
  });
}

test('simulation: a mis-declared last-played meaning is corrected by presence calibration', () => {
  const truth = makeTruth({ seed: 99, start: START, days: 21, games: 2 });
  const { acct } = simulate({ platform: 'steam', truth, games: 2, start: START, days: 21, schedule: DAILY, presence: true });
  // pretend the profile said 'end': calibration still says 'start'
  const fake = { ...providers.steam, profile: { ...providers.steam.profile, history: { ...providers.steam.profile.history, last_played: 'end' } } };
  const m = modelFor(fake, acct());
  assert.equal(m.declared, 'end');
  assert.equal(m.lastPlayed, 'start');
});

test('simulation: PS4 + PS5 versions of a game group into one game', () => {
  const db = openDb(':memory:');
  const settings = new Settings(db);
  const id = Number(db.prepare("INSERT INTO accounts(platform, name, created_at) VALUES ('psn', 'p', 0)").run().lastInsertRowid);
  const a = parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  applyItems(db, a, [
    { extId: 'CUSA1_00', title: 'Ghost of Tsushima', playtimeMin: 600, groupKey: 'psn-concept:42' },
    { extId: 'PPSA1_00', title: "Ghost of Tsushima Director's Cut", playtimeMin: 300, groupKey: 'psn-concept:42' },
  ], { settings: settings.all(), now: Date.now(), initial: true });
  assert.equal(db.prepare('SELECT COUNT(DISTINCT game_id) n FROM entries').get().n, 1);
});

test('simulation: Steam offline play uploaded weeks later is not crammed into the window', () => {
  const db = openDb(':memory:');
  const settings = new Settings(db);
  const id = Number(db.prepare("INSERT INTO accounts(platform, name, created_at) VALUES ('steam', 's', 0)").run().lastInsertRowid);
  const acct = () => parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  const t0 = Date.now() - 2 * DAY;
  applyItems(db, acct(), [{ extId: '1', title: 'G', playtimeMin: 100, recentMin: 0, devices: { windows: 100, offline: 0 } }], { settings: settings.all(), now: t0, initial: true });
  db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(t0, id);
  // +300 min uploaded now, but the 14-day counter says only 60 of it is recent
  const s = applyItems(db, acct(), [{ extId: '1', title: 'G', playtimeMin: 400, recentMin: 60, lastPlayedAt: t0 + DAY, devices: { windows: 160, offline: 240 } }], { settings: settings.all(), now: t0 + 2 * DAY });
  assert.equal(s.minutes_added, 60);
  assert.equal(s.late_minutes, 240);
  const ses = db.prepare("SELECT * FROM sessions WHERE kind = 'play'").get();
  assert.match(ses.note, /offline/);
});

test('simulation: titles removed from a complete library are flagged, deferred reports are not', () => {
  const db = openDb(':memory:');
  const settings = new Settings(db);
  const id = Number(db.prepare("INSERT INTO accounts(platform, name, created_at) VALUES ('steam', 's', 0)").run().lastInsertRowid);
  const acct = () => parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  applyItems(db, acct(), [{ extId: '1', title: 'A', playtimeMin: 10 }, { extId: '2', title: 'B', playtimeMin: 10 }], { settings: settings.all(), now: Date.now(), initial: true });
  applyItems(db, acct(), [{ extId: '1', title: 'A', playtimeMin: 10 }], { settings: settings.all(), now: Date.now(), complete: false });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entries WHERE missing_since IS NOT NULL').get().n, 0);
  const s = applyItems(db, acct(), [{ extId: '1', title: 'A', playtimeMin: 10 }], { settings: settings.all(), now: Date.now() });
  assert.equal(s.removed, 1);
});
