// Test harness for test/suite/server-db.test.js (server, persistence and scale).
// Everything here is written for this suite only: child-process servers, raw HTTP,
// in-process apps, a Steam API mock and direct database checks.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SERVER = path.join(ROOT, 'src', 'server.js');
export const PUBLIC = path.join(ROOT, 'public');

export const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

const tmpRoots = [];
export function tmpDir(prefix = 'pt-server-db-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
export function cleanupTmp() {
  for (const d of tmpRoots.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
}

/** A port that is free right now (on all interfaces). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '0.0.0.0', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Hold a port (like another container on the host network would). */
export function holdPort(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer((sock) => sock.destroy());
    s.on('error', reject);
    s.listen(port, '0.0.0.0', () => resolve(s));
  });
}

// the app's own settings (under both names: a stray VESTIGO_X would beat a test's PLAYTRACKER_X)
const STRIP = /^(PORT$|VESTIGO_|PLAYTRACKER_|TZ$|PUID$|PGID$|LOG_|NODE_ENV$|NODE_TEST_CONTEXT$|NODE_OPTIONS$)/;
export function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) env[k] = v;
  return { ...env, ...extra };
}

/**
 * Start `node src/server.js` as a child process. Resolves once it logs that it is ready
 * (the log line names the port it actually listens on) and answers /api/v1/health.
 */
export async function startServer({ env = {}, cwd, readyTimeout = 20_000 } = {}) {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    cwd: cwd || os.tmpdir(), env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const srv = { proc, output: '', port: null, exited: null, exit: null };
  srv.exited = new Promise((resolve) => proc.on('exit', (code, signal) => { srv.exit = { code, signal }; resolve(srv.exit); }));
  const onData = (d) => { srv.output += d; };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  srv.port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`server not ready after ${readyTimeout}ms:\n${srv.output}`)); }, readyTimeout);
    const check = () => {
      const m = /ready on port (\d+)/i.exec(srv.output);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    proc.stdout.on('data', check);
    proc.stderr.on('data', check);
    srv.exited.then((e) => { clearTimeout(timer); reject(Object.assign(new Error(`server exited (${e.code ?? e.signal}) before it was ready:\n${srv.output}`), { exit: e, output: srv.output })); });
  });
  srv.base = `http://127.0.0.1:${srv.port}`;
  // listening is logged from the listen callback; make sure HTTP really answers
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${srv.base}/api/v1/health`); if (r.ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  srv.api = (p, o) => api(srv.base, p, o);
  srv.stop = (signal = 'SIGTERM', timeout = 8000) => stopProc(srv, signal, timeout);
  return srv;
}

/** Run the server expecting it to fail to start; resolves with its exit and output. */
export async function runToExit({ env = {}, cwd, timeout = 15_000 } = {}) {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    cwd: cwd || os.tmpdir(), env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (d) => { output += d; });
  proc.stderr.on('data', (d) => { output += d; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve({ code: null, signal: 'TIMEOUT', output, timedOut: true }); }, timeout);
    proc.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output, timedOut: false }); });
  });
}

async function stopProc(srv, signal, timeout) {
  if (srv.exit) return { ...srv.exit, ms: 0 };
  const t0 = Date.now();
  srv.proc.kill(signal);
  const res = await Promise.race([srv.exited, new Promise((r) => setTimeout(() => r(null), timeout))]);
  if (!res) {
    srv.proc.kill('SIGKILL');
    await srv.exited;
    return { code: null, signal: 'TIMEOUT', ms: Date.now() - t0 };
  }
  return { ...res, ms: Date.now() - t0 };
}

/** JSON-ish fetch helper (fetch transparently decodes gzip/br). */
export async function api(base, p, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (typeof body === 'string' || body instanceof Uint8Array) init.body = body;
    else { init.body = JSON.stringify(body); if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(base + p, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, json, text };
}

/** Raw HTTP request without any client-side decoding or path normalisation. */
export function rawRequest(port, rawPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body != null && h['Content-Length'] == null) h['Content-Length'] = Buffer.byteLength(body);
    // a fresh connection per request: no keep-alive reuse between tests
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ---------- in-process app ----------
export async function startApp(createApp, opts = {}) {
  const app = createApp({ dbFile: ':memory:', password: '', log: quietLog, scheduler: false, ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, db: app.app.db, base, api: (p, o) => api(base, p, o) };
}

// ---------- database checks ----------
/** Every structural and accounting invariant a healthy database must satisfy. */
export function dbHealth(db) {
  return {
    integrity: db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]),
    foreign_keys: db.prepare('PRAGMA foreign_key_check').all(),
    // the minutes of all sessions of an entry add up to its lifetime total
    mismatched_entries: db.prepare(`SELECT e.id, e.title, e.playtime_min, COALESCE(SUM(s.minutes), 0) session_minutes
      FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min`).all(),
    orphan_entries: db.prepare('SELECT id FROM entries WHERE game_id NOT IN (SELECT id FROM games)').all(),
    orphan_sessions: db.prepare('SELECT id FROM sessions WHERE entry_id NOT IN (SELECT id FROM entries)').all(),
    negative: db.prepare('SELECT id FROM entries WHERE playtime_min < 0').all().concat(db.prepare('SELECT id FROM sessions WHERE minutes < 0').all()),
  };
}

export function assertHealthy(assert, db, label = '') {
  const h = dbHealth(db);
  assert.deepEqual(h.integrity, ['ok'], `${label} integrity_check`);
  assert.deepEqual(h.foreign_keys, [], `${label} foreign keys`);
  assert.deepEqual(h.mismatched_entries, [], `${label} session minutes must add up to each entry's total`);
  assert.deepEqual(h.orphan_entries, [], `${label} entries without a game`);
  assert.deepEqual(h.orphan_sessions, [], `${label} sessions without an entry`);
  assert.deepEqual(h.negative, [], `${label} negative minutes`);
}

