// Authentication & security suite (black-box through the HTTP API).
// Run: node --disable-warning=ExperimentalWarning --test test/suite/auth-security.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../src/logger.js';
import {
  startApp, call, cookiePair, cookieAttrs, rawHttp, rawSocket, setEnv, shiftClock,
  mockExternalFetch, jsonResponse, brokenEntries, leaksStack,
} from './helpers/auth-security-harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIL = 'http://evil.example';
const PASSWORD = 'correct horse battery';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// make sure ambient configuration cannot leak into these tests (under either name: VESTIGO_X wins over PLAYTRACKER_X)
const AMBIENT = ['PASSWORD', 'CORS_ORIGIN', 'SECURE_COOKIE', 'LOG_FILE'].flatMap((k) => [`VESTIGO_${k}`, `PLAYTRACKER_${k}`]);
const restoreAmbient = setEnv({ ...Object.fromEntries(AMBIENT.map((k) => [k, undefined])), LOG_REQUESTS: undefined });
after(() => restoreAmbient());

async function setPassword(s, password, { current, cookie, token } = {}) {
  return call(`${s.api}/auth/password`, { method: 'PUT', body: current === undefined ? { password } : { current, password }, cookie, token });
}
async function login(s, password, extra = {}) {
  return call(`${s.api}/auth/login`, { method: 'POST', body: { password }, ...extra });
}
async function countGames(s, auth = {}) {
  const r = await call(`${s.api}/games?limit=500`, auth);
  assert.equal(r.status, 200, r.text);
  return (r.json.items || r.json.games || r.json).length;
}
/** Row counts of every table that holds user data or credentials. */
function tableCounts(db) {
  const out = {};
  for (const t of ['games', 'entries', 'sessions', 'accounts', 'api_tokens', 'login_sessions', 'settings', 'dismissed_duplicates', 'snapshots', 'syncs']) {
    out[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  }
  out.settings_json = JSON.stringify(db.prepare('SELECT key, value FROM settings ORDER BY key').all());
  return out;
}

// ---------------------------------------------------------------------------------------------
describe('open mode (no password configured)', () => {
  let s;
  before(async () => { s = await startApp({ password: '' }); });
  after(() => s.close());

  test('auth status reports open access', async () => {
    const r = await call(`${s.api}/auth/status`);
    assert.equal(r.status, 200);
    assert.equal(r.json.auth_enabled, false);
    assert.equal(r.json.authenticated, true);
    assert.ok(r.json.password_source == null, 'no password source when open');
  });

  test('API reads and /metrics work without any credentials', async () => {
    for (const p of ['/games', '/settings', '/summary', '/tokens', '/stats', '/accounts']) {
      const r = await call(`${s.api}${p}`);
      assert.equal(r.status, 200, `${p}: ${r.text}`);
    }
    const m = await call(`${s.origin}/metrics`);
    assert.equal(m.status, 200);
    assert.match(m.text, /^vestigo_/m);
    assert.match(m.text, /^playtracker_/m, 'the old metric names are still published');
  });

  test('login without a configured password is a no-op and issues no session cookie', async () => {
    const r = await login(s, 'anything');
    assert.equal(r.status, 200);
    const c = r.setCookie ? cookieAttrs(r.setCookie) : null;
    assert.ok(!c || c.name !== 'pt_session' || c.value === '', 'no session minted in open mode');
    const st = await call(`${s.api}/auth/status`);
    assert.equal(st.json.auth_enabled, false, 'a login attempt never enables auth');
  });

  test('writes from scripts (no Origin) and from the app itself (same Origin) are allowed', async () => {
    const a = await call(`${s.api}/games`, { body: { title: 'No Origin Game' } });
    assert.equal(a.status, 200, a.text);
    const b = await call(`${s.api}/games`, { body: { title: 'Same Origin Game' }, origin: s.origin });
    assert.equal(b.status, 200, b.text);
  });

  test('cross-site writes are blocked (403) and change nothing', async () => {
    const before_ = await countGames(s);
    const theme = (await call(`${s.api}/settings`)).json.theme;
    const origins = [EVIL, 'null', `http://127.0.0.1:${s.port + 1}`, `http://127.0.0.1.evil.example:${s.port}`, 'garbage'];
    for (const origin of origins) {
      const g = await call(`${s.api}/games`, { body: { title: `Evil ${origin}` }, origin });
      assert.equal(g.status, 403, `POST from ${origin}`);
      const st = await call(`${s.api}/settings`, { method: 'PUT', body: { theme: theme === 'light' ? 'dark' : 'light' }, origin });
      assert.equal(st.status, 403, `PUT from ${origin}`);
      const d = await call(`${s.api}/games/1`, { method: 'DELETE', origin });
      assert.equal(d.status, 403, `DELETE from ${origin}`);
    }
    assert.equal(await countGames(s), before_, 'no game was created or deleted');
    assert.equal((await call(`${s.api}/settings`)).json.theme, theme, 'settings unchanged');
    assert.deepEqual(brokenEntries(s.db), []);
  });

  test('cross-site GETs are not granted a CORS read permission', async () => {
    const r = await call(`${s.api}/games`, { origin: EVIL });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), null, 'no ACAO header without VESTIGO_CORS_ORIGIN');
    const pre = await fetch(`${s.api}/games`, { method: 'OPTIONS', headers: { Origin: EVIL, 'Access-Control-Request-Method': 'POST' } });
    assert.ok(pre.status < 500);
    assert.equal(pre.headers.get('access-control-allow-origin'), null, 'preflight grants nothing');
  });

  test('a cross-site page cannot set a password (CSRF on PUT /auth/password) or log in', async () => {
    const x = await call(`${s.api}/auth/password`, { method: 'PUT', body: { password: 'attacker-chosen' }, origin: EVIL });
    assert.equal(x.status, 403);
    const st = await call(`${s.api}/auth/status`);
    assert.equal(st.json.auth_enabled, false, 'auth still disabled after the cross-site attempt');
    const l = await call(`${s.api}/auth/login`, { method: 'POST', body: { password: 'x' }, origin: EVIL });
    assert.equal(l.status, 403);
  });

  test('requests authenticated by an API token are exempt from the Origin check', async () => {
    const tok = await call(`${s.api}/tokens`, { body: { name: 'script' } });
    assert.equal(tok.status, 200);
    const r = await call(`${s.api}/games`, { body: { title: 'Token From Elsewhere' }, origin: EVIL, token: tok.json.token });
    assert.equal(r.status, 200, r.text);
    const r2 = await call(`${s.api}/games`, { body: { title: 'X-API-Key From Elsewhere' }, origin: EVIL, headers: { 'X-API-Key': tok.json.token } });
    assert.equal(r2.status, 200, r2.text);
  });

  test('an unrelated cookie with a malformed %-escape does not break the API', async () => {
    const r = await call(`${s.api}/games`, { cookie: 'tracking=50%off; theme=%E0%A4%A' });
    assert.equal(r.status, 200, `got ${r.status}`);
    const m = await call(`${s.origin}/metrics`, { cookie: 'x=%' });
    assert.equal(m.status, 200, `/metrics got ${m.status}`);
  });
});

