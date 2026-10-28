// Automatic backups (schedule, pruning, the copy before a schema upgrade, the API) and the weekly
// summary (numbers, text, when it is due, sending it once). Times are local wall-clock times, so
// the file passes in any timezone.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { SCHEMA_VERSION } from '../src/db.js';
import { Backups, backupBeforeUpgrade, listBackups } from '../src/services/backup.js';
import { weeklySummary, summaryText, summaryDue, WeeklySummary } from '../src/services/digest.js';
import { flushRollups } from '../src/services/rollup.js';
import { httpError, readableBody } from '../src/providers/http.js';

const MIN = 60_000;
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vg-backup-'));

function app(dir = tmpDir()) {
  const { app: a, close } = createApp({ dbFile: path.join(dir, 'vestigo.db'), password: '', scheduler: false, log: quiet });
  return { a, close, dir };
}

describe('backups', () => {
  test('a backup is a complete, readable copy; the oldest beyond backup_keep are removed', () => {
    const { a, close, dir } = app();
    try {
      a.db.prepare("INSERT INTO games(title, norm_title, created_at, updated_at) VALUES ('Hades', 'hades', 0, 0)").run();
      a.settings.set({ backup_keep: 2 });
      const made = [];
      for (let i = 0; i < 3; i++) {
        const r = a.backups.run();
        made.push(r.name);
        // distinct names and mtimes: the next backup is "later"
        const f = path.join(dir, 'backups', r.name);
        fs.utimesSync(f, new Date(Date.now() - (3 - i) * 3600e3), new Date(Date.now() - (3 - i) * 3600e3));
        if (i < 2) fs.renameSync(f, path.join(dir, 'backups', r.name.replace(/\d{6}\.db$/, `00000${i}.db`)));
      }
      const kept = listBackups(path.join(dir, 'backups'));
      assert.equal(kept.length, 2);
      const copy = new DatabaseSync(path.join(dir, 'backups', kept[0].name), { readOnly: true });
      assert.equal(copy.prepare('SELECT title FROM games').get().title, 'Hades');
      copy.close();
      assert.ok(!fs.readdirSync(path.join(dir, 'backups')).some((f) => f.endsWith('.partial')));
    } finally { close(); }
  });

  test('pruning never touches files it did not name', () => {
    const { a, close, dir } = app();
    try {
      a.settings.set({ backup_keep: 1 });
      fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
      for (const f of ['my-copy.db', 'vestigo.db', 'vestigo-2020-01-01.db', 'notes.txt']) fs.writeFileSync(path.join(dir, 'backups', f), 'x');
      a.backups.run(); a.backups.run();
      const names = fs.readdirSync(path.join(dir, 'backups'));
      for (const f of ['my-copy.db', 'vestigo.db', 'vestigo-2020-01-01.db', 'notes.txt']) assert.ok(names.includes(f), f);
      assert.equal(names.filter((n) => /^vestigo-\d{4}-\d\d-\d\d-\d{6}\.db$/.test(n)).length, 1);
    } finally { close(); }
  });

  test('schedule: due at once without a backup, then at backup_time the next day; off and weekly', () => {
    const { a, close } = app();
    try {
      const now = Date.now();
      assert.ok(a.backups.nextAt(now) <= now, 'first backup due right away');
      a.backups.run();
      const next = new Date(a.backups.nextAt(now));
      assert.equal(`${next.getHours()}:${next.getMinutes()}`, '3:30');
      assert.ok(next.getTime() > now && next.getTime() - now <= 25 * 3600e3);
      a.settings.set({ backup_mode: 'weekly' });
      assert.ok(a.backups.nextAt(now) - now > 12 * 3600e3);
      assert.equal(new Date(a.backups.nextAt(now)).getDay(), a.settings.get('week_starts_on'));
      a.settings.set({ backup_mode: 'off' });
      assert.equal(a.backups.nextAt(now), null);
      assert.equal(a.backups.status().enabled, false);
    } finally { close(); }
  });

  test('a failed backup is logged, reported and retried hours later, not every minute', () => {
    const dir = tmpDir();
    const errors = [];
    const settings = { all: () => ({ backup_mode: 'daily', backup_time: '03:30', week_starts_on: 1 }), get: () => 7 };
    fs.writeFileSync(path.join(dir, 'backups'), 'a file where the folder should be');
    const db = new DatabaseSync(':memory:');
    const b = new Backups({ db, dbFile: path.join(dir, 'missing.db'), settings, log: { ...quiet, error: (m) => errors.push(m) } });
    assert.throws(() => b.run());
    assert.equal(errors.length, 1);
    assert.ok(b.status().last_error.message);
    assert.ok(b.nextAt() - Date.now() > 5 * 3600e3);
  });

  test('an in-memory database has no backups', () => {
    const { app: a, close } = createApp({ dbFile: ':memory:', password: '', scheduler: false, log: quiet });
    try {
      assert.equal(a.backups.nextAt(), null);
      assert.throws(() => a.backups.run(), /in memory/);
    } finally { close(); }
  });

  test('a database on an older schema is copied before the update migrates it', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'playtracker.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE games(id INTEGER PRIMARY KEY, title TEXT); INSERT INTO games(title) VALUES (\'Celeste\'); PRAGMA user_version = 3;');
    old.close();
    const logs = [];
    const name = backupBeforeUpgrade(file, SCHEMA_VERSION, { ...quiet, info: (m) => logs.push(m) });
    assert.match(name, new RegExp(`^vestigo-before-v${SCHEMA_VERSION}-`));
    const copy = new DatabaseSync(path.join(dir, 'backups', name), { readOnly: true });
    assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(copy.prepare('SELECT title FROM games').get().title, 'Celeste');
    copy.close();
    assert.match(logs[0], /schema 3 → /);
    // already current, or no database at all: nothing copied
    assert.equal(backupBeforeUpgrade(file, 3, quiet), null);
    assert.equal(backupBeforeUpgrade(path.join(dir, 'none.db'), SCHEMA_VERSION, quiet), null);
  });

  test('API: list, back up now, download, delete; diagnostics show the last backup', async () => {
    const dir = tmpDir();
    const { server, app: a, close } = createApp({ dbFile: path.join(dir, 'vestigo.db'), password: '', scheduler: false, log: quiet });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const call = (method, p) => fetch(base + p, { method });
    try {
      const made = await (await call('POST', '/backups')).json();
      assert.match(made.name, /^vestigo-/);
      const list = await (await call('GET', '/backups')).json();
      assert.equal(list.count, 1);
      assert.equal(list.files[0].name, made.name);
      const got = await call('GET', `/backups/${made.name}`);
      assert.equal(got.status, 200);
      assert.equal(Buffer.from(await got.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
      assert.equal((await call('GET', '/backups/..%2Fvestigo.db')).status, 404);
      assert.equal((await call('GET', '/backups/vestigo.db')).status, 404);
      const sys = await (await call('GET', '/system')).json();
      assert.equal(sys.backups.last.name, made.name);
      assert.equal(sys.backups.files, undefined);
      assert.equal((await call('DELETE', `/backups/${made.name}`)).status, 200);
      assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 0);
      assert.equal(a.backups.status().count, 0);
      const week = await (await call('GET', '/summary/week')).json();
      assert.equal(week.minutes, 0);
      assert.match(week.text, /^Vestigo · your week/);
      assert.equal((await call('GET', '/summary/week?weeks_ago=-1')).status, 400);
      assert.equal((await call('POST', '/summary/week/send')).status, 400, 'no webhook set');
    } finally { close(); }
  });

  test('settings: backup_mode, backup_time and backup_keep are validated', async () => {
    const { validateSettings } = await import('../src/services/settings.js');
    assert.deepEqual(validateSettings({ backup_mode: 'weekly', backup_time: '02:15', backup_keep: 14 }).errors, []);
    assert.equal(validateSettings({ backup_mode: 'hourly' }).errors.length, 1);
    assert.equal(validateSettings({ backup_time: '25:00' }).errors.length, 1);
    assert.equal(validateSettings({ backup_keep: 0 }).errors.length, 1);
    assert.equal(validateSettings({ weekly_summary_time: '9am' }).errors.length, 1);
  });
});

