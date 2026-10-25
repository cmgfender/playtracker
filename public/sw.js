// Offline shell: static assets cache-first, API network-first with cached fallback.
// A new VERSION makes `activate` delete every other cache (e.g. the pre-rename 'pt-v1').
// Every SHELL file must exist: one failed request fails the whole install.
const VERSION = 'vestigo-v1';
const SHELL = ['/', '/app.css', '/app.js', '/charts.js', '/pages.js', '/favicon.svg', '/icon.svg', '/icon-180.png', '/icon-192.png', '/manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    if (/\/(export|backup)/.test(url.pathname)) return;
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))));
    return;
  }
  // revalidate with the server every time (cheap: ETag -> 304) so an update shows up at once
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(url.pathname.includes('.') ? e.request : '/', copy)); }
    return res;
  }).catch(() => caches.match(url.pathname.includes('.') ? e.request : '/')));
});
