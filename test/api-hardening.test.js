// Requests that used to answer 500 (or the wrong thing): a text body to a JSON route, a request
// target that is not a URL, offsets past any integer, a non-number week, game_id=0 with highlights,
// and an aborted backup download leaving its copy behind. Also: the OpenAPI document's public routes.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

describe('API hardening', () => {
  let srv; let close; let base; let port; let dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-hard-'));
    ({ server: srv, close } = createApp({ dbFile: path.join(dir, 'vestigo.db'), password: '', scheduler: false, log: quiet }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    port = srv.address().port;
    base = `http://127.0.0.1:${port}/api/v1`;
    await fetch(`${base}/games`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Hades' }) });
  });
  after(() => close());

  test('a text/plain body to a JSON route is not a server error', async () => {
    const r = await fetch(`${base}/games/1`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body: 'title=x' });
    assert.ok(r.status < 500, `status ${r.status}`);
  });

  test('a request target that is not a URL gets 400', async () => {
    const reply = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let out = ''; s.on('data', (d) => { out += d; }); s.on('end', () => resolve(out)); s.on('error', () => resolve(out));
    });
    assert.match(reply, /^HTTP\/1\.1 400/);
  });

  test('huge offsets, a non-number week and game_id=0 are answered, not 500', async () => {
    for (const p of ['/games?offset=99999999999999999999', '/sessions?offset=99999999999999999999']) assert.equal((await fetch(base + p)).status, 200, p);
    assert.equal((await fetch(`${base}/summary/week?weeks_ago=abc`)).status, 400);
    assert.equal((await fetch(`${base}/stats?highlights=true&game_id=0`)).status, 200);
  });

  test('public routes need no token in the OpenAPI document; uploads list their content types', async () => {
    const doc = await (await fetch(`http://127.0.0.1:${port}/api/openapi.json`)).json();
    assert.deepEqual(doc.paths['/api/v1/health']?.get?.security ?? doc.paths['/api/v1/auth/status']?.get?.security, []);
    assert.ok(doc.paths['/api/v1/import/gametrack'].post.requestBody.content['application/zip']);
    assert.ok(doc.paths['/api/v1/import'].post.requestBody.content['text/csv']);
  });

  test('a backup download cancelled while the copy is made leaves no copy behind', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('vestigo-backup-'));
    const ctl = new AbortController();
    const p = fetch(`${base}/backup`, { signal: ctl.signal }).catch(() => null);
    setTimeout(() => ctl.abort(), 1);
    await p;
    await new Promise((r) => setTimeout(r, 500));
    const left = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('vestigo-backup-') && !before.includes(f));
    assert.deepEqual(left, []);
  });
});