// ---------------------------------------------------------------------------------------------
describe('settings-stored password lifecycle', () => {
  let s; let cookie;
  before(async () => { s = await startApp({ password: '' }); });
  after(() => s.close());

  test('passwords shorter than 6 characters are rejected; exactly 6 is accepted', async () => {
    for (const pw of ['1', '12345', '     ']) {
      const r = await setPassword(s, pw);
      assert.equal(r.status, 400, `"${pw}" -> ${r.status}`);
      assert.equal((await call(`${s.api}/auth/status`)).json.auth_enabled, false);
    }
    const ok = await setPassword(s, 'abcdef');
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.auth_enabled, true);
    cookie = cookiePair(ok.setCookie);
    assert.match(cookie, /^pt_session=.+/, 'the caller receives a session so it is not locked out');
  });

  test('setting a password locks the API; the caller\'s new session works', async () => {
    assert.equal((await call(`${s.api}/games`)).status, 401);
    assert.equal((await call(`${s.api}/games`, { cookie })).status, 200);
    const st = await call(`${s.api}/auth/status`);
    assert.deepEqual([st.json.auth_enabled, st.json.authenticated, st.json.password_source], [true, false, 'settings']);
    const st2 = await call(`${s.api}/auth/status`, { cookie });
    assert.equal(st2.json.authenticated, true);
    assert.equal(st2.json.via, 'cookie');
  });

  test('changing the password requires the correct current password', async () => {
    const wrong = await setPassword(s, PASSWORD, { current: 'not-it', cookie });
    assert.equal(wrong.status, 401);
    const none = await setPassword(s, PASSWORD, { cookie });
    assert.equal(none.status, 401, 'missing current password');
    assert.equal((await login(s, 'abcdef')).status, 200, 'old password still valid after rejected changes');
    const ok = await setPassword(s, PASSWORD, { current: 'abcdef', cookie });
    assert.equal(ok.status, 200, ok.text);
    const fresh = cookiePair(ok.setCookie);
    assert.equal((await call(`${s.api}/games`, { cookie })).status, 401, 'sessions from before the change are signed out');
    assert.equal((await call(`${s.api}/games`, { cookie: fresh })).status, 200, 'the changer gets a new session');
    assert.equal((await login(s, 'abcdef')).status, 401, 'old password no longer works');
    cookie = fresh;
  });

  test('the password is stored only as a salted hash and never returned by the API', async () => {
    const rows = s.db.prepare('SELECT key, value FROM settings').all();
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes(PASSWORD), 'plaintext password not stored');
    const hashRow = rows.find((r) => r.key === 'password_hash');
    assert.ok(hashRow && hashRow.value.length > 20, 'a hash is stored');
    assert.ok(!hashRow.value.includes(sha256(PASSWORD)), 'not an unsalted sha256');
    const st = await call(`${s.api}/settings`, { cookie });
    assert.equal(st.status, 200);
    assert.ok(!('password_hash' in st.json), 'password_hash not in GET /settings');
    assert.ok(!st.text.includes(JSON.parse(hashRow.value)), 'hash value not in GET /settings');
    const put = await call(`${s.api}/settings`, { method: 'PUT', body: { theme: 'light' }, cookie });
    assert.equal(put.status, 200);
    assert.ok(!('password_hash' in put.json), 'password_hash not in PUT /settings response');
    for (const p of ['/system', '/export', '/accounts']) {
      const r = await call(`${s.api}${p}`, { cookie });
      assert.ok(!r.text.includes(JSON.parse(hashRow.value)), `hash not in ${p}`);
    }
  });

  test('PUT /settings cannot overwrite or clear the password hash', async () => {
    const before_ = s.db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get().value;
    const r = await call(`${s.api}/settings`, { method: 'PUT', body: { password_hash: '', password: '', theme: 'dark' }, cookie });
    assert.ok(r.status === 200 || r.status === 400, `status ${r.status}`);
    assert.equal(s.db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get().value, before_);
    assert.equal((await call(`${s.api}/games`)).status, 401, 'still protected');
    assert.equal((await login(s, PASSWORD)).status, 200);
  });

  test('wrong password is 401; the right one sets an HttpOnly, SameSite, path-wide session cookie', async () => {
    const bad = await login(s, 'wrong password');
    assert.equal(bad.status, 401);
    const bc = bad.setCookie ? cookieAttrs(bad.setCookie) : null;
    assert.ok(!bc || bc.value === '', 'no session on failure');
    const ok = await login(s, PASSWORD);
    assert.equal(ok.status, 200);
    const c = cookieAttrs(ok.setCookie);
    assert.equal(c.name, 'pt_session');
    assert.ok(c.value.length >= 32, 'session id has enough entropy');
    assert.equal(c.attrs.httponly, true, 'HttpOnly');
    assert.match(String(c.attrs.samesite), /^(lax|strict)$/i, 'SameSite Lax/Strict');
    assert.equal(c.attrs.path, '/');
    assert.ok(Number(c.attrs['max-age']) > 0, 'persistent session with a Max-Age');
    assert.ok(!c.attrs.secure, 'no Secure flag unless VESTIGO_SECURE_COOKIE=true (plain HTTP would drop it)');
    assert.equal((await call(`${s.api}/games`, { cookie: `${c.name}=${c.value}` })).status, 200);
    // the session id is stored hashed
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM login_sessions WHERE token_hash = ?').get(c.value).n, 0, 'raw session id not stored');
  });

  test('non-string, empty or oversized login passwords are rejected cleanly', async () => {
    for (const body of [{}, { password: null }, { password: 12345678 }, { password: [PASSWORD] }, { password: { toString: PASSWORD } }, { password: 'x'.repeat(5000) }, { password: `${PASSWORD} ` }]) {
      const r = await call(`${s.api}/auth/login`, { method: 'POST', body });
      assert.equal(r.status, 401, `${JSON.stringify(body).slice(0, 40)} -> ${r.status}`);
      assert.equal(r.setCookie, null);
      assert.ok(!leaksStack(r.text));
      assert.equal((await login(s, PASSWORD)).status, 200); // keep the failure counter low
    }
  });

  test('session fixation: login ignores a client-supplied session id and issues a new one', async () => {
    const chosen = 'attacker-chosen-session-id-0123456789abcdef';
    const r = await login(s, PASSWORD, { cookie: `pt_session=${chosen}` });
    assert.equal(r.status, 200);
    const c = cookieAttrs(r.setCookie);
    assert.notEqual(c.value, chosen);
    assert.equal((await call(`${s.api}/games`, { cookie: `pt_session=${chosen}` })).status, 401);
    const r2 = await login(s, PASSWORD);
    assert.notEqual(cookieAttrs(r2.setCookie).value, c.value, 'every login gets its own session');
    cookie = `pt_session=${c.value}`;
  });

  test('forged, empty, truncated or hash-valued session cookies are rejected', async () => {
    const value = cookie.split('=')[1];
    const forged = ['', 'x', value.slice(0, -1), `${value}x`, value.toUpperCase() === value ? value.toLowerCase() : value.toUpperCase(), sha256(value), 'null', 'undefined'];
    for (const v of forged) {
      const r = await call(`${s.api}/games`, { cookie: `pt_session=${v}` });
      assert.equal(r.status, 401, `pt_session=${v.slice(0, 12)}…`);
    }
    // a different cookie name carrying a valid id is not a session
    assert.equal((await call(`${s.api}/games`, { cookie: `session=${value}` })).status, 401);
    assert.equal((await call(`${s.api}/games`, { cookie })).status, 200);
  });

  test('logout clears the cookie and invalidates the session server-side', async () => {
    const r = await call(`${s.api}/auth/logout`, { method: 'POST', cookie });
    assert.equal(r.status, 200);
    const c = cookieAttrs(r.setCookie);
    assert.equal(c.name, 'pt_session');
    assert.ok(c.value === '' && Number(c.attrs['max-age']) === 0, 'cookie cleared');
    assert.equal((await call(`${s.api}/games`, { cookie })).status, 401, 'replaying the old cookie fails');
    // logout without a session is harmless
    assert.equal((await call(`${s.api}/auth/logout`, { method: 'POST' })).status, 200);
  });

  test('a session is valid until its Max-Age and rejected after it', async () => {
    const r = await login(s, PASSWORD);
    const c = cookieAttrs(r.setCookie);
    const maxAgeMs = Number(c.attrs['max-age']) * 1000;
    const ck = `pt_session=${c.value}`;
    let restore = shiftClock(maxAgeMs - 60_000);
    try { assert.equal((await call(`${s.api}/games`, { cookie: ck })).status, 200, 'valid 1 min before expiry'); } finally { restore(); }
    restore = shiftClock(maxAgeMs + 60_000);
    try { assert.equal((await call(`${s.api}/games`, { cookie: ck })).status, 401, 'rejected 1 min after expiry'); } finally { restore(); }
  });

  test('removing the password needs the current password, even for a signed-in caller', async () => {
    const r = await login(s, PASSWORD);
    const ck = cookiePair(r.setCookie);
    const tok = (await call(`${s.api}/tokens`, { body: { name: 'pw-test' }, cookie: ck })).json.token;
    assert.equal((await setPassword(s, '', { cookie: ck })).status, 401, 'cookie alone cannot remove it');
    assert.equal((await setPassword(s, '', { token: tok })).status, 401, 'token alone cannot remove it');
    assert.equal((await setPassword(s, '', { current: 'wrong', cookie: ck })).status, 401);
    assert.equal((await call(`${s.api}/auth/status`)).json.auth_enabled, true);
    const ok = await setPassword(s, '', { current: PASSWORD, cookie: ck });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.auth_enabled, false);
    assert.equal((await call(`${s.api}/games`)).status, 200, 'open again');
  });

  for (const name of ['VESTIGO_SECURE_COOKIE', 'PLAYTRACKER_SECURE_COOKIE']) {
    test(`Secure cookie flag is set when ${name}=true`, async () => {
      const restore = setEnv({ [name]: 'true' });
      let t;
      try { t = await startApp({ password: PASSWORD }); } finally { restore(); }
      try {
        const r = await login(t, PASSWORD);
        assert.equal(r.status, 200);
        assert.equal(cookieAttrs(r.setCookie).attrs.secure, true);
        assert.equal(cookieAttrs(r.setCookie).attrs.httponly, true);
        assert.equal(cookieAttrs(r.setCookie).name, 'pt_session', 'the login cookie keeps its name: nobody is signed out by an update');
      } finally { t.close(); }
    });
  }

  test('a non-string password value is rejected instead of being coerced', async () => {
    const t = await startApp({ password: '' });
    try {
      const r = await setPassword(t, { secret: 'hunter22' });
      const st = await call(`${t.api}/auth/status`);
      assert.equal(r.status, 400, `got ${r.status} ${r.text}`);
      assert.equal(st.json.auth_enabled, false, 'auth must not be enabled with a coerced password');
    } finally { t.close(); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('VESTIGO_PASSWORD / PLAYTRACKER_PASSWORD from the environment', () => {
  let dir; let dbFile; let token;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-auth-sec-'));
    dbFile = path.join(dir, 'pt.db');
    const s1 = await startApp({ dbFile, password: '' });
    try {
      const r = await setPassword(s1, 'settings-pass1');
      assert.equal(r.status, 200);
      token = (await call(`${s1.api}/tokens`, { body: { name: 'persist' }, cookie: cookiePair(r.setCookie) })).json.token;
      assert.ok(token);
    } finally { s1.close(); }
  });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('the environment password takes precedence and cannot be changed or removed through the API', async () => {
    const restore = setEnv({ VESTIGO_PASSWORD: 'env-secret-9' });
    let s;
    try { s = await startApp({ dbFile }); } finally { restore(); } // createApp reads VESTIGO_PASSWORD
    try {
      const st = await call(`${s.api}/auth/status`);
      assert.equal(st.json.auth_enabled, true);
      assert.equal(st.json.password_source, 'env');
      assert.equal((await call(`${s.api}/games`)).status, 401);
      assert.equal((await login(s, 'settings-pass1')).status, 401, 'settings password is overridden by the env one');
      const ok = await login(s, 'env-secret-9');
      assert.equal(ok.status, 200);
      const ck = cookiePair(ok.setCookie);
      assert.equal((await call(`${s.api}/games`, { cookie: ck })).status, 200);
      assert.equal((await call(`${s.api}/games`, { token })).status, 200, 'tokens survive a restart');
      const ch = await setPassword(s, 'another-pass', { current: 'env-secret-9', cookie: ck });
      assert.equal(ch.status, 400, 'env-managed password cannot be changed via API');
      assert.match(ch.json.error, /VESTIGO_PASSWORD/, 'the error names the variable that sets it');
      const rm = await setPassword(s, '', { current: 'env-secret-9', cookie: ck });
      assert.equal(rm.status, 400, 'env-managed password cannot be removed via API');
      assert.equal((await call(`${s.api}/auth/status`)).json.auth_enabled, true);
      assert.equal((await login(s, 'another-pass')).status, 401);
      assert.equal((await login(s, 'env-secret-9')).status, 200);
      const settings = await call(`${s.api}/settings`, { cookie: ck });
      assert.ok(!settings.text.includes('env-secret-9'), 'env password not exposed');
      assert.ok(!('password_hash' in settings.json));
      const sys = await call(`${s.api}/system`, { cookie: ck });
      assert.ok(!sys.text.includes('env-secret-9'), 'env password not in diagnostics');
    } finally { s.close(); }
  });

  /** Start on the shared database with these variables set (createApp reads them), then restore. */
  async function withEnv(vars) {
    const restore = setEnv(vars);
    try { return await startApp({ dbFile }); } finally { restore(); }
  }

  test('an existing install with only PLAYTRACKER_PASSWORD still requires that password', async () => {
    const s = await withEnv({ PLAYTRACKER_PASSWORD: 'legacy-secret-1' });
    try {
      const st = await call(`${s.api}/auth/status`);
      assert.equal(st.json.auth_enabled, true);
      assert.equal(st.json.authenticated, false);
      assert.equal(st.json.password_source, 'env');
      assert.ok(!('password_env' in st.json), 'which variable sets the password is not told to anonymous callers');
      assert.equal((await call(`${s.api}/games`)).status, 401);
      assert.equal((await login(s, 'settings-pass1')).status, 401);
      const ok = await login(s, 'legacy-secret-1');
      assert.equal(ok.status, 200);
      const ck = cookiePair(ok.setCookie);
      assert.equal((await call(`${s.api}/games`, { cookie: ck })).status, 200);
      assert.equal((await call(`${s.api}/auth/status`, { cookie: ck })).json.password_env, 'PLAYTRACKER_PASSWORD');
      assert.equal((await call(`${s.api}/auth/status`, { token })).json.password_env, 'PLAYTRACKER_PASSWORD');
      const ch = await setPassword(s, 'another-pass', { current: 'legacy-secret-1', cookie: ck });
      assert.equal(ch.status, 400);
      assert.match(ch.json.error, /PLAYTRACKER_PASSWORD/, 'the error names the variable actually in use');
    } finally { s.close(); }
  });

  test('with both names set, VESTIGO_PASSWORD wins', async () => {
    const s = await withEnv({ VESTIGO_PASSWORD: 'new-name-secret', PLAYTRACKER_PASSWORD: 'old-name-secret' });
    try {
      assert.equal((await login(s, 'old-name-secret')).status, 401);
      const ok = await login(s, 'new-name-secret');
      assert.equal(ok.status, 200);
      assert.equal((await call(`${s.api}/auth/status`, { cookie: cookiePair(ok.setCookie) })).json.password_env, 'VESTIGO_PASSWORD');
    } finally { s.close(); }
  });

  test('an empty VESTIGO_PASSWORD (Unraid passes empty fields) falls back to PLAYTRACKER_PASSWORD', async () => {
    const s = await withEnv({ VESTIGO_PASSWORD: '', PLAYTRACKER_PASSWORD: 'x' });
    try {
      assert.equal((await call(`${s.api}/auth/status`)).json.password_source, 'env');
      assert.equal((await call(`${s.api}/games`)).status, 401, 'not opened up by the empty variable');
      assert.equal((await login(s, '')).status, 401);
      const ok = await login(s, 'x');
      assert.equal(ok.status, 200);
      assert.equal((await call(`${s.api}/auth/status`, { cookie: cookiePair(ok.setCookie) })).json.password_env, 'PLAYTRACKER_PASSWORD');
    } finally { s.close(); }
  });

  test('empty values under both names leave the stored settings password in charge', async () => {
    const s = await withEnv({ VESTIGO_PASSWORD: '', PLAYTRACKER_PASSWORD: '' });
    try {
      assert.equal((await call(`${s.api}/auth/status`)).json.password_source, 'settings');
      assert.equal((await call(`${s.api}/games`)).status, 401);
      const ok = await login(s, 'settings-pass1');
      assert.equal(ok.status, 200);
      assert.equal((await call(`${s.api}/auth/status`, { cookie: cookiePair(ok.setCookie) })).json.password_env, null);
    } finally { s.close(); }
  });

  test('without the env var, the stored settings password still protects the data after a restart', async () => {
    const s = await startApp({ dbFile, password: '' });
    try {
      const st = await call(`${s.api}/auth/status`);
      assert.equal(st.json.auth_enabled, true);
      assert.equal(st.json.password_source, 'settings');
      assert.equal((await call(`${s.api}/games`)).status, 401);
      assert.equal((await login(s, 'env-secret-9')).status, 401);
      assert.equal((await login(s, 'settings-pass1')).status, 200);
      assert.equal((await call(`${s.api}/games`, { token })).status, 200);
    } finally { s.close(); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('API tokens', () => {
  let s; let cookie; let t1;
  before(async () => {
    s = await startApp({ password: '' });
    cookie = cookiePair((await setPassword(s, PASSWORD)).setCookie);
  });
  after(() => s.close());

  test('creating or listing tokens requires authentication', async () => {
    assert.equal((await call(`${s.api}/tokens`, { body: { name: 'anon' } })).status, 401);
    assert.equal((await call(`${s.api}/tokens`)).status, 401);
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM api_tokens').get().n, 0);
  });

  test('a new token is shown once; listings never contain it or its hash', async () => {
    const r = await call(`${s.api}/tokens`, { body: { name: 'ci' }, cookie });
    assert.equal(r.status, 200, r.text);
    t1 = r.json;
    assert.match(t1.token, /^vg_[A-Za-z0-9_-]{20,}$/);
    assert.ok(Number.isInteger(t1.id));
    const list = await call(`${s.api}/tokens`, { cookie });
    assert.equal(list.status, 200);
    const item = list.json.find((x) => x.id === t1.id);
    assert.ok(item, 'listed');
    assert.equal(item.name, 'ci');
    assert.ok(item.created_at > 0);
    assert.equal(item.last_used_at ?? null, null, 'never used yet');
    assert.ok(typeof item.prefix === 'string' && t1.token.startsWith(item.prefix) && item.prefix.length <= 12, 'short identifying prefix only');
    assert.ok(!list.text.includes(t1.token), 'full token not listed');
    assert.ok(!list.text.includes(sha256(t1.token)), 'hash not listed');
    for (const k of Object.keys(item)) assert.ok(!/hash|secret/.test(k) && k !== 'token', `field ${k}`);
    // stored hashed
    const rows = JSON.stringify(s.db.prepare('SELECT * FROM api_tokens').all());
    assert.ok(!rows.includes(t1.token), 'raw token not stored');
  });

  test('a token authenticates via Authorization: Bearer (any case), X-API-Key and ?api_key', async () => {
    const variants = [
      { headers: { Authorization: `Bearer ${t1.token}` } },
      { headers: { Authorization: `bearer ${t1.token}` } },
      { headers: { 'X-API-Key': t1.token } },
    ];
    for (const v of variants) assert.equal((await call(`${s.api}/games`, v)).status, 200, JSON.stringify(v.headers));
    assert.equal((await call(`${s.api}/games?api_key=${encodeURIComponent(t1.token)}`)).status, 200);
    const st = await call(`${s.api}/auth/status`, { token: t1.token });
    assert.equal(st.json.authenticated, true);
    assert.equal(st.json.via, 'token');
  });

  test('a pt_ token minted by PlayTracker (stored the old way) still authenticates and can be revoked', async () => {
    const legacy = `pt_${crypto.randomBytes(24).toString('base64url')}`;
    const id = Number(s.db.prepare('INSERT INTO api_tokens(name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?)').run('Home Assistant', sha256(legacy), legacy.slice(0, 7), Date.now()).lastInsertRowid);
    for (const v of [{ token: legacy }, { headers: { 'X-API-Key': legacy } }]) assert.equal((await call(`${s.api}/games`, v)).status, 200, JSON.stringify(v));
    assert.equal((await call(`${s.api}/games?api_key=${encodeURIComponent(legacy)}`)).status, 200);
    assert.equal((await call(`${s.origin}/metrics`, { token: legacy })).status, 200);
    const st = await call(`${s.api}/auth/status`, { token: legacy });
    assert.equal(st.json.authenticated, true);
    assert.equal(st.json.via, 'token');
    const item = (await call(`${s.api}/tokens`, { cookie })).json.find((x) => x.id === id);
    assert.equal(item.prefix, legacy.slice(0, 7), 'listed with its own pt_ prefix');
    assert.ok(item.last_used_at > 0, 'use is recorded');
    assert.equal((await call(`${s.api}/games`, { token: `vg_${legacy.slice(3)}` })).status, 401, 'the prefix is part of the secret');
    assert.equal((await call(`${s.api}/tokens/${id}`, { method: 'DELETE', cookie })).status, 200);
    assert.equal((await call(`${s.api}/games`, { token: legacy })).status, 401, 'revoked');
  });

  test('last_used_at is recorded when a token is used', async () => {
    const t = await call(`${s.api}/tokens`, { body: { name: 'usage' }, cookie });
    const before_ = Date.now();
    assert.equal((await call(`${s.api}/summary`, { token: t.json.token })).status, 200);
    const after_ = Date.now();
    const item = (await call(`${s.api}/tokens`, { cookie })).json.find((x) => x.id === t.json.id);
    assert.ok(item.last_used_at >= before_ - 1000 && item.last_used_at <= after_ + 1000, `last_used_at=${item.last_used_at}`);
  });

  test('wrong, truncated, padded, prefix-only or hash-valued tokens are rejected', async () => {
    const bad = [t1.token.slice(0, -1), `${t1.token}x`, t1.token.slice(0, 7), 'vg_', 'pt_', `pt_${t1.token.slice(3)}`, sha256(t1.token), t1.token.toUpperCase(), 'Bearer'];
    for (const b of bad) {
      assert.equal((await call(`${s.api}/games`, { token: b })).status, 401, `Bearer ${b.slice(0, 10)}`);
      assert.equal((await call(`${s.api}/games`, { headers: { 'X-API-Key': b } })).status, 401);
      assert.equal((await call(`${s.api}/games?api_key=${encodeURIComponent(b)}`)).status, 401);
    }
    assert.equal((await call(`${s.api}/games`, { headers: { Authorization: `Basic ${Buffer.from(`x:${PASSWORD}`).toString('base64')}` } })).status, 401, 'Basic auth with the password is not a back door');
  });

  test('revoking one token stops it immediately and leaves the others working', async () => {
    const a = (await call(`${s.api}/tokens`, { body: { name: 'a' }, cookie })).json;
    const b = (await call(`${s.api}/tokens`, { body: { name: 'b' }, cookie })).json;
    assert.notEqual(a.token, b.token);
    assert.equal((await call(`${s.api}/games`, { token: a.token })).status, 200);
    const del = await call(`${s.api}/tokens/${a.id}`, { method: 'DELETE', cookie });
    assert.equal(del.status, 200);
    assert.equal((await call(`${s.api}/games`, { token: a.token })).status, 401, 'revoked token rejected');
    assert.equal((await call(`${s.api}/games?api_key=${a.token}`)).status, 401);
    assert.equal((await call(`${s.api}/games`, { token: b.token })).status, 200, 'other token unaffected');
    assert.ok(!(await call(`${s.api}/tokens`, { cookie })).json.some((x) => x.id === a.id), 'no longer listed');
  });

  test('revoking needs authentication; unknown or malformed ids are harmless', async () => {
    const n = s.db.prepare('SELECT COUNT(*) n FROM api_tokens').get().n;
    assert.equal((await call(`${s.api}/tokens/${t1.id}`, { method: 'DELETE' })).status, 401);
    for (const id of ['999999', 'abc', '-1', '0']) {
      const r = await call(`${s.api}/tokens/${id}`, { method: 'DELETE', cookie });
      assert.ok(r.status < 500, `DELETE /tokens/${id} -> ${r.status}`);
    }
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM api_tokens').get().n, n);
    assert.equal((await call(`${s.api}/games`, { token: t1.token })).status, 200);
  });

  test('a token created without a name still works and gets a readable name', async () => {
    const r = await call(`${s.api}/tokens`, { body: {}, cookie });
    assert.equal(r.status, 200);
    const item = (await call(`${s.api}/tokens`, { cookie })).json.find((x) => x.id === r.json.id);
    assert.ok(typeof item.name === 'string' && item.name.length > 0);
    assert.equal((await call(`${s.api}/games`, { token: r.json.token })).status, 200);
  });

  test('tokens work cross-origin (scripts/dashboards) but a cookie session does not', async () => {
    const tk = await call(`${s.api}/games`, { body: { title: 'Dash Game' }, token: t1.token, origin: EVIL });
    assert.equal(tk.status, 200, tk.text);
    const ck = await call(`${s.api}/games`, { body: { title: 'CSRF Game' }, cookie, origin: EVIL });
    assert.equal(ck.status, 403);
    const games = (await call(`${s.api}/games?limit=500`, { cookie })).text;
    assert.ok(!games.includes('CSRF Game'));
  });

  test('a token value never appears in any other response', async () => {
    const t = await call(`${s.api}/tokens`, { body: { name: 'canary' }, cookie });
    const canary = t.json.token;
    await call(`${s.api}/games`, { token: canary }); // use it once (last_used, logs)
    for (const p of ['/tokens', '/settings', '/system', '/export', '/export?format=csv', '/logs', '/syncs', '/summary', '/widget', '/auth/status']) {
      const r = await call(`${s.api}${p}`, { cookie });
      assert.ok(!r.text.includes(canary), `token leaked by ${p}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('every non-public route rejects unauthenticated requests when a password is set', () => {
  let s; let cookie; let token; let revoked; let routes; let ids; let stale;
  const PUBLIC = new Set(['GET /api/v1/health', 'GET /api/v1/auth/status', 'POST /api/v1/auth/login', 'POST /api/v1/auth/logout']);
  before(async () => {
    s = await startApp({ password: '' });
    // seed real data while open
    const acc = await call(`${s.api}/accounts`, { body: { platform: 'custom', name: 'Pushed', config: {} } });
    assert.equal(acc.status, 200, acc.text);
    await call(`${s.api}/accounts/${acc.json.id}/report`, { body: { games: [{ id: 'g1', title: 'Sweep Game', playtime_minutes: 100 }] } });
    await call(`${s.api}/accounts/${acc.json.id}/report`, { body: { games: [{ id: 'g1', title: 'Sweep Game', playtime_minutes: 160 }] } });
    const games = (await call(`${s.api}/games`)).json;
    const g = (games.items || games.games || games)[0];
    const game = (await call(`${s.api}/games/${g.id}`)).json;
    const man = await call(`${s.api}/sessions`, { body: { game_id: g.id, minutes: 30, note: 'manual' } });
    assert.equal(man.status, 200, man.text);
    const tok = await call(`${s.api}/tokens`, { body: { name: 'sweep' } });
    const tok2 = await call(`${s.api}/tokens`, { body: { name: 'to-revoke' } });
    token = tok.json.token;
    revoked = tok2.json.token;
    await call(`${s.api}/tokens/${tok2.json.id}`, { method: 'DELETE' });
    ids = { games: g.id, entries: game.entries[0].id, sessions: man.json.id ?? man.json.session?.id ?? 1, accounts: acc.json.id, tokens: tok.json.id };
    const pw = await setPassword(s, PASSWORD);
    cookie = cookiePair(pw.setCookie);
    const l = await login(s, PASSWORD);
    stale = cookiePair(l.setCookie);
    await call(`${s.api}/auth/logout`, { method: 'POST', cookie: stale }); // now a dead session
    const spec = await call(`${s.origin}/api/openapi.json`, { token });
    assert.equal(spec.status, 200);
    routes = [];
    for (const [p, ops] of Object.entries(spec.json.paths)) {
      for (const m of Object.keys(ops)) routes.push({ method: m.toUpperCase(), template: p });
    }
    assert.ok(routes.length >= 50, `documented routes: ${routes.length}`);
  });
  after(() => s.close());

  const fill = (template) => template.replace(/\{(\w+)\}/g, (_, k, off) => {
    if (k === 'year') return String(new Date().getFullYear());
    const seg = template.slice(0, off).split('/').filter(Boolean).at(-1);
    return String(ids[seg] ?? 1);
  });

  async function sweep(label, auth) {
    const before_ = tableCounts(s.db);
    const failures = [];
    for (const r of routes) {
      const key = `${r.method} ${r.template}`;
      if (PUBLIC.has(key)) continue;
      const url = `${s.origin}${fill(r.template)}${auth.query || ''}`;
      const o = { method: r.method, headers: auth.headers || {}, cookie: auth.cookie };
      if (!['GET', 'DELETE'].includes(r.method)) o.body = {};
      const res = await call(url, o);
      if (res.status !== 401) failures.push(`${key} -> ${res.status}`);
    }
    assert.deepEqual(failures, [], `${label}: routes reachable without valid credentials`);
    assert.deepEqual(tableCounts(s.db), before_, `${label}: nothing changed`);
  }

  test('no credentials', async () => { await sweep('no credentials', {}); });
  test('a wrong bearer token', async () => { await sweep('wrong bearer', { headers: { Authorization: 'Bearer pt_not_a_real_token_000000000000' } }); });
  test('a revoked token (Bearer, X-API-Key and ?api_key)', async () => {
    await sweep('revoked bearer', { headers: { Authorization: `Bearer ${revoked}` } });
    await sweep('revoked x-api-key', { headers: { 'X-API-Key': revoked } });
    await sweep('revoked api_key', { query: `?api_key=${encodeURIComponent(revoked)}` });
  });
  test('a logged-out session cookie', async () => { await sweep('stale cookie', { cookie: stale }); });

  test('HEAD on protected GET routes and trailing-slash variants are protected too', async () => {
    for (const r of routes.filter((x) => x.method === 'GET' && !PUBLIC.has(`GET ${x.template}`))) {
      const h = await fetch(`${s.origin}${fill(r.template)}`, { method: 'HEAD' });
      assert.equal(h.status, 401, `HEAD ${r.template}`);
      const t = await call(`${s.origin}${fill(r.template)}/`);
      assert.ok(t.status === 401 || t.status === 404, `GET ${r.template}/ -> ${t.status}`);
      assert.ok(!t.text.includes('Sweep Game'));
    }
  });

  test('the documented public endpoints answer without credentials and reveal nothing private', async () => {
    const h = await call(`${s.api}/health`);
    assert.equal(h.status, 200);
    assert.ok(!h.text.includes('Sweep Game') && !h.text.includes('Pushed'));
    const st = await call(`${s.api}/auth/status`);
    assert.equal(st.status, 200);
    assert.equal(st.json.authenticated, false);
    assert.ok(!st.text.includes('Sweep Game'));
    const lo = await call(`${s.api}/auth/logout`, { method: 'POST' });
    assert.equal(lo.status, 200);
  });

  test('GET requests never change stored data (cookies ride along on cross-site top-level GETs)', async () => {
    const before_ = tableCounts(s.db);
    const games = s.db.prepare('SELECT * FROM games ORDER BY id').all();
    const entries = s.db.prepare('SELECT id, playtime_min, excluded, game_id FROM entries ORDER BY id').all();
    for (const r of routes.filter((x) => x.method === 'GET')) {
      const res = await call(`${s.origin}${fill(r.template)}`, { cookie, origin: EVIL });
      assert.ok(res.status < 500, `GET ${r.template} -> ${res.status}`);
    }
    assert.deepEqual(tableCounts(s.db), before_);
    assert.deepEqual(s.db.prepare('SELECT * FROM games ORDER BY id').all(), games);
    assert.deepEqual(s.db.prepare('SELECT id, playtime_min, excluded, game_id FROM entries ORDER BY id').all(), entries);
  });

  test('valid credentials still reach the data after the sweep (data intact, totals consistent)', async () => {
    const g = await call(`${s.api}/games/${ids.games}`, { cookie });
    assert.equal(g.status, 200);
    assert.equal(g.json.title, 'Sweep Game');
    assert.equal((await call(`${s.api}/accounts`, { token })).json.length, 1);
    assert.deepEqual(brokenEntries(s.db), []);
  });
});

// ---------------------------------------------------------------------------------------------
describe('/metrics', () => {
  let s; let cookie; let token;
  before(async () => {
    s = await startApp({ password: '' });
    token = (await call(`${s.api}/tokens`, { body: { name: 'prom' } })).json.token;
    // hostile platform name from an import must not be able to forge metric lines
    const imp = await call(`${s.api}/import`, { body: { games: [{ title: 'Injected', platform: 'x"} 999\nfake_metric 1\n#', playtime_minutes: 60 }] } });
    assert.equal(imp.status, 200, imp.text);
    cookie = cookiePair((await setPassword(s, PASSWORD)).setCookie);
  });
  after(() => s.close());

  test('is protected when a password is set', async () => {
    for (const o of [{}, { token: 'pt_wrong' }, { headers: { 'X-API-Key': 'nope' } }, { cookie: 'pt_session=forged' }]) {
      const r = await call(`${s.origin}/metrics`, o);
      assert.equal(r.status, 401, JSON.stringify(o));
      assert.ok(!r.text.includes('playtracker_') && !r.text.includes('vestigo_'), 'no metric data in the 401');
    }
    const q = await call(`${s.origin}/metrics?api_key=wrong`);
    assert.equal(q.status, 401);
  });

  test('accepts a token (Bearer / X-API-Key / ?api_key) or a session cookie', async () => {
    for (const o of [{ token }, { headers: { 'X-API-Key': token } }, { cookie }]) {
      const r = await call(`${s.origin}/metrics`, o);
      assert.equal(r.status, 200, JSON.stringify(o));
      assert.match(r.headers.get('content-type'), /text\/plain/);
      assert.match(r.text, /^vestigo_playtime_minutes_total \d+$/m);
      assert.match(r.text, /^playtracker_playtime_minutes_total \d+$/m);
    }
    assert.equal((await call(`${s.origin}/metrics?api_key=${encodeURIComponent(token)}`)).status, 200);
  });

  test('output stays well-formed Prometheus text even with hostile names in the data', async () => {
    const r = await call(`${s.origin}/metrics`, { token });
    const sample = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\.)*"(,[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\.)*")*\})? -?[0-9][0-9.e+-]*$/;
    for (const line of r.text.split('\n').filter(Boolean)) {
      assert.ok(line.startsWith('# ') || sample.test(line), `malformed line: ${JSON.stringify(line)}`);
    }
    assert.ok(!/^fake_metric/m.test(r.text), 'no injected metric');
    for (const p of ['vestigo', 'playtracker']) {
      const total = Number(new RegExp(`^${p}_playtime_minutes_total (\\d+)$`, 'm').exec(r.text)[1]);
      assert.equal(total, 60, `${p}_: the imported hour is counted once`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('configured VESTIGO_CORS_ORIGIN', () => {
  const DASH = 'https://dash.example:8443';
  let s; let restore;
  before(async () => { s = await startApp({ password: '' }); restore = setEnv({ VESTIGO_CORS_ORIGIN: DASH }); });
  after(() => { restore(); s.close(); });

  test('an existing PLAYTRACKER_CORS_ORIGIN still grants its origin; VESTIGO_CORS_ORIGIN wins when both are set', async () => {
    const back = setEnv({ VESTIGO_CORS_ORIGIN: undefined, PLAYTRACKER_CORS_ORIGIN: 'https://old.example' });
    try {
      assert.equal((await call(`${s.api}/games`, { origin: 'https://old.example' })).headers.get('access-control-allow-origin'), 'https://old.example');
      assert.equal((await call(`${s.api}/games`, { body: { title: 'From Old Dashboard' }, origin: 'https://old.example' })).status, 200);
      process.env.VESTIGO_CORS_ORIGIN = DASH;
      assert.equal((await call(`${s.api}/games`, { origin: DASH })).headers.get('access-control-allow-origin'), DASH);
      assert.equal((await call(`${s.api}/games`, { body: { title: 'x' }, origin: 'https://old.example' })).status, 403, 'the old name no longer applies');
    } finally { back(); }
  });

  test('preflight from the configured origin is answered with a scoped grant', async () => {
    const r = await fetch(`${s.api}/games`, { method: 'OPTIONS', headers: { Origin: DASH, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.ok(r.status === 204 || r.status === 200, `status ${r.status}`);
    assert.equal(r.headers.get('access-control-allow-origin'), DASH);
    const allowH = String(r.headers.get('access-control-allow-headers')).toLowerCase();
    for (const h of ['authorization', 'content-type', 'x-api-key']) assert.ok(allowH.includes(h), `allows ${h}`);
    assert.match(String(r.headers.get('access-control-allow-methods')), /POST/);
  });

  test('the configured origin may write; any other origin is still blocked', async () => {
    const ok = await call(`${s.api}/games`, { body: { title: 'From Dashboard' }, origin: DASH });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.headers.get('access-control-allow-origin'), DASH);
    for (const o of [EVIL, 'https://dash.example', 'https://dash.example:8443.evil.example', 'http://dash.example:8443']) {
      const r = await call(`${s.api}/games`, { body: { title: `From ${o}` }, origin: o });
      assert.equal(r.status, 403, `origin ${o}`);
    }
  });

  test('the grant is never a wildcard and never echoes an untrusted origin', async () => {
    const r = await call(`${s.api}/games`, { origin: EVIL });
    const acao = r.headers.get('access-control-allow-origin');
    assert.notEqual(acao, '*');
    assert.notEqual(acao, EVIL);
  });

  test('a CORS origin does not bypass the password', async () => {
    const t = await startApp({ password: PASSWORD });
    try {
      const tok = (await call(`${t.api}/tokens`, { body: { name: 'dash' }, cookie: cookiePair((await login(t, PASSWORD)).setCookie) })).json.token;
      assert.equal((await call(`${t.api}/games`, { origin: DASH })).status, 401);
      assert.equal((await call(`${t.api}/games`, { body: { title: 'x' }, origin: DASH })).status, 401);
      assert.equal((await call(`${t.api}/games`, { body: { title: 'Dash With Token' }, origin: DASH, token: tok })).status, 200);
    } finally { t.close(); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('request body size limits', () => {
  let s; let p;
  before(async () => {
    s = await startApp({ password: '' });
    p = await startApp({ password: PASSWORD });
  });
  after(() => { s.close(); p.close(); });

  /**
   * An oversized request must be refused with 413 and never processed. Sent over its own
   * connection with node:http (whole body written, response read concurrently).
   */
  async function refused(app, path_, obj, label, method = 'POST') {
    const r = await rawHttp(app.port, { method, path: path_, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
    assert.ok(!r.error, `${label}: ${r.error}`);
    assert.equal(r.status, 413, `${label}: ${r.status} ${String(r.body).slice(0, 80)}`);
    assert.ok(!leaksStack(r.body));
    return r;
  }

  test('a public endpoint (login) refuses a huge body and sets no session', async () => {
    for (const size of [256 * 1024, 2 * 1024 * 1024]) {
      const r = await refused(p, '/api/v1/auth/login', { password: 'a'.repeat(size) }, `login ${size}B`);
      assert.equal(r.headers['set-cookie'], undefined);
    }
    // a body as large as the real password is obviously fine
    assert.equal((await login(p, PASSWORD)).status, 200);
    assert.equal(p.db.prepare('SELECT COUNT(*) n FROM login_sessions').get().n, 1, 'only the legit login created a session');
    assert.equal((await rawHttp(p.port, { path: '/api/v1/health' })).status, 200, 'server healthy afterwards');
  });

  test('normal endpoints accept ordinary bodies but refuse very large ones', async () => {
    const small = await call(`${s.api}/games`, { body: { title: 'Normal Body', notes_pad: 'n'.repeat(100 * 1024) } });
    assert.equal(small.status, 200, small.text);
    const n = s.db.prepare('SELECT COUNT(*) n FROM games').get().n;
    await refused(s, '/api/v1/games', { title: 'Huge Body', pad: 'h'.repeat(20 * 1024 * 1024) }, 'games 20MB');
    await refused(s, '/api/v1/settings', { theme: 'light', pad: 'h'.repeat(20 * 1024 * 1024) }, 'settings 20MB', 'PUT');
    assert.equal(s.db.prepare('SELECT COUNT(*) n FROM games').get().n, n, 'oversized request not processed');
    assert.notEqual((await call(`${s.api}/settings`)).json.theme, 'light', 'oversized settings write not applied');
    assert.equal((await rawHttp(s.port, { path: '/api/v1/health' })).status, 200);
  });

  test('imports accept large bodies (README: up to 256 MB)', async () => {
    const big = JSON.stringify({ games: [{ title: 'Large Import Game', platform: 'import', playtime_minutes: 90 }], padding: 'p'.repeat(24 * 1024 * 1024) });
    const r = await call(`${s.api}/import`, { body: big });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.ok((await call(`${s.api}/games?limit=500`)).text.includes('Large Import Game'));
    assert.deepEqual(brokenEntries(s.db), []);
  });

  test('unauthenticated requests are rejected (401) before a big body is accepted', async () => {
    const big = `title,platform,playtime_hours\n${'Unauth Game,import,1\n'.repeat(600_000)}`; // ~12 MB
    for (const path_ of ['/api/v1/import', '/api/v1/games', '/api/v1/accounts/1/report', '/api/v1/import/gametrack']) {
      const t0 = Date.now();
      const r = await rawHttp(p.port, { method: 'POST', path: path_, headers: { 'Content-Type': 'text/csv' }, body: big });
      assert.ok(!r.error, `${path_}: ${r.error}`);
      assert.equal(r.status, 401, `${path_} -> ${r.status}`);
      assert.ok(Date.now() - t0 < 10_000, 'answered promptly');
    }
    assert.equal(p.db.prepare('SELECT COUNT(*) n FROM games').get().n, 0, 'nothing imported');
  });

  test('malformed JSON is a clean 400', async () => {
    for (const body of ['{"title":', '{title: "x"}', '\u0000\u0001', '[1,2', '"unterminated']) {
      const r = await call(`${s.api}/games`, { method: 'POST', body, type: 'application/json' });
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status}`);
      assert.equal(typeof r.json?.error, 'string');
      assert.ok(!leaksStack(r.text));
    }
  });

  test('an oversized body gets a prompt, readable 413 from fetch() clients too (not a stalled connection reset)', async () => {
    const t = await startApp({ password: PASSWORD });
    try {
      const body = JSON.stringify({ password: 'a'.repeat(1024 * 1024) });
      const outcomes = [];
      for (let i = 0; i < 8; i++) {
        try {
          const r = await fetch(`${t.api}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(2500) });
          await r.text();
          outcomes.push(r.status);
        } catch (err) { outcomes.push(err.cause?.code || err.name); }
      }
      assert.deepEqual(outcomes, Array(8).fill(413));
    } finally { t.close(); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('login throttling', () => {
  async function fresh() {
    const t = await startApp({ password: PASSWORD });
    return t;
  }

  test('a few mistakes are tolerated and a successful login resets the count', async () => {
    const t = await fresh();
    try {
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 3; i++) assert.equal((await login(t, `wrong-${i}`)).status, 401);
        assert.equal((await login(t, PASSWORD)).status, 200, `round ${round}: correct password after 3 typos`);
      }
    } finally { t.close(); }
  });

  test('repeated failures block further attempts, even with the right password, without locking out other credentials', async () => {
    const t = await fresh();
    try {
      const ck = cookiePair((await login(t, PASSWORD)).setCookie);
      const tok = (await call(`${t.api}/tokens`, { body: { name: 'during-block' }, cookie: ck })).json.token;
      const statuses = [];
      for (let i = 0; i < 12; i++) statuses.push((await login(t, `guess-${i}`)).status);
      assert.ok(statuses.slice(0, 3).every((x) => x === 401), `first guesses are plain failures: ${statuses}`);
      assert.ok(statuses.includes(429), `throttled within 12 guesses: ${statuses}`);
      const firstBlock = statuses.indexOf(429);
      assert.ok(statuses.slice(firstBlock).every((x) => x === 429), 'stays blocked');
      const right = await login(t, PASSWORD);
      assert.equal(right.status, 429, 'correct password is not tested while blocked');
      assert.equal(right.setCookie, null);
      assert.equal(typeof right.json.error, 'string');
      assert.ok(!leaksStack(right.text));
      // spoofed proxy headers do not give a fresh budget
      for (const h of [{ 'X-Forwarded-For': '203.0.113.7' }, { 'X-Real-IP': '198.51.100.2' }, { Forwarded: 'for=192.0.2.1' }]) {
        assert.equal((await login(t, PASSWORD, { headers: h })).status, 429, JSON.stringify(h));
      }
      // other credentials keep working
      assert.equal((await call(`${t.api}/games`, { cookie: ck })).status, 200);
      assert.equal((await call(`${t.api}/games`, { token: tok })).status, 200);
    } finally { t.close(); }
  });

  test('the block lifts after the advertised wait, and much later failures start from scratch', async () => {
    const t = await fresh();
    let restore = () => {};
    try {
      let blocked;
      for (let i = 0; i < 12 && !blocked; i++) {
        const r = await login(t, `guess-${i}`);
        if (r.status === 429) blocked = r;
      }
      assert.ok(blocked, 'throttled');
      const wait = Number(/(\d+)\s*s/.exec(blocked.json.error)?.[1] || blocked.headers.get('retry-after'));
      assert.ok(wait > 0 && wait <= 3600, `advertised wait ${wait}s`);
      restore = shiftClock((wait - 2) * 1000);
      assert.equal((await login(t, PASSWORD)).status, 429, 'still blocked just before the wait ends');
      restore();
      restore = shiftClock((wait + 2) * 1000);
      assert.equal((await login(t, PASSWORD)).status, 200, 'right password works once the wait is over');
      restore();
      // a day later, a couple of typos are again just typos
      restore = shiftClock(86_400_000);
      for (let i = 0; i < 2; i++) assert.equal((await login(t, `typo-${i}`)).status, 401);
      assert.equal((await login(t, PASSWORD)).status, 200);
    } finally { restore(); t.close(); }
  });
});

// ---------------------------------------------------------------------------------------------
describe('malformed URLs and requests', () => {
  let s; let p;
  before(async () => { s = await startApp({ password: '' }); p = await startApp({ password: PASSWORD }); });
  after(() => { s.close(); p.close(); });

  test('bad %-escapes in API paths are 4xx JSON errors, never 500', async () => {
    for (const app of [s, p]) {
      for (const pth of ['/api/v1/games/%E0%A4%A', '/api/v1/sessions/%zz', '/api/v1/accounts/%/sync', '/api/v1/%E0%A4%A', '/api/v1/tokens/%ff%fe', '/api/v1/games/%c0%af']) {
        for (const method of ['GET', 'DELETE', 'POST', 'PATCH']) {
          const r = await rawHttp(app.port, { method, path: pth, headers: { 'Content-Type': 'application/json' }, body: ['POST', 'PATCH'].includes(method) ? '{}' : undefined });
          assert.ok(r.status >= 400 && r.status < 500, `${method} ${pth} -> ${r.status}`);
          assert.ok(!leaksStack(r.body), `${pth} leaks`);
          if (r.status !== 405) assert.equal(typeof JSON.parse(r.body).error, 'string');
        }
      }
    }
  });

  test('NUL bytes and odd-but-valid escapes in ids never crash or bypass auth', async () => {
    for (const pth of ['/api/v1/games/%00', '/api/v1/games/1%00', '/api/v1/sessions/%20', '/api/v1/accounts/1%2F2', '/api/v1/games/..%2F..%2Fsettings']) {
      for (const method of ['GET', 'DELETE']) {
        const o = await rawHttp(s.port, { method, path: pth });
        assert.ok(o.status < 500, `open ${method} ${pth} -> ${o.status}`);
        const q = await rawHttp(p.port, { method, path: pth });
        assert.ok([400, 401, 404, 405].includes(q.status), `protected ${method} ${pth} -> ${q.status}`);
        assert.ok(!q.body.includes('schedule_mode'), 'no settings disclosed');
      }
    }
  });

  test('bad %-escapes in static paths are 404s, never 500', async () => {
    for (const pth of ['/%E0%A4%A', '/%E0%A4%A.js', '/app.js%', '/%zz/index.html']) {
      const r = await rawHttp(s.port, { path: pth });
      assert.ok(r.status === 404 || r.status === 400, `${pth} -> ${r.status}`);
    }
  });

  test('bad %-escapes in the query string never bypass auth or crash', async () => {
    for (const q of ['?api_key=%zz', '?api_key=%E0%A4%A', '?q=%&limit=%%%', '?api_key=']) {
      const r = await rawHttp(p.port, { path: `/api/v1/games${q}` });
      assert.equal(r.status, 401, `password mode ${q}`);
      const o = await rawHttp(s.port, { path: `/api/v1/games${q}` });
      assert.equal(o.status, 200, `open mode ${q}`);
    }
  });

  test('absurdly long URLs and headers are refused without taking the server down', async () => {
    const long = await rawHttp(s.port, { path: `/api/v1/games/${'9'.repeat(12_000)}` });
    assert.ok(long.error || (long.status >= 400 && long.status < 500), `long path -> ${long.status || long.error}`);
    const hdr = await rawHttp(p.port, { path: '/api/v1/games', headers: { Authorization: `Bearer ${'a'.repeat(100_000)}` } });
    assert.ok(hdr.error || (hdr.status >= 400 && hdr.status < 500), `huge header -> ${hdr.status || hdr.error}`);
    assert.equal((await call(`${s.api}/health`)).status, 200);
    assert.equal((await call(`${p.api}/health`)).status, 200);
  });

  test('garbage on the socket does not affect other clients', async () => {
    for (const junk of ['GARBAGE\r\n\r\n', 'GET / HTTP/9.9\r\n\r\n', '\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03', 'GET /api/v1/games HTTP/1.1\r\nHost: x\r\nContent-Length: -5\r\n\r\n', 'POST /api/v1/games HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n']) {
      const out = await rawSocket(s.port, junk);
      assert.ok(!/^HTTP\/1\.[01] 5\d\d/.test(out), `junk ${JSON.stringify(junk.slice(0, 20))} -> ${out.slice(0, 30)}`);
    }
    assert.equal((await call(`${s.api}/health`)).status, 200);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM games").get().n, 0, 'nothing was created by malformed requests');
  });

  test('a valid session cookie still works next to an unrelated malformed cookie', async () => {
    const ck = cookiePair((await login(p, PASSWORD)).setCookie);
    const a = await call(`${p.api}/games`, { cookie: `${ck}; other=%E0%A4%A` });
    assert.equal(a.status, 200, `got ${a.status}`);
    const b = await call(`${p.api}/games`, { cookie: 'other=%' });
    assert.equal(b.status, 401, `unauthenticated with junk cookie got ${b.status}`);
  });
});

// ---------------------------------------------------------------------------------------------
describe('static files and path traversal', () => {
  let s; let index;
  const markers = [];
  before(async () => {
    s = await startApp({ password: PASSWORD });
    index = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    markers.push(['src/auth.js', 'export class Auth'], ['package.json', '"name": "vestigo"'], ['README.md', '# Vestigo']);
    if (fs.existsSync('/etc/passwd')) markers.push(['/etc/passwd', 'root:']);
    if (fs.existsSync(path.join(ROOT, '.git', 'config'))) markers.push(['.git/config', '[core]']);
  });
  after(() => s.close());

  const ATTEMPTS = [
    '/../src/auth.js', '/..%2fsrc%2fauth.js', '/%2e%2e/src/auth.js', '/%2e%2e%2fsrc%2fauth.js', '/.%2e/src/auth.js',
    '/..%2f..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/....//....//etc/passwd',
    '/%252e%252e%252fsrc%252fauth.js', '/..%5csrc%5cauth.js', '/..\\src\\auth.js', '/index.html%00.js', '/%00../package.json',
    '/../package.json', '/..%2fpackage.json', '/%2e%2e/README.md', '/./.%2e/.git/config', '/..%2f.git%2fconfig', '//etc/passwd',
    '/%2fetc%2fpasswd', '/..%c0%afpackage.json', '/..%2f..%2fdata%2fvestigo.db', '/..%2f..%2fdata%2fplaytracker.db', '/api/../../package.json',
  ];

  test('traversal attempts never serve files outside public/', async () => {
    for (const a of ATTEMPTS) {
      const r = await rawHttp(s.port, { path: a });
      assert.ok(!r.error, `${a}: ${r.error}`);
      for (const [name, marker] of markers) assert.ok(!r.body.includes(marker), `${a} served ${name}`);
      assert.ok([200, 400, 401, 403, 404].includes(r.status), `${a} -> ${r.status}`);
      if (r.status === 200) assert.equal(r.body, index, `${a}: only the SPA shell may be returned`);
    }
  });

  test('non-GET methods on static paths are refused', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await rawHttp(s.port, { method, path: '/index.html', body: 'x' });
      assert.ok(r.status === 405 || r.status === 404, `${method} -> ${r.status}`);
    }
    assert.equal(fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), index);
  });

  test('the app shell loads without a session (so the login page can render) but data does not', async () => {
    for (const asset of ['/', '/index.html', '/app.js', '/app.css', '/manifest.webmanifest', '/library']) {
      const r = await rawHttp(s.port, { path: asset });
      assert.equal(r.status, 200, asset);
    }
    assert.equal((await rawHttp(s.port, { path: '/api/v1/games' })).status, 401);
  });
});

// ---------------------------------------------------------------------------------------------
describe('platform credentials are never disclosed', () => {
  const STEAM_KEY = 'STEAMKEY0123456789ABCDEFSECRET42';
  const STEAM_KEY_2 = 'NEWSTEAMKEY9876543210ZYXWVUQ77';
  const XBOX_KEY = 'xbl-0a1b2c3d-4e5f-6789-abcd-SECRET99';
  const NPSSO = 'NpSsO1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLmnopSECRET';
  const PSN_REFRESH = 'psn-refresh-token-VERY-SECRET-1234567890';
  const PSN_ACCESS = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: '4455667788' })).toString('base64url')}.SIGNATURE-SECRET-abc`;
  const SECRETS = [STEAM_KEY, STEAM_KEY_2, XBOX_KEY, NPSSO, PSN_REFRESH, PSN_ACCESS, 'SIGNATURE-SECRET', 'NEWSTEAMKEY'];
  let s; let mock; const steamKeys = []; let steamMode = 'forbidden';
  const ids = {};

  before(async () => {
    mock = mockExternalFetch((url, init) => {
      const u = new URL(url);
      if (u.hostname === 'api.steampowered.com') {
        steamKeys.push(u.searchParams.get('key'));
        if (u.pathname.includes('GetPlayerSummaries')) return jsonResponse({ response: { players: [] } });
        if (u.pathname.includes('GetOwnedGames')) {
          if (steamMode === 'forbidden') return new Response('<html><body>Forbidden</body></html>', { status: 403 });
          if (steamMode === 'broken') return jsonResponse({ response: { games: [null] } });
          return jsonResponse({ response: { game_count: 1, games: [{ appid: 10, name: 'Steam Secret Test', playtime_forever: 0 }] } });
        }
        return new Response('nope', { status: 404 });
      }
      if (u.hostname === 'ca.account.sony.com') {
        if (u.pathname.endsWith('/authorize')) {
          const ok = String(init.headers?.Cookie || '').includes(`npsso=${NPSSO}`);
          return new Response(null, { status: 302, headers: { Location: ok ? 'com.scee.psxandroid.scecompcall://redirect/?code=v3.AUTHCODE&cid=1' : 'com.scee.psxandroid.scecompcall://redirect/?error=login_required' } });
        }
        if (u.pathname.endsWith('/token')) return jsonResponse({ access_token: PSN_ACCESS, expires_in: 3600, refresh_token: PSN_REFRESH, refresh_token_expires_in: 5_184_000 });
      }
      if (u.hostname === 'm.np.playstation.com') {
        if (u.pathname.includes('/gamelist/v2/')) {
          return jsonResponse({ titles: [{ titleId: 'PPSA00001_00', name: 'PSN Secret Test', playDuration: 'PT10H30M', firstPlayedDateTime: '2025-01-01T10:00:00Z', lastPlayedDateTime: '2025-06-01T10:00:00Z', playCount: 12, category: 'ps5_native_game', concept: { id: 1001 } }], nextOffset: null });
        }
        return new Response('{}', { status: 403 }); // trophies/presence: not available
      }
      if (u.hostname === 'xbl.io') return jsonResponse({ error: 'Invalid API key' }, 401); // OpenXBL rejects every key here
      return new Response('{}', { status: 404 });
    });
    s = await startApp({ password: '', log: createLogger({ quiet: true }) });
  });
  after(() => { s.close(); mock.restore(); });

  async function everything() {
    const paths = ['/accounts', '/system', '/syncs?limit=500', '/logs?limit=1000', '/export', '/export?format=csv', '/settings', '/platforms', '/tokens', '/games?limit=500', '/sessions', '/summary', '/widget', '/now-playing', '/history/review', '/history/summary', '/duplicates', '/stats', '/stats/lifetime'];
    let all = '';
    for (const p of paths) {
      const r = await call(`${s.api}${p}`);
      assert.equal(r.status, 200, `${p}: ${r.text.slice(0, 120)}`);
      all += `\n${p}\n${r.text}`;
    }
    for (const id of Object.values(ids)) all += (await call(`${s.api}/syncs?account_id=${id}`)).text;
    all += (await call(`${s.origin}/metrics`)).text;
    return all;
  }
  const assertNoSecrets = (text, label) => {
    for (const sec of SECRETS) assert.ok(!text.includes(sec), `${label}: leaked ${sec.slice(0, 12)}…`);
  };

  test('API keys and NPSSO are masked in create, list and diagnostics responses', async () => {
    const st = await call(`${s.api}/accounts`, { body: { platform: 'steam', name: 'Steam', config: { api_key: STEAM_KEY, steam_id: '76561197960287930', presence: 'off' }, sync: false } });
    assert.equal(st.status, 200, st.text);
    ids.steam = st.json.id;
    assert.notEqual(st.json.config.api_key, STEAM_KEY);
    assert.ok(st.json.config.api_key && !st.json.config.api_key.includes(STEAM_KEY.slice(0, 8)), 'masked placeholder');
    assert.equal(st.json.config.steam_id, '76561197960287930', 'non-secret fields stay visible');
    const xb = await call(`${s.api}/accounts`, { body: { platform: 'xbox', name: 'Xbox', config: { api_key: XBOX_KEY, presence: 'off' }, sync: false } });
    assert.equal(xb.status, 200, xb.text);
    ids.xbox = xb.json.id;
    const ps = await call(`${s.api}/accounts`, { body: { platform: 'psn', name: 'PSN', config: { npsso: NPSSO, presence: 'off' }, sync: false } });
    assert.equal(ps.status, 200, ps.text);
    ids.psn = ps.json.id;
    for (const r of [st, xb, ps]) assertNoSecrets(r.text, `POST /accounts ${r.json.platform}`);
    const list = await call(`${s.api}/accounts`);
    assert.equal(list.json.length, 3);
    assertNoSecrets(list.text, 'GET /accounts');
    assertNoSecrets(await everything(), 'all endpoints');
  });

  test('a short key is masked completely, not partially revealed', async () => {
    const r = await call(`${s.api}/accounts`, { body: { platform: 'xbox', name: 'Short', config: { api_key: 'k3y9z', presence: 'off' }, sync: false } });
    assert.equal(r.status, 200);
    assert.ok(!r.json.config.api_key.includes('3y9z') && !r.json.config.api_key.includes('k3y9'), `masked as ${r.json.config.api_key}`);
    assert.equal((await call(`${s.api}/accounts/${r.json.id}`, { method: 'DELETE' })).status, 200);
  });

  test('sending the masked placeholder back keeps the stored key; a new key replaces it', async () => {
    const masked = (await call(`${s.api}/accounts`)).json.find((a) => a.id === ids.steam).config.api_key;
    const p1 = await call(`${s.api}/accounts/${ids.steam}`, { method: 'PATCH', body: { name: 'Steam renamed', config: { api_key: masked, steam_id: '76561197960287930' } } });
    assert.equal(p1.status, 200, p1.text);
    assertNoSecrets(p1.text, 'PATCH response');
    steamKeys.length = 0;
    const s1 = await call(`${s.api}/accounts/${ids.steam}/sync?wait=true`, { method: 'POST' });
    assert.ok(s1.status >= 400, 'mocked Steam refuses the key (403)');
    assert.ok(steamKeys.length > 0, 'Steam was called');
    assert.ok(steamKeys.every((k) => k === STEAM_KEY), `original key used, got ${steamKeys}`);
    const p2 = await call(`${s.api}/accounts/${ids.steam}`, { method: 'PATCH', body: { config: { api_key: STEAM_KEY_2 } } });
    assert.equal(p2.status, 200);
    assertNoSecrets(p2.text, 'PATCH new key response');
    steamKeys.length = 0;
    await call(`${s.api}/accounts/${ids.steam}/sync?wait=true`, { method: 'POST' });
    assert.ok(steamKeys.length > 0 && steamKeys.every((k) => k === STEAM_KEY_2), `new key used, got ${steamKeys}`);
  });

  test('failed syncs (auth error and internal error) never echo keys or stack traces to clients', async () => {
    steamMode = 'forbidden';
    const a = await call(`${s.api}/accounts/${ids.steam}/sync?wait=true`, { method: 'POST' });
    assert.ok(a.status >= 400 && a.status < 600);
    assert.equal(typeof a.json.error, 'string');
    assertNoSecrets(a.text, 'sync 403 response');
    assert.ok(!leaksStack(a.text), 'no stack in sync failure');
    steamMode = 'broken';
    const b = await call(`${s.api}/accounts/${ids.steam}/sync?wait=true`, { method: 'POST' });
    assert.ok(b.status >= 400 && b.status < 600, `broken upstream -> ${b.status}`);
    assert.equal(typeof b.json.error, 'string');
    assert.ok(!leaksStack(b.text), `no stack in internal failure: ${b.text}`);
    assertNoSecrets(b.text, 'sync internal error response');
    const acc = (await call(`${s.api}/accounts`)).json.find((x) => x.id === ids.steam);
    assert.ok(acc.last_error, 'the failure is recorded for the user');
    assertNoSecrets(JSON.stringify(acc), 'account last_error');
    assertNoSecrets(await everything(), 'all endpoints after failures');
    steamMode = 'forbidden';
  });

  test('PSN tokens obtained during a sync are kept server-side only', async () => {
    const r = await call(`${s.api}/accounts/${ids.psn}/sync?wait=true`, { method: 'POST' });
    assert.equal(r.status, 200, r.text);
    assertNoSecrets(r.text, 'sync result');
    const acc = (await call(`${s.api}/accounts`)).json.find((x) => x.id === ids.psn);
    assert.equal(acc.last_status, 'ok');
    assert.ok(acc.games >= 1, 'the sync really imported the library');
    // the tokens are stored (so syncs can refresh) ...
    const stored = s.db.prepare('SELECT state FROM accounts WHERE id = ?').get(ids.psn).state;
    assert.ok(stored.includes(PSN_REFRESH), 'scenario sanity: refresh token was obtained');
    // ... but never returned
    assertNoSecrets(await everything(), 'all endpoints after PSN sync');
    assert.deepEqual(brokenEntries(s.db), []);
  });

  test('a credentials test never echoes the credentials', async () => {
    steamMode = 'ok';
    const r = await call(`${s.api}/accounts/test`, { body: { platform: 'steam', config: { api_key: STEAM_KEY, steam_id: '76561197960287930' } } });
    steamMode = 'forbidden';
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.games, 1);
    assertNoSecrets(r.text, 'accounts/test');
    const bad = await call(`${s.api}/accounts/test`, { body: { platform: 'psn', config: { npsso: `WRONG-${NPSSO}` } } });
    assert.ok(bad.status >= 400, `bad npsso -> ${bad.status}`);
    assertNoSecrets(bad.text, 'accounts/test failure');
    assert.ok(!leaksStack(bad.text));
    assert.equal(typeof bad.json.error, 'string');
  });

  test('a platform rejecting credentials is never reported as a Vestigo 401 or a 500', async () => {
    const results = [];
    for (const [platform, config] of [['xbox', { api_key: 'rejected-by-openxbl-000' }], ['psn', { npsso: 'rejected-npsso' }], ['steam', { api_key: 'rejected-steam-key', steam_id: '76561197960287930' }]]) {
      const r = await call(`${s.api}/accounts/test`, { body: { platform, config } });
      results.push(`${platform}:${r.status}`);
      assert.equal(typeof r.json?.error, 'string', platform);
    }
    // the caller IS authenticated to Vestigo; the platform said no. 401 means "log in to
    // Vestigo again" to every client (the bundled UI shows the login screen on any 401).
    for (const x of results) {
      const status = Number(x.split(':')[1]);
      const ok = status === 502 || (status >= 400 && status < 500 && status !== 401);
      assert.ok(ok, `credential rejection reported as ${x} (all: ${results.join(', ')})`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('error responses never leak internals', () => {
  let s; let p;
  before(async () => {
    s = await startApp({ password: '', log: createLogger({ quiet: true }) });
    p = await startApp({ password: PASSWORD });
    // test-only route that fails like an unexpected bug would (exercises the global error handler)
    s.inst.app.router.get('/api/v1/__test_internal_error', () => { const o = null; return o.boom; }, {});
  });
  after(() => { s.close(); p.close(); });

  test('4xx/5xx bodies are JSON { error } without stack traces or file paths', async () => {
    const cases = [
      ['invalid JSON', s, { url: '/api/v1/games', method: 'POST', body: '{"oops', type: 'application/json' }, 400],
      ['unknown route', s, { url: '/api/v1/definitely-not-here' }, 404],
      ['unknown id', s, { url: '/api/v1/games/987654' }, 404],
      ['wrong method', s, { url: '/api/v1/health', method: 'DELETE' }, 405],
      ['validation', s, { url: '/api/v1/settings', method: 'PUT', body: { schedule_mode: 'whenever' } }, 400],
      ['missing field', s, { url: '/api/v1/games', method: 'POST', body: {} }, 400],
      ['cross-site', s, { url: '/api/v1/games', method: 'POST', body: { title: 'x' }, origin: EVIL }, 403],
      ['unauthorized', p, { url: '/api/v1/games' }, 401],
      ['wrong password', p, { url: '/api/v1/auth/login', method: 'POST', body: { password: 'nope' } }, 401],
      ['internal bug', s, { url: '/api/v1/__test_internal_error' }, 500],
    ];
    for (const [label, app, o, status] of cases) {
      const r = await call(`${app.origin}${o.url}`, o);
      assert.equal(r.status, status, `${label}: ${r.status} ${r.text}`);
      assert.match(r.headers.get('content-type') || '', /application\/json/, `${label} content-type`);
      assert.equal(typeof r.json?.error, 'string', `${label} has an error message`);
      assert.ok(!('stack' in r.json), `${label}: stack field`);
      assert.ok(!leaksStack(r.text), `${label}: ${r.text}`);
    }
  });

  test('an unexpected failure is logged server-side with its stack for the admin', async () => {
    await call(`${s.api}/__test_internal_error`);
    const logs = await call(`${s.api}/logs?level=error`);
    assert.equal(logs.status, 200);
    const item = logs.json.items.find((l) => /__test_internal_error/.test(l.message));
    assert.ok(item, 'error logged');
    assert.ok(item.stack && /TypeError/.test(item.stack), 'stack kept in the server log');
  });

  test('security headers are present on API and static responses', async () => {
    const api = await call(`${s.api}/health`);
    assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
    assert.match(api.headers.get('x-frame-options') || '', /^(DENY|SAMEORIGIN)$/i);
    assert.match(api.headers.get('cache-control') || '', /no-store/, 'API responses are not cached');
    assert.match(api.headers.get('referrer-policy') || '', /^(no-referrer|same-origin|strict-origin|strict-origin-when-cross-origin)$/, 'URLs (which may carry ?api_key) are not sent to other sites');
    const unauth = await call(`${p.api}/games`);
    assert.match(unauth.headers.get('cache-control') || '', /no-store/);
    const page = await rawHttp(s.port, { path: '/' });
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.match(page.headers['x-frame-options'] || '', /^(DENY|SAMEORIGIN)$/i, 'the UI cannot be framed by other sites');
  });
});
