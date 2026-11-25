// What the "When did you play this?" dialog shows: the evidence about an entry's history, where
// a window disagrees with it, "keep my dates", periods, and the hours of games added by hand.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

let app; let base; let db;
const quiet = { info() {}, warn() {}, error() {} };
const DAY = 86_400_000;
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

before(async () => {
  app = createApp({ dbFile: ':memory:', password: '', log: quiet, scheduler: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  db = app.app.db;
});
after(() => app.close());

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

/** An Xbox-like entry with history, unlock times and an IGDB release date (Fortnite on the live library). */
function fortnite() {
  const now = Date.now();
  const acc = Number(db.prepare("INSERT INTO accounts(platform, name, config, state, created_at) VALUES ('xbox', 'Xbox', '{}', '{}', ?)").run(now).lastInsertRowid);
  const game = Number(db.prepare("INSERT INTO games(title, norm_title, created_at, updated_at) VALUES ('Fortnite', 'fortnite', ?, ?)").run(now, now).lastInsertRowid);
  const unlocks = [at(2017, 7, 22, 17), at(2017, 7, 22, 18), at(2017, 8, 5), at(2017, 9, 2)];
  const hist = { tracking_start: at(2026, 10, 22), last_played_at: at(2023, 12, 23, 19), anchors: unlocks, manual: { start: at(2018, 1, 1), end: at(2019, 12, 31, 20) } };
  const entry = Number(db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, baseline_min, first_seen_at, last_played_at, enriched_at, hist)
    VALUES (?, ?, 'xbox', 'fn', 'Fortnite', 29113, 29113, ?, ?, ?, ?)`).run(acc, game, at(2026, 10, 22), hist.last_played_at, now, JSON.stringify(hist)).lastInsertRowid);
  const ins = db.prepare('INSERT INTO achievements(entry_id, ach_id, name, unlocked, unlocked_at, first_seen_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)');
  unlocks.forEach((t, i) => ins.run(entry, `a${i}`, ['Gunsmith', 'Take Out Those Husks', 'Builder', 'Survivor'][i], t, now, now));
  db.prepare("INSERT INTO achievements(entry_id, ach_id, name, unlocked, first_seen_at, updated_at) VALUES (?, 'locked', 'Locked one', 0, ?, ?)").run(entry, now, now);
  // IGDB's date is the 1.0 release, three years after early access
  // (as IGDB gives it: the calendar day at midnight UTC)
  db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, name, release_date, fetched_at) VALUES (?, 1905, 'title', 'Fortnite', ?, ?)").run(game, Date.UTC(2020, 5, 29), now);
  return { game, entry };
}

test('the context lists every date known, oldest first, with the unlocks by month', async () => {
  const { entry } = fortnite();
  await call('/history/reinfer', { method: 'POST' });
  const r = await call(`/entries/${entry}/history/context`);
  assert.equal(r.status, 200);
  const c = r.data;
  assert.deepEqual(c.marks.map((m) => m.key), ['first_unlock', 'last_unlock', 'release_igdb', 'last_played', 'tracking']);
  assert.equal(c.marks[0].detail, 'Gunsmith');
  assert.equal(c.marks[0].at, at(2017, 7, 22, 17));
  assert.equal(c.marks.find((m) => m.key === 'release_igdb').source, 'IGDB: Fortnite');
  assert.equal(c.marks.find((m) => m.key === 'release_igdb').at, at(2020, 6, 29), 'IGDB\'s day is that day here, not the evening before');
  assert.deepEqual(c.unlocks.by_month, [{ key: '2017-07', n: 2 }, { key: '2017-08', n: 1 }, { key: '2017-09', n: 1 }]);
  assert.equal(c.unlocks.before_tracking, 4);
  assert.equal(c.unlocks.total, 5);
  assert.equal(c.minutes, 29113);
  assert.equal(c.manual.coarse, true, 'Jan 1 noon to Dec 31 8 pm: a period');
  assert.equal(c.enrich_pending, false);
});

test('your dates that the evidence disagrees with are pointed out, on the game and on Improve history, until you keep them', async () => {
  const { game, entry } = fortnite();
  await call('/history/reinfer', { method: 'POST' });
  const c = (await call(`/entries/${entry}/history/context`)).data;
  assert.deepEqual(c.conflicts.map((x) => x.kind), ['unlocks_before', 'last_played_after']);
  assert.match(c.conflicts[0].text, /^4 achievements unlocked before this start, the first on Jul 22, 2017$/);
  assert.match(c.conflicts[1].text, /^Xbox says it was last played on Dec 23, 2023, after this end$/);
  // on the game page
  const g = (await call(`/games/${game}`)).data;
  const h = g.entries.find((e) => e.id === entry).history;
  assert.equal(h.conflicts.length, 2);
  assert.equal(h.acknowledged, false);
  assert.ok(h.marks.some((m) => m.key === 'first_unlock'));
  // on Improve history: not among the least certain (you set it), but in "check your dates"
  let rev = (await call('/history/review')).data;
  assert.ok(rev.check.some((x) => x.entry_id === entry));
  assert.ok(!rev.items.some((x) => x.entry_id === entry));
  // a window that fits the evidence has nothing to say against it
  const fit = (await call(`/entries/${entry}/history/context?start=${encodeURIComponent(new Date(at(2017, 7, 1)).toISOString())}&end=${encodeURIComponent(new Date(at(2023, 12, 31)).toISOString())}`)).data;
  assert.deepEqual(fit.conflicts, []);
  // a start before the release (with no unlock before it) is pointed out
  const early = (await call(`/entries/${entry}/history/context?start=2015-01-01T12:00:00`)).data;
  assert.ok(!early.conflicts.some((x) => x.kind === 'before_release'), 'unlocks before IGDB\'s date: that date is not this copy\'s');
  // keep mine: no longer pointed out
  const k = await call(`/entries/${entry}/history`, { method: 'PATCH', body: { acknowledge: true } });
  assert.equal(k.status, 200);
  assert.equal(k.data.entries.find((e) => e.id === entry).history.acknowledged, true);
  rev = (await call('/history/review')).data;
  assert.ok(!rev.check.some((x) => x.entry_id === entry));
  // new dates of yours are checked again
  await call(`/entries/${entry}/history`, { method: 'PATCH', body: { first_played_at: '2019-01-01T12:00:00', last_played_at: '2019-06-30T20:00:00' } });
  rev = (await call('/history/review')).data;
  assert.ok(rev.check.some((x) => x.entry_id === entry));
  assert.equal((await call(`/entries/${entry}/history`, { method: 'PATCH', body: { reset: true, acknowledge: true } })).status, 400, 'nothing of yours to keep after a reset');
});

test('a period answer is saved as one and spread evenly; the context checks bad windows', async () => {
  const { entry } = fortnite();
  const r = await call(`/entries/${entry}/history`, { method: 'PATCH', body: { first_played_at: '2018-04-01T12:00:00', last_played_at: '2018-06-30T20:00:00', coarse: true } });
  assert.equal(r.status, 200);
  const h = r.data.entries.find((e) => e.id === entry).history;
  assert.equal(h.coarse, true);
  assert.ok(h.reasons.includes('Spread evenly over the period you set'));
  const months = db.prepare(`SELECT substr(day, 1, 7) m, SUM(minutes) n FROM play_days WHERE entry_id = ? AND estimated = 1 GROUP BY m`).all(entry);
  assert.deepEqual(months.map((x) => x.m), ['2018-04', '2018-05', '2018-06']);
  const n = months.map((x) => x.n);
  assert.ok(Math.max(...n) < 1.15 * Math.min(...n), n.join());
  assert.equal((await call(`/entries/${entry}/history/context?start=2019-01-01&end=2018-01-01`)).status, 400);
  assert.equal((await call(`/entries/${entry}/history/context?start=nope`)).status, 400);
  assert.equal((await call('/entries/999999/history/context')).status, 404);
});

test('a game added by hand takes the hours played before, dated over the years you give (an N64 game)', async () => {
  const add = await call('/games', {
    method: 'POST',
    body: { title: 'Super Mario 64', played_on: 'Nintendo 64', status: 'completed', history: { minutes: 2400, first_played_at: '1996-09-29T12:00:00', last_played_at: '1998-12-31T20:00:00', coarse: true } },
  });
  assert.equal(add.status, 200);
  const e = add.data.entries[0];
  assert.equal(e.platform, 'manual');
  assert.equal(e.meta.played_on, 'Nintendo 64');
  assert.equal(e.playtime_min, 2400);
  assert.equal(add.data.minutes, 2400, 'counts in the lifetime total');
  assert.equal(e.history.minutes, 2400);
  assert.equal(e.history.undated, 0, 'all of it dated, though before 1995 would be too');
  assert.ok(e.history.window[0] >= at(1996, 9, 29, 0) && e.history.window[1] <= at(1999, 1, 1, 0));
  // history, not play: nothing today, nothing in the tracked stats
  const st = (await call(`/games/${add.data.id}`)).data.summary;
  assert.equal(st.tracked_minutes, 0);
  assert.equal(st.estimated_minutes, 2400);
  // changed later in the dialog: more hours, other years
  const more = await call(`/entries/${e.id}/history`, { method: 'PATCH', body: { minutes: 3000, first_played_at: '1997-01-01T12:00:00', last_played_at: '1997-12-31T20:00:00' } });
  assert.equal(more.status, 200);
  const e2 = more.data.entries[0];
  assert.equal(e2.playtime_min, 3000);
  assert.equal(e2.history.minutes, 3000);
  assert.ok(e2.history.window[0] >= at(1997, 1, 1, 0) && e2.history.window[1] <= at(1998, 1, 1, 0));
  // a session logged since adds to it; taking the hours away leaves the session
  await call('/sessions', { method: 'POST', body: { game_id: add.data.id, minutes: 45 } });
  const none = await call(`/entries/${e.id}/history`, { method: 'PATCH', body: { minutes: 0 } });
  assert.equal(none.status, 200);
  assert.equal(none.data.entries[0].playtime_min, 45);
  assert.equal(none.data.entries[0].history, null);
  // a synced entry's history comes from its platform
  const { entry } = fortnite();
  assert.equal((await call(`/entries/${entry}/history`, { method: 'PATCH', body: { minutes: 10 } })).status, 400);
  // a game added by hand with no hours: the dialog can add them
  const bare = (await call('/games', { method: 'POST', body: { title: 'GoldenEye 007' } })).data;
  const set = await call(`/entries/${bare.entries[0].id}/history`, { method: 'PATCH', body: { minutes: 600, first_played_at: '1997-08-25T12:00:00', last_played_at: '1999-12-31T20:00:00' } });
  assert.equal(set.status, 200);
  assert.equal(set.data.entries[0].history.minutes, 600);
  assert.equal((await call(`/entries/${bare.entries[0].id}/history`, { method: 'PATCH', body: { minutes: -5 } })).status, 400);
  assert.equal((await call('/games', { method: 'POST', body: { title: 'Bad', history: { minutes: 'lots' } } })).status, 400);
  assert.equal((await call('/games', { method: 'POST', body: { title: 'Bad', history: { minutes: 60, first_played_at: '2000-01-01', last_played_at: '1999-01-01' } } })).status, 400);
});

test('a period answered before the game came out starts at the release (Mewgenics: "2026, Jan - Mar", out Feb 10)', async () => {
  const now = Date.now();
  const game = Number(db.prepare("INSERT INTO games(title, norm_title, created_at, updated_at) VALUES ('Mewgenics', 'mewgenics', ?, ?)").run(now, now).lastInsertRowid);
  const hist = (more = {}) => JSON.stringify({ tracking_start: at(2026, 10, 22), release_at: at(2026, 2, 10, 0), last_played_at: at(2026, 7, 24), ...more });
  const entry = (h) => Number(db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, baseline_min, first_seen_at, hist)
    VALUES (NULL, ?, 'steam', ?, 'Mewgenics', 8100, 8100, ?, ?)`).run(game, `m${Math.random()}`, at(2026, 10, 22), h).lastInsertRowid);
  const quarter = { first_played_at: '2026-01-01T12:00:00', last_played_at: '2026-03-31T20:00:00', coarse: true };
  const e1 = entry(hist());
  const r = await call(`/entries/${e1}/history`, { method: 'PATCH', body: quarter });
  const h = r.data.entries.find((x) => x.id === e1).history;
  assert.equal(h.manual.start, at(2026, 2, 10, 0), 'starts when it came out');
  assert.equal(h.manual.end, at(2026, 3, 31, 20));
  assert.ok(!h.conflicts.some((c) => c.kind === 'before_release'));
  // played before the store date (an unlock in early access): the answer stands as given
  const e2 = entry(hist({ anchors: [at(2026, 1, 20)] }));
  const r2 = await call(`/entries/${e2}/history`, { method: 'PATCH', body: quarter });
  assert.equal(r2.data.entries.find((x) => x.id === e2).history.manual.start, at(2026, 1, 1));
  // dates typed as days stand as typed
  const e3 = entry(hist());
  const r3 = await call(`/entries/${e3}/history`, { method: 'PATCH', body: { ...quarter, coarse: false } });
  const h3 = r3.data.entries.find((x) => x.id === e3).history;
  assert.equal(h3.manual.start, at(2026, 1, 1));
  // and need no warning about the release: no hours are dated before the store's date anyway
  assert.ok(!h3.conflicts.some((c) => c.kind === 'before_release'));
  assert.ok(h3.window[0] >= new Date(2026, 1, 10).getTime(), 'the estimate starts at the release');
});

