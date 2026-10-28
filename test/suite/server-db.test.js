// Server, persistence and scale - black-box tests of the real server process and its database.
//
//  - SPA serving: index fallback for client routes, 404 for missing assets, caching headers,
//    ETag revalidation, brotli/gzip negotiation, traversal safety
//  - ports: PORT, fallback when the port is taken, fallback disabled
//  - data directory and migrations: fresh install, PLAYTRACKER_DB override, empty file,
//    idempotent reopen, upgrade of a first-release (v1) database, corrupt / foreign files
//  - upgrading a PlayTracker install in place: its playtracker.db, PLAYTRACKER_* variables and pt_
//    tokens keep working; vestigo.db vs playtracker.db; VESTIGO_* names win over PLAYTRACKER_*
//  - restarts: SIGTERM / SIGINT / SIGKILL keep every acknowledged write, tracking continues
//  - time zones: day/hour buckets follow TZ and are rebuilt when it changes (incl. DST)
//  - concurrency: parallel writes, reads, imports, merges, deletes and syncs
//  - scale: 20k games / 200k sessions seeded directly; key endpoints stay fast and exact
//
// Expectations come from README.md / docs and from what a correct tracker must do.
import './helpers/server-db-tz.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../../src/server.js';
import { openDb } from '../../src/db.js';
import { resolveDbFile } from '../../src/env.js';
import * as H from './helpers/server-db-harness.js';
import { buildLegacyV1, LEGACY, LEGACY_TOKEN } from './helpers/server-db-legacy.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now(); // captured once; every relative time below derives from it

after(() => H.cleanupTmp());

const readPublic = (f) => fs.readFileSync(path.join(H.PUBLIC, f));
const ok = (r, what) => { assert.equal(r.status, 200, `${what}: HTTP ${r.status} ${r.text?.slice(0, 300)}`); return r.json; };

// =====================================================================================
describe('SPA and static files (real server process)', () => {
  let srv;
  let index;
  before(async () => {
    const dir = H.tmpDir();
    srv = await H.startServer({ env: { PORT: String(await H.freePort()), PLAYTRACKER_DATA: dir, TZ: 'UTC' } });
    index = readPublic('index.html');
  });
  after(async () => { await srv?.stop(); });

  test('GET / serves the app shell with HTML type and safety headers', async () => {
    const r = await H.rawRequest(srv.port, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.deepEqual(r.body, index);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(r.headers['x-frame-options'], 'clickjacking protection header');
  });

  test('client-side routes fall back to index.html (deep links and reloads work)', async () => {
    for (const p of ['/library', '/game/12', '/game/999999', '/sessions', '/stats', '/wrapped/2025', '/duplicates', '/history', '/accounts',
      '/system', '/settings', '/api', '/more', '/library?q=hades&sort=playtime', '/stats#top', '/some/unknown/client/route', '/library/']) {
      const r = await H.rawRequest(srv.port, p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers['content-type'], /^text\/html/, p);
      assert.deepEqual(r.body, index, `${p} must serve the app shell`);
    }
  });

  test('missing static assets are a real 404 - never the app shell', async () => {
    for (const p of ['/missing.js', '/app.js.map', '/img/cover.png', '/favicon.ico', '/robots.txt', '/fonts/x.woff2', '/app.css.bak', '/pages.min.js', '/game/12.json']) {
      const r = await H.rawRequest(srv.port, p);
      assert.equal(r.status, 404, p);
      assert.notDeepEqual(r.body, index, `${p} must not return index.html`);
      assert.doesNotMatch(String(r.headers['content-type'] || ''), /text\/html/, `${p} 404 is not HTML`);
    }
  });

  test('unknown API paths answer a JSON 404 - never the app shell', async () => {
    for (const p of ['/api/v1/does-not-exist', '/api/v2/games', '/api/nothing', '/api/v1/games/1/nope']) {
      const r = await H.rawRequest(srv.port, p);
      assert.equal(r.status, 404, p);
      assert.match(r.headers['content-type'], /application\/json/, p);
      assert.ok(JSON.parse(r.body.toString()).error, `${p} has an error message`);
    }
    const bad = await H.rawRequest(srv.port, '/api/v1/games', { method: 'PUT' });
    assert.equal(bad.status, 405, 'known API path, wrong method');
  });

  test('every file the shell, the manifest and the scripts reference exists with the right type and exact content', async () => {
    const html = index.toString();
    const refs = new Set([...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]));
    const manifest = JSON.parse(readPublic('manifest.webmanifest').toString());
    for (const i of manifest.icons) refs.add(i.src);
    // every module the app imports, followed from app.js through pages.js into pages/*.js
    const todo = ['/app.js'];
    for (let f; (f = todo.shift());) {
      for (const m of readPublic(f.slice(1)).toString().matchAll(/from '(\.\.?\/[\w./-]+\.js)'/g)) {
        const ref = path.posix.join(path.posix.dirname(f), m[1]);
        if (!refs.has(ref)) { refs.add(ref); todo.push(ref); }
      }
    }
    assert.ok(refs.has('/pages.js') && refs.has('/pages/shared.js'), `the page modules are found: ${[...refs]}`);
    refs.add('/sw.js');
    const types = { '.js': /^text\/javascript/, '.css': /^text\/css/, '.svg': /^image\/svg\+xml/, '.png': /^image\/png/, '.webmanifest': /^application\/manifest\+json/ };
    assert.ok(refs.size >= 8, `found references: ${[...refs]}`);
    for (const ref of refs) {
      const r = await H.rawRequest(srv.port, ref);
      assert.equal(r.status, 200, ref);
      assert.match(r.headers['content-type'], types[path.extname(ref)], `${ref} content type`);
      assert.deepEqual(r.body, readPublic(ref.slice(1)), `${ref} body is the file on disk`);
    }
  });

  test('app code revalidates on every load (no-cache + ETag); images may be cached', async () => {
    for (const p of ['/', '/library', '/app.js', '/pages.js', '/pages/game.js', '/charts.js', '/app.css', '/manifest.webmanifest', '/sw.js']) {
      const r = await H.rawRequest(srv.port, p);
      const cc = String(r.headers['cache-control'] || '');
      assert.ok(/no-cache|max-age=0|must-revalidate/.test(cc), `${p} must revalidate, got "${cc}"`);
      assert.doesNotMatch(cc, /immutable/, p);
      assert.ok(r.headers.etag, `${p} has an ETag to revalidate against`);
    }
    for (const p of ['/icon.svg', '/icon-192.png', '/icon-512.png']) {
      const r = await H.rawRequest(srv.port, p);
      const m = /max-age=(\d+)/.exec(String(r.headers['cache-control'] || ''));
      assert.ok(m && Number(m[1]) > 0, `${p} is cacheable: ${r.headers['cache-control']}`);
      assert.ok(r.headers.etag, p);
    }
  });

  test('a matching ETag gets 304 with no body; a stale one gets the full file', async () => {
    for (const p of ['/app.js', '/', '/icon-192.png']) {
      const first = await H.rawRequest(srv.port, p);
      const etag = first.headers.etag;
      const again = await H.rawRequest(srv.port, p);
      assert.equal(again.headers.etag, etag, `${p} ETag is stable`);
      const nm = await H.rawRequest(srv.port, p, { headers: { 'if-none-match': etag } });
      assert.equal(nm.status, 304, p);
      assert.equal(nm.body.length, 0, `${p} 304 has no body`);
      assert.equal(nm.headers.etag, etag);
      const stale = await H.rawRequest(srv.port, p, { headers: { 'if-none-match': '"stale-etag"' } });
      assert.equal(stale.status, 200, p);
      assert.deepEqual(stale.body, first.body);
    }
    // the shell and a client route are the same file: one ETag
    assert.equal((await H.rawRequest(srv.port, '/stats')).headers.etag, (await H.rawRequest(srv.port, '/')).headers.etag);
    assert.notEqual((await H.rawRequest(srv.port, '/app.js')).headers.etag, (await H.rawRequest(srv.port, '/app.css')).headers.etag, 'different files, different ETags');
  });

  test('If-None-Match follows HTTP semantics: a list of ETags, a weak validator, or *', async () => {
    const etag = (await H.rawRequest(srv.port, '/app.js')).headers.etag;
    for (const v of [`"older", ${etag}`, `W/${etag}`, '*']) {
      const r = await H.rawRequest(srv.port, '/app.js', { headers: { 'if-none-match': v } });
      assert.equal(r.status, 304, `If-None-Match: ${v}`);
    }
  });

  test('brotli is preferred, gzip is the fallback, identity otherwise - and every body decodes to the exact file', async () => {
    for (const f of ['app.js', 'pages.js', 'pages/game.js', 'app.css', 'index.html', 'icon.svg', 'manifest.webmanifest']) {
      const want = readPublic(f);
      const url = f === 'index.html' ? '/' : `/${f}`;
      const br = await H.rawRequest(srv.port, url, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
      assert.equal(br.headers['content-encoding'], 'br', `${f} br`);
      assert.deepEqual(zlib.brotliDecompressSync(br.body), want, `${f} br body`);
      assert.equal(Number(br.headers['content-length']), br.body.length);
      assert.match(String(br.headers.vary || ''), /accept-encoding/i, `${f} Vary`);
      assert.ok(br.body.length < want.length, `${f} br is smaller`);

      const gz = await H.rawRequest(srv.port, url, { headers: { 'accept-encoding': 'gzip' } });
      assert.equal(gz.headers['content-encoding'], 'gzip', `${f} gzip`);
      assert.deepEqual(zlib.gunzipSync(gz.body), want, `${f} gzip body`);

      for (const ae of [undefined, 'identity', 'deflate']) {
        const id = await H.rawRequest(srv.port, url, { headers: ae ? { 'accept-encoding': ae } : {} });
        assert.equal(id.headers['content-encoding'], undefined, `${f} with Accept-Encoding ${ae}`);
        assert.deepEqual(id.body, want);
        assert.equal(Number(id.headers['content-length']), want.length);
      }
    }
  });

  test('already-compressed images are sent as they are', async () => {
    for (const f of ['icon-192.png', 'icon-512.png']) {
      const r = await H.rawRequest(srv.port, `/${f}`, { headers: { 'accept-encoding': 'gzip, br' } });
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-encoding'], undefined, f);
      assert.deepEqual(r.body, readPublic(f));
    }
  });

  test('a coding refused with q=0 is never used', async () => {
    const a = await H.rawRequest(srv.port, '/app.js', { headers: { 'accept-encoding': 'br;q=0, gzip' } });
    assert.notEqual(a.headers['content-encoding'], 'br', 'br;q=0 means "not br"');
    const b = await H.rawRequest(srv.port, '/app.js', { headers: { 'accept-encoding': 'gzip;q=0' } });
    assert.equal(b.headers['content-encoding'], undefined, 'gzip;q=0 means "not gzip"');
  });

  test('HEAD returns the same headers as GET and no body', async () => {
    for (const ae of ['br', 'gzip', '']) {
      const get = await H.rawRequest(srv.port, '/app.css', { headers: { 'accept-encoding': ae } });
      const head = await H.rawRequest(srv.port, '/app.css', { method: 'HEAD', headers: { 'accept-encoding': ae } });
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);
      assert.equal(head.headers['content-length'], get.headers['content-length'], `HEAD length (${ae || 'identity'})`);
      assert.equal(head.headers.etag, get.headers.etag);
      assert.equal(head.headers['content-encoding'], get.headers['content-encoding']);
    }
    const head404 = await H.rawRequest(srv.port, '/nope.js', { method: 'HEAD' });
    assert.equal(head404.status, 404);
  });

  test('writes to static paths are refused with 405', async () => {
    for (const [m, p] of [['POST', '/'], ['PUT', '/app.js'], ['DELETE', '/library'], ['PATCH', '/index.html'], ['POST', '/missing.js']]) {
      const r = await H.rawRequest(srv.port, p, { method: m });
      assert.equal(r.status, 405, `${m} ${p}`);
    }
  });

  test('405 responses name the allowed methods (Allow header, RFC 9110)', async () => {
    const r = await H.rawRequest(srv.port, '/', { method: 'POST' });
    assert.equal(r.status, 405);
    assert.match(String(r.headers.allow || ''), /GET/);
    const a = await H.rawRequest(srv.port, '/api/v1/games', { method: 'PUT' });
    assert.equal(a.status, 405);
    assert.match(String(a.headers.allow || ''), /GET/);
  });

  test('path traversal, encoded slashes, NUL bytes and malformed escapes never leak files or crash the server', async () => {
    const secrets = [fs.readFileSync(path.join(H.ROOT, 'package.json')), fs.readFileSync(path.join(H.ROOT, 'src', 'server.js')), fs.readFileSync(path.join(H.ROOT, 'src', 'db.js'))];
    const paths = ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/..%2f..%2fetc%2fpasswd', '/%2e%2e%2fsrc%2fserver.js', '/..%5cpackage.json',
      '/static/..%2f..%2fsrc%2fdb.js', '/app.js%00', '/app.js%00.png', '/%E0%A4%A', '/%', '/public/app.js', '/.git/config', '/..', '/%2e%2e', '//etc/passwd', '/src/server.js'];
    for (const p of paths) {
      const r = await H.rawRequest(srv.port, p);
      assert.ok([200, 400, 404].includes(r.status), `${p} -> ${r.status}`);
      for (const s of secrets) assert.ok(!r.body.includes(s.subarray(0, 200)), `${p} leaked a source file`);
      assert.ok(!r.body.toString().includes('root:x:0:0'), `${p} leaked /etc/passwd`);
      if (r.status === 200) assert.deepEqual(r.body, index, `${p}: a 200 may only be the app shell`);
    }
    const api = await H.rawRequest(srv.port, '/api/v1/games/%E0%A4%A');
    assert.equal(api.status, 400, 'malformed API path is a 400');
    assert.equal((await srv.api('/api/v1/health')).status, 200, 'server still healthy');
    assert.equal(srv.exit, null, 'server did not crash');
  });

  test('malformed and oversized request bodies are refused cleanly and the server keeps serving', async () => {
    const json = { 'Content-Type': 'application/json' };
    const bad = await H.rawRequest(srv.port, '/api/v1/games', { method: 'POST', headers: json, body: '{"title": ' });
    assert.equal(bad.status, 400, 'malformed JSON');
    assert.ok(JSON.parse(bad.body.toString()).error);
    const notObject = await H.rawRequest(srv.port, '/api/v1/games', { method: 'POST', headers: json, body: '42' });
    assert.equal(notObject.status, 400, 'a JSON number is not a game');
    const huge = await H.rawRequest(srv.port, '/api/v1/games', { method: 'POST', headers: json, body: JSON.stringify({ title: 'x'.repeat(5 * 1024 * 1024) }) });
    assert.equal(huge.status, 413, '5 MB on a normal endpoint');
    const login = await H.rawRequest(srv.port, '/api/v1/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ password: 'x'.repeat(100 * 1024) }) });
    assert.equal(login.status, 413, 'public endpoints take small bodies only');
    // imports are allowed to be big (README: up to 256 MB)
    const csv = `title,platform,playtime_hours,notes\nBig Notes,switch,1,"${'n'.repeat(5 * 1024 * 1024)}"\n`;
    const imp = await H.rawRequest(srv.port, '/api/v1/import?dry_run=true', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: csv });
    assert.equal(imp.status, 200, `5 MB import: ${imp.body.toString().slice(0, 200)}`);
    // an upload cut off half-way through
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: '/api/v1/import', agent: false, headers: { 'Content-Type': 'text/csv', 'Content-Length': String(20 * 1024 * 1024) } });
      req.on('error', () => resolve());
      req.write(`title,platform,playtime_hours\n${'Cut Off,switch,1\n'.repeat(50_000)}`);
      setTimeout(() => { req.destroy(); resolve(); }, 150);
    });
    await H.sleep(150);
    assert.equal((await H.rawRequest(srv.port, '/api/v1/health')).status, 200);
    assert.equal(srv.exit, null, 'still running');
    const after = JSON.parse((await H.rawRequest(srv.port, '/api/v1/games?q=Big%20Notes')).body.toString());
    assert.equal(after.total, 0, 'a dry run changes nothing');
    const cut = JSON.parse((await H.rawRequest(srv.port, '/api/v1/games?q=Cut%20Off')).body.toString());
    assert.equal(cut.total, 0, 'a cut-off upload imports nothing');
  });

  test('API responses are never cached and large JSON is gzip-compressed when accepted', async () => {
    const r = await H.rawRequest(srv.port, '/api/openapi.json', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], 'gzip');
    const doc = JSON.parse(zlib.gunzipSync(r.body).toString());
    assert.ok(doc.paths['/api/v1/games'], 'OpenAPI lists the library endpoint');
    const plain = await H.rawRequest(srv.port, '/api/openapi.json');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(plain.body.toString()), doc);
    for (const p of ['/api/v1/games', '/api/v1/stats', '/api/v1/summary', '/api/v1/health']) {
      const x = await H.rawRequest(srv.port, p);
      assert.match(String(x.headers['cache-control'] || ''), /no-store/, `${p} must not be cached (fresh numbers)`);
    }
  });
});

