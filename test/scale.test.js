import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { rebuildRollups } from '../src/services/rollup.js';

let app; let base; let db;
const quiet = { info() {}, warn() {}, error() {} };
const DAY = 86_400_000;

before(async () => {
  app = createApp({ dbFile: ':memory:', password: '', log: quiet, scheduler: false });
  db = app.app.db;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  // 3 games x 2 platforms, 400 manual sessions spread over 200 days
  const games = [];
  for (const t of ['Alpha', 'Beta', 'Gamma']) games.push((await call('/games', { method: 'POST', body: { title: t } })).id);
  const now = Date.now();
  for (let i = 0; i < 400; i++) {
    await call('/sessions', { method: 'POST', body: { game_id: games[i % 3], minutes: 30 + (i % 5) * 10, ended_at: now - Math.floor(i / 2) * DAY - (i % 2) * 3600_000 } });
  }
});
after(() => app.close());

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

const rollupTotal = () => db.prepare('SELECT ROUND(SUM(minutes)) m FROM play_days WHERE excluded = 0').get().m;
const sessionTotal = () => db.prepare("SELECT SUM(minutes) m FROM sessions WHERE kind = 'play'").get().m;

test('rollups mirror sessions exactly', async () => {
  assert.equal(rollupTotal(), sessionTotal());
  const st = await call('/stats?range=all');
  assert.equal(st.total_minutes, sessionTotal());
  assert.equal(st.sessions, 400);
  assert.equal(st.games_played, 3);
});

test('editing, excluding, merging and deleting keep stats consistent', async () => {
  const [s] = (await call('/sessions?limit=1')).items;
  await call(`/sessions/${s.id}`, { method: 'PATCH', body: { minutes: s.minutes + 100 } });
  assert.equal(rollupTotal(), sessionTotal());
  await call(`/sessions/${s.id}`, { method: 'DELETE' });
  assert.equal(rollupTotal(), sessionTotal());

  const games = (await call('/games?sort=title')).items;
  const alpha = games.find((g) => g.title === 'Alpha');
  const beta = games.find((g) => g.title === 'Beta');
  const before = (await call('/stats?range=all')).total_minutes;
  const betaMin = (await call(`/stats?range=all&game_id=${beta.id}`)).total_minutes;

  // exclude Beta's entry -> its minutes leave the stats, include -> they come back
  const betaEntry = (await call(`/games/${beta.id}`)).entries[0];
  await call(`/entries/${betaEntry.id}`, { method: 'PATCH', body: { excluded: true } });
  assert.equal((await call('/stats?range=all')).total_minutes, before - betaMin);
  await call(`/entries/${betaEntry.id}`, { method: 'PATCH', body: { excluded: false } });
  assert.equal((await call('/stats?range=all')).total_minutes, before);

  // merge Beta into Alpha -> rollups follow the new game id
  await call(`/games/${alpha.id}/merge`, { method: 'POST', body: { source_ids: [beta.id] } });
  const top = (await call('/stats?range=all')).top_games;
  assert.equal(top.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM play_days WHERE game_id = ?').get(beta.id).n, 0);
  assert.equal((await call('/stats?range=all')).total_minutes, before);
});

test('full rebuild (timezone change) reproduces the same totals', () => {
  const t = rollupTotal();
  rebuildRollups(db);
  assert.equal(rollupTotal(), t);
});

test('keyset paging walks every session exactly once', async () => {
  const seen = new Set();
  let cursor = null; let pages = 0;
  do {
    const r = await call(`/sessions?limit=37${cursor ? `&before=${cursor}` : ''}`);
    for (const s of r.items) { assert.ok(!seen.has(s.id), 'duplicate session across pages'); seen.add(s.id); }
    cursor = r.next; pages++;
  } while (cursor && pages < 100);
  assert.equal(seen.size, (await call('/sessions?limit=1')).total);
});

test('library paging returns disjoint pages and totals', async () => {
  const p1 = await call('/games?limit=1&offset=0&sort=title');
  const p2 = await call('/games?limit=1&offset=1&sort=title');
  assert.equal(p1.total, 2);
  assert.notEqual(p1.items[0].id, p2.items[0].id);
  assert.ok(p1.total_minutes > 0 && p1.max_minutes > 0);
});

test('streamed export is valid JSON with every session', async () => {
  const ex = await fetch(`${base}/export`).then((r) => r.json());
  const n = ex.games.reduce((a, g) => a + g.sessions.length, 0);
  assert.equal(n, db.prepare("SELECT COUNT(*) n FROM sessions WHERE kind = 'play'").get().n);
});
