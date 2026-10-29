import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { openDb, SCHEMA_VERSION } from './db.js';
import { Backups, backupBeforeUpgrade } from './services/backup.js';
import { WeeklySummary } from './services/digest.js';
import { Igdb } from './services/igdb.js';
import { sendSummary } from './services/webhook.js';
import { Settings } from './services/settings.js';
import { SyncService } from './services/sync.js';
import { lifetime } from './services/stats.js';
import { Auth, parseCookies } from './auth.js';
import { Router } from './router.js';
import { registerRoutes } from './api/routes.js';
import { HttpError } from './util.js';
import { ensureRollupTimezone, flushRollups, rebuildRollups } from './services/rollup.js';
import { createLogger, asLogger } from './logger.js';
import { env, envSource, dataDir, resolveDbFile } from './env.js';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
// the commit the image was built from (CI sets it), so diagnostics say exactly which build runs
const REVISION = /^[0-9a-f]{7,40}$/i.test(env('REVISION', '')) ? env('REVISION').slice(0, 7) : null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

/** Accept-Encoding allows `coding` (RFC 9110 §12.5.3: q=0 means "not acceptable"; a named coding overrides *). */
function acceptsEncoding(header, coding) {
  let any = false;
  for (const part of String(header || '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim());
    const q = params.find((p) => p.startsWith('q='));
    const ok = !q || Number(q.slice(2)) > 0;
    if (name === coding) return ok;
    if (name === '*') any = ok;
  }
  return any;
}

/** If-None-Match matches `etag`: "*" or any entry of the list, W/ ignored (weak comparison, RFC 9110 §13.1.2). */
const etagMatches = (header, etag) => !!header && (header.trim() === '*' || header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag));

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/**
 * Static files are read once and kept compressed in memory: each encoding the first time a
 * browser asks for it, on the thread pool (brotli at quality 9 takes about a quarter of a second
 * for the whole app, which would otherwise hold up every request after a restart).
 */
function staticServer(dir, { dev }) {
  const cache = new Map();
  const load = (file) => {
    if (!dev && cache.has(file)) return cache.get(file);
    let raw;
    try { raw = fs.readFileSync(file); } catch { return null; }
    const ext = path.extname(file);
    const entry = {
      raw, type: MIME[ext] || 'application/octet-stream',
      compressible: /text|json|svg|javascript|manifest/.test(MIME[ext] || ''),
      etag: `"${raw.length.toString(36)}-${Buffer.from(String(fs.statSync(file).mtimeMs)).toString('base64url').slice(-8)}"`,
    };
    cache.set(file, entry);
    return entry;
  };
  const encoded = (f, coding) => (f[coding] ??= (coding === 'br' ? brotli(f.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : gzip(f.raw, { level: 9 })));
  return async (req, res, pathname) => {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return false; } // malformed %-escapes
    if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA fallback
    const file = path.normalize(path.join(dir, rel));
    if (file !== dir && !file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)) return false;
    const f = load(file);
    if (!f) return false;
    const headers = {
      'Content-Type': f.type, ETag: f.etag, Vary: 'Accept-Encoding',
      // app code revalidates (ETag) so a container update reaches browsers immediately
      'Cache-Control': /\.(html|js|css|webmanifest)$/.test(rel) ? 'no-cache' : 'public, max-age=3600',
    };
    if (etagMatches(req.headers['if-none-match'], f.etag)) { res.writeHead(304, headers); res.end(); return true; }
    const ae = req.headers['accept-encoding'];
    let body = f.raw;
    const coding = !f.compressible ? null : acceptsEncoding(ae, 'br') ? 'br' : acceptsEncoding(ae, 'gzip') ? 'gzip' : null;
    const packed = coding && await encoded(f, coding === 'br' ? 'br' : 'gz').catch(() => null);
    if (packed) { body = packed; headers['Content-Encoding'] = coding; }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}