describe('weekly summary', () => {
  // Wednesday 2026-03-18 15:00; weeks start on Monday, so last week is Mar 9 – 15
  const NOW = local(2026, 3, 18, 15);

  function library(db) {
    const game = (title) => Number(db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, 0, 0)').run(title, title.toLowerCase()).lastInsertRowid);
    const entry = (g, platform = 'steam') => Number(db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at) VALUES (NULL, ?, ?, ?, 'x', 0, 0)").run(g, platform, `x${g}${platform}`).lastInsertRowid);
    const ins = db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at) VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?)");
    const play = (e, start, minutes, kind = 'play') => { ins.run(e, kind, minutes, start, start + minutes * MIN, start, start + minutes * MIN, start + minutes * MIN); db.prepare('UPDATE entries SET playtime_min = playtime_min + ? WHERE id = ?').run(minutes, e); };
    const hades = entry(game('Hades'));
    const celeste = entry(game('Celeste'), 'xbox');
    const old = entry(game('Old Favourite'));
    play(old, local(2026, 1, 5, 20), 60); // played long before: not new last week
    play(old, local(2026, 3, 3, 20), 60); // the week before last: 60 minutes
    play(old, local(2026, 3, 10, 20), 30);
    play(hades, local(2026, 3, 11, 19), 120);
    play(hades, local(2026, 3, 14, 13), 90);
    play(celeste, local(2026, 3, 14, 18), 45);
    play(hades, local(2026, 3, 9, 1), 500, 'estimate'); // estimated history never counts
    play(hades, local(2026, 3, 17, 20), 40); // this week
    const ach = db.prepare('INSERT INTO achievements(entry_id, ach_id, name, unlocked, unlocked_at, rarity, points, grade, first_seen_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0, 0)');
    ach.run(hades, 'a1', 'Escaped', local(2026, 3, 14, 14), 4.2, null, null);
    ach.run(celeste, 'b1', 'Summit', local(2026, 3, 14, 19), 31, 30, null);
    ach.run(celeste, 'b2', 'Earlier', local(2026, 3, 2, 19), 1, 10, null); // the week before
    flushRollups(db);
  }

  test('last week in numbers: totals, change, top games, new games, achievements, highlights', () => {
    const { a, close } = app();
    try {
      library(a.db);
      const s = weeklySummary(a.db, { weekStartsOn: 1, now: NOW });
      assert.equal(s.week.start_day, '2026-03-09');
      assert.equal(s.week.end_day, '2026-03-15');
      assert.equal(s.week.complete, true);
      assert.equal(s.minutes, 285);
      assert.equal(s.sessions, 4);
      assert.equal(s.games_played, 3);
      assert.equal(s.days_played, 3);
      assert.equal(s.previous_minutes, 60);
      assert.equal(s.change_percent, 375);
      assert.deepEqual(s.top_games.map((g) => [g.title, g.minutes]), [['Hades', 210], ['Celeste', 45], ['Old Favourite', 30]]);
      // Hades's estimated history sits in last week too; first played ever there, so it is new
      assert.deepEqual(s.new_games.map((g) => g.title).sort(), ['Celeste', 'Hades']);
      assert.equal(s.achievements.unlocked, 2);
      assert.equal(s.achievements.points, 30);
      assert.equal(s.achievements.rarest.name, 'Escaped');
      assert.equal(s.longest_session.title, 'Hades');
      assert.equal(s.longest_session.minutes, 120);
      assert.equal(s.busiest_day.day, '2026-03-14');
      assert.equal(s.busiest_day.weekday, 'Saturday');

      const text = summaryText(s);
      assert.match(text, /^Vestigo · your week \(Mar 9 – Mar 15\)/);
      assert.match(text, /4h 45m over 3 days · 4 sessions · 3 games, 375% more than the week before/);
      assert.match(text, /1\. Hades — 3h 30m/);
      assert.match(text, /2 achievements unlocked \(30 G\) · rarest: Escaped in Hades \(4\.2%\)/);
      assert.doesNotMatch(text, /<|undefined|null|NaN/);

      const now = weeklySummary(a.db, { weeksAgo: 0, weekStartsOn: 1, now: NOW });
      assert.equal(now.minutes, 40);
      assert.equal(now.week.complete, false);
      const quietWeek = weeklySummary(a.db, { weeksAgo: 5, weekStartsOn: 1, now: NOW });
      assert.match(summaryText(quietWeek), /No tracked play this week/);
    } finally { close(); }
  });

  test('due on the first day of the week at the set time, once, and not days late', () => {
    const s = { weekly_summary: true, webhook_url: 'https://example.com/h', weekly_summary_time: '09:00', week_starts_on: 1 };
    const mon = (h) => local(2026, 3, 16, h);
    assert.equal(summaryDue(s, null, mon(8)), null);
    assert.equal(summaryDue(s, null, mon(9)), '2026-03-09');
    assert.equal(summaryDue(s, '2026-03-09', mon(10)), null);
    assert.equal(summaryDue(s, null, NOW), '2026-03-09', 'two days late still goes out');
    assert.equal(summaryDue(s, null, local(2026, 3, 20, 12)), null, 'four days late is skipped');
    assert.equal(summaryDue({ ...s, webhook_url: '' }, null, mon(9)), null);
    assert.equal(summaryDue({ ...s, weekly_summary: false }, null, mon(9)), null);
    assert.equal(summaryDue({ ...s, week_starts_on: 0 }, null, local(2026, 3, 15, 9)), '2026-03-08');
  });

  test('sent once per week; a failed send is retried with a back-off', async () => {
    const { a, close } = app();
    try {
      library(a.db);
      a.settings.set({ webhook_url: 'https://example.com/hook' });
      const sent = [];
      let fail = true;
      const w = new WeeklySummary({ db: a.db, settings: a.settings, log: quiet, send: async (url, summary, text) => { if (fail) throw new Error('webhook responded 500'); sent.push({ url, summary, text }); } });
      const mon = local(2026, 3, 16, 9, 5);
      assert.equal(await w.tick(mon), false);
      assert.equal(await w.tick(mon + 60_000), false, 'waiting out the back-off');
      fail = false;
      assert.equal(await w.tick(mon + 6 * MIN), true);
      assert.equal(await w.tick(mon + 7 * MIN), false);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].summary.minutes, 285);
      assert.match(sent[0].text, /your week/);
      assert.equal(a.settings.public().weekly_summary_sent, undefined);
    } finally { close(); }
  });
});

