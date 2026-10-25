// Harness for test/suite/ui-e2e.test.js: in-process app, external-network guard, Playwright
// pages that record page errors / console errors / failed requests, and small polling helpers.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createApp } from '../../../src/server.js';

const require = createRequire(import.meta.url);

/**
 * Playwright's Chromium (a local or global `playwright` install), or `skipReason` saying why the
 * browser tests cannot run here (e.g. CI, which runs plain Node with no browser).
 */
function loadChromium() {
  let pw;
  try { pw = require('playwright'); } catch {
    try { pw = require(`${execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()}/playwright`); } catch { /* not installed */ }
  }
  if (!pw?.chromium) return { chromium: null, skipReason: 'Playwright is not installed (npm i -g playwright && npx playwright install chromium)' };
  let exe = '';
  try { exe = pw.chromium.executablePath(); } catch { /* no browser downloaded */ }
  if (!exe || !fs.existsSync(exe)) return { chromium: null, skipReason: 'Playwright\'s Chromium is not installed (npx playwright install chromium)' };
  return { chromium: pw.chromium, skipReason: null };
}
export const { chromium, skipReason } = loadChromium();

export const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const DESKTOP = { width: 1400, height: 900 };
export const PHONE = { width: 390, height: 844 };
export const PHONE_SMALL = { width: 360, height: 740 };
export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const isLocal = (u) => { try { return new URL(u).hostname === '127.0.0.1'; } catch { return false; } };

/** Server-side: any fetch to a non-127.0.0.1 host is recorded and fails (no real network). */
export function installFetchGuard() {
  const real = globalThis.fetch;
  const external = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (isLocal(url)) return real(input, init);
    external.push(url);
    throw new TypeError(`ui-e2e: blocked external fetch to ${url}`);
  };
  return { external, real, restore() { globalThis.fetch = real; } };
}

