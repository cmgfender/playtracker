// Offline shell: static assets revalidated (cached as fallback), API network-first with a cached fallback.
// A new VERSION makes `activate` delete every other cache (e.g. the pre-rename 'pt-v1').
// Every SHELL file must exist: one failed request fails the whole install.
const VERSION = 'vestigo-v1';
const SHELL = ['/', '/app.css', '/app.js', '/charts.js', '/pages.js', '/favicon.svg', '/icon.svg', '/icon-180.png', '/icon-192.png', '/manifest.webmanifest'];
// at most this many API answers are kept; only what the offline pages need is cached at all
const API_MAX = 60;

/** The API reads worth keeping for offline use: Home, the first page of the library, a game, the default Stats. */
function cacheable(url) {
  const p = url.pathname.replace(/^\/api\/v1/, '');
  const q = url.searchParams;
  if (['/summary', '/settings', '/accounts', '/stats/lifetime'].includes(p)) return !url.search;
  if (/^\/games\/\d+$/.test(p)) return true;
  if (p === '/games') return !q.get('q') && (q.get('offset') || '0') === '0';
  if (p === '/stats') return (q.get('range') || '30d') === '30d' && !q.get('platform') && !q.get('game_id');
  return false;
}

/** Keep the newest API_MAX API answers (the cache lists them oldest first). */
async function trim(cache) {
  const api = (await cache.keys()).filter((r) => new URL(r.url).pathname.startsWith('/api/'));
  await Promise.all(api.slice(0, Math.max(0, api.length - API_MAX)).map((r) => cache.delete(r)));
}

/** A cached answer, marked with the time it was fetched so the app can say "showing data from 14:02". */
async function fromCache(req) {
  const hit = await caches.match(req);
  if (!hit) return new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  const headers = new Headers(hit.headers);
  headers.set('X-Vestigo-Offline', headers.get('X-Vestigo-Cached-At') || String(Date.parse(headers.get('Date')) || Date.now()));
  return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
}

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
// activate also drops API answers an older worker kept that are no longer worth keeping (searches, later pages)
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => caches.open(VERSION)).then(async (c) => {
      for (const r of await c.keys()) { const u = new URL(r.url); if (u.pathname.startsWith('/api/') && !cacheable(u)) await c.delete(r); }
      await trim(c);
    }).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    if (/\/(export|backup)/.test(url.pathname)) return;
    const keep = cacheable(url);
    e.respondWith(fetch(e.request).then((res) => {
      if (keep && res.ok) {
        const headers = new Headers(res.headers);
        headers.set('X-Vestigo-Cached-At', String(Date.now()));
        const copy = res.clone();
        e.waitUntil(copy.blob().then((b) => caches.open(VERSION).then(async (c) => { await c.put(e.request, new Response(b, { status: res.status, headers })); await trim(c); })));
      }
      return res;
    }).catch(() => (keep ? fromCache(e.request) : new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    return;
  }
  // revalidate with the server every time (cheap: ETag -> 304) so an update shows up at once
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(url.pathname.includes('.') ? e.request : '/', copy)); }
    return res;
  }).catch(() => caches.match(url.pathname.includes('.') ? e.request : '/')));
});