// =====================================================================================
describe('ports', () => {
  test('the server listens on PORT', async () => {
    const port = await H.freePort();
    const srv = await H.startServer({ env: { PORT: String(port), PLAYTRACKER_DATA: H.tmpDir(), TZ: 'UTC' } });
    try {
      assert.equal(srv.port, port);
      assert.equal((await srv.api('/api/v1/health')).json.ok, true);
    } finally { await srv.stop(); }
  });

  test('a taken port moves to the next free one and logs where it went; both instances keep their own data', async () => {
    const port = await H.freePort();
    const a = await H.startServer({ env: { PORT: String(port), PLAYTRACKER_DATA: H.tmpDir(), TZ: 'UTC' } });
    const blocker = await H.holdPort(port + 1).catch(() => null); // also hold the next one: it skips every taken port
    let b;
    try {
      b = await H.startServer({ env: { PORT: String(port), PLAYTRACKER_DATA: H.tmpDir(), TZ: 'UTC' } });
      assert.equal(a.port, port);
      assert.ok(b.port > port && b.port <= port + 20, `moved to ${b.port}`);
      if (blocker) assert.ok(b.port > port + 1, 'skips every taken port');
      assert.match(b.output, new RegExp(`\\b${port}\\b`), 'mentions the taken port');
      assert.match(b.output, new RegExp(`\\b${b.port}\\b`), 'logs the port it moved to');
      ok(await b.api('/api/v1/games', { method: 'POST', body: { title: 'Only On B' } }), 'add game on B');
      assert.equal(ok(await a.api('/api/v1/games'), 'A games').total, 0, 'A is untouched');
      assert.equal(ok(await b.api('/api/v1/games'), 'B games').total, 1);
    } finally {
      await b?.stop();
      await a.stop();
      blocker?.close();
    }
  });

  test('with PLAYTRACKER_PORT_FALLBACK=false a taken port fails fast with a clear error', async () => {
    const port = await H.freePort();
    const blocker = await H.holdPort(port);
    try {
      const r = await H.runToExit({ env: { PORT: String(port), PLAYTRACKER_DATA: H.tmpDir(), TZ: 'UTC', PLAYTRACKER_PORT_FALLBACK: 'false' } });
      assert.equal(r.timedOut, false, 'exits instead of hanging');
      assert.notEqual(r.code, 0, 'non-zero exit code');
      assert.match(r.output, new RegExp(`${port}`), 'names the port');
      assert.match(r.output, /in use|EADDRINUSE|listen/i, 'says why');
    } finally { blocker.close(); }
  });

  test('without PORT the documented default 7720 is used', async (t) => {
    const free = await new Promise((resolve) => { const s = http.createServer(); s.once('error', () => resolve(false)); s.listen(7720, '0.0.0.0', () => s.close(() => resolve(true))); });
    if (!free) return t.skip('7720 is in use on this machine');
    const srv = await H.startServer({ env: { PLAYTRACKER_DATA: H.tmpDir(), TZ: 'UTC' } });
    try { assert.equal(srv.port, 7720); } finally { await srv.stop(); }
  });
});