test('a start before the release date only IGDB has is pointed out: nothing else keeps hours from being charted before it', async () => {
  const now = Date.now();
  const game = Number(db.prepare("INSERT INTO games(title, norm_title, created_at, updated_at) VALUES ('Halo 5', 'halo 5', ?, ?)").run(now, now).lastInsertRowid);
  db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, name, release_date, fetched_at) VALUES (?, 7, 'title', 'Halo 5: Guardians', ?, ?)").run(game, Date.UTC(2015, 9, 27), now);
  const entry = Number(db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, baseline_min, first_seen_at, hist)
    VALUES (NULL, ?, 'xbox', 'h5', 'Halo 5', 17065, 17065, ?, ?)`).run(game, at(2026, 10, 22), JSON.stringify({ tracking_start: at(2026, 10, 22), last_played_at: at(2021, 7, 17) })).lastInsertRowid);
  const r = await call(`/entries/${entry}/history`, { method: 'PATCH', body: { first_played_at: '2015-01-01T12:00:00', last_played_at: '2015-12-31T20:00:00' } });
  const c = r.data.entries.find((x) => x.id === entry).history.conflicts;
  const rel = c.find((x) => x.kind === 'before_release');
  assert.ok(rel, JSON.stringify(c));
  assert.match(rel.text, /Oct 27, 2015/);
  // a period answer starts at IGDB's date instead
  const p = await call(`/entries/${entry}/history`, { method: 'PATCH', body: { first_played_at: '2015-01-01T12:00:00', last_played_at: '2015-12-31T20:00:00', coarse: true } });
  const h = p.data.entries.find((x) => x.id === entry).history;
  // from the first moment it was out anywhere: Oct 27 begins in UTC+14 the day before
  assert.equal(h.manual.start, Date.UTC(2015, 9, 27) - 14 * 3_600_000);
  assert.ok(!h.conflicts.some((x) => x.kind === 'before_release'));
});

test('a game played on its New Zealand launch (GTA VI: out Nov 19, played Nov 18 at 7 am in New York) keeps that day in a period answer', async () => {
  const now = Date.now();
  const game = Number(db.prepare("INSERT INTO games(title, norm_title, created_at, updated_at) VALUES ('GTA VI', 'gta vi', ?, ?)").run(now, now).lastInsertRowid);
  db.prepare("INSERT INTO game_meta(game_id, igdb_id, matched_by, name, release_date, fetched_at) VALUES (?, 9, 'title', 'Grand Theft Auto VI', ?, ?)").run(game, Date.UTC(2026, 10, 19), now);
  const entry = Number(db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, baseline_min, first_seen_at, hist)
    VALUES (NULL, ?, 'xbox', 'gta6', 'GTA VI', 600, 600, ?, ?)`).run(game, at(2026, 12, 1), JSON.stringify({ tracking_start: at(2026, 12, 1) })).lastInsertRowid);
  const ctx = (await call(`/entries/${entry}/history/context`)).data;
  assert.equal(ctx.marks.find((m) => m.key === 'release_igdb').at, at(2026, 11, 19), 'released Nov 19, as IGDB lists it');
  const r = await call(`/entries/${entry}/history`, { method: 'PATCH', body: { first_played_at: '2026-11-01T12:00:00', last_played_at: '2026-11-30T20:00:00', coarse: true } });
  const start = r.data.entries.find((x) => x.id === entry).history.manual.start;
  // (absolute times, so this holds in any timezone: midnight Nov 19 in UTC+14 is 10:00 UTC on Nov 18)
  assert.equal(start, Date.UTC(2026, 10, 18, 10), 'from the launch in the earliest time zone');
  assert.ok(start <= Date.UTC(2026, 10, 18, 12, 1), 'Nov 18, 7:01 am in New York (12:01 UTC), the first session, is inside the period');
});