/** Open a database file read-only for inspection (works while the server holds it, WAL). */
export function inspect(file, fn) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

export function schemaOf(db) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => ({ ...r }));
}

// ---------- Steam API mock (only api/store.steampowered.com; 127.0.0.1 passes through) ----------
export function installSteamMock({ games = () => [], delayMs = 0, persona = 'Tester' } = {}) {
  const realFetch = globalThis.fetch;
  const calls = { owned: 0, summaries: 0, other: 0, total: 0 };
  const state = { games, delayMs, gate: null };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init);
    calls.total++;
    if (url.hostname === 'api.steampowered.com') {
      if (url.pathname.includes('GetOwnedGames')) {
        calls.owned++;
        if (state.gate) await state.gate;
        if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
        const list = state.games();
        return json({ response: { game_count: list.length, games: list } });
      }
      if (url.pathname.includes('GetPlayerSummaries')) {
        calls.summaries++;
        return json({ response: { players: [{ steamid: url.searchParams.get('steamids'), personaname: persona, communityvisibilitystate: 3, timecreated: Math.floor(Date.UTC(2012, 0, 1) / 1000) }] } });
      }
      calls.other++;
      if (url.pathname.includes('GetPlayerAchievements')) return json({ playerstats: { error: 'Requested app has no stats', success: false } }, 400);
      if (url.pathname.includes('GetItems')) return json({ response: { store_items: [] } });
      return json({}, 404);
    }
    if (url.hostname === 'store.steampowered.com') { calls.other++; return json({}); }
    calls.other++;
    throw new TypeError(`fetch failed (no network in tests): ${url.hostname}`);
  };
  return {
    calls, state,
    /** Hold every GetOwnedGames reply until release() is called. */
    hold() { let release; state.gate = new Promise((r) => { release = r; }); return () => { state.gate = null; release(); }; },
    restore() { globalThis.fetch = realFetch; },
  };
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
