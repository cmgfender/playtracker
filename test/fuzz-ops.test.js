// Random operations against the whole app, with everything that must stay true checked after each:
// reports from a platform (more time, less time, a new title, a game gone), sessions logged, edited,
// converted and deleted, games merged, entries moved, split and excluded, history dated by hand and
// reset, settings switched, the clock moving on. Each seed is one library's life; a failure names the
// seed and the step, so it can be replayed (FUZZ_SEED=7 FUZZ_STEPS=400 node --test test/fuzz-ops.test.js).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { clock, local, startApp, guardNetwork, restoreNetwork, totalsMismatch, rollupMismatch, DAY, HOUR, MIN } from './suite/helpers/sessions-stats-harness.js';

const SEEDS = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : [1, 2, 3, 4, 5, 6];
const STEPS = Number(process.env.FUZZ_STEPS || 140);
const TITLES = ['Halo 3', 'Halo: Reach', 'Hades', 'Celeste', 'Portal 2', 'Stardew Valley', 'DARK SOULS III', 'Tetris Effect', 'Outer Wilds', 'Forza Horizon 5', 'Mass Effect 2', 'The Witcher 3: Wild Hunt'];

function rng(seed) { let s = seed * 2654435761 >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

for (const seed of SEEDS) {
  describe(`a library's life, seed ${seed}`, () => {
    let h;
    before(async () => { guardNetwork(); clock.install(local(2025, 1, 6, 12)); h = await startApp(); });
    after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

    test(`${STEPS} random operations keep every total, rollup and page in agreement`, async () => {
      const r = rng(seed);
      const pick = (xs) => xs[Math.floor(r() * xs.length)];
      const int = (a, b) => a + Math.floor(r() * (b - a + 1));
      const log = [];
      const accounts = [];
      const reported = new Map(); // account id -> Map ext -> { title, minutes }
      const q = (sql, ...a) => h.db.prepare(sql).all(...a);
      // (a refusal is an answer: 4xx is fine, 5xx never)
      const call = async (method, path, body) => {
        const res = await h.call(method, path, body);
        assert.ok(res.status < 500, `${method} ${path} ${JSON.stringify(body)} -> ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
        return res;
      };
      const ops = {
        async account() {
          if (accounts.length >= 3) return 'skip';
          const a = (await call('POST', '/accounts', { platform: 'custom', name: `acct ${accounts.length + 1}`, config: {} })).body;
          accounts.push(a.id); reported.set(a.id, new Map());
          return `account ${a.id}`;
        },
        async report() {
          if (!accounts.length) return ops.account();
          const acc = pick(accounts); const known = reported.get(acc);
          const games = [];
          for (let i = 0, n = int(1, 4); i < n; i++) {
            const ext = `g${int(1, 9)}`;
            if (games.some((g) => g.id === ext)) continue;
            const was = known.get(ext);
            const roll = r();
            // more time (usually), the same, or less (a platform correcting itself)
            const minutes = !was ? int(0, 900) : roll < 0.7 ? was.minutes + int(1, 240) : roll < 0.85 ? was.minutes : Math.max(0, was.minutes - int(1, 120));
            const title = was && r() < 0.9 ? was.title : pick(TITLES);
            const g = { id: ext, title, playtime_minutes: minutes };
            if (r() < 0.6) g.last_played_at = clock.now - int(0, 6) * HOUR;
            games.push(g); known.set(ext, { title, minutes });
          }
          const res = await call('POST', `/accounts/${acc}/report`, { games });
          return `report ${acc} ${JSON.stringify(games)} -> ${res.status}`;
        },
        async add() { const res = await call('POST', '/games', { title: pick(TITLES), merge: r() < 0.5 }); return `add -> ${res.body.id}`; },
        async session() {
          const g = pick(q('SELECT id FROM games'));
          if (!g) return ops.add();
          const minutes = int(1, 300); const start = clock.now - int(0, 40) * DAY - int(0, 23) * HOUR - minutes * MIN;
          const res = await call('POST', '/sessions', { game_id: g.id, minutes, started_at: start, ...(r() < 0.3 ? { note: 'n' } : {}) });
          return `session game ${g.id} ${minutes}m -> ${res.status}`;
        },
        async editSession() {
          const s = pick(q("SELECT id, minutes, started_at FROM sessions WHERE source != 'inferred'"));
          if (!s) return 'skip';
          const body = pick([{ minutes: int(1, 400) }, { started_at: (s.started_at || clock.now) - int(1, 72) * HOUR }, { kind: pick(['play', 'baseline']) }, { note: 'edited' }, { ended_at: clock.now - int(0, 48) * HOUR }]);
          const res = await call('PATCH', `/sessions/${s.id}`, body);
          return `edit session ${s.id} ${JSON.stringify(body)} -> ${res.status}`;
        },
        async deleteSession() {
          const s = pick(q("SELECT id FROM sessions WHERE source != 'inferred'"));
          if (!s) return 'skip';
          return `delete session ${s.id} -> ${(await call('DELETE', `/sessions/${s.id}`)).status}`;
        },
        async bulk() {
          const ids = q("SELECT id FROM sessions WHERE source != 'inferred' ORDER BY RANDOM() LIMIT 3").map((x) => x.id);
          if (!ids.length) return 'skip';
          const action = pick(['baseline', 'play', 'delete']);
          return `bulk ${action} ${ids} -> ${(await call('POST', '/sessions/bulk', { ids, action })).status}`;
        },
        async merge() {
          const gs = q('SELECT id FROM games ORDER BY RANDOM() LIMIT 2');
          if (gs.length < 2) return 'skip';
          return `merge ${gs[1].id} into ${gs[0].id} -> ${(await call('POST', `/games/${gs[0].id}/merge`, { source_ids: [gs[1].id] })).status}`;
        },
        async move() {
          const e = pick(q('SELECT id FROM entries')); const g = pick(q('SELECT id FROM games'));
          if (!e || !g) return 'skip';
          return `move entry ${e.id} to game ${g.id} -> ${(await call('POST', `/entries/${e.id}/move`, { game_id: g.id })).status}`;
        },
        async split() {
          const e = pick(q('SELECT id FROM entries'));
          if (!e) return 'skip';
          return `split entry ${e.id} -> ${(await call('POST', `/entries/${e.id}/split`, {})).status}`;
        },
        async exclude() {
          const e = pick(q('SELECT id, excluded FROM entries'));
          if (!e) return 'skip';
          return `entry ${e.id} excluded=${!e.excluded} -> ${(await call('PATCH', `/entries/${e.id}`, { excluded: !e.excluded })).status}`;
        },
        async playtime() {
          const e = pick(q('SELECT id, playtime_min FROM entries'));
          if (!e) return 'skip';
          const total = Math.max(0, e.playtime_min + int(-60, 200));
          return `entry ${e.id} playtime ${total} -> ${(await call('POST', `/entries/${e.id}/playtime`, { playtime_minutes: total })).status}`;
        },
        async history() {
          const e = pick(q('SELECT id FROM entries WHERE baseline_min > 0'));
          if (!e) return 'skip';
          const end = clock.now - int(1, 400) * DAY; const start = end - int(1, 900) * DAY;
          const body = pick([{ first_played_at: start, last_played_at: end }, { first_played_at: start }, { last_played_at: end }, { first_played_at: start, last_played_at: end, coarse: true }, { mode: 'undated' }, { mode: 'auto' }, { reset: true },
            { acknowledge: true }, { minutes: int(0, 2000) }, { first_played_at: end, last_played_at: start }, { first_played_at: clock.now + 30 * DAY }]);
          return `history entry ${e.id} ${JSON.stringify(body)} -> ${(await call('PATCH', `/entries/${e.id}/history`, body)).status}`;
        },
        async game() {
          const g = pick(q('SELECT id FROM games'));
          if (!g) return 'skip';
          const body = pick([{ status: pick(['playing', 'backlog', 'completed', 'beaten', 'dropped', 'unset', 'wishlist']) }, { title: pick(TITLES) }, { hidden: r() < 0.5 }, { rating: int(1, 10) }, { merge_locked: r() < 0.5 }, { notes: 'x' }]);
          return `game ${g.id} ${JSON.stringify(body)} -> ${(await call('PATCH', `/games/${g.id}`, body)).status}`;
        },
        async deleteGame() {
          const g = pick(q('SELECT id FROM games'));
          if (!g || r() < 0.6) return 'skip';
          return `delete game ${g.id} -> ${(await call('DELETE', `/games/${g.id}`)).status}`;
        },
        async settings() {
          const body = pick([{ assumed_hours: r() < 0.5 }, { week_starts_on: int(0, 1) }, { history_max_day_minutes: pick([240, 480, 720]) }]);
          return `settings ${JSON.stringify(body)} -> ${(await call('PUT', '/settings', body)).status}`;
        },
        async reinfer() { return `reinfer -> ${(await call('POST', '/history/reinfer', {})).status}`; },
        async era() { return `era -> ${(await call('POST', '/legends/eras', { name: `Era ${int(1, 99)}`, from: `${int(2019, 2025)}-0${int(1, 9)}`, to: r() < 0.5 ? '' : '2025-12' })).status}`; },
        async wait() { clock.advance(int(1, 72) * HOUR); return 'time passes'; },
      };
      const weighted = ['report', 'report', 'report', 'report', 'session', 'session', 'session', 'wait', 'wait', 'wait', 'add', 'editSession', 'editSession', 'deleteSession', 'bulk', 'merge', 'move', 'split', 'exclude', 'playtime',
        'history', 'history', 'game', 'game', 'deleteGame', 'settings', 'reinfer', 'era', 'account'];

      const check = async (step) => {
        const where = `seed ${seed}, step ${step}:\n${log.slice(-8).join('\n')}\n`;
        assert.deepEqual(totalsMismatch(h.db), [], `entry totals equal their sessions; ${where}`);
        assert.deepEqual(rollupMismatch(h.db), { bad: [], orphans: 0, stale: 0, pending: 0 }, `rollups equal sessions; ${where}`);
        const one = (sql) => h.db.prepare(sql).get();
        assert.equal(one('SELECT COUNT(*) n FROM sessions WHERE minutes < 0 OR minutes IS NULL').n, 0, `no negative session; ${where}`);
        assert.equal(one('SELECT COUNT(*) n FROM entries WHERE playtime_min < 0 OR baseline_min < 0 OR baseline_min > playtime_min').n, 0, `history within the total; ${where}`);
        assert.equal(one('SELECT COUNT(*) n FROM entries e LEFT JOIN games g ON g.id = e.game_id WHERE g.id IS NULL').n, 0, `no entry without its game; ${where}`);
        assert.equal(one('SELECT COUNT(*) n FROM sessions s LEFT JOIN entries e ON e.id = s.entry_id WHERE e.id IS NULL').n, 0, `no session without its entry; ${where}`);
        assert.equal(one('SELECT COUNT(*) n FROM games g WHERE NOT EXISTS (SELECT 1 FROM entries e WHERE e.game_id = g.id)').n, 0, `no game without an entry; ${where}`);
        assert.equal(one('SELECT COUNT(*) n FROM play_days WHERE minutes < 0 OR minutes > 1440.5').n, 0, `no day of more than 24 hours for one session; ${where}`);
        assert.equal(one("SELECT COUNT(*) n FROM sessions WHERE kind = 'play' AND source != 'inferred' AND started_at IS NOT NULL AND ended_at IS NOT NULL AND ended_at < started_at").n, 0, `no session ending before it starts; ${where}`);
        if (step % 10 && step !== STEPS) return;
        // the pages agree with the database and with each other
        const sum = one('SELECT COALESCE(SUM(playtime_min), 0) m FROM entries WHERE excluded = 0').m;
        const life = (await call('GET', '/stats/lifetime')).body;
        assert.equal(life.total_minutes, sum, `lifetime is the sum of counted entries; ${where}`);
        const all = (await call('GET', '/stats?range=all&estimates=include')).body;
        const undated = one("SELECT COALESCE(SUM(s.minutes), 0) m FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.excluded = 0 AND s.kind = 'baseline'").m;
        assert.ok(Math.abs(all.total_minutes + undated - sum) <= 2, `all-time play + undated history = lifetime (${all.total_minutes} + ${undated} vs ${sum}); ${where}`);
        all.series.forEach((s, i) => assert.ok(Math.abs(Object.values(all.series_by_basis).reduce((a, v) => a + v[i], 0) - s.minutes) <= 3, `a bucket is the sum of its kinds; ${where}`));
        const games = (await call('GET', '/games?limit=5000&hidden=all')).body;
        const rows = games.items || games;
        assert.equal(rows.length, one('SELECT COUNT(*) n FROM games').n, `the library lists every game; ${where}`);
        assert.equal(rows.reduce((a, g) => a + g.minutes, 0), sum, `the library's hours are the lifetime; ${where}`);
        const leg = (await call('GET', '/legends')).body;
        // (a game on the wish list that was played is part of the career; one never played has no minutes to count)
        assert.equal(leg.career.minutes, sum, `the career is the lifetime; ${where}`);
        for (const path of ['/summary', '/stats/milestones', '/franchises', '/stats/library', '/stats/findings?range=all', '/duplicates', '/history/review?limit=20', '/suggest', '/stats/facts', '/stats/years', '/sessions?limit=50']) await call('GET', path);
        const g = rows[Math.floor(r() * rows.length)];
        if (g) {
          const d = (await call('GET', `/games/${g.id}`)).body;
          assert.equal(d.entries.filter((e) => !e.excluded).reduce((a, e) => a + e.playtime_min, 0), g.minutes, `a game is the sum of its counted entries; ${where}`);
          const s = d.summary;
          if (s) assert.ok(Math.abs((s.tracked_minutes || 0) + (s.estimated_minutes || 0) + (s.baseline_minutes || 0) - s.total_minutes) <= 2, `a game's parts add up (${JSON.stringify(s)}); ${where}`);
          await call('GET', `/games/${g.id}/stats`); await call('GET', `/games/${g.id}/achievements`); await call('GET', `/games/${g.id}/forecast`);
        }
      };

      for (let step = 1; step <= STEPS; step++) {
        const name = step <= 3 ? ['account', 'report', 'add'][step - 1] : pick(weighted);
        log.push(`${step} ${name}: ${await ops[name]()}`);
        await check(step);
      }
      // whatever life it had, the library leaves in an export and arrives whole in a fresh instance
      const life = (await call('GET', '/stats/lifetime')).body;
      const exported = (await call('GET', '/export')).body;
      const fresh = await startApp();
      try {
        const res = await fresh.call('POST', '/import', exported);
        assert.ok(res.status < 300, `import of the export -> ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
        const there = await fresh.get('/stats/lifetime');
        if (process.env.FUZZ_DEBUG && there.total_minutes !== life.total_minutes) {
          const rowsOf = (db) => db.prepare("SELECT g.title, e.platform, e.account_id IS NULL local, e.excluded, e.playtime_min m, e.baseline_min b FROM entries e JOIN games g ON g.id = e.game_id ORDER BY g.title, e.platform, m").all().map((x) => `${x.title}|${x.platform}|${x.local ? 'local' : 'acct'}|x${x.excluded}|${x.m}|b${x.b}`);
          console.log('BEFORE\n' + rowsOf(h.db).join('\n')); console.log('AFTER\n' + rowsOf(fresh.db).join('\n'));
          console.log('EXPORT', JSON.stringify(exported).slice(0, 1500)); console.log('IMPORT RESULT', JSON.stringify(res.body).slice(0, 600));
        }
        assert.equal(there.total_minutes, life.total_minutes, `seed ${seed}: the lifetime survives an export and import`);
        assert.deepEqual(totalsMismatch(fresh.db), [], `seed ${seed}: the imported entries add up`);
        assert.deepEqual(rollupMismatch(fresh.db), { bad: [], orphans: 0, stale: 0, pending: 0 }, `seed ${seed}: the imported rollups add up`);
      } finally { await fresh.close(); }
    });
  });
}

describe('what an export must carry for a restore to be the same library', () => {
  let h;
  before(async () => { guardNetwork(); clock.install(local(2025, 1, 6, 12)); h = await startApp(); });
  after(async () => { await h?.close(); clock.uninstall(); restoreNetwork(); });

  test('two entries that share a title, platform and account stay two; a game never played stays unplayed', async () => {
    const acc = await h.post('/accounts', { platform: 'custom', name: 'Console', config: {} });
    // the same title twice under one account (two releases the platform lists apart), and one never started
    await h.post(`/accounts/${acc.id}/report`, { games: [{ id: 'a', title: 'Halo 3', playtime_minutes: 600 }, { id: 'b', title: 'Halo 3', playtime_minutes: 240 }, { id: 'c', title: 'Celeste', playtime_minutes: 0 }] });
    const before_ = await h.get('/stats/lifetime');
    assert.deepEqual([before_.total_minutes, before_.games_played], [840, 1]);
    const exported = await h.get('/export');
    assert.deepEqual(exported.games.map((g) => [g.title, g.playtime_minutes, g.copy ?? null]), [['Celeste', 0, null], ['Halo 3', 600, null], ['Halo 3', 240, 2]]);
    const fresh = await startApp();
    try {
      await fresh.post('/import', exported);
      const there = await fresh.get('/stats/lifetime');
      assert.deepEqual([there.total_minutes, there.games_played], [840, 1], 'both copies arrive; the untouched game is not "played"');
      assert.deepEqual(fresh.db.prepare("SELECT playtime_min m, last_played_at lp FROM entries ORDER BY playtime_min").all().map((r) => [r.m, r.lp]), [[0, null], [240, null], [600, null]]);
      // imported again: nothing is added twice
      await fresh.post('/import', exported);
      assert.equal((await fresh.get('/stats/lifetime')).total_minutes, 840);
      assert.equal(fresh.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 3);
    } finally { await fresh.close(); }
  });
});