async function readBody(req, limit = 256 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function sendJson(req, res, status, data) {
  let body = Buffer.from(JSON.stringify(data));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (body.length > 1024 && acceptsEncoding(req.headers['accept-encoding'], 'gzip')) {
    body = zlib.gzipSync(body, { level: 5 });
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

export const DEFAULT_PORT = 7720;

/**
 * dbFile: undefined = from the environment and the data folder (resolveDbFile).
 * password: undefined = VESTIGO_PASSWORD / PLAYTRACKER_PASSWORD; passwordEnv names the variable a given one stands for.
 */
export function createApp({ dbFile, password, passwordEnv, log: rawLog, scheduler = true, dev = process.env.NODE_ENV === 'development' } = {}) {
  const log = rawLog ? asLogger(rawLog) : createLogger();
  if (password === undefined) { password = env('PASSWORD'); passwordEnv ??= envSource('PASSWORD'); }
  dbFile ??= resolveDbFile({ log: log.scoped('db') });
  backupBeforeUpgrade(dbFile, SCHEMA_VERSION, log.scoped('backup'));
  const db = openDb(dbFile);
  log.attachDb(db);
  const settings = new Settings(db);
  const sync = new SyncService({ db, settings, log });
  const backups = new Backups({ db, dbFile, settings, log: log.scoped('backup') });
  const weekly = new WeeklySummary({ db, settings, log: log.scoped('webhook'), send: sendSummary });
  const igdb = new Igdb({ db, settings, log: log.scoped('igdb') });
  const auth = new Auth({ db, settings, envPassword: password, envName: passwordEnv });
  const router = new Router();
  const http_ = { requests: 0, errors: 0, client_errors: 0, started_at: Date.now(), slow: 0 };
  const app = { db, dbFile, settings, sync, backups, weekly, igdb, auth, log, version: pkg.version, revision: REVISION, router, http: http_, rebuildRollups: () => rebuildRollups(db) };
  const apiLog = log.scoped('api');
  const t0 = Date.now();
  const rolled = ensureRollupTimezone(db, settings, log.scoped('rollup'));
  if (rolled > 1000) log.scoped('rollup').info(`Indexed ${rolled} sessions in ${Date.now() - t0}ms`);
  registerRoutes(router, app);
  router.get('/api/openapi.json', () => router.openapi({ title: 'Vestigo API', version: pkg.version, description: 'Vestigo Media Tracker — self-hosted playtime and session tracking' }), { summary: 'OpenAPI document', public: true, hidden: true });
  const serveStatic = staticServer(PUBLIC_DIR, { dev });
  const trustProxy = env('SECURE_COOKIE') === 'true';

  const handler = async (req, res) => {
    let url;
    // a request target that is not a URL ("//[") is the client's error, not a server one
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Bad request'); }
    const pathname = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    if (pathname === '/metrics') return metrics(req, res, url);
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
      if (!(await serveStatic(req, res, pathname))) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); }
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);

    let m;
    try { m = router.match(req.method, pathname); } catch { return sendJson(req, res, 400, { error: 'Malformed URL' }); }
    if (!m) return sendJson(req, res, 404, { error: 'Not found' });
    if (m.methodNotAllowed) { res.setHeader('Allow', m.allow.join(', ')); return sendJson(req, res, 405, { error: 'Method not allowed' }); }
    const cookies = parseCookies(req.headers.cookie);
    const who = auth.identify(req, cookies, url);
    if (!who.ok && !m.route.doc.public) return sendJson(req, res, 401, { error: 'Unauthorized' });
    // CSRF: browser writes (cookie login, or an instance without a password) must come from our
    // own origin or the configured CORS origin. Token requests are not sent by browsers on their own.
    if (who.via !== 'token' && !['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      let originHost = null;
      try { originHost = new URL(req.headers.origin).host; } catch { /* "null" or garbage */ }
      const cors = env('CORS_ORIGIN');
      const allowed = cors && req.headers.origin === cors;
      if (originHost !== host && !allowed) return sendJson(req, res, 403, { error: 'Cross-origin request blocked' });
    }

    flushRollups(db); // no-op unless sessions changed outside a request (cheap queue check)
    let sent = false;
    const ctx = {
      req, res, params: m.params, query: Object.fromEntries(url.searchParams), cookies, auth: who, body: {}, rawBody: '', rawType: null,
      setCookie(name, value, maxAge) {
        res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${trustProxy ? '; Secure' : ''}`);
      },
      stream(status, type, headers = {}) {
        sent = true;
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
      },
      sendRaw(status, body, type, headers = {}) {
        sent = true;
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
        res.end(body);
      },
    };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
        // big bodies only where they belong (imports), and never before authentication
        const buf = await readBody(req, m.route.doc.bigBody ? 256 * 1024 * 1024 : m.route.doc.public ? 64 * 1024 : 4 * 1024 * 1024);
        ctx.rawBuffer = buf; // binary uploads (ZIP exports)
        const raw = m.route.doc.binary ? '' : buf.toString('utf8');
        ctx.rawBody = raw;
        const type = String(req.headers['content-type'] || '');
        // text bodies (CSV imports, license lists) stay in rawBody; body is always an object, so a
        // route reading c.body.x never meets a string
        if (/csv|text\/plain/.test(type)) ctx.rawType = 'csv';
        else if (raw.trim()) {
          try { ctx.body = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON body'); }
        }
        if (ctx.body === null || typeof ctx.body !== 'object') ctx.body = {};
      }
      const t = Date.now();
      http_.requests++;
      const out = await m.route.handler(ctx);
      if (req.method !== 'GET') flushRollups(db);
      if (!sent) sendJson(req, res, 200, out ?? { ok: true });
      const ms = Date.now() - t;
      if (ms > 3000) {
        http_.slow++;
        const q = new URLSearchParams(url.search);
        q.delete('api_key'); // never log credentials
        apiLog.warn(`Slow request ${req.method} ${pathname} took ${ms}ms`, { query: q.toString() || undefined });
      }
      else if (process.env.LOG_REQUESTS === 'true') apiLog.info(`${req.method} ${pathname} ${ms}ms`);
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      if (status >= 500) {
        http_.errors++;
        // 502 = upstream platform failure (already logged by the sync service)
        if (status !== 502) apiLog.error(`${req.method} ${pathname} failed: ${err.message}`, err);
      } else http_.client_errors++;
      if (!sent && !res.headersSent) {
        // the rest of an oversized upload is left unread: the connection cannot be reused
        if (status === 413) res.setHeader('Connection', 'close');
        sendJson(req, res, status, { error: err.message || 'Internal error', details: err.details });
      } else if (!res.writableEnded) res.destroy(); // a stream cut short must not look complete
    }
  };

  function corsHeaders() {
    const origin = env('CORS_ORIGIN');
    if (!origin) return {};
    return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };
  }

  function metrics(req, res, url) {
    const who = auth.identify(req, parseCookies(req.headers.cookie), url);
    if (!who.ok) { res.writeHead(401); return res.end('Unauthorized'); }
    const l = lifetime(db);
    const accounts = db.prepare('SELECT id, platform, name, last_sync_at, last_status FROM accounts').all();
    const series = (p) => [
      `# HELP ${p}_playtime_minutes_total Lifetime playtime in minutes`, `# TYPE ${p}_playtime_minutes_total gauge`,
      `${p}_playtime_minutes_total ${l.total_minutes}`,
      ...l.platforms.map((x) => `${p}_playtime_minutes{platform="${x.platform}"} ${x.minutes}`),
      `# TYPE ${p}_tracked_minutes_total gauge`, `${p}_tracked_minutes_total ${l.tracked_minutes}`,
      `# TYPE ${p}_sessions_total gauge`, `${p}_sessions_total ${l.sessions}`,
      `# TYPE ${p}_games_total gauge`, `${p}_games_total ${l.games}`,
      `# TYPE ${p}_account_last_sync_seconds gauge`,
      ...accounts.map((a) => `${p}_account_last_sync_seconds{id="${a.id}",platform="${a.platform}",status="${a.last_status || 'never'}"} ${Math.floor((a.last_sync_at || 0) / 1000)}`),
    ];
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    // the same series under the old playtracker_ names, so existing dashboards keep working (deprecated, kept until 2.0)
    res.end([...series('vestigo'), ...series('playtracker')].join('\n') + '\n');
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      apiLog.error('Unhandled request error', err);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    });
  });
  server.on('clientError', (err, socket) => { socket.destroy(); });
  if (scheduler) { sync.start(); backups.start(); weekly.start(); igdb.start(); }
  let closed = false;
  return {
    server, app,
    close: () => {
      if (closed) return;
      closed = true;
      sync.stop();
      backups.stop();
      weekly.stop();
      igdb.stop();
      server.close();
      log.detachDb();
      try { db.close(); } catch { /* already closed */ }
    },
  };
}