// =====================================================================================
describe('data directory and database migrations', () => {
  const tables = ['settings', 'accounts', 'games', 'entries', 'sessions', 'snapshots', 'syncs', 'api_tokens', 'login_sessions', 'dismissed_duplicates'];
  let latestVersion;

  test('a fresh install creates its (nested) data folder and an empty, working database', async () => {
    const dir = path.join(H.tmpDir(), 'appdata', 'nested', 'playtracker');
    assert.equal(fs.existsSync(dir), false);
    const srv = await H.startServer({ env: { PORT: String(await H.freePort()), PLAYTRACKER_DATA: dir, TZ: 'UTC' } });
    try {
      assert.ok(fs.existsSync(path.join(dir, 'vestigo.db')), 'a new install gets vestigo.db in PLAYTRACKER_DATA');
      assert.equal(fs.existsSync(path.join(dir, 'playtracker.db')), false, 'and no file under the old name');
      const games = ok(await srv.api('/api/v1/games'), 'games');
      assert.equal(games.total, 0);
      assert.deepEqual(games.items, []);
      assert.equal(ok(await srv.api('/api/v1/stats/lifetime'), 'lifetime').total_minutes, 0);
      const stats = ok(await srv.api('/api/v1/stats?range=all'), 'stats');
      assert.equal(stats.total_minutes, 0);
      assert.equal(stats.sessions, 0);
      assert.deepEqual(ok(await srv.api('/api/v1/accounts'), 'accounts'), []);
      ok(await srv.api('/api/v1/summary'), 'summary');
      ok(await srv.api('/api/v1/settings'), 'settings');
      const sys = ok(await srv.api('/api/v1/system'), 'system');
      assert.equal(path.resolve(sys.data_dir), path.resolve(dir, 'vestigo.db'));
      // it really writes there
      const g = ok(await srv.api('/api/v1/games', { method: 'POST', body: { title: 'First Game' } }), 'add');
      ok(await srv.api('/api/v1/sessions', { method: 'POST', body: { game_id: g.id, minutes: 30, started_at: '2025-03-01T10:00:00Z' } }), 'session');
    } finally { await srv.stop(); }
    H.inspect(path.join(dir, 'vestigo.db'), (db) => {
      latestVersion = db.prepare('PRAGMA user_version').get().user_version;
      assert.ok(latestVersion >= 1, 'schema version recorded');
      const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      for (const t of tables) assert.ok(have.has(t), `table ${t}`);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM games').get().n, 1);
      H.assertHealthy(assert, db, 'fresh');
    });
  });

  test('PLAYTRACKER_DB puts the database exactly there (overrides PLAYTRACKER_DATA)', async () => {
    const root = H.tmpDir();
    const dataDir = path.join(root, 'data');
    const dbFile = path.join(root, 'elsewhere', 'deep', 'my-tracker.db');
    const srv = await H.startServer({ env: { PORT: String(await H.freePort()), PLAYTRACKER_DATA: dataDir, PLAYTRACKER_DB: dbFile, TZ: 'UTC' } });
    try {
      ok(await srv.api('/api/v1/games', { method: 'POST', body: { title: 'Stored Elsewhere' } }), 'add');
      const sys = ok(await srv.api('/api/v1/system'), 'system');
      assert.equal(path.resolve(sys.data_dir), path.resolve(dbFile));
      assert.ok(sys.db_bytes > 0, 'reports the database size');
    } finally { await srv.stop(); }
    assert.ok(fs.existsSync(dbFile));
    for (const f of ['vestigo.db', 'playtracker.db']) assert.equal(fs.existsSync(path.join(dataDir, f)), false, `no second database (${f}) in PLAYTRACKER_DATA`);
    H.inspect(dbFile, (db) => assert.equal(db.prepare('SELECT title FROM games').get().title, 'Stored Elsewhere'));
  });

  test('an empty (0-byte) database file is initialised, not rejected', async () => {
    const dbFile = path.join(H.tmpDir(), 'empty.db');
    fs.writeFileSync(dbFile, '');
    const srv = await H.startServer({ env: { PORT: String(await H.freePort()), PLAYTRACKER_DATA: path.dirname(dbFile), PLAYTRACKER_DB: dbFile, TZ: 'UTC' } });
    try {
      assert.equal(ok(await srv.api('/api/v1/games'), 'games').total, 0);
      ok(await srv.api('/api/v1/games', { method: 'POST', body: { title: 'Into The Void' } }), 'add');
    } finally { await srv.stop(); }
    H.inspect(dbFile, (db) => {
      assert.ok(db.prepare('PRAGMA user_version').get().user_version >= 1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM games').get().n, 1);
    });
  });

  test('opening the same database again and again is idempotent (schema, version and data unchanged)', async () => {
    const dbFile = path.join(H.tmpDir(), 'sub', 'reopen.db');
    const d1 = openDb(dbFile); // service level: creates parent folders + schema
    const v1 = d1.prepare('PRAGMA user_version').get().user_version;
    const s1 = H.schemaOf(d1);
    d1.close();
    assert.ok(v1 >= 1);
    if (latestVersion) assert.equal(v1, latestVersion, 'same version as a server-created database');

    // write real data through the app
    let app = await H.startApp(createApp, { dbFile });
    const g = ok(await app.api('/api/v1/games', { method: 'POST', body: { title: 'Reopen Me', status: 'playing' } }), 'add');
    ok(await app.api('/api/v1/sessions', { method: 'POST', body: { game_id: g.id, minutes: 75, started_at: '2025-06-01T18:00:00Z' } }), 'session');
    ok(await app.api('/api/v1/settings', { method: 'PUT', body: { theme: 'black' } }), 'settings');
    const before = { game: ok(await app.api(`/api/v1/games/${g.id}`), 'game'), settings: ok(await app.api('/api/v1/settings'), 'settings'), life: ok(await app.api('/api/v1/stats/lifetime'), 'life') };
    app.close();
    const counts = (db) => Object.fromEntries(tables.concat(['play_days']).filter((t) => db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(t)).map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
    const c0 = H.inspect(dbFile, counts);

    for (let i = 0; i < 3; i++) {
      const d = openDb(dbFile);
      assert.equal(d.prepare('PRAGMA user_version').get().user_version, v1, `reopen ${i}: version`);
      assert.deepEqual(H.schemaOf(d), s1, `reopen ${i}: schema`);
      d.close();
      app = await H.startApp(createApp, { dbFile });
      const g2 = ok(await app.api(`/api/v1/games/${g.id}`), 'game');
      assert.equal(g2.minutes, before.game.minutes);
      assert.equal(g2.status, 'playing');
      assert.deepEqual(g2.summary, before.game.summary);
      assert.deepEqual(ok(await app.api('/api/v1/stats/lifetime'), 'life'), before.life);
      const st = ok(await app.api('/api/v1/settings'), 'settings');
      delete st.next_global_run; delete before.settings.next_global_run;
      assert.deepEqual(st, before.settings);
      app.close();
      assert.deepEqual(H.inspect(dbFile, counts), c0, `reopen ${i}: no rows added or lost`);
    }
    H.inspect(dbFile, (db) => H.assertHealthy(assert, db, 'reopened'));
  });

  describe('upgrade of a first-release (schema v1) database', () => {
    let dir; let dbFile; let srv;
    const PASS = 'legacy-pass-123';
    const auth = { Authorization: `Bearer ${LEGACY_TOKEN}` };
    before(async () => {
      dir = H.tmpDir();
      dbFile = path.join(dir, 'playtracker.db');
      buildLegacyV1(dbFile);
      srv = await H.startServer({ env: { PORT: String(await H.freePort()), PLAYTRACKER_DATA: dir, TZ: 'UTC', PLAYTRACKER_PASSWORD: PASS } });
    });
    after(async () => { await srv?.stop(); });

    test('the upgrade keeps every game, total, status, rating and note', async () => {
      const list = ok(await srv.api('/api/v1/games?limit=100&sort=title', { headers: auth }), 'games (old API token still valid)');
      assert.equal(list.total, 3);
      assert.equal(list.total_minutes, LEGACY.total_minutes);
      for (const [title, want] of Object.entries(LEGACY.games)) {
        const g = list.items.find((x) => x.title === title);
        assert.ok(g, title);
        assert.equal(g.minutes, want.minutes, `${title} lifetime minutes`);
        assert.equal(g.status, want.status, `${title} status`);
        assert.equal(g.rating, want.rating, `${title} rating`);
        assert.equal(g.notes, want.notes, `${title} notes`);
        const d = ok(await srv.api(`/api/v1/games/${g.id}`, { headers: auth }), title);
        assert.equal(d.summary.tracked_minutes, want.tracked, `${title} tracked minutes`);
        assert.equal(d.summary.total_minutes, want.minutes);
      }
    });

    test('lifetime and tracked totals are exactly what the old version recorded', async () => {
      const life = ok(await srv.api('/api/v1/stats/lifetime', { headers: auth }), 'lifetime');
      assert.equal(life.total_minutes, LEGACY.total_minutes);
      assert.equal(life.tracked_minutes, LEGACY.tracked_minutes);
      assert.equal(life.sessions, LEGACY.play_sessions);
      const all = ok(await srv.api('/api/v1/stats?range=all&estimates=exclude', { headers: auth }), 'stats');
      assert.equal(all.total_minutes, LEGACY.tracked_minutes, 'charts show exactly the tracked play');
      // pre-tracking time is history, never tracked play; estimates + undated add up to it
      assert.equal(life.estimated_minutes + life.baseline_minutes, LEGACY.total_minutes - LEGACY.tracked_minutes);
    });

    test('settings, the custom account, sync history, tokens and dismissed suggestions survive', async () => {
      const st = ok(await srv.api('/api/v1/settings', { headers: auth }), 'settings');
      assert.equal(st.theme, LEGACY.theme);
      assert.equal(st.schedule_mode, LEGACY.schedule_mode);
      const accounts = ok(await srv.api('/api/v1/accounts', { headers: auth }), 'accounts');
      assert.equal(accounts.length, 1);
      assert.equal(accounts[0].name, LEGACY.account.name);
      assert.equal(accounts[0].platform, LEGACY.account.platform);
      assert.equal(accounts[0].minutes, LEGACY.games.Hades.minutes);
      assert.equal(ok(await srv.api('/api/v1/syncs', { headers: auth }), 'syncs').length, 4);
      const tokens = ok(await srv.api('/api/v1/tokens', { headers: auth }), 'tokens');
      assert.deepEqual(tokens.map((t) => t.name), ['Home Assistant']);
      assert.equal((await srv.api('/api/v1/games')).status, 401, 'still protected');
      assert.equal((await srv.api('/api/v1/games', { headers: { Authorization: 'Bearer pt_wrong' } })).status, 401);
      H.inspect(dbFile, (db) => assert.equal(db.prepare('SELECT COUNT(*) n FROM dismissed_duplicates WHERE key = ?').get(LEGACY.dismissed).n, 1));
    });

    test('the first release\'s playtracker.db is upgraded where it is: no vestigo.db appears', async () => {
      assert.equal(path.resolve(ok(await srv.api('/api/v1/system', { headers: auth }), 'system').data_dir), path.resolve(dbFile));
      assert.equal(fs.existsSync(path.join(dir, 'vestigo.db')), false);
    });

    test('the upgraded database is structurally sound and every entry adds up', () => {
      H.inspect(dbFile, (db) => {
        H.assertHealthy(assert, db, 'upgraded');
        if (latestVersion) assert.equal(db.prepare('PRAGMA user_version').get().user_version, latestVersion, 'migrated to the latest schema version');
      });
    });

    test('tracking continues where the old version left off, and a restart changes nothing', async () => {
      const before = ok(await srv.api('/api/v1/stats/lifetime', { headers: auth }), 'life');
      const accId = ok(await srv.api('/api/v1/accounts', { headers: auth }), 'accounts')[0].id;
      const rep = ok(await srv.api(`/api/v1/accounts/${accId}/report`, { method: 'POST', headers: auth, body: { games: [{ id: 'hades', title: 'Hades', playtime_minutes: 660, last_played_at: new Date(NOW - HOUR).toISOString() }] } }), 'report');
      assert.equal(rep.initial, false, 'not treated as a first import');
      const after1 = ok(await srv.api('/api/v1/stats/lifetime', { headers: auth }), 'life');
      assert.equal(after1.total_minutes, before.total_minutes + 30);
      assert.equal(after1.tracked_minutes, before.tracked_minutes + 30, 'the 30 new minutes are tracked play');
      assert.equal(after1.sessions, before.sessions + 1);
      const snapshot = H.inspect(dbFile, (db) => db.prepare('SELECT id, entry_id, kind, minutes, source FROM sessions ORDER BY id').all().map((r) => ({ ...r })));
      await srv.stop();
      srv = await H.startServer({ env: { PORT: String(await H.freePort()), PLAYTRACKER_DATA: dir, TZ: 'UTC', PLAYTRACKER_PASSWORD: PASS } });
      assert.deepEqual(ok(await srv.api('/api/v1/stats/lifetime', { headers: auth }), 'life'), after1);
      H.inspect(dbFile, (db) => {
        assert.deepEqual(db.prepare('SELECT id, entry_id, kind, minutes, source FROM sessions ORDER BY id').all().map((r) => ({ ...r })), snapshot, 'no session rewritten on restart');
        H.assertHealthy(assert, db, 'after restart');
      });
    });
  });

  test('a corrupt database file stops the server with a clear error and is left untouched', async () => {
    const dir = H.tmpDir();
    const dbFile = path.join(dir, 'playtracker.db');
    const junk = Buffer.from('this is definitely not an sqlite database '.repeat(400));
    fs.writeFileSync(dbFile, junk);
    const r = await H.runToExit({ env: { PORT: String(await H.freePort()), PLAYTRACKER_DATA: dir, TZ: 'UTC' } });
    assert.equal(r.timedOut, false, 'exits instead of hanging');
    assert.notEqual(r.code, 0);
    assert.match(r.output, /database/i, 'the log says the database is the problem');
    assert.deepEqual(fs.readFileSync(dbFile), junk, 'the file is not modified or replaced');
  });

  test("another application's SQLite file is refused without damaging its data", async () => {
    const dir = H.tmpDir();
    const dbFile = path.join(dir, 'playtracker.db');
    const other = new DatabaseSync(dbFile);
    other.exec("CREATE TABLE games (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO games(name) VALUES ('chess'), ('go');");
    other.close();
    const r = await H.runToExit({ env: { PORT: String(await H.freePort()), PLAYTRACKER_DATA: dir, TZ: 'UTC' } });
    assert.equal(r.timedOut, false);
    assert.notEqual(r.code, 0, 'does not run on a database it cannot migrate');
    H.inspect(dbFile, (db) => {
      assert.deepEqual(db.prepare('SELECT name FROM games ORDER BY id').all().map((x) => x.name), ['chess', 'go'], 'foreign rows intact');
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((x) => x.name);
      assert.deepEqual(names, ['games'], 'a failed migration leaves nothing half-created');
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    });
  });
});

// =====================================================================================
describe('upgrading a PlayTracker install in place', () => {
  const PASS = 'old-install-pass-1';
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  const exists = (dir, f) => fs.existsSync(path.join(dir, f));

  /** A data folder as PlayTracker left it: playtracker.db with `titles` and a pt_ token. */
  async function playtrackerFolder(titles = ['Old Faithful']) {
    const dir = H.tmpDir();
    const file = path.join(dir, 'playtracker.db');
    const app = await H.startApp(createApp, { dbFile: file });
    try {
      for (const title of titles) ok(await app.api('/api/v1/games', { method: 'POST', body: { title } }), 'add');
    } finally { app.close(); }
    // minted the way PlayTracker did: pt_ + random, stored as its SHA-256 and a short prefix
    const token = `pt_${crypto.randomBytes(24).toString('base64url')}`;
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO api_tokens(name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?)').run('Grafana', sha(token), token.slice(0, 7), Date.now());
    db.close();
    return { dir, file, token };
  }
  /** A data folder holding a vestigo.db with `titles`. */
  async function vestigoFile(dir, titles) {
    const app = await H.startApp(createApp, { dbFile: path.join(dir, 'vestigo.db') });
    try {
      for (const title of titles) ok(await app.api('/api/v1/games', { method: 'POST', body: { title } }), 'add');
    } finally { app.close(); }
  }

  test('upgrade in place: playtracker.db, PLAYTRACKER_DATA, PLAYTRACKER_PASSWORD and the pt_ token keep working', async () => {
    const { dir, file, token } = await playtrackerFolder();
    const before = fs.readdirSync(dir).sort();
    // exactly what an existing container passes: the old variable names, nothing else
    const srv = await H.startServer({ env: { PORT: String(await H.freePort()), PLAYTRACKER_DATA: dir, PLAYTRACKER_PASSWORD: PASS, TZ: 'UTC' } });
    try {
      assert.match(srv.output, /Vestigo \S+( \(\w+\))? ready on port/, 'the startup line names Vestigo');
      assert.ok(srv.output.includes(`db=${file}`), `the startup log names the file in use:\n${srv.output}`);
      assert.equal(exists(dir, 'vestigo.db'), false, 'no vestigo.db is created next to it');
      assert.equal((await srv.api('/api/v1/games')).status, 401, 'still protected by the old variable');
      const st = ok(await srv.api('/api/v1/auth/status'), 'status');
      assert.equal(st.auth_enabled, true);
      assert.equal(st.password_source, 'env');
      const login = await srv.api('/api/v1/auth/login', { method: 'POST', body: { password: PASS } });
      assert.equal(login.status, 200, login.text);
      const cookie = { cookie: login.headers.get('set-cookie').split(';')[0] };
      assert.match(cookie.cookie, /^pt_session=/, 'the login cookie keeps its name');
      assert.equal(ok(await srv.api('/api/v1/auth/status', { headers: cookie }), 'status').password_env, 'PLAYTRACKER_PASSWORD');
      const games = ok(await srv.api('/api/v1/games', { headers: cookie }), 'games');
      assert.deepEqual(games.items.map((g) => g.title), ['Old Faithful'], 'the library is there');
      const bearer = { Authorization: `Bearer ${token}` };
      assert.equal(ok(await srv.api('/api/v1/games', { headers: bearer }), 'old pt_ token').total, 1);
      assert.equal((await srv.api('/api/v1/games', { headers: { 'X-API-Key': token } })).status, 200);
      const metrics = await srv.api('/metrics', { headers: bearer });
      assert.equal(metrics.status, 200);
      assert.match(metrics.text, /^playtracker_games_total 1$/m, 'old metric names still published');
      assert.match(metrics.text, /^vestigo_games_total 1$/m);
      assert.equal(path.resolve(ok(await srv.api('/api/v1/system', { headers: bearer }), 'system').data_dir), path.resolve(file), 'the System page shows the file in use');
      ok(await srv.api('/api/v1/games', { method: 'POST', headers: bearer, body: { title: 'Added After The Update' } }), 'write');
    } finally { await srv.stop(); }
    assert.equal(exists(dir, 'vestigo.db'), false);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => !/-(wal|shm)$/.test(f)).sort(), before.filter((f) => !/-(wal|shm)$/.test(f)), 'nothing renamed, moved or added');
    H.inspect(file, (db) => {
      assert.deepEqual(db.prepare('SELECT title FROM games ORDER BY id').all().map((g) => g.title), ['Old Faithful', 'Added After The Update'], 'writes go to the old file');
      H.assertHealthy(assert, db, 'upgraded in place');
    });
  });

  test('an empty data folder gets vestigo.db', async () => {
    const dir = H.tmpDir();
    const srv = await H.startServer({ env: { PORT: String(await H.freePort()), VESTIGO_DATA: dir, TZ: 'UTC' } });
    try {
      ok(await srv.api('/api/v1/games', { method: 'POST', body: { title: 'Brand New' } }), 'add');
      assert.equal(path.resolve(ok(await srv.api('/api/v1/system'), 'system').data_dir), path.resolve(dir, 'vestigo.db'));
    } finally { await srv.stop(); }
    assert.equal(exists(dir, 'playtracker.db'), false);
    H.inspect(path.join(dir, 'vestigo.db'), (db) => assert.equal(db.prepare('SELECT title FROM games').get().title, 'Brand New'));
  });

  test('both files in the folder: the one holding the games is used, the log says which and why, nothing is touched', async () => {
    const { dir, file } = await playtrackerFolder(['Copied Over', 'From The Old Server']);
    await vestigoFile(dir, []); // e.g. a fresh Vestigo install that the old database was copied into
    const bytes = () => Object.fromEntries(['vestigo.db', 'playtracker.db'].map((f) => [f, fs.readFileSync(path.join(dir, f))]));
    const was = bytes();
    const srv = await H.startServer({ env: { PORT: String(await H.freePort()), VESTIGO_DATA: dir, TZ: 'UTC' } });
    try {
      assert.match(srv.output, /using playtracker\.db \(2 games\), not vestigo\.db \(0 games\)/, srv.output);
      assert.ok(srv.output.includes(`db=${file}`), srv.output);
      assert.equal(path.resolve(ok(await srv.api('/api/v1/system'), 'system').data_dir), path.resolve(file));
      assert.equal(ok(await srv.api('/api/v1/games'), 'games').total, 2);
    } finally { await srv.stop(); }
    assert.deepEqual(bytes()['vestigo.db'], was['vestigo.db'], 'the file not chosen is left exactly as it was');
    assert.equal(exists(dir, 'vestigo.db-wal') || exists(dir, 'vestigo.db-shm'), false, 'and gains no side files from the look inside');
  });

  test('resolveDbFile: more games wins, a tie goes to vestigo.db, an unreadable file loses; files are only read', async () => {
    const log = { lines: [], warn(m) { this.lines.push(m); } };
    const pick = (dir) => path.basename(resolveDbFile({ dir, log }));
    const env = { VESTIGO_DB: process.env.VESTIGO_DB, PLAYTRACKER_DB: process.env.PLAYTRACKER_DB };
    delete process.env.VESTIGO_DB; delete process.env.PLAYTRACKER_DB;
    try {
      const empty = H.tmpDir();
      assert.equal(pick(empty), 'vestigo.db', 'empty folder: a new vestigo.db');
      assert.deepEqual(fs.readdirSync(empty), [], 'choosing creates nothing');

      const legacyOnly = (await playtrackerFolder()).dir;
      assert.equal(pick(legacyOnly), 'playtracker.db', 'only the old file: used in place');

      const newer = (await playtrackerFolder(['One'])).dir;
      await vestigoFile(newer, ['One', 'Two']);
      assert.equal(pick(newer), 'vestigo.db', 'vestigo.db has more games');

      const tie = (await playtrackerFolder(['Same'])).dir;
      await vestigoFile(tie, ['Same']);
      log.lines.length = 0;
      assert.equal(pick(tie), 'vestigo.db', 'a tie goes to vestigo.db');
      assert.match(log.lines.join('\n'), /Both vestigo\.db and playtracker\.db .*using vestigo\.db \(1 game\), not playtracker\.db \(1 game\)/);

      const broken = (await playtrackerFolder(['Precious'])).dir;
      fs.writeFileSync(path.join(broken, 'vestigo.db'), 'not a database '.repeat(300));
      const junk = fs.readFileSync(path.join(broken, 'vestigo.db'));
      assert.equal(pick(broken), 'playtracker.db', 'an unreadable vestigo.db never hides the real data');
      assert.deepEqual(fs.readFileSync(path.join(broken, 'vestigo.db')), junk);
      assert.match(log.lines.at(-1), /vestigo\.db \(unreadable\)/);

      const zero = (await playtrackerFolder(['Kept'])).dir;
      fs.writeFileSync(path.join(zero, 'vestigo.db'), '');
      assert.equal(pick(zero), 'playtracker.db', 'an empty vestigo.db has no games');
      assert.match(log.lines.at(-1), /using playtracker\.db \(1 game\), not vestigo\.db \(0 games\)/);
      assert.equal(fs.statSync(path.join(zero, 'vestigo.db')).size, 0);
      assert.deepEqual(fs.readdirSync(zero).sort(), ['playtracker.db', 'vestigo.db'], 'the look inside leaves no side files behind');

      process.env.PLAYTRACKER_DB = path.join(empty, 'old-override.db');
      assert.equal(pick(newer), 'old-override.db', 'PLAYTRACKER_DB still overrides');
      process.env.VESTIGO_DB = path.join(empty, 'new-override.db');
      assert.equal(pick(newer), 'new-override.db', 'VESTIGO_DB wins over PLAYTRACKER_DB');
      process.env.VESTIGO_DB = '';
      assert.equal(pick(newer), 'old-override.db', 'an empty VESTIGO_DB counts as unset');
    } finally {
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test('VESTIGO_DATA wins over PLAYTRACKER_DATA; an empty VESTIGO_DATA (Unraid) falls back to it', async () => {
    const { dir: old, file } = await playtrackerFolder();
    const other = H.tmpDir();
    let srv = await H.startServer({ env: { PORT: String(await H.freePort()), VESTIGO_DATA: other, PLAYTRACKER_DATA: old, TZ: 'UTC' } });
    try {
      assert.equal(path.resolve(ok(await srv.api('/api/v1/system'), 'system').data_dir), path.resolve(other, 'vestigo.db'));
    } finally { await srv.stop(); }
    srv = await H.startServer({ env: { PORT: String(await H.freePort()), VESTIGO_DATA: '', VESTIGO_PASSWORD: '', PLAYTRACKER_DATA: old, PLAYTRACKER_PASSWORD: PASS, TZ: 'UTC' } });
    try {
      assert.equal((await srv.api('/api/v1/games')).status, 401, 'PLAYTRACKER_PASSWORD applies: the empty VESTIGO_PASSWORD is ignored');
      const login = await srv.api('/api/v1/auth/login', { method: 'POST', body: { password: PASS } });
      assert.equal(login.status, 200);
      const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
      assert.equal(path.resolve(ok(await srv.api('/api/v1/system', { headers }), 'system').data_dir), path.resolve(file));
    } finally { await srv.stop(); }
  });
});

describe('packaging: existing containers keep updating with no change', () => {
  const read = (f) => fs.readFileSync(path.join(H.ROOT, f), 'utf8');
  const tag = (xml, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
  const config = (xml) => [...xml.matchAll(/<Config Name="([^"]+)" Target="([^"]+)"/g)].map((m) => [m[1], m[2]]);

  test('the legacy Unraid template keeps its name, image, URL and PLAYTRACKER_ variables; the new one mirrors it', () => {
    const old = read('unraid/playtracker.xml');
    assert.equal(tag(old, 'Name'), 'PlayTracker', 're-applying the template must not rename or duplicate the container');
    assert.equal(tag(old, 'Repository'), 'ghcr.io/cmgfender/playtracker:latest');
    assert.equal(tag(old, 'TemplateURL'), 'https://raw.githubusercontent.com/cmgfender/playtracker/main/unraid/playtracker.xml');
    assert.match(tag(old, 'Overview'), /^Vestigo \(formerly PlayTracker\)/);
    const neu = read('unraid/vestigo.xml');
    assert.equal(tag(neu, 'Name'), 'Vestigo');
    assert.equal(tag(neu, 'Repository'), 'ghcr.io/cmgfender/vestigo:latest');
    assert.equal(tag(neu, 'TemplateURL'), 'https://raw.githubusercontent.com/cmgfender/playtracker/main/unraid/vestigo.xml');
    assert.deepEqual(config(old).map(([n, t]) => [n, t.replace(/^PLAYTRACKER_/, 'VESTIGO_')]), config(neu), 'same fields, new variable names');
    assert.deepEqual(config(old).filter(([, t]) => /_/.test(t) && !/^LOG_LEVEL$/.test(t)).map(([, t]) => t).sort(),
      ['PLAYTRACKER_CORS_ORIGIN', 'PLAYTRACKER_LOG_FILE', 'PLAYTRACKER_PASSWORD', 'PLAYTRACKER_SECURE_COOKIE']);
  });

  test('the image keeps its defaults and CI publishes every build under both names, the old one first', () => {
    const docker = read('Dockerfile');
    assert.match(docker, /^\s+PLAYTRACKER_DATA=\/data \\$/m, 'the baked data default keeps the old name (a baked VESTIGO_DATA would beat a user\'s PLAYTRACKER_DATA)');
    assert.doesNotMatch(docker, /VESTIGO_DATA=/);
    for (const re of [/PORT=7720/, /^VOLUME \["\/data"\]$/m, /^EXPOSE 7720$/m, /^STOPSIGNAL SIGTERM$/m, /^HEALTHCHECK /m, /PUID=99/, /PGID=100/]) assert.match(docker, re);
    const ci = read('.github/workflows/docker.yml');
    // the image existing installs pull is built and pushed on its own; the new name is a copy
    // that can never fail that build
    assert.match(ci, /^\s+images: ghcr\.io\/cmgfender\/playtracker$/m);
    assert.match(ci, /build-args: REVISION=\$\{\{ github\.sha \}\}/);
    const copy = ci.slice(ci.indexOf('- name: Copy to ghcr.io/cmgfender/vestigo'));
    assert.match(copy, /continue-on-error: true/);
    assert.match(copy, /imagetools create --tag "ghcr\.io\/cmgfender\/vestigo:/);
  });
});

// =====================================================================================
describe('restarts and durability (password-protected real server)', () => {
  const PASS = 'restart-pass-123';
  let dir; let env; let srv; let auth; let cookie; let snap; let etag;
  const dbFile = () => path.join(dir, 'vestigo.db');

  async function stateOf(s) {
    const get = async (p) => ok(await s.api(p, { headers: auth }), p);
    const games = (await get('/api/v1/games?limit=5000&sort=title')).items;
    const details = [];
    for (const g of games) {
      const d = await get(`/api/v1/games/${g.id}`);
      details.push({ id: d.id, title: d.title, minutes: d.minutes, status: d.status, rating: d.rating, notes: d.notes, summary: d.summary, entries: d.entries.map((e) => ({ id: e.id, playtime_min: e.playtime_min, platform: e.platform, history: e.history?.minutes ?? null })) });
    }
    const settings = await get('/api/v1/settings');
    delete settings.next_global_run;
    const stats = await get('/api/v1/stats?range=all&estimates=include');
    delete stats.range.to; // "all time" ends now
    return {
      games, details, settings,
      sessions: (await get('/api/v1/sessions?kind=all&limit=1000')).items,
      lifetime: await get('/api/v1/stats/lifetime'),
      stats,
      accounts: (await get('/api/v1/accounts')).map((a) => ({ id: a.id, name: a.name, platform: a.platform, enabled: a.enabled, last_sync_at: a.last_sync_at, last_status: a.last_status, games: a.games, minutes: a.minutes, schedule: a.schedule })),
      tokens: (await get('/api/v1/tokens')).map((t) => ({ id: t.id, name: t.name, prefix: t.prefix })),
      syncs: (await get('/api/v1/syncs')).map((x) => ({ id: x.id, status: x.status, sessions_created: x.sessions_created, minutes_added: x.minutes_added })),
    };
  }

  before(async () => {
    dir = H.tmpDir();
    env = { PORT: String(await H.freePort()), PLAYTRACKER_DATA: dir, TZ: 'UTC', PLAYTRACKER_PASSWORD: PASS };
    srv = await H.startServer({ env });
  });
  after(async () => { await srv?.stop(); });

  test('with a password the app shell still loads (login screen) but data needs credentials', async () => {
    const shell = await H.rawRequest(srv.port, '/library');
    assert.equal(shell.status, 200);
    assert.deepEqual(shell.body, readPublic('index.html'));
    assert.equal((await H.rawRequest(srv.port, '/app.js')).status, 200);
    assert.equal((await srv.api('/api/v1/games')).status, 401);
    assert.equal((await srv.api('/api/v1/stats')).status, 401);
    assert.equal((await H.rawRequest(srv.port, '/metrics')).status, 401);
    assert.equal(ok(await srv.api('/api/v1/health'), 'health').ok, true, 'health check stays public (container HEALTHCHECK)');
    assert.equal(ok(await srv.api('/api/v1/auth/status'), 'status').auth_enabled, true);
  });

  test('everything written before a graceful stop (SIGTERM) is there after the restart', async () => {
    const login = await srv.api('/api/v1/auth/login', { method: 'POST', body: { password: PASS } });
    assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie().find((c) => c.startsWith('pt_session=')).split(';')[0];
    const tok = ok(await srv.api('/api/v1/tokens', { method: 'POST', headers: { Cookie: cookie }, body: { name: 'restart-test' } }), 'token');
    auth = { Authorization: `Bearer ${tok.token}` };

    const acc = ok(await srv.api('/api/v1/accounts', { method: 'POST', headers: auth, body: { platform: 'custom', name: 'Switch' } }), 'account');
    ok(await srv.api(`/api/v1/accounts/${acc.id}/report`, { method: 'POST', headers: auth, body: { games: [
      { id: 'totk', title: 'Zelda: TotK', playtime_minutes: 600, last_played_at: new Date(NOW - 3 * DAY).toISOString() },
      { id: 'mk8', title: 'Mario Kart 8', playtime_minutes: 240, first_played_at: '2024-01-10', last_played_at: '2025-02-01' },
    ] } }), 'first report');
    const g = ok(await srv.api('/api/v1/games', { method: 'POST', headers: auth, body: { title: 'Celeste', status: 'beaten' } }), 'add');
    for (const [d, m] of [['2025-04-01T19:00:00Z', 45], ['2025-04-03T20:00:00Z', 70], [new Date(NOW - 2 * DAY).toISOString(), 25]]) {
      ok(await srv.api('/api/v1/sessions', { method: 'POST', headers: auth, body: { game_id: g.id, minutes: m, started_at: d, note: `n${m}` } }), 'session');
    }
    ok(await srv.api(`/api/v1/games/${g.id}`, { method: 'PATCH', headers: auth, body: { rating: 8, notes: 'Strawberries', favorite: true } }), 'patch');
    ok(await srv.api('/api/v1/settings', { method: 'PUT', headers: auth, body: { theme: 'light', accent: '#ff8800', schedule_mode: 'weekly', week_starts_on: 0 } }), 'settings');
    snap = await stateOf(srv);
    etag = (await H.rawRequest(srv.port, '/app.js')).headers.etag;
    assert.equal(snap.games.length, 3);

    const stop = await srv.stop('SIGTERM');
    assert.equal(stop.signal, null, `exited by itself, not killed (${stop.signal})`);
    assert.equal(stop.code, 0, 'clean exit code');
    assert.ok(stop.ms < 5000, `stopped in ${stop.ms}ms`);
    assert.match(srv.output, /SIGTERM/, 'logs the shutdown');

    srv = await H.startServer({ env });
    assert.deepEqual(await stateOf(srv), snap, 'identical state after restart');
    assert.equal((await srv.api('/api/v1/games', { headers: { Cookie: cookie } })).status, 200, 'login cookie still valid');
    assert.equal((await srv.api('/api/v1/games')).status, 401, 'still locked without credentials');
    assert.equal((await H.rawRequest(srv.port, '/app.js')).headers.etag, etag, 'unchanged files keep their ETag (browser caches stay valid)');
  });

  test('after a clean stop the database file alone holds everything (WAL checkpointed)', async () => {
    const stop = await srv.stop('SIGTERM');
    assert.equal(stop.code, 0);
    const wal = `${dbFile()}-wal`;
    assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'no un-checkpointed WAL left behind');
    const copy = path.join(H.tmpDir(), 'copy.db');
    fs.copyFileSync(dbFile(), copy); // e.g. a backup tool that copies only vestigo.db
    H.inspect(copy, (db) => {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM games').get().n, snap.games.length);
      assert.equal(db.prepare('SELECT COALESCE(SUM(playtime_min), 0) m FROM entries WHERE excluded = 0').get().m, snap.lifetime.total_minutes);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, snap.sessions.length);
      H.assertHealthy(assert, db, 'copy');
    });
    srv = await H.startServer({ env });
  });

  test('tracking continues across a restart without counting anything twice', async () => {
    const acc = snap.accounts[0];
    const before = ok(await srv.api('/api/v1/stats/lifetime', { headers: auth }), 'life');
    const rep = ok(await srv.api(`/api/v1/accounts/${acc.id}/report`, { method: 'POST', headers: auth, body: { games: [
      // only seconds of wall-clock time passed since the last report, so the delta stays
      // within the documented 15-minute tolerance (bigger ones are clamped to history)
      { id: 'totk', title: 'Zelda: TotK', playtime_minutes: 610, last_played_at: new Date().toISOString() },
      { id: 'mk8', title: 'Mario Kart 8', playtime_minutes: 240, last_played_at: '2025-02-01' },
    ] } }), 'report');
    assert.equal(rep.initial, false, 'the restart did not make the account look new');
    assert.equal(rep.sessions_created, 1);
    assert.equal(rep.minutes_added, 10);
    const life = ok(await srv.api('/api/v1/stats/lifetime', { headers: auth }), 'life');
    assert.equal(life.total_minutes, before.total_minutes + 10);
    assert.equal(life.tracked_minutes, before.tracked_minutes + 10);
    assert.equal(life.estimated_minutes + life.baseline_minutes, before.estimated_minutes + before.baseline_minutes, 'history unchanged');
    const zelda = ok(await srv.api('/api/v1/games?q=Zelda', { headers: auth }), 'q').items[0];
    assert.equal(zelda.minutes, 610);
  });

  test('SIGINT (Ctrl-C) also shuts down cleanly and keeps the data', async () => {
    const before = ok(await srv.api('/api/v1/stats/lifetime', { headers: auth }), 'life');
    const stop = await srv.stop('SIGINT');
    assert.equal(stop.code, 0);
    assert.equal(stop.signal, null);
    srv = await H.startServer({ env });
    assert.deepEqual(ok(await srv.api('/api/v1/stats/lifetime', { headers: auth }), 'life'), before);
  });

  test('a hard kill (SIGKILL, power-cut style) loses nothing that was acknowledged', async () => {
    const g = ok(await srv.api('/api/v1/games', { method: 'POST', headers: auth, body: { title: 'Crash Bandicoot' } }), 'add');
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(ok(await srv.api('/api/v1/sessions', { method: 'POST', headers: auth, body: { game_id: g.id, minutes: 10 + i, started_at: `2025-08-0${i + 1}T12:00:00Z` } }), 'session').id);
    }
    ok(await srv.api('/api/v1/settings', { method: 'PUT', headers: auth, body: { theme: 'black' } }), 'settings');
    const before = ok(await srv.api('/api/v1/stats/lifetime', { headers: auth }), 'life');
    const stop = await srv.stop('SIGKILL');
    assert.equal(stop.signal, 'SIGKILL');
    srv = await H.startServer({ env });
    const game = ok(await srv.api(`/api/v1/games/${g.id}`, { headers: auth }), 'game');
    assert.equal(game.minutes, 10 + 11 + 12 + 13 + 14);
    assert.deepEqual(game.sessions.map((s) => s.id).sort((a, b) => a - b), ids);
    assert.equal(ok(await srv.api('/api/v1/settings', { headers: auth }), 'settings').theme, 'black');
    assert.deepEqual(ok(await srv.api('/api/v1/stats/lifetime', { headers: auth }), 'life'), before);
    H.inspect(dbFile(), (db) => H.assertHealthy(assert, db, 'after SIGKILL'));
  });

  test('a downloaded backup is a complete, consistent copy that restores to the same library', async () => {
    const r = await fetch(`${srv.base}/api/v1/backup`, { headers: auth });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition') || '', /attachment/);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(0, 16).toString('latin1'), 'SQLite format 3\0');
    const rdir = H.tmpDir();
    const rfile = path.join(rdir, 'playtracker.db'); // restored under the old name, as a PlayTracker backup would be
    fs.writeFileSync(rfile, buf);
    H.inspect(rfile, (db) => H.assertHealthy(assert, db, 'backup'));
    const live = await stateOf(srv);
    const restored = await H.startServer({ env: { ...env, PORT: String(await H.freePort()), PLAYTRACKER_DATA: rdir } });
    try {
      assert.deepEqual(await stateOf(restored), live, 'restoring the backup gives back the same library, settings, accounts and tokens');
      assert.equal(path.resolve(ok(await restored.api('/api/v1/system', { headers: auth }), 'system').data_dir), path.resolve(rfile));
    } finally { await restored.stop(); }
    assert.equal(fs.existsSync(path.join(rdir, 'vestigo.db')), false, 'the restored file is used in place');
  });

  test('SIGTERM with idle keep-alive connections and a download in progress still exits promptly', async () => {
    const agent = new http.Agent({ keepAlive: true });
    await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: srv.port, path: '/api/v1/health', agent }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject));
    const dl = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: srv.port, path: '/api/v1/export', headers: auth, agent: false }, (res) => { res.pause(); resolve({ req, res }); });
      req.on('error', reject);
    });
    const stop = await srv.stop('SIGTERM');
    dl.req.destroy();
    agent.destroy();
    assert.equal(stop.signal, null, 'not killed by the harness');
    assert.equal(stop.code, 0);
    assert.ok(stop.ms < 3000, `exited in ${stop.ms}ms`);
    srv = await H.startServer({ env });
    ok(await srv.api('/api/v1/stats/lifetime', { headers: auth }), 'back up');
    H.inspect(dbFile(), (db) => H.assertHealthy(assert, db, 'after shutdown with open connections'));
  });

  test('repeated restarts never re-date history, duplicate sessions or drift totals', async () => {
    const base = await stateOf(srv);
    for (let i = 0; i < 3; i++) {
      await srv.stop();
      srv = await H.startServer({ env });
      assert.deepEqual(await stateOf(srv), base, `restart ${i + 1}`);
    }
    H.inspect(dbFile(), (db) => H.assertHealthy(assert, db, 'after restarts'));
  });
});

