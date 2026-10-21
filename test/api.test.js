import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

let app; let base;
const quiet = { info() {}, warn() {}, error() {} };

before(async () => {
  app = createApp({ dbFile: ':memory:', password: '', log: quiet, scheduler: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
});
after(() => app.close());

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

test('custom account push → sessions → stats', async () => {
  const acc = await call('/accounts', { method: 'POST', body: { platform: 'custom', name: 'Switch', config: { platform_label: 'Switch' } } });
  assert.equal(acc.status, 200);
  const id = acc.data.id;
  // first report = initial import → baseline only
  let r = await call(`/accounts/${id}/report`, { method: 'POST', body: { games: [{ id: 'totk', title: 'Zelda TotK', playtime_minutes: 3000 }] } });
  assert.equal(r.data.initial, true);
  assert.equal(r.data.sessions_created, 0);
  assert.equal(r.data.baseline_minutes, 3000);
  // second report: +45 minutes (elapsed time is tiny, so allow via tolerance setting)
  await call('/settings', { method: 'PUT', body: { max_overage_minutes: 120 } });
  r = await call(`/accounts/${id}/report`, { method: 'POST', body: { games: [{ id: 'totk', title: 'Zelda TotK', playtime_minutes: 3045 }] } });
  assert.equal(r.data.sessions_created, 1);
  assert.equal(r.data.minutes_added, 45);
  const st = await call('/stats?range=7d');
  assert.equal(st.data.total_minutes, 45);
  const w = await call('/widget');
  assert.equal(w.data.lifetime_hours, 51);
});

test('manual game, manual session, edit + delete', async () => {
  const g = await call('/games', { method: 'POST', body: { title: 'Celeste' } });
  const s = await call('/sessions', { method: 'POST', body: { game_id: g.data.id, minutes: 30, note: 'Ch 1' } });
  assert.equal(s.data.minutes, 30);
  let gd = await call(`/games/${g.data.id}`);
  assert.equal(gd.data.summary.total_minutes, 30);
  await call(`/sessions/${s.data.id}`, { method: 'PATCH', body: { minutes: 50 } });
  gd = await call(`/games/${g.data.id}`);
  assert.equal(gd.data.summary.total_minutes, 50);
  const del = await call(`/sessions/${s.data.id}`, { method: 'DELETE' });
  assert.equal(del.data.result, 'deleted');
  gd = await call(`/games/${g.data.id}`);
  assert.equal(gd.data.summary.total_minutes, 0);
  const patch = await call(`/games/${g.data.id}`, { method: 'PATCH', body: { status: 'completed', rating: 9, favorite: true } });
  assert.equal(patch.data.status, 'completed');
  assert.equal((await call(`/games/${g.data.id}`, { method: 'PATCH', body: { status: 'nope' } })).status, 400);
});

test('CSV import, merge, split, export', async () => {
  const csv = 'title,platform,playtime_hours,status\nHollow Knight,import,20,completed\n"Hollow Knight: Voidheart Edition",xbox,5,\n';
  const imp = await call('/import', { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv' } });
  assert.equal(imp.data.games, 2);
  assert.equal(imp.data.baseline_minutes, 1500);
  const dup = await call('/duplicates');
  const sug = dup.data.suggestions.find((x) => x.games.some((g) => g.title === 'Hollow Knight'));
  assert.ok(sug);
  const [a, b] = sug.games;
  const merged = await call(`/games/${a.id}/merge`, { method: 'POST', body: { source_ids: [b.id] } });
  assert.equal(merged.data.entries.length, 2);
  assert.equal(merged.data.summary.total_minutes, 1500);
  const split = await call(`/entries/${merged.data.entries[1].id}/split`, { method: 'POST' });
  assert.notEqual(split.data.id, a.id);
  const ex = await fetch(`${base}/export`).then((r) => r.json());
  assert.equal(ex.format, 'playtracker-export');
  assert.ok(ex.games.length >= 3);
  const csvOut = await fetch(`${base}/export?format=csv`).then((r) => r.text());
  assert.match(csvOut, /^title,platform/);
});

test('settings validation and schedule label', async () => {
  const bad = await call('/settings', { method: 'PUT', body: { schedule_mode: 'yearly' } });
  assert.equal(bad.status, 400);
  const ok = await call('/settings', { method: 'PUT', body: { schedule_mode: 'days', schedule_every: 3, schedule_time: '05:30' } });
  assert.equal(ok.data.schedule_label, 'Every 3 days at 05:30');
});

test('password protects the API; tokens work', async () => {
  const tok = await call('/tokens', { method: 'POST', body: { name: 'ci' } });
  assert.match(tok.data.token, /^pt_/);
  const set = await fetch(`${base}/auth/password`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'hunter22' }) });
  assert.equal(set.status, 200);
  assert.equal((await call('/games')).status, 401);
  assert.equal((await call('/health')).status, 200);
  assert.equal((await call('/games', { headers: { Authorization: `Bearer ${tok.data.token}` } })).status, 200);
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'hunter22' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/games', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await call('/auth/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
  // remove password again
  await call('/auth/password', { method: 'PUT', body: { current: 'hunter22', password: '' }, headers: { Cookie: cookie } });
  assert.equal((await call('/games')).status, 200);
});

test('openapi spec lists routes', async () => {
  const spec = await fetch(base.replace('/v1', '') + '/openapi.json').then((r) => r.json());
  assert.ok(spec.paths['/api/v1/accounts/{id}/report'].post);
});

test('pushed reports without recent minutes are not treated as "nothing recent" (Steam strict counter)', async () => {
  const acc = await call('/accounts', { method: 'POST', body: { platform: 'steam', name: 'pushed', config: { api_key: 'k', steam_id: '76561197960287930' }, sync: false } });
  await call(`/accounts/${acc.data.id}/report`, { method: 'POST', body: { games: [{ id: '10', title: 'CS', playtime_minutes: 100 }] } });
  app.app.db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(Date.now() - 86_400_000, acc.data.id);
  app.app.db.prepare('UPDATE entries SET last_synced_at = ? WHERE account_id = ?').run(Date.now() - 86_400_000, acc.data.id);
  const r = await call(`/accounts/${acc.data.id}/report`, { method: 'POST', body: { games: [{ id: '10', title: 'CS', playtime_minutes: 160 }] } });
  assert.equal(r.data.minutes_added, 60);
  assert.equal(r.data.late_minutes, 0);
});