describe('readable platform errors', () => {
  const AKAMAI = '<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n \nYou don\'t have permission to access "http://m.np.playstation.com/api" on this server.<P>\nReference #18.6c2f1002.1761605492.1a2b3c\n</BODY>\n</HTML>\n';

  test("Sony's Access Denied page reads as a temporary block, not a credentials problem", () => {
    const err = httpError('m.np.playstation.com', 403, AKAMAI, 'text/html');
    assert.equal(err.auth, false);
    assert.equal(err.blocked, true);
    assert.match(err.message, /^PlayStation Network refused the request \(403 Access Denied\)/);
    assert.doesNotMatch(err.message, /<|credentials \//);
  });

  test('API errors keep their meaning, in one short line', () => {
    const e401 = httpError('m.np.playstation.com', 401, '{"error":{"message":"Invalid token","code":2241}}', 'application/json');
    assert.equal(e401.auth, true);
    assert.equal(e401.message, 'm.np.playstation.com responded 401 (check credentials / privacy settings): Invalid token');
    const e403 = httpError('xbl.io', 403, '{"error":"Profile is private"}', 'application/json');
    assert.equal(e403.auth, true);
    assert.match(e403.message, /Profile is private$/);
    assert.equal(httpError('api.steampowered.com', 404, '', '').message, 'api.steampowered.com responded 404');
    assert.equal(readableBody('<html><body><p>Bad&nbsp;request &amp; more</p></body></html>'), 'Bad request & more');
    assert.equal(readableBody('x'.repeat(500)).length, 200);
  });
});