// =====================================================================================
describe('time zones: day and hour buckets follow TZ and are rebuilt when it changes', () => {
  let dir; let ids = {};
  const startTz = async (tz) => H.startServer({ env: { PORT: String(await H.freePort()), PLAYTRACKER_DATA: dir, TZ: tz } });
  const heat = async (s, gid, year = 2025) => ok(await s.api(`/api/v1/stats/heatmap?year=${year}&game_id=${gid}&estimates=exclude`), 'heatmap').days;
  const hours = async (s, gid) => ok(await s.api(`/api/v1/stats?range=year:2025&game_id=${gid}&estimates=exclude`), 'stats').hours;
  const nonZero = (arr) => Object.fromEntries(arr.map((m, h) => [h, m]).filter(([, m]) => m));
  // [title, start, end, minutes]
  const SESSIONS = [
    ['Night Owl', '2025-07-14T23:00:00Z', '2025-07-15T01:00:00Z', 120],
    ['Spring Forward', '2025-03-09T06:00:00Z', '2025-03-09T08:00:00Z', 120], // New York: 01:00 EST -> 04:00 EDT
    ['Fall Back', '2025-11-02T05:00:00Z', '2025-11-02T07:00:00Z', 120], // New York: 01:00 EDT -> 01:00 EST -> 02:00 EST
    ['Short Night', '2025-03-09T03:00:00Z', '2025-03-09T08:00:00Z', 300], // New York: Mar 8 22:00 -> Mar 9 04:00 (23h day)
    ['Long Night', '2025-11-02T02:00:00Z', '2025-11-02T08:00:00Z', 360], // New York: Nov 1 22:00 -> Nov 2 03:00 (25h day)
    ['New Year', '2025-12-31T23:30:00Z', '2026-01-01T00:30:00Z', 60],
  ];
  const TOTAL = SESSIONS.reduce((a, s) => a + s[3], 0);

  before(() => { dir = H.tmpDir(); });

  const ALIASES = { 'Asia/Kolkata': ['Asia/Kolkata', 'Asia/Calcutta'] }; // ICU reports the legacy canonical id
  async function common(s, tz) {
    const names = ALIASES[tz] || [tz];
    const reported = ok(await s.api('/api/v1/health'), 'health').tz;
    assert.ok(names.includes(reported), `health reports the active time zone (${reported})`);
    const sys = ok(await s.api('/api/v1/system'), 'system');
    assert.ok(names.includes(sys.tz), `system reports ${sys.tz}`);
    const life = ok(await s.api('/api/v1/stats/lifetime'), 'life');
    assert.equal(life.total_minutes, TOTAL, `${tz}: lifetime unchanged`);
    assert.equal(life.tracked_minutes, TOTAL);
    const all = ok(await s.api('/api/v1/stats?range=all&estimates=exclude'), 'all');
    assert.equal(all.total_minutes, TOTAL, `${tz}: all-time chart total`);
    assert.equal(all.sessions, SESSIONS.length, `${tz}: each session counted once`);
    const y25 = ok(await s.api('/api/v1/stats/heatmap?year=2025&estimates=exclude'), 'h25').days;
    const y26 = ok(await s.api('/api/v1/stats/heatmap?year=2026&estimates=exclude'), 'h26').days;
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    assert.equal(sum(y25) + sum(y26), TOTAL, `${tz}: no minute lost or doubled at day/year boundaries`);
  }

  test('UTC: sessions split at UTC midnight', async () => {
    const s = await startTz('UTC');
    try {
      for (const [title, st, en, m] of SESSIONS) {
        const g = ok(await s.api('/api/v1/games', { method: 'POST', body: { title } }), title);
        ids[title] = g.id;
        ok(await s.api('/api/v1/sessions', { method: 'POST', body: { game_id: g.id, minutes: m, started_at: st, ended_at: en } }), `${title} session`);
      }
      await common(s, 'UTC');
      assert.deepEqual(await heat(s, ids['Night Owl']), { '2025-07-14': 60, '2025-07-15': 60 });
      assert.deepEqual(nonZero(await hours(s, ids['Night Owl'])), { 0: 60, 23: 60 });
      assert.deepEqual(await heat(s, ids['Spring Forward']), { '2025-03-09': 120 });
      assert.deepEqual(nonZero(await hours(s, ids['Spring Forward'])), { 6: 60, 7: 60 });
      assert.deepEqual(await heat(s, ids['New Year']), { '2025-12-31': 30 });
      assert.deepEqual(await heat(s, ids['New Year'], 2026), { '2026-01-01': 30 });
      assert.equal(ok(await s.api('/api/v1/stats/year/2025?estimates=exclude'), 'year').total_minutes, TOTAL - 30);
    } finally { await s.stop(); }
  });

  test('America/New_York: everything is re-bucketed to local days, including DST change days', async () => {
    const s = await startTz('America/New_York');
    try {
      await common(s, 'America/New_York');
      assert.deepEqual(await heat(s, ids['Night Owl']), { '2025-07-14': 120 }, '19:00-21:00 EDT');
      assert.deepEqual(nonZero(await hours(s, ids['Night Owl'])), { 19: 60, 20: 60 });
      // spring forward: 01:00-02:00 EST then 03:00-04:00 EDT; 02:xx does not exist
      assert.deepEqual(await heat(s, ids['Spring Forward']), { '2025-03-09': 120 });
      assert.deepEqual(nonZero(await hours(s, ids['Spring Forward'])), { 1: 60, 3: 60 });
      // fall back: the 01:00 hour happens twice
      assert.deepEqual(await heat(s, ids['Fall Back']), { '2025-11-02': 120 });
      assert.deepEqual(nonZero(await hours(s, ids['Fall Back'])), { 1: 120 });
      // midnight on a 23-hour and a 25-hour day: real minutes per local day
      assert.deepEqual(await heat(s, ids['Short Night']), { '2025-03-08': 120, '2025-03-09': 180 });
      assert.deepEqual(nonZero(await hours(s, ids['Short Night'])), { 22: 60, 23: 60, 0: 60, 1: 60, 3: 60 });
      assert.deepEqual(await heat(s, ids['Long Night']), { '2025-11-01': 120, '2025-11-02': 240 });
      assert.deepEqual(nonZero(await hours(s, ids['Long Night'])), { 22: 60, 23: 60, 0: 60, 1: 120, 2: 60 });
      // New Year's Eve 18:30-19:30 local: all of it in 2025
      assert.deepEqual(await heat(s, ids['New Year']), { '2025-12-31': 60 });
      assert.deepEqual(await heat(s, ids['New Year'], 2026), {});
      assert.equal(ok(await s.api('/api/v1/stats/year/2025?estimates=exclude'), 'year').total_minutes, TOTAL);
    } finally { await s.stop(); }
  });

  test('Asia/Kolkata (UTC+5:30): half-hour offsets split hours correctly', async () => {
    const s = await startTz('Asia/Kolkata');
    try {
      await common(s, 'Asia/Kolkata');
      assert.deepEqual(await heat(s, ids['Night Owl']), { '2025-07-15': 120 }, '04:30-06:30 IST');
      assert.deepEqual(nonZero(await hours(s, ids['Night Owl'])), { 4: 30, 5: 60, 6: 30 });
      assert.deepEqual(await heat(s, ids['New Year'], 2026), { '2026-01-01': 60 });
      assert.deepEqual(await heat(s, ids['New Year']), {});
    } finally { await s.stop(); }
  });

  test('back to UTC: the original buckets return exactly, and sessions logged in another zone are re-bucketed too', async () => {
    let s = await startTz('Asia/Tokyo');
    try {
      await common(s, 'Asia/Tokyo');
      // a session logged while the server ran in Tokyo: 2025-05-05 08:00-09:30 JST = 2025-05-04 23:00Z -> 00:30Z
      const g = ok(await s.api('/api/v1/games', { method: 'POST', body: { title: 'Tokyo Drift' } }), 'add');
      ids['Tokyo Drift'] = g.id;
      ok(await s.api('/api/v1/sessions', { method: 'POST', body: { game_id: g.id, minutes: 90, started_at: '2025-05-05T08:00:00+09:00', ended_at: '2025-05-05T09:30:00+09:00' } }), 'session');
      assert.deepEqual(await heat(s, g.id), { '2025-05-05': 90 });
    } finally { await s.stop(); }
    s = await startTz('UTC');
    try {
      assert.deepEqual(await heat(s, ids['Night Owl']), { '2025-07-14': 60, '2025-07-15': 60 });
      assert.deepEqual(nonZero(await hours(s, ids['Spring Forward'])), { 6: 60, 7: 60 });
      assert.deepEqual(await heat(s, ids['Long Night']), { '2025-11-02': 360 });
      assert.deepEqual(await heat(s, ids['Tokyo Drift']), { '2025-05-04': 60, '2025-05-05': 30 });
      assert.equal(ok(await s.api('/api/v1/stats/lifetime'), 'life').total_minutes, TOTAL + 90);
    } finally { await s.stop(); }
    H.inspect(path.join(dir, 'vestigo.db'), (db) => H.assertHealthy(assert, db, 'tz'));
  });
});

