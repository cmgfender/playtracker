import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createLogger } from '../src/logger.js';

let app; let base;
const realFetch = globalThis.fetch;

before(async () => {
  app = createApp({ dbFile: ':memory:', password: '', log: createLogger({ quiet: true, file: '' }), scheduler: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
});
after(() => { app.close(); globalThis.fetch = realFetch; });

const call = async (path, opts = {}) => (await realFetch(base + path, opts)).json();

test('sync failures are persisted to the error log with context', async () => {
  globalThis.fetch = async (url) => (String(url).startsWith('http://127.0.0.1') ? realFetch(url) : new Response('nope', { status: 403 }));
  const acc = await call('/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'steam', config: { api_key: 'bad', steam_id: '76561197960287930' }, sync: false }) });
  const res = await realFetch(`${base}/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
  globalThis.fetch = realFetch;
  assert.equal(res.status, 502);
  const logs = await call('/logs?level=error');
  assert.ok(logs.items.length >= 1);
  const e = logs.items[0];
  assert.equal(e.source, 'sync');
  assert.match(e.message, /steam\/Steam failed/);
  assert.equal(e.context.account_id, acc.id);
  assert.equal(e.context.auth, true);
  assert.ok(logs.counts_24h.error >= 1);
  const sys = await call('/system');
  assert.ok(sys.errors_24h >= 1);
  const a = sys.accounts.find((x) => x.id === acc.id);
  assert.equal(a.failed_syncs_7d, 1);
  assert.match(a.last_error, /credentials/);
  assert.ok(a.api_usage_24h.errors >= 1);
  assert.ok(a.capabilities.limitations.length > 0);
  assert.ok(Array.isArray(sys.console));
});

test('unknown API routes and bad input do not pollute the error log', async () => {
  const before_ = (await call('/logs')).items.length;
  await realFetch(`${base}/games/999999`);
  await realFetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
  assert.equal((await call('/logs')).items.length, before_);
  const sys = await call('/system');
  assert.ok(sys.http.client_errors >= 2);
});

test('clearing the log', async () => {
  await realFetch(`${base}/logs`, { method: 'DELETE' });
  assert.equal((await call('/logs')).items.length, 0);
});
