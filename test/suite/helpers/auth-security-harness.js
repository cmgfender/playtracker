// Test harness for test/suite/auth-security.test.js (self-contained: no shared helpers).
import http from 'node:http';
import net from 'node:net';
import { createApp } from '../../../src/server.js';

export const QUIET = { info() {}, warn() {}, error() {}, debug() {} };

/** A logger that records everything (to verify what is logged server-side). */
export function recordingLog() {
  const lines = [];
  const rec = (level) => (...args) => lines.push({ level, args });
  return { lines, log: { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') } };
}

/**
 * Start an in-process PlayTracker on a random port.
 * opts.password: undefined = take PLAYTRACKER_PASSWORD from the environment (createApp default).
 */
export async function startApp(opts = {}) {
  const args = { dbFile: opts.dbFile || ':memory:', log: opts.log || QUIET, scheduler: false };
  if ('password' in opts) args.password = opts.password;
  const inst = createApp(args);
  await new Promise((r) => inst.server.listen(0, '127.0.0.1', r));
  const port = inst.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const api = `${origin}/api/v1`;
  let closed = false;
  return {
    inst, port, origin, api, db: inst.app.db,
    close() {
      if (closed) return;
      closed = true;
      inst.server.closeAllConnections?.(); // never leave half-read uploads keeping the process alive
      inst.close();
    },
  };
}

/**
 * fetch wrapper. o: { method, body (object -> JSON, string/Buffer -> raw), type, headers, cookie, token, origin }
 * Returns { status, headers, text, json, setCookie }.
 */
export async function call(url, o = {}) {
  const headers = { ...(o.headers || {}) };
  let body;
  if (o.body !== undefined) {
    if (typeof o.body === 'string' || Buffer.isBuffer(o.body)) body = o.body;
    else body = JSON.stringify(o.body);
    headers['Content-Type'] ||= o.type || 'application/json';
  }
  if (o.cookie) headers.Cookie = o.cookie;
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  if (o.origin) headers.Origin = o.origin;
  const res = await fetch(url, { method: o.method || (body !== undefined ? 'POST' : 'GET'), headers, body });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json, setCookie: res.headers.get('set-cookie') };
}

/** "pt_session=abc; Path=/; ..." -> "pt_session=abc" */
export const cookiePair = (setCookie) => String(setCookie || '').split(';')[0];

export function cookieAttrs(setCookie) {
  const parts = String(setCookie || '').split(';').map((s) => s.trim());
  const [nv, ...rest] = parts;
  const i = nv.indexOf('=');
  const attrs = {};
  for (const a of rest) {
    const k = a.split('=')[0].toLowerCase();
    attrs[k] = a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
  }
  return { name: nv.slice(0, i), value: nv.slice(i + 1), attrs };
}

/**
 * Raw HTTP request over node:http (the path is sent exactly as given, no client-side
 * normalisation). Resolves { status, headers, body } or { error: code }.
 */
export function rawHttp(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const h = { ...headers };
    if (body !== undefined) h['Content-Length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        req.destroy(); // the server may answer before reading the whole body: do not linger
      });
      res.on('error', (e) => resolve({ error: e.code || e.message }));
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    req.end(body);
  });
}

/** Write raw bytes to the server and collect whatever comes back until close/timeout. */
export function rawSocket(port, text, waitMs = 400) {
  return new Promise((resolve) => {
    let buf = '';
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    s.on('data', (d) => { buf += d; });
    s.on('error', () => {});
    s.on('close', () => resolve(buf));
    setTimeout(() => s.destroy(), waitMs);
  });
}

/** Temporarily set environment variables (undefined deletes); returns a restore function. */
export function setEnv(vars) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
}

/** Shift the in-process clock (Date.now) by offsetMs; returns a restore function. */
export function shiftClock(offsetMs) {
  const real = Date.now;
  Date.now = () => real.call(Date) + offsetMs;
  return () => { Date.now = real; };
}

/**
 * Replace globalThis.fetch for everything that is not 127.0.0.1 with handler(url, init) ->
 * Response | Promise<Response>. Local calls pass through. Returns { calls, restore }.
 */
export function mockExternalFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const u = new URL(url);
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return real(input, init);
    calls.push({ url, init });
    const out = await handler(url, init);
    if (!out) return new Response('not mocked', { status: 404 });
    return out;
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

export const jsonResponse = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** entries whose sessions do not add up to their playtime (must always be empty). */
export function brokenEntries(db) {
  return db.prepare(`SELECT e.id, e.playtime_min, COALESCE(SUM(s.minutes),0) s FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id
    GROUP BY e.id HAVING COALESCE(SUM(s.minutes),0) != e.playtime_min`).all();
}

/** Patterns that only appear in a stack trace / internal path disclosure. */
export const STACK_PATTERNS = [/\n\s+at\s/, /\bat\s+\S+\s+\(.*:\d+:\d+\)/, /node:internal/, /file:\/\//, /\/home\/user\//, /\/src\/[\w/]+\.js/, /\.js:\d+:\d+/];
export function leaksStack(text) {
  return STACK_PATTERNS.some((re) => re.test(String(text || '')));
}
