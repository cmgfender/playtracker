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

/** axe-core's browser bundle (a local or global `axe-core` install), or null: the built-in check stands in. */
function loadAxe() {
  if (process.env.VESTIGO_E2E_NO_AXE) return null; // try the built-in check
  for (const from of [() => require.resolve('axe-core/axe.min.js'), () => `${execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()}/axe-core/axe.min.js`]) {
    try { const f = from(); if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8'); } catch { /* not installed */ }
  }
  return null;
}
const AXE = loadAxe();

/**
 * Form controls without an accessible name ('label', 'select-name', toggles and comboboxes) and
 * interactive elements nested in one another ('nested-interactive'), in the page as it is now
 * (open dialogs included). axe-core when installed, else an equivalent built-in check.
 * Returns ['rule: element html', …].
 */
export async function labelViolations(page) {
  if (AXE) {
    if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ content: AXE });
    return page.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: ['label', 'select-name', 'nested-interactive', 'aria-toggle-field-name', 'aria-input-field-name', 'button-name', 'aria-allowed-attr', 'aria-required-attr', 'aria-valid-attr-value', 'aria-required-children'] });
      return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 140)}`));
    });
  }
  return page.evaluate(() => {
    const out = [];
    const name = (el) => {
      if (el.getAttribute('aria-label')?.trim()) return true;
      const by = el.getAttribute('aria-labelledby');
      if (by && by.split(/\s+/).some((id) => document.getElementById(id)?.textContent.trim())) return true;
      if ([...(el.labels || [])].some((l) => l.textContent.trim())) return true;
      return !!(el.getAttribute('title')?.trim() || el.getAttribute('placeholder')?.trim());
    };
    for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=button]):not([type=submit]), select, textarea, [role=combobox], [role=radiogroup]')) {
      if (el.closest('[inert], [aria-hidden="true"]')) continue;
      if (!name(el)) out.push(`label: ${el.outerHTML.slice(0, 140)}`);
    }
    for (const el of document.querySelectorAll('button, [role=button], [role=radio], [role=option]')) {
      if (el.closest('[inert], [aria-hidden="true"]')) continue;
      if (!(el.getAttribute('aria-label')?.trim() || el.textContent.trim() || el.getAttribute('title'))) out.push(`button-name: ${el.outerHTML.slice(0, 140)}`);
    }
    const interactive = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=radio], [role=option], [tabindex]:not([tabindex="-1"])';
    for (const el of document.querySelectorAll('a[href], button, [role=button], [role=option]')) {
      if (el.closest('[inert], [aria-hidden="true"]')) continue;
      if (el.querySelector(interactive)) out.push(`nested-interactive: ${el.outerHTML.slice(0, 140)}`);
    }
    return out;
  });
}
export const axeLoaded = !!AXE;

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

// environment switches that would change what the UI shows (secure cookies, CORS, a password from
// the shell) are cleared, under both names the app reads (VESTIGO_X, else PLAYTRACKER_X)
for (const k of ['CORS_ORIGIN', 'SECURE_COOKIE', 'PASSWORD', 'LOG_FILE'].flatMap((x) => [`VESTIGO_${x}`, `PLAYTRACKER_${x}`])) delete process.env[k];

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
export async function openPage(browser, origin, { viewport = DESKTOP, colorScheme = 'dark', storage, reducedMotion, serviceWorkers = 'block' } = {}) {
  const phone = viewport.width < 600;
  // the app registers its service worker on 127.0.0.1 (a secure context): blocked unless a test is about it
  const ctx = await browser.newContext({
    viewport, colorScheme, locale: 'en-US', timezoneId: TZ, acceptDownloads: true, serviceWorkers,
    ...(reducedMotion ? { reducedMotion } : {}),
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

/**
 * Wait until the SPA finished rendering the current route: the new #view is shown and no longer
 * aria-busy (the page being left stays on screen, without an id, until then), no skeleton, a heading.
 */
export async function waitView(page, timeout = 8000) {
  await page.waitForFunction(viewReady, null, { timeout });
}
/** In the page: true once the current route has rendered (see waitView). */
export function viewReady() {
  const v = document.querySelector('#view') || document.querySelector('#login-form');
  if (!v) return false;
  if (v.id === 'login-form') return true;
  if (v.hidden || v.getAttribute('aria-busy') === 'true' || document.querySelector('.main.leaving')) return false;
  if (v.querySelector('.skel')) return false;
  return !!v.querySelector('h1, .empty h2');
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
 * On a touch screen a dialog keeps focus on its title (no keyboard popping up) unless it opts in.
 */
export async function modalReady(page) {
  await page.locator('.modal').last().waitFor();
  await page.waitForFunction(() => {
    const m = [...document.querySelectorAll('.modal')].pop();
    if (!m) return false;
    const first = m.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea');
    const title = m.querySelector('.mh h2');
    if (matchMedia('(pointer: coarse)').matches && document.activeElement === title) return new Promise((r) => setTimeout(() => r(document.activeElement === title || document.activeElement === first), 80));
    return !first || document.activeElement === first;
  }, null, { timeout: 3000 });
}
/** Mark every toast currently on screen as seen (call before an action whose toast text repeats). */
export const markToasts = (page) => page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((x) => x.setAttribute('data-e2e-seen', ''))).catch(() => {});

/**
 * WCAG contrast ratio of two sRGB colours: [r, g, b] arrays (0-255) or rgb() / rgba() strings.
 * Anything else (oklab(), color(srgb …), what color-mix() computes to) must be resolved with srgb()
 * first: reading its numbers as RGB gives nonsense, so it throws instead.
 */
export function contrast(a, b) {
  const parse = (c) => {
    if (Array.isArray(c)) return c.slice(0, 3);
    if (!/^rgba?\(/.test(String(c).trim())) throw new Error(`contrast(): ${c} is not sRGB, resolve it with srgb() first`);
    return (String(c).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  };
  const lum = (rgb) => { const [r, g, b2] = rgb.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b2; };
  const [l1, l2] = [lum(parse(a)), lum(parse(b))].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Resolve CSS colours of any syntax to sRGB [r, g, b, a] (0-255, alpha 0-1) the way a canvas paints them. */
export function srgb(page, colors) {
  return page.evaluate((list) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    return list.map((c) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    });
  }, colors);
}

// While sampling: no transitions or animations; a sampled element's ink (text, icons) or fill is hidden.
const PROBE_CSS = `*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}
[data-e2e-hide],[data-e2e-hide] *{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;text-decoration-color:transparent!important}
svg[data-e2e-hide],[data-e2e-hide] svg,text[data-e2e-hide],[data-e2e-fill]{visibility:hidden!important}`;
const probeStyle = (page) => page.evaluate((css) => {
  if (document.getElementById('e2e-probe')) return;
  const s = document.createElement('style');
  s.id = 'e2e-probe'; s.textContent = css;
  document.head.append(s);
}, PROBE_CSS);

/**
 * Contrast of what elements draw against the pixels actually painted behind them, so gradients,
 * accent tints, translucent bars and blur count as painted. `specs`: [{ sel, fill?, ring? }], the
 * first match of each selector.
 * - text: the element's own text box (an SVG: the icon's box; SVG text: its fill) with its ink hidden; the worst pixel counts
 * - fill: the element itself (e.g. a switch track) against what is around it
 * - ring: the element is focused to read its focus ring (outline on the element, a switch's track or
 *   a tile's cover), then the band the ring covers is measured unfocused
 * All samples on screen together share one screenshot. Returns [{ ratio, fg, bg, … } | null if absent].
 */
export async function sampleContrasts(page, specs) {
  await probeStyle(page);
  // 1. colours and focus rings of everything, before any ink is hidden (computed styles are live)
  const info = await page.evaluate((list) => list.map((s) => {
    const el = document.querySelector(s.sel);
    if (!el) return null;
    // SVG text (chart labels) is inked by its fill
    if (!s.ring) return { color: getComputedStyle(el)[s.fill ? 'backgroundColor' : el instanceof SVGTextElement ? 'fill' : 'color'] };
    el.focus({ preventScroll: true });
    const ringEl = el.matches('.switch input') ? el.nextElementSibling : el.matches('.tile') ? el.querySelector('.cover') : el;
    const cs = getComputedStyle(ringEl);
    const out = { color: cs.outlineColor, focusVisible: el.matches(':focus-visible'), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) || 0, offset: parseFloat(cs.outlineOffset) || 0 };
    el.blur();
    return out;
  }), specs);
  const results = info.map((x) => (x && x.style === 'none' ? { ...x, ratio: 0, fg: '', bg: '' } : null));
  let pending = info.map((x, i) => i).filter((i) => info[i] && !results[i]);
  try {
    for (let round = 0; pending.length && round <= specs.length; round++) {
      // 2. the boxes on screen now; hide their ink (scroll to the next one when none is)
      const batch = await page.evaluate(([list, todo]) => {
        const box = (s) => {
          const el = document.querySelector(s.sel);
          const target = s.ring ? (el.matches('.switch input') ? el.nextElementSibling : el.matches('.tile') ? el.querySelector('.cover') : el) : el;
          let r = target.getBoundingClientRect();
          if (!s.ring && !s.fill && !(el instanceof SVGElement)) {
            // the element's own text, not its icons or differently coloured children
            let l = Infinity; let t = Infinity; let rt = -Infinity; let b = -Infinity;
            const range = document.createRange();
            for (const n of el.childNodes) {
              if (n.nodeType !== 3 || !n.textContent.trim()) continue;
              range.selectNodeContents(n);
              for (const q of range.getClientRects()) { l = Math.min(l, q.left); t = Math.min(t, q.top); rt = Math.max(rt, q.right); b = Math.max(b, q.bottom); }
            }
            if (rt > l) r = { left: l, top: t, width: rt - l, height: b - t };
          }
          return { el, x: r.left, y: r.top, w: r.width, h: r.height };
        };
        const ready = [];
        const later = [];
        for (const i of todo) {
          const s = list[i];
          const b = box(s);
          const pad = s.ring ? s.offset + s.width : 0;
          const onScreen = b.w > 0 && b.x - pad >= 0 && b.y - pad >= 0 && b.x + b.w + pad <= innerWidth && b.y + b.h + pad <= innerHeight;
          (onScreen ? ready : later).push([i, b]);
        }
        if (!ready.length) { later[0][1].el.scrollIntoView({ block: 'center' }); return { ready: [] }; }
        for (const [i, b] of ready) if (!list[i].ring) b.el.setAttribute(list[i].fill ? 'data-e2e-fill' : 'data-e2e-hide', '');
        return { ready: ready.map(([i, b]) => ({ i, x: b.x, y: b.y, w: b.w, h: b.h })) };
      }, [specs.map((s, i) => ({ ...s, ...(info[i] || {}) })), pending]);
      if (!batch.ready.length) continue;
      // 3. one screenshot of the area they cover, judged in the page (pixels never leave it)
      const reach = (b) => { const s = specs[b.i]; const p = s.ring ? info[b.i].offset + info[b.i].width : 0; return [b.x - p, b.y - p, b.x + b.w + p, b.y + b.h + p]; };
      const edges = batch.ready.map(reach);
      const clip = { x: Math.max(0, Math.floor(Math.min(...edges.map((e) => e[0])))), y: Math.max(0, Math.floor(Math.min(...edges.map((e) => e[1])))) };
      clip.width = Math.ceil(Math.max(...edges.map((e) => e[2]))) - clip.x;
      clip.height = Math.ceil(Math.max(...edges.map((e) => e[3]))) - clip.y;
      const png = await page.screenshot({ clip, scale: 'css', animations: 'disabled', caret: 'hide' });
      const judged = await page.evaluate(async ([b64, at, items]) => {
        const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const cv = new OffscreenCanvas(bmp.width, bmp.height);
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(bmp, 0, 0);
        const px = cx.getImageData(0, 0, bmp.width, bmp.height).data;
        const k = bmp.width / at.width; // device pixels per CSS pixel
        const probe = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
        const rgba = (c) => { probe.clearRect(0, 0, 1, 1); probe.fillStyle = c; probe.fillRect(0, 0, 1, 1); const d = probe.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
        const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
        return items.map(({ i, x, y, w, h, color, ring, offset, width }) => {
          const fg = rgba(color);
          const p = ring ? offset + width : 0;
          const inside = (cxp, cyp, d) => cxp > x - d && cxp < x + w + d && cyp > y - d && cyp < y + h + d;
          let best = null;
          for (let py = Math.floor((y - p - at.y) * k); py < Math.ceil((y + h + p - at.y) * k); py++) {
            for (let pxx = Math.floor((x - p - at.x) * k); pxx < Math.ceil((x + w + p - at.x) * k); pxx++) {
              if (pxx < 0 || py < 0 || pxx >= bmp.width || py >= bmp.height) continue;
              const cxp = at.x + (pxx + 0.5) / k; const cyp = at.y + (py + 0.5) / k;
              if (ring ? !(inside(cxp, cyp, offset + width) && !inside(cxp, cyp, offset)) : !inside(cxp, cyp, 0)) continue;
              const o = (py * bmp.width + pxx) * 4;
              const bg = [px[o], px[o + 1], px[o + 2]];
              const f = bg.map((v, j) => fg[j] * fg[3] + v * (1 - fg[3]));
              const r = ratio(f, bg);
              if (!best || r < best.ratio) best = { ratio: r, fg: hex(f), bg: hex(bg) };
            }
          }
          return { i, ...(best || { ratio: Infinity, fg: hex(fg), bg: '' }) };
        });
      }, [png.toString('base64'), clip, batch.ready.map((b) => ({ ...b, ...info[b.i], ring: !!specs[b.i].ring }))]);
      for (const j of judged) results[j.i] = { ...info[j.i], ...j };
      const done = new Set(judged.map((j) => j.i));
      pending = pending.filter((i) => !done.has(i));
    }
  } finally {
    await page.evaluate(() => document.querySelectorAll('[data-e2e-hide],[data-e2e-fill]').forEach((el) => { el.removeAttribute('data-e2e-hide'); el.removeAttribute('data-e2e-fill'); }));
  }
  return results;
}

/** One sample of sampleContrasts(): the element's ink (or `fill`) against what is painted behind it. */
export const inkContrast = async (page, sel, opts = {}) => (await sampleContrasts(page, [{ sel, ...opts }]))[0];
/** One focus-ring sample of sampleContrasts(): { focusVisible, style, width, ratio, fg, bg }. */
export const ringContrast = async (page, sel) => (await sampleContrasts(page, [{ sel, ring: true }]))[0];

/**
 * Achievements for an entry, as a provider would store them (there is no API to push them): two
 * unlocked during the game's latest tracked session (one rare), one during its estimated history
 * when it has some, one without a session, one locked and one locked and hidden. Returns what was
 * stored and when the session-bound ones were unlocked.
 */
export async function seedAchievements(ok, db, gameId) {
  const g = await ok(`/games/${gameId}`);
  const entry = g.entries.find((e) => e.account_id) || g.entries[0];
  const play = (await ok(`/sessions?game_id=${gameId}&limit=1`)).items[0];
  const est = (await ok(`/sessions?game_id=${gameId}&kind=estimate&limit=1`)).items[0];
  const mid = (s) => { const a = s.started_at ?? s.window_start ?? s.window_end; const b = s.ended_at ?? s.window_end; return Math.round((a + b) / 2); };
  const t = play ? mid(play) : Date.now() - HOUR;
  const items = [
    { id: 'A1', name: 'Shrine Seeker', description: 'Clear your first shrine', unlocked: true, unlocked_at: t - 60_000, rarity: 4.2, points: null },
    { id: 'A2', name: 'Paraglider', description: 'Leave the Great Sky Island', unlocked: true, unlocked_at: t, rarity: 61.5 },
    ...(est ? [{ id: 'A3', name: 'Old Friend', description: 'Before tracking began', unlocked: true, unlocked_at: mid(est), rarity: 33 }] : []),
    { id: 'A4', name: 'Undated', description: 'The platform kept no time', unlocked: true, unlocked_at: null, rarity: 80 },
    { id: 'A5', name: 'Master Sword', description: 'Pull the sword', unlocked: false, rarity: 12.3 },
    { id: 'A6', name: 'Secret Ending', description: 'What happens after the credits', unlocked: false, hidden: true, rarity: 1.1 },
  ];
  const { storeAchievements, ACH_VERSION } = await import('../../../src/services/achievements.js');
  storeAchievements(db, entry.id, items);
  db.prepare('UPDATE entries SET ach_v = ?, ach_at = ? WHERE id = ?').run(ACH_VERSION, Date.now(), entry.id);
  return { entryId: entry.id, sessionId: play?.id ?? null, items, unlockedAt: t };
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

/** Every chart on the page: its SVG's role, label and scale, and the boxes of its axis text (CSS px). */
export const chartReport = (page) => page.evaluate(() => [...document.querySelectorAll('#view .chart > svg, #view .donut-wrap > svg')].map((svg) => {
  const host = svg.closest('.chart') || svg.parentElement;
  const vb = svg.viewBox.baseVal;
  const r = svg.getBoundingClientRect();
  const hb = host.getBoundingClientRect();
  const scale = r.width / vb.width;
  return {
    kind: String(host.className), role: svg.getAttribute('role'), label: svg.getAttribute('aria-label') || '', hostW: host.clientWidth, svgW: r.width,
    heat: host.classList.contains('heat'), donut: !host.classList.contains('chart'), box: { l: hb.left, r: hb.right },
    texts: host.classList.contains('chart') ? [...svg.querySelectorAll('.axis text')].map((t) => {
      const b = t.getBoundingClientRect();
      return { s: t.textContent, px: parseFloat(getComputedStyle(t).fontSize) * scale, l: b.left, r: b.right, t: b.top, b: b.bottom };
    }) : [],
  };
}));
/** What is wrong with the charts of chartReport(): role / label, a stretched drawing, text size, text leaving the box, overlaps. */
export function chartProblems(where, charts) {
  const out = [];
  for (const c of charts) {
    const id = `${where} ${c.kind}`;
    if (c.role !== 'img') out.push(`${id}: role=${c.role}`);
    if (!/\w{3,}.*: \S/.test(c.label) || /undefined|NaN/.test(c.label)) out.push(`${id}: aria-label ${JSON.stringify(c.label)}`);
    if (c.donut) continue;
    if (!c.heat && Math.abs(c.svgW - c.hostW) > 1) out.push(`${id}: drawn ${c.svgW}px wide in a ${c.hostW}px box`);
    for (const t of c.texts) {
      if (Math.abs(t.px - 11) > 1) out.push(`${id}: "${t.s}" renders at ${t.px.toFixed(1)}px`);
      if (!c.heat && (t.l < c.box.l - 1 || t.r > c.box.r + 1)) out.push(`${id}: "${t.s}" leaves the chart (${Math.round(t.l)}-${Math.round(t.r)} of ${Math.round(c.box.l)}-${Math.round(c.box.r)})`);
    }
    for (let i = 0; i < c.texts.length; i++) {
      for (let j = i + 1; j < c.texts.length; j++) {
        const a = c.texts[i]; const b = c.texts[j];
        if (Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5) out.push(`${id}: "${a.s}" and "${b.s}" overlap`);
      }
    }
  }
  return out;
}