/** Start an in-memory app on a free port; `api` talks JSON to it (optionally with a cookie). */
export async function startApp({ password = '' } = {}) {
  const inst = createApp({ dbFile: ':memory:', password, log: QUIET, scheduler: false });
  await new Promise((r) => inst.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${inst.server.address().port}`;
  let cookie = '';
  const api = async (path, { method = 'GET', body, headers = {}, raw = false } = {}) => {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (body !== undefined) {
      if (typeof body === 'string') { payload = body; h['content-type'] ||= 'text/csv'; } else { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    }
    const res = await fetch(`${origin}/api/v1${path}`, { method, headers: h, body: payload });
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, body: data, headers: res.headers };
  };
  /** api() that throws on non-2xx (for seeding / reading state). */
  const ok = async (path, opts) => {
    const r = await api(path, opts);
    if (r.status < 200 || r.status >= 300) throw new Error(`${opts?.method || 'GET'} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return {
    inst, app: inst.app, db: inst.app.db, origin, api, ok,
    setCookie(c) { cookie = c; },
    close: () => inst.close(),
  };
}

/** Entries whose sessions do not add up to their lifetime total (must always be empty). */
export function invariantViolations(db) {
  return db.prepare(`SELECT e.id, e.title, e.platform, e.playtime_min, COALESCE(SUM(s.minutes), 0) sessions_min
    FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min`).all();
}

/**
 * A fresh browser context + page. Records page errors, console errors (except failed loads of
 * external resources, which are blocked on purpose), failed local requests, dialogs and
 * external requests. `settle()` waits until no local request is in flight.
 */
export async function openPage(browser, origin, { viewport = DESKTOP, colorScheme = 'dark', storage } = {}) {
  const phone = viewport.width < 600;
  const ctx = await browser.newContext({
    viewport, colorScheme, locale: 'en-US', timezoneId: TZ, acceptDownloads: true,
    ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    ...(storage ? { storageState: storage } : {}),
  });
  const rec = { pageErrors: [], consoleErrors: [], httpErrors: [], external: [], dialogs: [] };
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (isLocal(u) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    rec.external.push(u);
    return route.abort();
  });
  const page = await ctx.newPage();
  page.__e2e = rec; // lets helpers explain failures
  let inflight = 0;
  let lastChange = Date.now();
  const track = (req, d) => { if (isLocal(req.url())) { inflight += d; lastChange = Date.now(); } };
  page.on('request', (r) => track(r, 1));
  page.on('requestfinished', (r) => track(r, -1));
  page.on('requestfailed', (r) => track(r, -1));
  page.on('pageerror', (e) => rec.pageErrors.push(String(e?.stack || e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location()?.url || '';
    // a blocked/failed external image (cover art) is expected and handled by the UI
    if (/Failed to load resource/.test(m.text()) && loc && !isLocal(loc)) return;
    rec.consoleErrors.push(`${m.text()} @ ${loc}`);
  });
  page.on('response', (r) => { if (isLocal(r.url()) && r.status() >= 400) rec.httpErrors.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
  page.on('dialog', (d) => { rec.dialogs.push(`${d.type()}: ${d.message()}`); d.dismiss().catch(() => {}); });
  const settle = async (quietMs = 120, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (inflight <= 0 && Date.now() - lastChange >= quietMs) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  /** Console errors not explained by an allowed local HTTP status (e.g. a deliberate 400). */
  const unexpectedConsole = (allowStatuses = []) => rec.consoleErrors.filter((t) => !allowStatuses.some((s) => t.includes(`status of ${s}`)));
  return { ctx, page, rec, settle, unexpectedConsole, phone, close: () => ctx.close() };
}

/** Wait until the SPA finished rendering the current route (skeleton gone, heading present). */
export async function waitView(page, timeout = 8000) {
  await page.waitForFunction(() => {
    const v = document.querySelector('#view') || document.querySelector('#login-form');
    if (!v) return false;
    if (v.id === 'login-form') return true;
    if (v.querySelector('.skel')) return false;
    return !!v.querySelector('h1, .empty h2');
  }, null, { timeout });
}

/**
 * Width the document needs vs. the viewport (horizontal overflow check). Compare `doc` with `client`
 * (documentElement.clientWidth, the layout viewport): with mobile emulation an overflowing page
 * zooms out and widens innerWidth, so `inner` grows along with the overflow and proves nothing.
 */
export async function overflow(page, width) {
  return page.evaluate((width) => ({
    doc: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, body: document.body.scrollWidth, inner: window.innerWidth,
    // widest offender, for a useful failure message
    culprit: (() => {
      let worst = null; const vw = width || window.innerWidth;
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width && r.right > vw + 1) {
          let p = el.parentElement; let clipped = false;
          while (p) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') { clipped = true; break; } p = p.parentElement; }
          if (!clipped && (!worst || r.right > worst.right)) worst = { right: Math.round(r.right), tag: el.tagName, cls: String(el.className?.baseVal ?? el.className).slice(0, 60), text: (el.textContent || '').trim().slice(0, 40) };
        }
      }
      return worst;
    })(),
  }), width);
}

export async function waitUntil(fn, { timeout = 5000, interval = 50, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${message} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

/**
 * Wait for a NEW toast containing `text` (string or RegExp) and return its text. Toasts stay up
 * for ~3 s, so every toast already seen by an earlier wait is marked and can never match again.
 */
export async function toast(page, text, timeout = 5000) {
  const loc = page.locator('#toasts .toast:not([data-e2e-seen])', { hasText: text });
  try {
    await loc.first().waitFor({ state: 'visible', timeout });
  } catch (err) {
    const shown = await page.locator('#toasts .toast').allInnerTexts().catch(() => []);
    const modal = await page.locator('.modal').allInnerTexts().catch(() => []);
    throw new Error(`no new toast matching ${text} within ${timeout}ms; toasts on screen: ${JSON.stringify(shown)}; failed requests: ${JSON.stringify(page.__e2e?.httpErrors?.slice(-5) || [])}; open dialog: ${JSON.stringify(modal.map((m) => m.slice(0, 160)))}`, { cause: err });
  }
  const t = await loc.first().textContent();
  await markToasts(page);
  return t;
}
/**
 * Wait until the newest dialog has taken its initial focus. The app focuses the first field ~50 ms
 * after a dialog opens; typing before that lets the late focus move keystrokes into another field.
 */
export async function modalReady(page) {
  await page.locator('.modal').last().waitFor();
  await page.waitForFunction(() => {
    const m = [...document.querySelectorAll('.modal')].pop();
    if (!m) return false;
    const first = m.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea');
    return !first || document.activeElement === first;
  }, null, { timeout: 3000 });
}
/** Mark every toast currently on screen as seen (call before an action whose toast text repeats). */
export const markToasts = (page) => page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((x) => x.setAttribute('data-e2e-seen', ''))).catch(() => {});

/** WCAG contrast ratio of two CSS rgb()/rgba() colors. */
export function contrast(a, b) {
  const parse = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const lum = (rgb) => { const [r, g, b2] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b2; };
  const [l1, l2] = [lum(parse(a)), lum(parse(b))].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Seed a realistic library through the public API. Returns ids and expected totals. */
export async function seed(ok, now) {
  const celeste = await ok('/games', { method: 'POST', body: { title: 'Celeste', status: 'playing', cover_url: 'https://cdn.example.invalid/celeste.jpg' } });
  await ok('/sessions', { method: 'POST', body: { game_id: celeste.id, minutes: 90, ended_at: now - 3 * HOUR, note: 'Chapter 7' } });
  await ok('/sessions', { method: 'POST', body: { game_id: celeste.id, minutes: 45, ended_at: now - 27 * HOUR } });
  const hollow = await ok('/games', { method: 'POST', body: { title: 'Hollow Knight', status: 'playing' } });
  await ok('/sessions', { method: 'POST', body: { game_id: hollow.id, minutes: 120, ended_at: now - 50 * HOUR, note: 'Mantis Lords' } });
  const ori = await ok('/games', { method: 'POST', body: { title: 'Ori and the Will of the Wisps', status: 'backlog' } });
  const account = await ok('/accounts', { method: 'POST', body: { platform: 'custom', name: 'Switch', config: { platform_label: 'Switch' } } });
  await ok(`/accounts/${account.id}/report`, { method: 'POST', body: { games: [
    { id: 'totk', title: 'Zelda: TotK', playtime_minutes: 5000, last_played_at: now - 30 * DAY, first_played_at: now - 400 * DAY },
    { id: 'mk8', title: 'Mario Kart 8 Deluxe', playtime_minutes: 600, last_played_at: now - 60 * DAY },
  ] } });
  // a follow-up report a moment later: +12 min (within the wall-clock tolerance) is a real session
  await ok(`/accounts/${account.id}/report`, { method: 'POST', body: { games: [
    { id: 'totk', title: 'Zelda: TotK', playtime_minutes: 5012, last_played_at: now - MIN },
    { id: 'mk8', title: 'Mario Kart 8 Deluxe', playtime_minutes: 600, last_played_at: now - 60 * DAY },
  ] } });
  const imported = await ok('/import', { method: 'POST', body: 'title,platform,playtime_hours,last_played,status,rating\nHades,switch,42,2025-11-02,completed,10\nStardew Valley,import,80,2025-12-20,,\n' });
  const games = (await ok('/games?limit=100&hidden=all')).items;
  const id = (t) => games.find((g) => g.title === t)?.id;
  return {
    account, imported,
    ids: { celeste: celeste.id, hollow: hollow.id, ori: ori.id, zelda: id('Zelda: TotK'), mk8: id('Mario Kart 8 Deluxe'), hades: id('Hades'), stardew: id('Stardew Valley') },
    minutes: { celeste: 135, hollow: 120, ori: 0, zelda: 5012, mk8: 600, hades: 2520, stardew: 4800 },
  };
}