/**
 * Running as root in a container (Unraid default): make the data dir owned by PUID:PGID,
 * then drop privileges - no external tools (gosu/su-exec) needed.
 */
export function prepareDataDir(dir, log) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
    log.error(`Cannot create data directory ${dir}: ${err.message}`);
    process.exit(1);
  }
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const uid = Number(process.env.PUID);
  const gid = Number(process.env.PGID);
  if (isRoot && Number.isInteger(uid) && Number.isInteger(gid) && process.env.PUID !== '0') {
    const chownTree = (p) => {
      try { fs.chownSync(p, uid, gid); } catch { /* best effort (e.g. NFS) */ }
      let st;
      try { st = fs.statSync(p); } catch { return; }
      if (st.isDirectory()) for (const f of fs.readdirSync(p)) chownTree(path.join(p, f));
    };
    chownTree(dir);
    try {
      process.setgid(gid);
      process.setuid(uid);
      log.info(`Running as uid ${uid} / gid ${gid}`);
    } catch (err) {
      log.warn(`Could not switch to PUID ${uid} / PGID ${gid} (${err.message}); continuing as root`);
    }
  }
  try { fs.accessSync(dir, fs.constants.W_OK); } catch {
    log.error(`Data directory ${dir} is not writable by uid ${process.getuid?.()}. Fix the host folder permissions or set PUID/PGID (Unraid: 99/100).`);
    process.exit(1);
  }
}

