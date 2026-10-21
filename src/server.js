import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { Settings } from './services/settings.js';
import { SyncService } from './services/sync.js';
import { lifetime } from './services/stats.js';
import { Auth, parseCookies } from './auth.js';
import { Router } from './router.js';
import { registerRoutes } from './api/routes.js';
import { HttpError } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

/** Static files are read once and kept pre-compressed in memory. */
function staticServer(dir, { dev }) {
  const cache = new Map();
  const load = (file) => {
    if (!dev && cache.has(file)) return cache.get(file);
    let raw;
    try { raw = fs.readFileSync(file); } catch { return null; }
    const ext = path.extname(file);
    const compressible = /text|json|svg|javascript|manifest/.test(MIME[ext] || '');
    const entry = {
      raw, type: MIME[ext] || 'application/octet-stream',
      br: compressible ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }) : null,
      gz: compressible ? zlib.gzipSync(raw, { level: 9 }) : null,
      etag: `"${raw.length.toString(36)}-${Buffer.from(String(fs.statSync(file).mtimeMs)).toString('base64url').slice(-8)}"`,
    };
    cache.set(file, entry);
    return entry;
  };
  return (req, res, pathname) => {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA fallback
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir)) return false;
    const f = load(file);
    if (!f) return false;
    const headers = {
      'Content-Type': f.type, ETag: f.etag, Vary: 'Accept-Encoding',
      'Cache-Control': rel === '/index.html' || rel === '/sw.js' ? 'no-cache' : 'public, max-age=3600',
    };
    if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); res.end(); return true; }
    const ae = String(req.headers['accept-encoding'] || '');
    let body = f.raw;
    if (f.br && /\bbr\b/.test(ae)) { body = f.br; headers['Content-Encoding'] = 'br'; } else if (f.gz && /\bgzip\b/.test(ae)) { body = f.gz; headers['Content-Encoding'] = 'gzip'; }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };
}

async function readBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(req, res, status, data) {
  let body = Buffer.from(JSON.stringify(data));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    body = zlib.gzipSync(body, { level: 5 });
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

export function createApp({ dbFile = process.env.PLAYTRACKER_DB || path.join(process.env.PLAYTRACKER_DATA || './data', 'playtracker.db'), password = process.env.PLAYTRACKER_PASSWORD, log = console, scheduler = true, dev = process.env.NODE_ENV === 'development' } = {}) {
  const db = openDb(dbFile);
  const settings = new Settings(db);
  const sync = new SyncService({ db, settings, log });
  const auth = new Auth({ db, settings, envPassword: password });
  const router = new Router();
  const app = { db, settings, sync, auth, version: pkg.version, router };
  registerRoutes(router, app);
  router.get('/api/openapi.json', () => router.openapi({ title: 'PlayTracker API', version: pkg.version, description: 'Self-hosted game playtime & session tracker' }), { summary: 'OpenAPI document', public: true, hidden: true });
  const serveStatic = staticServer(PUBLIC_DIR, { dev });
  const trustProxy = process.env.PLAYTRACKER_SECURE_COOKIE === 'true';

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    if (pathname === '/metrics') return metrics(req, res, url);
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      if (!serveStatic(req, res, pathname)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); }
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    for (const [k, v] of Object.entries(corsHeaders())) res.setHeader(k, v);

    const m = router.match(req.method, pathname);
    if (!m) return sendJson(req, res, 404, { error: 'Not found' });
    if (m.methodNotAllowed) return sendJson(req, res, 405, { error: 'Method not allowed' });
    const cookies = parseCookies(req.headers.cookie);
    const who = auth.identify(req, cookies, url);
    if (!who.ok && !m.route.doc.public) return sendJson(req, res, 401, { error: 'Unauthorized' });
    // CSRF: cookie-authenticated writes must come from our own origin
    if (who.via === 'cookie' && req.method !== 'GET' && req.headers.origin) {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      if (new URL(req.headers.origin).host !== host) return sendJson(req, res, 403, { error: 'Cross-origin request blocked' });
    }

    let sent = false;
    const ctx = {
      req, res, params: m.params, query: Object.fromEntries(url.searchParams), cookies, auth: who, body: {}, rawBody: '', rawType: null,
      setCookie(name, value, maxAge) {
        res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${trustProxy ? '; Secure' : ''}`);
      },
      sendRaw(status, body, type, headers = {}) {
        sent = true;
        res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
        res.end(body);
      },
    };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
        const raw = await readBody(req);
        ctx.rawBody = raw;
        const type = String(req.headers['content-type'] || '');
        if (/csv|text\/plain/.test(type)) { ctx.rawType = 'csv'; ctx.body = raw; } else if (raw.trim()) {
          try { ctx.body = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON body'); }
        }
        if (ctx.body === null || typeof ctx.body !== 'object') ctx.body = ctx.rawType ? ctx.body : {};
      }
      const out = await m.route.handler(ctx);
      if (!sent) sendJson(req, res, 200, out ?? { ok: true });
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      if (status >= 500) log.error?.(`[api] ${req.method} ${pathname}:`, err);
      if (!sent && !res.headersSent) sendJson(req, res, status, { error: err.message || 'Internal error', details: err.details });
    }
  };

  function corsHeaders() {
    const origin = process.env.PLAYTRACKER_CORS_ORIGIN;
    if (!origin) return {};
    return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };
  }

  function metrics(req, res, url) {
    const who = auth.identify(req, parseCookies(req.headers.cookie), url);
    if (!who.ok) { res.writeHead(401); return res.end('Unauthorized'); }
    const l = lifetime(db);
    const lines = [
      '# HELP playtracker_playtime_minutes_total Lifetime playtime in minutes', '# TYPE playtracker_playtime_minutes_total gauge',
      `playtracker_playtime_minutes_total ${l.total_minutes}`,
      ...l.platforms.map((p) => `playtracker_playtime_minutes{platform="${p.platform}"} ${p.minutes}`),
      '# TYPE playtracker_tracked_minutes_total gauge', `playtracker_tracked_minutes_total ${l.tracked_minutes}`,
      '# TYPE playtracker_sessions_total gauge', `playtracker_sessions_total ${l.sessions}`,
      '# TYPE playtracker_games_total gauge', `playtracker_games_total ${l.games}`,
      '# TYPE playtracker_account_last_sync_seconds gauge',
      ...db.prepare('SELECT id, platform, name, last_sync_at, last_status FROM accounts').all().map((a) => `playtracker_account_last_sync_seconds{id="${a.id}",platform="${a.platform}",status="${a.last_status || 'never'}"} ${Math.floor((a.last_sync_at || 0) / 1000)}`),
    ];
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(lines.join('\n') + '\n');
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      log.error?.(err);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    });
  });
  if (scheduler) sync.start();
  return { server, app, close: () => { sync.stop(); server.close(); db.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || process.env.PLAYTRACKER_PORT || 8080);
  const { server, close } = createApp();
  server.listen(port, '0.0.0.0', () => console.log(`PlayTracker ${pkg.version} listening on :${port} (TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone})`));
  const shutdown = () => { console.log('Shutting down'); close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
