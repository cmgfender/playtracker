// DNS rebinding: an instance without a password answers only to names an outsider cannot point
// at it (IP addresses, localhost, single-label and local names, the CORS origin, the names in
// VESTIGO_ALLOWED_HOSTS). With a password the check is off: a rebound page has no session cookie.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, hostAllowed, hostName } from '../src/server.js';

const VARS = ['VESTIGO_ALLOWED_HOSTS', 'PLAYTRACKER_ALLOWED_HOSTS', 'VESTIGO_CORS_ORIGIN', 'PLAYTRACKER_CORS_ORIGIN'];
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
for (const k of VARS) delete process.env[k];
after(() => { for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function recording() {
  const lines = [];
  const rec = (level) => (msg) => lines.push({ level, msg: String(msg) });
  return { lines, log: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug() {} } };
}

async function start({ password = '' } = {}) {
  const r = recording();
  const inst = createApp({ dbFile: ':memory:', password, log: r.log, scheduler: false });
  await new Promise((ok) => inst.server.listen(0, '127.0.0.1', ok));
  return { ...inst, lines: r.lines, port: inst.server.address().port };
}

/** A request with the Host (and Origin) a browser on that name would send; fetch cannot set Host. */
function req(port, method, path, { host, origin, body, token } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (host !== undefined) headers.Host = host;
    if (origin) headers.Origin = origin;
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: b }));
    });
    r.on('error', reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('hostName: lower case, without port, brackets or trailing dot', () => {
  assert.equal(hostName('Tower.Local:7720'), 'tower.local');
  assert.equal(hostName('[::1]:7720'), '::1');
  assert.equal(hostName('[fe80::1%25eth0]'), 'fe80::1%25eth0');
  assert.equal(hostName('fe80::1'), 'fe80::1'); // a bare IPv6 address keeps its colons
  assert.equal(hostName('tower.local.:80'), 'tower.local');
  assert.equal(hostName(undefined), '');
});

test('hostAllowed: the ways owners reach their server', () => {
  const ok = (h, o = {}) => assert.equal(hostAllowed(h, { allowed: '', cors: undefined, ...o }), true, h);
  for (const h of ['192.168.1.10:7720', '10.0.0.5', '127.0.0.1:7720', '100.101.102.103:7720', '[::1]:7720', '[fd00::5]', '::1',
    'localhost', 'localhost:7720', 'vestigo.localhost', 'tower:7720', 'TOWER', 'vestigo', 'tower.local:7720', 'tower.local.',
    'nas.lan', 'nas.home', 'nas.home.arpa', 'box.internal', 'srv.localdomain', 'tower.fritz.box', '', undefined]) ok(h);
  // the configured CORS origin's host, and VESTIGO_ALLOWED_HOSTS in its forms
  ok('vestigo.example.com', { cors: 'https://vestigo.example.com' });
  ok('vestigo.example.com:443', { allowed: 'vestigo.example.com' });
  ok('vestigo.example.com', { allowed: 'other.org, VESTIGO.example.com:8443' });
  ok('vestigo.example.com', { allowed: 'https://vestigo.example.com/' });
  ok('a.b.example.com', { allowed: '.example.com' });
  ok('example.com', { allowed: '.example.com' });
  ok('play.example.com', { allowed: '*.example.com' });
  ok('anything.example.org', { allowed: '*' });
});

test('hostAllowed: names an attacker can point at the server are refused', () => {
  const no = (h, o = {}) => assert.equal(hostAllowed(h, { allowed: '', cors: undefined, ...o }), false, h);
  for (const h of ['attacker.example:7720', 'evil.com', 'local.evil.com', 'lan.evil.com', 'tower.local.evil.com', '192.168.1.10.evil.com']) no(h);
  no('notexample.com', { allowed: '.example.com' });
  no('example.com.evil.net', { allowed: 'example.com' });
  no('evil.com', { cors: 'https://vestigo.example.com', allowed: 'vestigo.example.com' });
  no('evil.com', { cors: 'not a url' });
});

test('without a password, a rebound name gets 403 everywhere and one warning naming it', async () => {
  const s = await start();
  try {
    const evil = { host: `attacker.example:${s.port}`, origin: `http://attacker.example:${s.port}` };
    const put = await req(s.port, 'PUT', '/api/v1/settings', { ...evil, body: { webhook_url: 'https://attacker.example/hook' } });
    assert.equal(put.status, 403);
    assert.match(JSON.parse(put.body).error, /VESTIGO_ALLOWED_HOSTS/);
    assert.equal(s.app.settings.get('webhook_url') || '', '', 'the write did not happen');
    assert.equal((await req(s.port, 'GET', '/api/v1/accounts', evil)).status, 403);
    assert.equal((await req(s.port, 'GET', '/api/v1/backup', evil)).status, 403);
    const page = await req(s.port, 'GET', '/', evil);
    assert.equal(page.status, 403);
    assert.match(page.body, /attacker\.example.*VESTIGO_ALLOWED_HOSTS/);
    assert.equal((await req(s.port, 'GET', '/metrics', evil)).status, 403);
    // the health check tells nothing and stays reachable for monitors
    assert.equal((await req(s.port, 'GET', '/api/v1/health', evil)).status, 200);
    const warns = s.lines.filter((l) => l.level === 'warn' && l.msg.includes('attacker.example'));
    assert.equal(warns.length, 1, 'logged once, not per request');
    assert.match(warns[0].msg, /VESTIGO_ALLOWED_HOSTS=attacker\.example/);

    // an API token is no browser's: scripts and apps through any name keep working
    const tok = JSON.parse((await req(s.port, 'POST', '/api/v1/tokens', { host: `127.0.0.1:${s.port}`, body: { name: 'dash' } })).body).token;
    assert.equal((await req(s.port, 'GET', '/api/v1/accounts', { host: `vestigo.example.com`, token: tok })).status, 200);
    assert.equal((await req(s.port, 'GET', '/metrics', { host: `vestigo.example.com`, token: tok })).status, 200);

    // the usual addresses
    for (const host of [`192.168.1.10:${s.port}`, `tower:${s.port}`, `tower.local:${s.port}`, `localhost:${s.port}`, `[::1]:${s.port}`]) {
      assert.equal((await req(s.port, 'GET', '/api/v1/accounts', { host })).status, 200, host);
      assert.equal((await req(s.port, 'GET', '/', { host })).status, 200, host);
    }
    // a same-origin write on a local name still passes the CSRF check
    const own = await req(s.port, 'PUT', '/api/v1/settings', { host: `tower.local:${s.port}`, origin: `http://tower.local:${s.port}`, body: { theme: 'dark' } });
    assert.equal(own.status, 200);
  } finally { s.close(); }
});

test('VESTIGO_ALLOWED_HOSTS (or PLAYTRACKER_ALLOWED_HOSTS) and the CORS origin let a proxy domain in', async () => {
  const s = await start();
  try {
    const host = 'vestigo.example.com';
    assert.equal((await req(s.port, 'GET', '/api/v1/games', { host })).status, 403);
    process.env.PLAYTRACKER_ALLOWED_HOSTS = 'vestigo.example.com';
    assert.equal((await req(s.port, 'GET', '/api/v1/games', { host })).status, 200, 'the old name works too');
    assert.equal((await req(s.port, 'GET', '/api/v1/games', { host: 'other.example.com' })).status, 403);
    // the warning names the variable already in use
    assert.ok(s.lines.some((l) => l.level === 'warn' && /other\.example\.com.*PLAYTRACKER_ALLOWED_HOSTS=other\.example\.com/.test(l.msg)));
    process.env.VESTIGO_ALLOWED_HOSTS = '.example.com';
    assert.equal((await req(s.port, 'GET', '/api/v1/games', { host: 'other.example.com' })).status, 200);
    delete process.env.VESTIGO_ALLOWED_HOSTS; delete process.env.PLAYTRACKER_ALLOWED_HOSTS;
    process.env.VESTIGO_CORS_ORIGIN = 'https://vestigo.example.com';
    assert.equal((await req(s.port, 'GET', '/api/v1/games', { host })).status, 200);
    delete process.env.VESTIGO_CORS_ORIGIN;
  } finally {
    for (const k of VARS) delete process.env[k];
    s.close();
  }
});

test('with a password the Host is not checked (a rebound page has no session cookie)', async () => {
  const s = await start({ password: 'secret-pass' });
  try {
    const host = 'vestigo.example.com';
    assert.equal((await req(s.port, 'GET', '/', { host })).status, 200);
    assert.equal((await req(s.port, 'GET', '/api/v1/games', { host })).status, 401, 'refused by the login, not the name');
    const st = JSON.parse((await req(s.port, 'GET', '/api/v1/auth/status', { host })).body);
    assert.equal(st.auth_enabled, true);
    assert.equal(s.lines.filter((l) => l.level === 'warn').length, 0);
  } finally { s.close(); }
});