// =====================================================================================
describe('concurrency: parallel requests and syncs never corrupt data', () => {
  let app; let mock; let dbFile;
  const steamGames = new Map(); // appid -> { name, playtime_forever, rtime_last_played, playtime_2weeks }
  const listSteam = () => [...steamGames.entries()].map(([appid, g]) => ({ appid, img_icon_url: '', has_community_visible_stats: false, ...g }));
  const health = () => H.assertHealthy(assert, app.db, 'live db');
  const steamAccount = async (name, id) => ok(await app.api('/api/v1/accounts', { method: 'POST', body: { platform: 'steam', name, sync: false, config: { api_key: 'A'.repeat(32), steam_id: id } } }), 'steam account');
  const waitFor = async (cond, what, ms = 5000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await H.sleep(5); } };
  const entryOf = (accountId, ext) => app.db.prepare('SELECT * FROM entries WHERE account_id = ? AND ext_id = ?').get(accountId, String(ext));
  const playMinutes = (entryId) => app.db.prepare("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE entry_id = ? AND kind = 'play'").get(entryId).m;

  before(async () => {
    mock = H.installSteamMock({ games: listSteam });
    dbFile = path.join(H.tmpDir(), 'concurrency.db');
    app = await H.startApp(createApp, { dbFile });
  });
  after(async () => {
    app?.close();
    mock?.restore();
    await H.sleep(50);
  });

  test('300 manual sessions logged at once across 10 games: every minute counted exactly once', async () => {
    const games = [];
    for (let i = 0; i < 10; i++) games.push(ok(await app.api('/api/v1/games', { method: 'POST', body: { title: `Parallel Game ${String.fromCharCode(65 + i)}` } }), 'add'));
    const want = new Map(games.map((g) => [g.id, { minutes: 0, n: 0 }]));
    const reqs = [];
    for (let k = 0; k < 300; k++) {
      const g = games[k % 10];
      const minutes = 1 + ((k * 37) % 179);
      want.get(g.id).minutes += minutes; want.get(g.id).n++;
      const start = new Date(Date.UTC(2025, 0, 1) + k * 5 * HOUR).toISOString();
      reqs.push(app.api('/api/v1/sessions', { method: 'POST', body: { game_id: g.id, minutes, started_at: start } }));
    }
    const res = await Promise.all(reqs);
    assert.deepEqual([...new Set(res.map((r) => r.status))], [200]);
    assert.equal(new Set(res.map((r) => r.json.id)).size, 300, 'every session got its own id');
    for (const g of games) {
      const d = ok(await app.api(`/api/v1/games/${g.id}`), 'game');
      assert.equal(d.minutes, want.get(g.id).minutes, `${g.title} total`);
      assert.equal(d.summary.tracked_minutes, want.get(g.id).minutes);
      assert.equal(d.summary.sessions, want.get(g.id).n);
      assert.equal(d.entries.length, 1, 'one manual entry per game, not one per request');
    }
    const total = [...want.values()].reduce((a, w) => a + w.minutes, 0);
    const st = ok(await app.api('/api/v1/stats?range=year:2025&estimates=exclude'), 'stats');
    assert.equal(st.total_minutes, total);
    assert.equal(st.sessions, 300);
    health();
  });

  test('reads interleaved with writes always succeed and the end state is consistent', async () => {
    const g = ok(await app.api('/api/v1/games', { method: 'POST', body: { title: 'Read Write Race' } }), 'add');
    const reqs = [];
    let expect = 0;
    for (let k = 0; k < 100; k++) {
      const minutes = 5 + (k % 20);
      expect += minutes;
      reqs.push(app.api('/api/v1/sessions', { method: 'POST', body: { game_id: g.id, minutes, started_at: new Date(Date.UTC(2025, 5, 1) + k * 3 * HOUR).toISOString() } }));
      const reads = ['/api/v1/stats?range=all', '/api/v1/summary', '/api/v1/games?sort=playtime', `/api/v1/games/${g.id}`, '/api/v1/sessions?limit=50', '/api/v1/stats/heatmap?year=2025', '/api/v1/stats/lifetime', '/api/v1/duplicates?summary=true'];
      reqs.push(app.api(reads[k % reads.length]));
      if (k % 10 === 0) reqs.push(app.api(`/api/v1/games/${g.id}`, { method: 'PATCH', body: { rating: k % 11, status: ['playing', 'paused', 'beaten'][k % 3] } }));
    }
    const res = await Promise.all(reqs);
    const bad = res.filter((r) => r.status !== 200);
    assert.deepEqual(bad.map((r) => `${r.status} ${r.text.slice(0, 120)}`), []);
    for (const r of res) {
      if (r.json?.id === g.id && typeof r.json.minutes === 'number') assert.ok(r.json.minutes >= 0 && r.json.minutes <= expect, 'a read never sees more than was written');
    }
    const d = ok(await app.api(`/api/v1/games/${g.id}`), 'game');
    assert.equal(d.minutes, expect);
    assert.equal(d.summary.sessions, 100);
    assert.ok(['playing', 'paused', 'beaten'].includes(d.status));
    health();
  });

  test('the same title added 50 times at once is one game (auto-merge); merge:false really creates separate games', async () => {
    const res = await Promise.all(Array.from({ length: 50 }, () => app.api('/api/v1/games', { method: 'POST', body: { title: 'Parallel Quest' } })));
    assert.deepEqual([...new Set(res.map((r) => r.status))], [200]);
    assert.equal(new Set(res.map((r) => r.json.id)).size, 1, 'all requests got the same game');
    const list = ok(await app.api('/api/v1/games?q=Parallel%20Quest'), 'search');
    assert.equal(list.total, 1);
    assert.equal(list.items[0].entry_count, 1, 'a single manual entry');
    const sep = await Promise.all(Array.from({ length: 5 }, () => app.api('/api/v1/games', { method: 'POST', body: { title: 'Separate Copy', merge: false } })));
    assert.equal(new Set(sep.map((r) => r.json.id)).size, 5);
    health();
  });

  test('deleting the same session 10 times at once subtracts its minutes once', async () => {
    const g = ok(await app.api('/api/v1/games', { method: 'POST', body: { title: 'Delete Race' } }), 'add');
    const a = ok(await app.api('/api/v1/sessions', { method: 'POST', body: { game_id: g.id, minutes: 30, started_at: '2025-02-01T10:00:00Z' } }), 's1');
    ok(await app.api('/api/v1/sessions', { method: 'POST', body: { game_id: g.id, minutes: 45, started_at: '2025-02-02T10:00:00Z' } }), 's2');
    const res = await Promise.all(Array.from({ length: 10 }, () => app.api(`/api/v1/sessions/${a.id}`, { method: 'DELETE' })));
    assert.equal(res.filter((r) => r.status === 200).length, 1, 'exactly one delete succeeds');
    assert.deepEqual([...new Set(res.filter((r) => r.status !== 200).map((r) => r.status))], [404]);
    const d = ok(await app.api(`/api/v1/games/${g.id}`), 'game');
    assert.equal(d.minutes, 45);
    assert.equal(d.summary.sessions, 1);
    health();
  });

  test('conflicting merges fired at once never lose playtime', async () => {
    const mk = async (title, minutes) => {
      const g = ok(await app.api('/api/v1/games', { method: 'POST', body: { title, merge: false } }), title);
      ok(await app.api('/api/v1/sessions', { method: 'POST', body: { game_id: g.id, minutes, started_at: '2025-03-03T10:00:00Z' } }), 'session');
      return g.id;
    };
    const x = await mk('Merge Race X', 10); const y = await mk('Merge Race Y', 20); const z = await mk('Merge Race Z', 30);
    const res = await Promise.all([
      app.api(`/api/v1/games/${x}/merge`, { method: 'POST', body: { source_ids: [y] } }),
      app.api(`/api/v1/games/${y}/merge`, { method: 'POST', body: { source_ids: [x] } }),
      app.api(`/api/v1/games/${z}/merge`, { method: 'POST', body: { source_ids: [x, y] } }),
      app.api(`/api/v1/games/${x}/merge`, { method: 'POST', body: { source_ids: [z] } }),
    ]);
    for (const r of res) assert.ok([200, 404].includes(r.status), `merge answered ${r.status}: ${r.text.slice(0, 200)}`);
    const left = [x, y, z].map((id) => app.db.prepare('SELECT id FROM games WHERE id = ?').get(id)).filter(Boolean).map((r) => r.id);
    assert.ok(left.length >= 1);
    let total = 0;
    for (const id of left) total += ok(await app.api(`/api/v1/games/${id}`), 'game').minutes;
    assert.equal(total, 60, 'all 60 minutes still belong to a game');
    health();
  });

  test('the same CSV imported 8 times at once is applied once (imports are idempotent)', async () => {
    const csv = 'title,platform,playtime_hours,last_played,status,rating\n'
      + 'Idem Alpha,switch,42,2025-11-02,completed,10\nIdem Beta,switch,12.5,2025-01-15,beaten,\nIdem Gamma,switch,3,2024-06-30,,7\n'
      + 'Idem Delta,switch,100,2025-09-09,playing,\nIdem Epsilon,switch,0.5,2025-10-01,,\n';
    const res = await Promise.all(Array.from({ length: 8 }, () => app.api('/api/v1/import', { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv' } })));
    assert.deepEqual(res.map((r) => r.status), Array(8).fill(200), res.map((r) => r.text.slice(0, 200)).join('\n'));
    const list = ok(await app.api('/api/v1/games?q=Idem&limit=50&sort=title'), 'games');
    assert.equal(list.total, 5, 'five games, not forty');
    const want = { 'Idem Alpha': 2520, 'Idem Beta': 750, 'Idem Gamma': 180, 'Idem Delta': 6000, 'Idem Epsilon': 30 };
    for (const g of list.items) {
      assert.equal(g.minutes, want[g.title], g.title);
      assert.equal(g.entry_count, 1, `${g.title}: one entry`);
    }
    assert.equal(list.total_minutes, 9480);
    health();
  });

  let steamId;
  test('sync requests fired at once for one account share a single run (initial import counted once)', async () => {
    steamGames.set(620, { name: 'Portal 2', playtime_forever: 1200, rtime_last_played: Math.floor((NOW - 30 * DAY) / 1000), playtime_2weeks: 0 });
    steamGames.set(400, { name: 'Portal', playtime_forever: 300, rtime_last_played: Math.floor((NOW - 200 * DAY) / 1000), playtime_2weeks: 0 });
    steamGames.set(730, { name: 'Counter-Strike 2', playtime_forever: 0, rtime_last_played: 0, playtime_2weeks: 0 });
    const acc = await steamAccount('Steam', '76561198000000001');
    steamId = acc.id;
    const lifeBefore = ok(await app.api('/api/v1/stats/lifetime'), 'life');
    const owned0 = mock.calls.owned;
    const release = mock.hold();
    const runs = Array.from({ length: 6 }, () => app.api(`/api/v1/accounts/${acc.id}/sync?wait=true`, { method: 'POST' }));
    await waitFor(() => mock.calls.owned > owned0, 'the first library fetch');
    const during = ok(await app.api('/api/v1/accounts'), 'accounts').find((a) => a.id === acc.id);
    assert.equal(during.syncing, true, 'the account shows as syncing');
    await H.sleep(50);
    release();
    const res = await Promise.all(runs);
    assert.deepEqual(res.map((r) => r.status), Array(6).fill(200), res.map((r) => r.text.slice(0, 200)).join('\n'));
    assert.equal(new Set(res.map((r) => r.json.sync_id)).size, 1, 'one sync run shared by all callers');
    assert.equal(mock.calls.owned - owned0, 1, 'the library was fetched once');
    assert.equal(ok(await app.api(`/api/v1/syncs?account_id=${acc.id}`), 'syncs').length, 1);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM entries WHERE account_id = ?').get(acc.id).n, 3);
    const life = ok(await app.api('/api/v1/stats/lifetime'), 'life');
    assert.equal(life.total_minutes, lifeBefore.total_minutes + 1500, 'lifetime gains the library once');
    assert.equal(life.tracked_minutes, lifeBefore.tracked_minutes, 'an initial import is history, never tracked play');
    health();
  });

  test('a burst of follow-up syncs records each real delta once', async () => {
    steamGames.get(620).playtime_forever = 1290;
    steamGames.get(620).playtime_2weeks = 90;
    steamGames.get(620).rtime_last_played = Math.floor((NOW - 2 * HOUR) / 1000);
    const e = entryOf(steamId, 620);
    const play0 = playMinutes(e.id);
    const release = mock.hold();
    const runs = Array.from({ length: 5 }, () => app.api(`/api/v1/accounts/${steamId}/sync?wait=true`, { method: 'POST' }));
    await H.sleep(30);
    release();
    const res = await Promise.all(runs);
    assert.deepEqual(res.map((r) => r.status), Array(5).fill(200));
    assert.equal(new Set(res.map((r) => r.json.sync_id)).size, 1);
    assert.equal(playMinutes(e.id) - play0, 90, 'exactly the 90 new minutes are tracked');
    assert.equal(entryOf(steamId, 620).playtime_min, 1290);
    // nothing changed: another burst adds nothing
    const again = await Promise.all(Array.from({ length: 4 }, () => app.api(`/api/v1/accounts/${steamId}/sync?wait=true`, { method: 'POST' })));
    for (const r of again) assert.equal(ok(r, 'sync').minutes_added, 0);
    assert.equal(playMinutes(e.id) - play0, 90);
    health();
  });

  test('a report pushed while the same account is syncing is refused cleanly or applied once - never doubled', async () => {
    steamGames.get(620).playtime_forever = 1320;
    steamGames.get(620).playtime_2weeks = 120;
    steamGames.get(620).rtime_last_played = Math.floor((NOW - HOUR) / 1000);
    const e = entryOf(steamId, 620);
    const play0 = playMinutes(e.id);
    const owned0 = mock.calls.owned;
    const release = mock.hold();
    const run = app.api(`/api/v1/accounts/${steamId}/sync?wait=true`, { method: 'POST' });
    await waitFor(() => mock.calls.owned > owned0, 'library fetch');
    const rep = await app.api(`/api/v1/accounts/${steamId}/report`, { method: 'POST', body: { games: [{ id: '620', title: 'Portal 2', playtime_minutes: 1320, last_played_at: new Date(NOW - HOUR).toISOString() }] } });
    assert.ok([200, 409].includes(rep.status), `report during sync answered ${rep.status}`);
    release();
    ok(await run, 'sync');
    assert.equal(entryOf(steamId, 620).playtime_min, 1320);
    assert.equal(playMinutes(e.id) - play0, 30, 'the 30 new minutes are counted once');
    health();
  });

  test('two accounts syncing at once while importing and logging sessions keep every total right', async () => {
    const custom = ok(await app.api('/api/v1/accounts', { method: 'POST', body: { platform: 'custom', name: 'Deck Push' } }), 'custom');
    ok(await app.api(`/api/v1/accounts/${custom.id}/report`, { method: 'POST', body: { games: [{ id: 'p2', title: 'Portal 2', playtime_minutes: 100 }, { id: 'hl', title: 'Half-Life', playtime_minutes: 50 }] } }), 'first report');
    steamGames.get(620).playtime_forever = 1380;
    steamGames.get(620).playtime_2weeks = 180;
    steamGames.get(620).rtime_last_played = Math.floor((NOW - 30 * MIN) / 1000);
    steamGames.set(220, { name: 'Half-Life 2', playtime_forever: 45, rtime_last_played: Math.floor((NOW - 3 * HOUR) / 1000), playtime_2weeks: 45 });
    const steamE = entryOf(steamId, 620);
    const steamPlay0 = playMinutes(steamE.id);
    const pushE = entryOf(custom.id, 'p2');
    const pushPlay0 = playMinutes(pushE.id);
    const portal2 = steamE.game_id;
    const release = mock.hold();
    const work = [
      app.api(`/api/v1/accounts/${steamId}/sync?wait=true`, { method: 'POST' }),
      app.api(`/api/v1/accounts/${custom.id}/report`, { method: 'POST', body: { games: [{ id: 'p2', title: 'Portal 2', playtime_minutes: 110, last_played_at: new Date().toISOString() }, { id: 'hl', title: 'Half-Life', playtime_minutes: 50 }] } }),
      app.api('/api/v1/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: 'title,platform,playtime_hours,last_played\nPortal 2,switch,2,2025-05-05\nBraid,switch,6,2024-04-04\n' }),
      ...Array.from({ length: 6 }, (_, i) => app.api('/api/v1/sessions', { method: 'POST', body: { game_id: portal2, minutes: 15, started_at: `2025-09-1${i}T20:00:00Z` } })),
    ];
    await H.sleep(30);
    release();
    const res = await Promise.all(work);
    assert.deepEqual(res.map((r) => r.status), Array(res.length).fill(200), res.map((r) => r.text.slice(0, 160)).join('\n'));
    assert.equal(playMinutes(steamE.id) - steamPlay0, 60, 'Steam delta counted once');
    assert.equal(entryOf(steamId, 620).playtime_min, 1380);
    assert.equal(playMinutes(pushE.id) - pushPlay0, 10, 'pushed delta counted once');
    const manual = app.db.prepare("SELECT * FROM entries WHERE game_id = ? AND platform = 'manual'").get(portal2);
    assert.equal(manual.playtime_min, 90, 'six manual sessions of 15 minutes');
    // library and lifetime agree with the entries, nothing counted twice
    const life = ok(await app.api('/api/v1/stats/lifetime'), 'life');
    const sums = app.db.prepare("SELECT COALESCE(SUM(playtime_min), 0) total FROM entries WHERE excluded = 0").get();
    assert.equal(life.total_minutes, sums.total);
    const tracked = app.db.prepare("SELECT COALESCE(SUM(s.minutes), 0) m FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE s.kind = 'play' AND e.excluded = 0").get().m;
    assert.equal(life.tracked_minutes, tracked);
    const lib = ok(await app.api('/api/v1/games?limit=5000'), 'games');
    assert.equal(lib.total_minutes, sums.total, 'library total = sum of entries');
    health();
  });

  test('deleting an account while its sync is in flight leaves no orphans and the server keeps working', async () => {
    const acc = await steamAccount('Doomed', '76561198000000002');
    const owned0 = mock.calls.owned;
    const release = mock.hold();
    const run = app.api(`/api/v1/accounts/${acc.id}/sync?wait=true`, { method: 'POST' });
    await waitFor(() => mock.calls.owned > owned0, 'library fetch');
    ok(await app.api(`/api/v1/accounts/${acc.id}`, { method: 'DELETE' }), 'delete');
    release();
    const r = await run;
    assert.ok(r.status !== 200 || r.json, `sync finished with ${r.status}`);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM entries WHERE account_id = ?').get(acc.id).n, 0, 'no entries for a deleted account');
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM syncs WHERE account_id = ?').get(acc.id).n, 0);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM accounts WHERE id = ?').get(acc.id).n, 0, 'the account is not resurrected');
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM games WHERE id NOT IN (SELECT game_id FROM entries)').get().n, 0, 'no empty games left behind');
    ok(await app.api('/api/v1/games'), 'games');
    ok(await app.api('/api/v1/stats?range=all'), 'stats');
    health();
  });

  test('"Sync all" while a sync is running does not start a second run of that account', async () => {
    const owned0 = mock.calls.owned;
    const syncs0 = app.db.prepare('SELECT COUNT(*) n FROM syncs WHERE account_id = ?').get(steamId).n;
    const release = mock.hold();
    const run = app.api(`/api/v1/accounts/${steamId}/sync?wait=true`, { method: 'POST' });
    await waitFor(() => mock.calls.owned > owned0, 'library fetch');
    const all = ok(await app.api('/api/v1/sync', { method: 'POST' }), 'sync all');
    assert.ok(all.started >= 1);
    release();
    ok(await run, 'sync');
    await H.sleep(50);
    assert.equal(mock.calls.owned - owned0, 1, 'one library fetch');
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM syncs WHERE account_id = ?').get(steamId).n - syncs0, 1, 'one sync row');
    health();
  });
});

// =====================================================================================
describe('scale: 20k games and 200k sessions seeded directly', () => {
  const GAMES = 20_000;
  const PER = 10;
  const LIMIT = Number(process.env.SCALE_LIMIT_MS || 5000); // "responds within a few seconds"
  let app; let dbFile; let accIds;
  const exp = { total: 0, byDay: new Map(), byMonth: new Map(), byPlatform: new Map(), byGame: new Map(), sessions: 0 };
  let seedMs = 0; let startMs = 0;
  const timed = async (p, opts) => {
    const t = Date.now();
    const r = await app.api(p, opts);
    if (process.env.SERVER_DB_TIMINGS) console.log(`[timing] ${opts?.method || 'GET'} ${p.slice(0, 80)} ${Date.now() - t}ms`);
    return { ...r, ms: Date.now() - t };
  };
  const fast = (r, what, limit = LIMIT) => { ok(r, what); assert.ok(r.ms < limit, `${what} took ${r.ms}ms (limit ${limit}ms)`); return r.json; };

  before(async () => {
    dbFile = path.join(H.tmpDir(), 'scale', 'playtracker.db');
    const t0 = Date.now();
    const db = openDb(dbFile);
    const r = H.rng(20251023);
    const syl = ['ka', 'zu', 'mi', 'tor', 'vex', 'lan', 'qui', 'ro', 'sha', 'dun', 'el', 'fy', 'gor', 'hal', 'ix', 'jun'];
    const word = () => { let s = ''; const n = 2 + Math.floor(r() * 3); for (let i = 0; i < n; i++) s += syl[Math.floor(r() * syl.length)]; return s[0].toUpperCase() + s.slice(1); };
    const plats = ['steam', 'xbox', 'psn', 'custom'];
    const Y = Date.UTC(2025, 0, 1);
    db.exec('BEGIN');
    // every account last synced at the end of 2025 (the sessions below are that year's play)
    const accIns = db.prepare("INSERT INTO accounts(platform, name, config, state, enabled, last_sync_at, last_status, created_at) VALUES (?, ?, '{}', '{}', 0, ?, 'ok', ?)");
    accIds = plats.map((p) => Number(accIns.run(p, `Big ${p}`, Date.UTC(2025, 11, 31, 12), Y).lastInsertRowid));
    const gIns = db.prepare('INSERT INTO games(title, norm_title, created_at, updated_at) VALUES (?, ?, ?, ?)');
    const eIns = db.prepare('INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, last_played_at, first_seen_at, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const sIns = db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at, confidence) VALUES (?, 'sync', 'play', ?, ?, ?, ?, ?, ?, 'pinned')");
    for (let i = 0; i < GAMES; i++) {
      const title = `${word()} ${word()} ${i}`;
      const pi = i % plats.length;
      const gid = Number(gIns.run(title, title.toLowerCase(), Y + i, Y + i).lastInsertRowid);
      const sess = [];
      for (let j = 0; j < PER; j++) {
        const day = (i * 7 + j * 37 + Math.floor(r() * 5)) % 365;
        const start = Y + day * DAY + (8 + Math.floor(r() * 10)) * HOUR + Math.floor(r() * 60) * MIN; // 08:00-18:59 UTC
        const minutes = 5 + Math.floor(r() * 236); // <= 240: never crosses midnight
        sess.push([minutes, start, start + minutes * MIN]);
      }
      const total = sess.reduce((a, s) => a + s[0], 0);
      const last = Math.max(...sess.map((s) => s[2]));
      const eid = Number(eIns.run(accIds[pi], gid, plats[pi], String(100000 + i), title, total, last, Y, last).lastInsertRowid);
      for (const [m, st, en] of sess) {
        sIns.run(eid, m, st, en, st, en, en);
        const k = new Date(st).toISOString().slice(0, 10);
        exp.byDay.set(k, (exp.byDay.get(k) || 0) + m);
        exp.byMonth.set(k.slice(0, 7), (exp.byMonth.get(k.slice(0, 7)) || 0) + m);
        exp.sessions++;
      }
      exp.total += total;
      exp.byGame.set(gid, { title, minutes: total, entry: total, last, ext: String(100000 + i), account: accIds[pi] }); // minutes: whole game; entry: its synced entry
      exp.byPlatform.set(plats[pi], (exp.byPlatform.get(plats[pi]) || 0) + total);
    }
    db.exec('COMMIT');
    db.close();
    seedMs = Date.now() - t0;
    const t1 = Date.now();
    app = await H.startApp(createApp, { dbFile });
    startMs = Date.now() - t1;
  });
  after(() => app?.close());

  test('first start on a big existing database (one-time stats index build) is quick', () => {
    assert.equal(exp.sessions, GAMES * PER);
    assert.ok(startMs < 30_000, `startup took ${startMs}ms (seeding ${seedMs}ms)`);
    const counts = app.db.prepare('SELECT (SELECT COUNT(*) FROM games) g, (SELECT COUNT(*) FROM sessions) s').get();
    assert.equal(counts.g, GAMES);
    assert.equal(counts.s, GAMES * PER);
  });

  test('/games pages through 20k games quickly with exact totals and stable ordering', async () => {
    const first = fast(await timed('/api/v1/games?limit=100'), 'games page 1');
    assert.equal(first.total, GAMES);
    assert.equal(first.total_minutes, exp.total);
    assert.equal(first.items.length, 100);
    const deep = fast(await timed(`/api/v1/games?sort=playtime&limit=100&offset=${GAMES - 100}`), 'games deep offset');
    assert.equal(deep.items.length, 100);
    for (let i = 1; i < deep.items.length; i++) assert.ok(deep.items[i - 1].minutes >= deep.items[i].minutes, 'sorted by playtime');
    const minExpected = Math.min(...[...exp.byGame.values()].map((g) => g.minutes));
    assert.equal(deep.items.at(-1).minutes, minExpected, 'the last page ends with the least played game');
    const top = fast(await timed('/api/v1/games?sort=playtime&limit=1'), 'top');
    assert.equal(top.items[0].minutes, Math.max(...[...exp.byGame.values()].map((g) => g.minutes)));
    const big = fast(await timed('/api/v1/games?limit=5000&sort=title'), 'games 5000');
    assert.equal(big.items.length, 5000);
    for (let i = 1; i < big.items.length; i++) assert.ok(big.items[i - 1].title.localeCompare(big.items[i].title, 'en', { sensitivity: 'base' }) <= 0 || big.items[i - 1].title.toLowerCase() <= big.items[i].title.toLowerCase(), 'title order');
    const past = fast(await timed(`/api/v1/games?limit=100&offset=${GAMES + 10}`), 'past the end');
    assert.deepEqual(past.items, []);
    assert.equal(past.total, GAMES);
    const [gid, g] = [...exp.byGame.entries()][12345];
    const found = fast(await timed(`/api/v1/games?q=${encodeURIComponent(g.title)}`), 'search');
    assert.ok(found.items.some((x) => x.id === gid && x.minutes === g.minutes), 'search finds the exact game');
    const plat = fast(await timed('/api/v1/games?platform=xbox&limit=1'), 'platform filter');
    assert.equal(plat.total, GAMES / 4);
    assert.equal(plat.total_minutes, exp.byPlatform.get('xbox'));
  });

  test('/stats?range=all and year/month stats are fast and add up exactly', async () => {
    const all = fast(await timed('/api/v1/stats?range=all'), 'stats all');
    assert.equal(all.total_minutes, exp.total);
    assert.equal(all.tracked_minutes, exp.total);
    assert.equal(all.sessions, GAMES * PER);
    assert.equal(all.games_played, GAMES);
    assert.equal(all.series.reduce((a, s) => a + s.minutes, 0), exp.total);
    assert.deepEqual(Object.fromEntries(all.platforms.map((p) => [p.platform, p.minutes])), Object.fromEntries(exp.byPlatform));
    assert.equal(all.days_played, exp.byDay.size);
    const busiest = [...exp.byDay.entries()].sort((a, b) => b[1] - a[1])[0];
    assert.deepEqual(all.busiest_day, { day: busiest[0], minutes: busiest[1] });
    const year = fast(await timed('/api/v1/stats?range=year:2025&group=month'), 'stats year');
    assert.equal(year.series.length, 12);
    assert.deepEqual(Object.fromEntries(year.series.map((s) => [s.key, s.minutes])), Object.fromEntries([...exp.byMonth.entries()].sort()));
    const month = fast(await timed('/api/v1/stats?range=month:2025-06&group=day'), 'stats month');
    assert.equal(month.total_minutes, exp.byMonth.get('2025-06'));
    const review = fast(await timed('/api/v1/stats/year/2025'), 'year in review');
    assert.equal(review.total_minutes, exp.total);
    assert.equal(review.sessions, GAMES * PER);
    for (const p of ['/api/v1/stats?range=30d', '/api/v1/stats?range=365d', '/api/v1/stats?range=all&platform=psn', `/api/v1/stats?range=all&game_id=${[...exp.byGame.keys()][77]}`]) fast(await timed(p), p);
    const cached = await timed('/api/v1/stats?range=all');
    assert.deepEqual(cached.json, all, 'cached answer is identical');
  });

  test('/stats/heatmap is fast and every day is exact', async () => {
    const h = fast(await timed('/api/v1/stats/heatmap?year=2025'), 'heatmap');
    assert.deepEqual(h.days, Object.fromEntries([...exp.byDay.entries()].sort()));
    assert.deepEqual(fast(await timed('/api/v1/stats/heatmap?year=2024'), 'heatmap 2024').days, {});
    const [gid] = [...exp.byGame.keys()].slice(-1);
    const one = fast(await timed(`/api/v1/stats/heatmap?year=2025&game_id=${gid}`), 'game heatmap');
    assert.equal(Object.values(one.days).reduce((a, b) => a + b, 0), exp.byGame.get(gid).minutes);
  });

  test('/summary, /stats/lifetime and deep session paging are fast and consistent', async () => {
    fast(await timed('/api/v1/summary'), 'summary');
    const life = fast(await timed('/api/v1/stats/lifetime'), 'lifetime');
    assert.equal(life.total_minutes, exp.total);
    assert.equal(life.sessions, GAMES * PER);
    assert.equal(life.games, GAMES);
    let page = fast(await timed('/api/v1/sessions?limit=1000'), 'sessions page 1');
    assert.equal(page.total, GAMES * PER);
    assert.equal(page.total_minutes, exp.total);
    const seen = new Set();
    let prev = Infinity;
    for (let i = 0; i < 15 && page.next; i++) {
      for (const s of page.items) {
        assert.ok(!seen.has(s.id), 'no session twice across pages');
        seen.add(s.id);
        const t = s.ended_at || s.window_end;
        assert.ok(t <= prev, 'newest first');
        prev = t;
      }
      page = fast(await timed(`/api/v1/sessions?limit=1000&before=${page.next}`), `sessions page ${i + 2}`);
    }
    assert.ok(seen.size >= 15_000);
    fast(await timed('/api/v1/sessions?limit=100&offset=190000'), 'sessions deep offset');
    const gid = [...exp.byGame.keys()][4242];
    const g = fast(await timed(`/api/v1/games/${gid}`), 'game detail');
    assert.equal(g.minutes, exp.byGame.get(gid).minutes);
    assert.equal(g.summary.sessions, PER);
    assert.equal(g.sessions.length, PER);
    fast(await timed('/api/v1/widget'), 'widget');
    fast(await timed('/api/v1/system'), 'system');
  });

  test('duplicate detection over 20k titles stays fast', async () => {
    fast(await timed('/api/v1/duplicates?summary=true'), 'duplicates summary', LIMIT * 2);
    fast(await timed('/api/v1/duplicates'), 'duplicates', LIMIT * 2);
  });

  test('20 heavy requests at once all finish within a few seconds', async () => {
    const paths = ['/api/v1/stats?range=all&estimates=exclude', '/api/v1/stats/heatmap?year=2025&estimates=exclude', '/api/v1/games?sort=trending', '/api/v1/summary', '/api/v1/sessions?limit=500'];
    const t = Date.now();
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => app.api(paths[i % paths.length])));
    assert.deepEqual([...new Set(res.map((r) => r.status))], [200]);
    assert.ok(Date.now() - t < LIMIT * 3, `took ${Date.now() - t}ms`);
  });

  test('a write is reflected immediately in every cached view, even at scale', async () => {
    const gid = [...exp.byGame.keys()][1000]; // a Steam game
    const before = { all: (await app.api('/api/v1/stats?range=all')).json, heat: (await app.api('/api/v1/stats/heatmap?year=2025')).json, life: (await app.api('/api/v1/stats/lifetime')).json, games: (await app.api('/api/v1/games?limit=1')).json };
    const t = Date.now();
    ok(await app.api('/api/v1/sessions', { method: 'POST', body: { game_id: gid, minutes: 60, started_at: '2025-06-15T10:00:00Z' } }), 'add session');
    assert.ok(Date.now() - t < LIMIT, 'a write stays fast at scale');
    const all = fast(await timed('/api/v1/stats?range=all'), 'stats after write');
    assert.equal(all.total_minutes, before.all.total_minutes + 60);
    assert.equal(all.sessions, before.all.sessions + 1);
    const heat = fast(await timed('/api/v1/stats/heatmap?year=2025'), 'heatmap after write');
    assert.equal(heat.days['2025-06-15'], (before.heat.days['2025-06-15'] || 0) + 60);
    assert.equal(fast(await timed('/api/v1/stats/lifetime'), 'life').total_minutes, before.life.total_minutes + 60);
    assert.equal(fast(await timed('/api/v1/games?limit=1'), 'games').total_minutes, before.games.total_minutes + 60);
    assert.equal(fast(await timed(`/api/v1/games/${gid}`), 'game').minutes, exp.byGame.get(gid).minutes + 60);
    exp.total += 60; exp.sessions += 1; exp.byGame.get(gid).minutes += 60;
    H.assertHealthy(assert, app.db, 'scale db');
  });

  test('a follow-up report for a 5,000-game account is quick and records exactly the new play', async () => {
    const accId = accIds[3]; // the custom account
    const mine = [...exp.byGame.entries()].filter(([, g]) => g.account === accId);
    assert.equal(mine.length, GAMES / 4);
    const bumped = new Set(mine.slice(0, 100).map(([id]) => id));
    let k = 0;
    const games = mine.map(([id, g]) => (bumped.has(id)
      ? { id: g.ext, title: g.title, playtime_minutes: g.entry + 10, last_played_at: new Date(NOW - (k++) * 15 * MIN).toISOString() } // one after another, never overlapping
      : { id: g.ext, title: g.title, playtime_minutes: g.entry }));
    const life0 = ok(await app.api('/api/v1/stats/lifetime'), 'life');
    const r = await timed(`/api/v1/accounts/${accId}/report`, { method: 'POST', body: { games } });
    const res = fast(r, 'follow-up report');
    assert.equal(res.initial, false);
    assert.equal(res.games_seen, GAMES / 4);
    assert.equal(res.minutes_added, 1000, 'exactly 100 x 10 new minutes');
    const life = ok(await app.api('/api/v1/stats/lifetime'), 'life');
    assert.equal(life.total_minutes, life0.total_minutes + 1000);
    assert.equal(life.tracked_minutes, life0.tracked_minutes + 1000);
    for (const id of [...bumped].slice(0, 5)) assert.equal(ok(await app.api(`/api/v1/games/${id}`), 'game').minutes, exp.byGame.get(id).minutes + 10);
    const untouched = mine[200][0];
    assert.equal(ok(await app.api(`/api/v1/games/${untouched}`), 'game').minutes, exp.byGame.get(untouched).minutes, 'unchanged games stay unchanged');
    for (const id of bumped) { exp.byGame.get(id).minutes += 10; exp.byGame.get(id).entry += 10; }
    exp.total += 1000;
    exp.sessions += res.sessions_created;
    assert.ok(res.sessions_created >= 1 && res.sessions_created <= 100);
    H.assertHealthy(assert, app.db, 'after follow-up report');
  });

  test('the full export streams every game and session', async () => {
    const t = Date.now();
    const r = await app.api('/api/v1/export');
    const ms = Date.now() - t;
    assert.equal(r.status, 200);
    assert.ok(ms < LIMIT * 4, `export took ${ms}ms`);
    const doc = JSON.parse(r.text);
    const entries = app.db.prepare('SELECT COUNT(*) n FROM entries').get().n; // one record per entry (the manual session above added one)
    assert.equal(entries, GAMES + 1);
    assert.equal(doc.games.length, entries);
    assert.equal(doc.games.reduce((a, g) => a + g.sessions.length, 0), exp.sessions);
    assert.equal(doc.games.reduce((a, g) => a + g.playtime_minutes, 0), exp.total);
  });

  test('an export taken while the library changes lists every game exactly once', async () => {
    // a slow client: the server has to wait for the socket while other requests change data
    const ids = [...exp.byGame.entries()].sort((a, b) => a[1].title.toLowerCase().localeCompare(b[1].title.toLowerCase())).slice(0, 5).map(([id]) => id);
    const body = await new Promise((resolve, reject) => {
      const req = http.get(`${app.base}/api/v1/export`, (res) => {
        res.pause();
        const chunks = [];
        (async () => {
          await H.sleep(300); // let the first chunks go out, then change data the export already passed
          for (const [i, id] of ids.entries()) ok(await app.api(`/api/v1/games/${id}`, { method: 'PATCH', body: { title: `zzzz renamed during export ${i}` } }), 'rename');
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString()));
          res.resume();
        })().catch(reject);
      });
      req.on('error', reject);
    });
    assert.ok(body.length > 16 * 1024 * 1024, `export is far larger than socket buffers (${body.length} bytes), so the renames happened mid-download`);
    const doc = JSON.parse(body);
    const entries = app.db.prepare('SELECT COUNT(*) n FROM entries').get().n;
    assert.equal(doc.games.length, entries, 'one record per entry - none duplicated, none lost');
    assert.equal(doc.games.reduce((a, g) => a + g.playtime_minutes, 0), exp.total, 'export total equals the library total');
  });

  // a client that reads the export slowly (a phone on a bad connection)
  const slowExport = () => new Promise((resolve, reject) => {
    const req = http.get(`${app.base}/api/v1/export`, (res) => { res.pause(); resolve({ req, res }); });
    req.on('error', reject);
  });
  const finish = (res) => new Promise((resolve) => { const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve(Buffer.concat(c))); res.resume(); });
  const isSqlite = (r) => r.status === 200 && r.text.startsWith('SQLite format 3');

  test('a backup requested while an export is still downloading succeeds', async () => {
    const { res } = await slowExport();
    await H.sleep(200);
    const b = await app.api('/api/v1/backup');
    const body = await finish(res);
    assert.ok(body.length > 16 * 1024 * 1024, 'the export was still in progress during the backup');
    assert.equal(b.status, 200, `backup during export: ${b.status} ${b.text.slice(0, 120)}`);
    assert.ok(isSqlite(b));
  });

  test('once the export finishes, backups work again', async () => {
    const { res } = await slowExport();
    await finish(res);
    const b = await app.api('/api/v1/backup');
    assert.ok(isSqlite(b), `backup after export: ${b.status} ${b.text.slice(0, 120)}`);
  });

  test('reopening the big database is fast and identical; a TZ change rebuilds every bucket once', async () => {
    const before = {
      all: ok(await app.api('/api/v1/stats?range=all&estimates=exclude'), 'all'),
      year: ok(await app.api('/api/v1/stats?range=year:2025&estimates=exclude'), 'year'), // the seeded year: 08:00-22:00 UTC only
      heat: ok(await app.api('/api/v1/stats/heatmap?year=2025&estimates=exclude'), 'heat'),
    };
    delete before.all.range.to;
    app.close();
    let t = Date.now();
    app = await H.startApp(createApp, { dbFile });
    const reopenMs = Date.now() - t;
    const again = ok(await app.api('/api/v1/stats?range=all&estimates=exclude'), 'all');
    delete again.range.to;
    assert.deepEqual(again, before.all, 'same numbers after reopening');
    assert.ok(reopenMs < LIMIT, `reopen took ${reopenMs}ms (first start with the index build: ${startMs}ms)`);
    // the container's TZ changes (UTC -> New York): hours move, totals do not
    assert.deepEqual(before.year.hours.slice(0, 8), [0, 0, 0, 0, 0, 0, 0, 0], 'UTC: all 2025 play is between 08:00 and 22:00');
    app.close();
    process.env.TZ = 'America/New_York';
    try {
      t = Date.now();
      app = await H.startApp(createApp, { dbFile });
      const tzMs = Date.now() - t;
      assert.ok(tzMs < 30_000, `rebuild after the TZ change took ${tzMs}ms`);
      const nyAll = ok(await app.api('/api/v1/stats?range=all&estimates=exclude'), 'ny all');
      assert.equal(nyAll.total_minutes, before.all.total_minutes, 'all-time total unchanged');
      assert.equal(nyAll.sessions, before.all.sessions);
      const ny = ok(await app.api('/api/v1/stats?range=year:2025&estimates=exclude'), 'ny');
      assert.equal(ny.total_minutes, before.year.total_minutes);
      assert.equal(ny.hours.reduce((a, b) => a + b, 0), before.year.hours.reduce((a, b) => a + b, 0), 'hours still add up');
      assert.ok(ny.hours.slice(3, 8).some((m) => m > 0), 'play now shows in the early local hours (03:00-07:59 EST/EDT)');
      assert.deepEqual(ny.hours.slice(19, 24), [0, 0, 0, 0, 0], 'nothing after 19:00 local (22:00 UTC)');
      const heat = ok(await app.api('/api/v1/stats/heatmap?year=2025&estimates=exclude'), 'heat');
      assert.equal(Object.values(heat.days).reduce((a, b) => a + b, 0), Object.values(before.heat.days).reduce((a, b) => a + b, 0));
    } finally {
      process.env.TZ = 'UTC';
    }
  });

  // must stay last in this block: the bug it checks leaves this app instance broken
  test('a cancelled export download releases the database (backups keep working, the WAL stays bounded)', async () => {
    const { req } = await slowExport();
    await H.sleep(300);
    req.destroy(); // the user cancels the download
    await H.sleep(300);
    const gid = [...exp.byGame.keys()][7];
    const wal0 = fs.statSync(`${dbFile}-wal`).size;
    for (let i = 0; i < 300; i++) ok(await app.api('/api/v1/sessions', { method: 'POST', body: { game_id: gid, minutes: 5, started_at: new Date(Date.UTC(2025, 7, 1) + i * HOUR).toISOString() } }), 'write');
    const grown = fs.statSync(`${dbFile}-wal`).size - wal0; // a healthy WAL is reused from the start after each checkpoint
    const b = await app.api('/api/v1/backup');
    assert.ok(isSqlite(b), `backup after a cancelled export: ${b.status} ${b.text.slice(0, 120)}`);
    assert.ok(grown < 8 * 1024 * 1024, `WAL grew by ${(grown / 1048576).toFixed(1)} MB from 300 small writes`);
  });
});