/** Listen on the preferred port; when it's taken (host networking) try the next ones. */
export function listen(server, port, log, { attempts = 20, host = '0.0.0.0' } = {}) {
  return new Promise((resolve, reject) => {
    let p = port;
    const tryListen = () => {
      server.once('error', onError);
      server.listen(p, host, () => { server.off('error', onError); resolve(p); });
    };
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && env('PORT_FALLBACK') !== 'false' && p < port + attempts) {
        log.warn(`Port ${p} is already in use, trying ${p + 1}`);
        p++;
        tryListen();
      } else reject(err);
    };
    tryListen();
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const log = createLogger();
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception - exiting so the container restarts cleanly', err);
    setTimeout(() => process.exit(1), 200);
  });
  process.on('unhandledRejection', (err) => log.error('Unhandled promise rejection', err instanceof Error ? err : new Error(String(err))));
  process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') log.warn(`Node warning: ${w.message}`); });

  const port = Number(process.env.PORT || env('PORT') || DEFAULT_PORT);
  prepareDataDir(dataDir(), log);
  let instance;
  try {
    instance = createApp({ log });
  } catch (err) {
    log.error('Failed to start (database could not be opened or migrated)', err);
    process.exit(1);
  }
  listen(instance.server, port, log).then((actual) => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    log.info(`Vestigo ${pkg.version}${REVISION ? ` (${REVISION})` : ''} ready on port ${actual} (TZ=${tz}, db=${instance.app.dbFile})`);
    for (const ip of lanAddresses()) log.info(`  → http://${ip}:${actual}`);
    if (tz === 'UTC' && !process.env.TZ) log.warn('TZ is not set - daily stats use UTC. Set the TZ variable (e.g. America/New_York).');
  }).catch((err) => {
    log.error(`Could not listen on port ${port}: ${err.message}`);
    process.exit(1);
  });
  const shutdown = (sig) => { log.info(`${sig} received, shutting down`); instance.close(); setTimeout(() => process.exit(0), 300); };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
