// Resource contracts: cached stats outlive writes no stat reads (API call accounting, presence
// heartbeats, the error log, API token use) and are dropped by any other; the Stats page's
// comparison and highlights are cached like the stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { computeStats, comparePeriod, periodHighlights, memo } from '../src/services/stats.js';
import { createLogger } from '../src/logger.js';

const MIN = 60_000;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function fixture(dbFile = ':memory:') {
  const { app, close, server } = createApp({ dbFile, password: '', scheduler: false, log: quiet });
  const { db } = app;
  const acc = Number(db.prepare("INSERT INTO accounts(platform, name, enabled, created_at) VALUES ('steam', 'Me', 0, 0)").run().lastInsertRowid);
  const g = Number(db.prepare("INSERT INTO games(title, norm_title, created_at, updated_at) VALUES ('Hades', 'hades', 0, 0)").run().lastInsertRowid);
  const e = Number(db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at) VALUES (?, ?, 'steam', '1', 'Hades', 0, 0)").run(acc, g).lastInsertRowid);
  const end = Date.now() - 3600_000;
  db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, started_at, ended_at, created_at) VALUES (?, 'manual', 'play', 45, ?, ?, ?)").run(e, end - 45 * MIN, end, end);
  app.rebuildRollups();
  return { app, close, server, db, acc, e };
}

test('cached stats survive API call accounting, presence heartbeats, logged warnings and token use; any other write drops them', () => {
  const { app, close, db, acc, e } = fixture();
  const log = createLogger({ quiet: true });
  try {
    db.prepare("INSERT INTO presence(account_id, ext_id, title, started_at, last_seen_at) VALUES (?, '1', 'Hades', ?, ?)").run(acc, Date.now() - MIN, Date.now() - MIN);
    const { token } = app.auth.createToken('widget');
    log.attachDb(db);
    const s = computeStats(db, { range: '30d' });
    assert.equal(s.total_minutes, 45);
    assert.equal(computeStats(db, { range: '30d' }), s, 'the same answer object while nothing changed');

    app.sync.recordCall(acc, { ok: true, ms: 5, host: 'api.steampowered.com' });
    app.sync.applyPresence(app.sync.account(acc), [{ extId: '1', title: 'Hades' }], { now: Date.now() }); // still playing: a heartbeat
    log.scoped('test').warn('A warning for the error log');
    assert.equal(app.auth.identify({ headers: { authorization: `Bearer ${token}` } }, {}, new URL('http://x/')).via, 'token');
    assert.equal(db.prepare('SELECT calls FROM api_usage').get().calls, 1, 'the call is still counted');
    assert.ok(db.prepare('SELECT last_seen_at FROM presence').get().last_seen_at > Date.now() - MIN, 'the heartbeat is still stored');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM logs WHERE level = 'warn'").get().n, 1, 'the warning is still logged');
    assert.ok(db.prepare('SELECT last_used_at FROM api_tokens').get().last_used_at, 'token use is still recorded');
    assert.equal(computeStats(db, { range: '30d' }), s, 'none of those voided the cache');

    db.prepare('UPDATE sessions SET minutes = 50 WHERE entry_id = ?').run(e);
    app.rebuildRollups();
    const s2 = computeStats(db, { range: '30d' });
    assert.notEqual(s2, s);
    assert.equal(s2.total_minutes, 50, 'a real write is seen at once');
  } finally { log.detachDb(); close(); }
});

test('the cache keeps the answers of one data version only', () => {
  const { close, db } = fixture();
  try {
    let calls = 0;
    const big = () => { calls++; return { rows: Array(1000).fill(calls) }; };
    const a = memo(db, 'k', big);
    assert.equal(memo(db, 'k', big), a);
    db.prepare("INSERT INTO settings(key, value) VALUES ('x', '1')").run();
    const b = memo(db, 'k', big);
    assert.notEqual(b, a);
    assert.equal(calls, 2);
    // every later version computes afresh (and never hands back an older answer)
    db.prepare("UPDATE settings SET value = '2' WHERE key = 'x'").run();
    assert.notEqual(memo(db, 'k', big), a);
    assert.equal(calls, 3);
  } finally { close(); }
});

test('the previous period and the highlights are cached until the next write (explicit `now` stays exact)', async () => {
  const { close, server, db } = fixture();
  try {
    const p = comparePeriod(db, { range: '30d' });
    assert.equal(comparePeriod(db, { range: '30d' }), p);
    const h = periodHighlights(db, { range: '30d' });
    assert.equal(periodHighlights(db, { range: '30d' }), h);
    const then = Date.now() - 40 * 86_400_000;
    assert.equal(periodHighlights(db, { range: '30d', now: then }).new_games.count, 0, 'a past `now` is its own answer');
    assert.equal(h.new_games.count, 1);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const get = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/v1/stats?range=30d&compare=true&highlights=true`)).json();
    const [x, y] = [await get(), await get()];
    assert.deepEqual(x, y);
    assert.equal(x.highlights.new_games.count, 1);
    assert.equal(x.previous.total_minutes, 0);
  } finally { close(); }
});
