// Vestigo web UI, end to end (Playwright + in-process app, no real network).
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e.test.js
//
// Expectations come from README.md / docs/PLATFORMS.md / the API route summaries and from what
// a correct playtime tracker must do (totals add up, nothing lost or counted twice, bad input
// refused, layout usable on a phone). Known app bugs are `todo` tests named "APP BUG ui-e2e-<n>".
// Without Playwright + Chromium (e.g. CI) every browser suite here is skipped, with the reason;
// the static checks of public/ (name, icons, manifest, service worker) always run.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromium, installFetchGuard, startApp, seed, openPage, waitView, overflow, waitUntil, toast, markToasts, modalReady, contrast,
  invariantViolations, DESKTOP, PHONE, PHONE_SMALL, MIN, HOUR, DAY, skipReason,
} from './helpers/ui-e2e-harness.js';
const UI = { skip: skipReason || false };

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const NOW = Date.now();
const YEAR = new Date(NOW).getFullYear();
const DEFAULT_LAYOUT = 'kpis,live,jump,chart,top,recent,accounts,-heatmap,-backlog';

let browser;
let guard;

before(async () => {
  if (skipReason) return;
  guard = installFetchGuard();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  guard?.restore();
});

/** "137h" / "2.3h" / "1h 30m" / "45m" -> minutes (null if not a duration). */
function parseDuration(text) {
  const t = String(text).replace(/,/g, '').replace(/\s+/g, ' ').trim();
  let m = /^(\d+(?:\.\d+)?)\s?h(?:\s*(\d+)m)?$/.exec(t);
  if (m) return Math.round(Number(m[1]) * 60 + Number(m[2] || 0));
  m = /^(\d+)m$/.exec(t);
  return m ? Number(m[1]) : null;
}
/** A KPI hours value ("137h", "4.5h") is within display rounding of `minutes`. */
function assertHours(text, minutes, label) {
  const shown = Number.parseFloat(String(text).replace(/,/g, ''));
  const h = minutes / 60;
  const tol = h >= 10 ? 0.51 : 0.051;
  assert.ok(Math.abs(shown - h) <= tol, `${label}: shows ${JSON.stringify(text)}, expected about ${h.toFixed(2)}h`);
}
const localInput = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const waitH1 = (page, expected, timeout = 8000) => page.waitForFunction((e) => {
  const v = document.querySelector('#view');
  if (!v || v.querySelector('.skel')) return false;
  const t = v.querySelector('h1')?.textContent.trim() || '';
  return e.startsWith('re:') ? new RegExp(e.slice(3)).test(t) : t === e;
}, expected instanceof RegExp ? `re:${expected.source}` : expected, { timeout });

describe('Vestigo web UI (no password)', UI, () => {
  let S; // started app
  let D; // seeded data

  before(async () => {
    S = await startApp();
    D = await seed(S.ok, NOW);
  });
  after(() => {
    // the server never tried to reach a real platform during any of this
    assert.deepEqual(guard.external, [], 'no server-side request left 127.0.0.1');
    assert.deepEqual(invariantViolations(S.db), [], 'final state: sessions add up to every lifetime total');
    S?.close();
  });

  const assertInvariant = (label) => assert.deepEqual(invariantViolations(S.db), [], `${label}: every entry's sessions must add up to its lifetime total`);
  const game = (id) => S.ok(`/games/${id}`);

  /** Open `path` in a fresh page and wait for the route to render. */
  async function visit(path, opts = {}) {
    const h = await openPage(browser, S.origin, opts);
    await h.page.goto(`${S.origin}${path}`);
    await waitView(h.page);
    await h.settle();
    return h;
  }
  /** Click an internal link / button and wait for the SPA to finish rendering. */
  async function spa(h, locator, h1) {
    await locator.click();
    if (h1) await waitH1(h.page, h1); else await waitView(h.page);
    await h.settle();
  }
  const clean = (h, allow = []) => {
    assert.deepEqual(h.rec.pageErrors, [], 'no uncaught page errors');
    assert.deepEqual(h.unexpectedConsole(allow), [], 'no unexpected console errors');
    assert.deepEqual(h.rec.dialogs, [], 'no unexpected browser dialogs');
  };

  // ------------------------------------------------------------------ every route renders
  // [path, highlighted nav entry, browser tab title]
  const ROUTES = () => [
    ['/', 'Home', 'Vestigo'], ['/library', 'Library', 'Library · Vestigo'], [`/game/${D.ids.celeste}`, 'Library', 'Celeste · Vestigo'],
    [`/game/${D.ids.zelda}`, 'Library', 'Zelda: TotK · Vestigo'], ['/sessions', 'Sessions', 'Sessions · Vestigo'], ['/stats', 'Stats', 'Stats · Vestigo'],
    [`/wrapped/${YEAR}`, null, `${YEAR} in review · Vestigo`], [`/wrapped/${YEAR - 1}`, null, `${YEAR - 1} in review · Vestigo`],
    ['/duplicates', 'Duplicates', 'Duplicates · Vestigo'], ['/history', 'Improve history', 'Improve history · Vestigo'], ['/accounts', 'Accounts', 'Accounts · Vestigo'],
    ['/system', 'System', 'System · Vestigo'], ['/settings', 'Settings', 'Settings · Vestigo'], ['/api', 'API', 'API · Vestigo'], ['/more', null, 'More · Vestigo'],
    ['/this-route-does-not-exist', null, 'Not found · Vestigo'],
  ];
  async function checkRoutes(viewport) {
    const h = await openPage(browser, S.origin, { viewport });
    const problems = [];
    try {
      for (const [path, nav, title] of ROUTES()) {
        await h.page.goto(`${S.origin}${path}`);
        await waitView(h.page);
        await h.settle();
        const text = await h.page.locator('#view').innerText();
        if (/Something went wrong/.test(text)) problems.push(`${path}: shows "Something went wrong": ${text.slice(0, 200)}`);
        if (path === '/this-route-does-not-exist') {
          if (!/Not found/.test(text)) problems.push('unknown route does not say Not found');
          if (await h.page.locator('#view a[href="/"]', { hasText: 'Go home' }).count() !== 1) problems.push('unknown route has no Go home link');
        }
        if (await h.page.title() !== title) problems.push(`${path}: tab title ${JSON.stringify(await h.page.title())}, expected ${JSON.stringify(title)}`);
        const o = await overflow(h.page, viewport.width);
        if (o.doc > viewport.width + 1 || o.body > viewport.width + 1 || o.doc > o.client) problems.push(`${path}: horizontal overflow ${o.doc}px > ${o.client}px of ${viewport.width}px, widest: ${JSON.stringify(o.culprit)}`);
        if (nav && viewport === DESKTOP) {
          const active = (await h.page.locator('.side .nav-link.active').allInnerTexts()).map((x) => x.trim());
          if (!(active.length === 1 && active[0].startsWith(nav))) problems.push(`${path}: sidebar highlights ${JSON.stringify(active)}, expected ${nav}`);
        }
        if (viewport.width < 600) {
          const expected = ['Home', 'Library', 'Sessions', 'Stats'].includes(nav) ? nav : 'More';
          const active = (await h.page.locator('.tabbar a.active').allInnerTexts()).map((x) => x.trim());
          if (JSON.stringify(active) !== JSON.stringify([expected])) problems.push(`${path}: tab bar highlights ${JSON.stringify(active)}, expected ${expected}`);
        }
      }
      clean(h);
      assert.deepEqual(h.rec.httpErrors, [], 'no failed API calls while browsing');
      assert.deepEqual(problems, []);
      // the blocked external cover image falls back to generated art (no broken image left)
      await h.page.goto(`${S.origin}/game/${D.ids.celeste}`);
      await waitView(h.page);
      await h.settle();
      assert.ok(h.rec.external.some((u) => u.includes('cdn.example.invalid')), 'the external cover was requested (and blocked)');
      assert.equal(await h.page.locator('.hero .cover img').count(), 0, 'a cover image that fails to load is removed');
      assert.ok((await h.page.locator('.hero .cover .ph').innerText()).trim().length > 0, 'fallback cover shows the title / initials');
    } finally { await h.close(); }
  }

  test('every route renders at desktop 1400x900 without page errors, console errors or horizontal overflow', () => checkRoutes(DESKTOP));
  test('every route renders at phone 390x844 without page errors, console errors or horizontal overflow', () => checkRoutes(PHONE));
  test('every route renders at a small phone 360x740 without page errors, console errors or horizontal overflow', () => checkRoutes(PHONE_SMALL));

  // the System error-log header and the API endpoint tables (ui-e2e-1, ui-e2e-2), and the platform
  // capability tables on Accounts once "What each platform reports" is open
  for (const vp of [PHONE, PHONE_SMALL]) {
    for (const path of ['/system', '/api', '/accounts']) {
      test(`${path} fits a ${vp.width}px phone screen without horizontal scrolling${path === '/accounts' ? ' (platform details open)' : ''}`, async () => {
        const h = await visit(path, { viewport: vp });
        try {
          for (const d of await h.page.locator('#view details').all()) await d.locator('summary').first().click();
          if (path === '/accounts') assert.ok(await h.page.locator('#view details .cap-table').first().isVisible(), 'platform details are open');
          const o = await overflow(h.page, vp.width);
          assert.ok(o.doc <= vp.width + 1 && o.doc <= o.client, `document is ${o.doc}px wide on a ${vp.width}px screen (layout viewport ${o.client}px); widest element: ${JSON.stringify(o.culprit)}`);
        } finally { await h.close(); }
      });
    }
  }

  test('unknown game id shows a friendly error state instead of a blank page', async () => {
    const h = await visit('/game/987654');
    try {
      const text = await h.page.locator('#view').innerText();
      assert.match(text, /Game not found/);
      assert.equal(await h.page.locator('#view button', { hasText: 'Reload' }).count(), 1);
      clean(h, [404]);
    } finally { await h.close(); }
  });

  // ------------------------------------------------------------------ navigation shell
  test('navigation: sidebar on desktop, tab bar + More page on phone, back button works', async () => {
    const d = await visit('/');
    try {
      assert.ok(await d.page.locator('.side').isVisible(), 'desktop shows the sidebar');
      assert.ok(!(await d.page.locator('.tabbar').isVisible()), 'desktop hides the tab bar');
      assert.ok(!(await d.page.locator('#fab-log').isVisible()), 'desktop hides the floating button');
      // brand lockup: tile + wordmark + "Media tracker" line, a link home
      const side = d.page.locator('.side a.brand');
      assert.equal(await side.getAttribute('href'), '/');
      assert.deepEqual((await side.locator('.brand-word').innerText()).split('\n').map((x) => x.trim()), ['Vestigo', 'Media tracker']);
      assert.equal((await side.locator('.brand-mark').boundingBox()).width, 30, 'sidebar logo tile is 30px');
      assert.equal(await d.page.title(), 'Vestigo');
      await spa(d, d.page.locator('.side a.nav-link', { hasText: 'Sessions' }), 'Sessions');
      assert.equal(new URL(d.page.url()).pathname, '/sessions');
      assert.equal(await d.page.title(), 'Sessions · Vestigo', 'the tab title follows SPA navigation');
      await d.page.goBack();
      await waitH1(d.page, /Good|Late night/);
      assert.equal(await d.page.title(), 'Vestigo', 'and back');
      clean(d);
    } finally { await d.close(); }

    const p = await visit('/', { viewport: PHONE });
    try {
      assert.ok(!(await p.page.locator('.side').isVisible()), 'phone hides the sidebar');
      assert.ok(await p.page.locator('.tabbar').isVisible(), 'phone shows the tab bar');
      assert.ok(await p.page.locator('#fab-log').isVisible(), 'phone shows the floating Log session button');
      assert.ok(!(await p.page.locator('#dash-log').isVisible()), 'desktop-only button is hidden on phone');
      const top = p.page.locator('.topbar a.brand');
      assert.equal((await top.locator('.brand-word').innerText()).trim(), 'Vestigo', 'the top bar has the wordmark without the "Media tracker" line');
      assert.equal(await top.locator('small').count(), 0);
      assert.equal((await top.locator('.brand-mark').boundingBox()).width, 26, 'top bar logo tile is 26px');
      await spa(p, p.page.locator('.tabbar a', { hasText: 'Library' }), 'Library');
      assert.equal(new URL(p.page.url()).pathname, '/library');
      await spa(p, p.page.locator('.tabbar a', { hasText: 'More' }), 'More');
      const links = (await p.page.locator('#view .item .ttl').allInnerTexts()).map((x) => x.trim());
      assert.deepEqual(links, ['Duplicates', 'Accounts', 'Improve history', 'System', 'Settings', 'API', 'Year in review']);
      await spa(p, p.page.locator('#view .item', { hasText: 'Accounts' }), 'Accounts');
      assert.equal(await p.page.title(), 'Accounts · Vestigo');
      await p.page.goBack();
      await waitH1(p.page, 'More');
      assert.equal(await p.page.title(), 'More · Vestigo');
      await p.page.goBack();
      await waitH1(p.page, 'Library');
      assert.equal(await p.page.title(), 'Library · Vestigo');
      // the top bar keeps its height on a short page (the grid used to stretch it)
      await p.page.goto(`${S.origin}/wrapped/2001`);
      await waitView(p.page);
      const bar = Math.round((await p.page.locator('.topbar').boundingBox()).height);
      assert.ok(bar <= 60, `top bar is ${bar}px on an empty Year in review page`);
      clean(p);
    } finally { await p.close(); }
  });

  // ------------------------------------------------------------------ dashboard
  test('dashboard numbers match the data: lifetime includes history, week / 30-day cards only tracked play', async () => {
    const lt = await S.ok('/stats/lifetime');
    const tracked = 90 + 45 + 120 + 12; // every tracked session seeded (manual + synced)
    assert.equal(lt.total_minutes, Object.values(D.minutes).reduce((a, b) => a + b, 0), 'API lifetime = sum of seeded totals');
    const h = await visit('/');
    try {
      const kpi = (label) => h.page.locator('.kpi', { has: h.page.locator('.label', { hasText: label }) });
      assertHours(await kpi('Lifetime').locator('.value').innerText(), lt.total_minutes, 'Lifetime card');
      assert.match(await kpi('Lifetime').locator('.sub').innerText(), new RegExp(`of ${lt.games} games played`));
      const week = parseDuration((await kpi('This week').locator('.value').innerText()).replace(/\s/g, ''));
      assert.ok(week <= tracked + 3, `This week (${week} min) must only count tracked play (<= ${tracked} min), never imported history`);
      const month = Number.parseFloat(await kpi('Last 30 days').locator('.value').innerText());
      assert.ok(month * 60 <= tracked + 3, `Last 30 days card (${month}h) must only count tracked play`);
      const recent = await h.page.locator('.card', { has: h.page.locator('h2', { hasText: 'Recent sessions' }) }).innerText();
      for (const t of ['Celeste', 'Chapter 7', 'Hollow Knight', 'Zelda: TotK']) assert.ok(recent.includes(t), `Recent sessions lists ${t}`);
      assert.ok(!recent.includes('Mario Kart'), 'history-only games never appear as recent sessions');
      const accounts = await h.page.locator('.card', { has: h.page.locator('h2', { hasText: 'Accounts' }) }).innerText();
      assert.match(accounts, /Switch/);
      assert.match(accounts, /API/);
      assert.match(accounts, /Last report/, 'a push account shows when it last reported');
      const wk = await S.ok('/summary').then((x) => x.week);
      const plural = (n, w) => `${n} ${n === 1 ? w : `${w}s`}`;
      assert.equal(await kpi('This week').locator('.sub').innerText(), `${plural(wk.sessions, 'session')} · ${plural(wk.games_played, 'game')}`, 'This week counts are pluralised correctly');
      clean(h);
    } finally { await h.close(); }
  });

  // ------------------------------------------------------------------ library
  test('library: search, platform / status / never-played filters, sort, grid-list switch (persisted), deep links', async () => {
    const h = await visit('/library');
    const { page } = h;
    const titles = async () => {
      await h.settle();
      const grid = await page.locator('#lib-items .lib-grid').count();
      return (await page.locator(grid ? '#lib-items .lib-grid .tile .t' : '#lib-items .lib-list .li .ellipsis').allInnerTexts()).map((x) => x.trim());
    };
    const setOf = async () => new Set(await titles());
    const waitTitles = (pred, message) => waitUntil(async () => pred(await titles()), { message });
    try {
      const all = (await S.ok('/games?limit=500')).items.map((g) => g.title);
      assert.equal(all.length, 7);
      assert.deepEqual(await setOf(), new Set(all), 'library shows every visible game');
      assert.match(await page.locator('#lib-count').innerText(), /^7 games · /);

      await page.locator('#lib-q').fill('cel');
      await waitTitles((t) => t.length === 1 && t[0] === 'Celeste', 'search "cel"');
      assert.equal(new URL(page.url()).searchParams.get('q'), 'cel', 'search is kept in the URL');
      assert.match(await page.locator('#lib-count').innerText(), /^1 game · /);
      await page.locator('#lib-q').fill('zzz-no-such-game');
      await page.locator('#lib-items .empty h2', { hasText: 'No matches' }).waitFor();
      await page.locator('#lib-q').fill('');
      await waitTitles((t) => t.length === 7, 'cleared search');

      await page.locator('#lib-chips [data-plat="custom"]').click();
      await waitTitles((t) => t.length === 2, 'platform filter');
      assert.deepEqual(await setOf(), new Set(['Zelda: TotK', 'Mario Kart 8 Deluxe']), 'Custom filter = games pushed by the custom account');
      assert.equal(new URL(page.url()).searchParams.get('platform'), 'custom');
      await page.locator('#lib-chips [data-plat="manual"]').click();
      await waitTitles((t) => t.includes('Celeste') && !t.includes('Zelda: TotK'), 'manual filter');
      assert.deepEqual(await setOf(), new Set(['Celeste', 'Hollow Knight', 'Ori and the Will of the Wisps']));
      await page.locator('#lib-chips [data-plat=""]').click();
      await waitTitles((t) => t.length === 7, 'All platforms');

      await page.locator('#lib-chips [data-status="playing"]').click();
      await waitTitles((t) => t.length === 2, 'status filter');
      assert.deepEqual(await setOf(), new Set(['Celeste', 'Hollow Knight']));
      await page.locator('#lib-chips [data-status="playing"]').click(); // toggles off
      await waitTitles((t) => t.length === 7, 'status filter off');

      await page.locator('#lib-chips [data-played="false"]').click();
      await waitTitles((t) => t.length === 1, 'never played filter');
      assert.deepEqual(await titles(), ['Ori and the Will of the Wisps']);
      assert.match(await page.locator('#lib-items .tile .m').innerText(), /Unplayed/);
      await page.locator('#lib-chips [data-played="false"]').click();
      await waitTitles((t) => t.length === 7, 'never played off');

      await page.locator('#lib-sort').selectOption('title');
      await waitTitles((t) => t[0] === 'Celeste', 'A-Z sort');
      const az = await titles();
      assert.deepEqual(az, [...az].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })), 'A → Z is alphabetical');
      assert.equal(new URL(page.url()).searchParams.get('sort'), 'title');
      await page.locator('#lib-sort').selectOption('playtime');
      await waitTitles((t) => t[0] === 'Zelda: TotK', 'most played sort');
      const M = D.minutes;
      const minutesOf = (t) => ({ Celeste: M.celeste, 'Hollow Knight': M.hollow, 'Ori and the Will of the Wisps': M.ori, 'Zelda: TotK': M.zelda, 'Mario Kart 8 Deluxe': M.mk8, Hades: M.hades, 'Stardew Valley': M.stardew })[t];
      const mp = (await titles()).map(minutesOf);
      assert.deepEqual(mp, [...mp].sort((a, b) => b - a), 'Most played is ordered by lifetime minutes');

      await page.locator('[data-view="list"]').click();
      await page.locator('#lib-items .lib-list').waitFor();
      assert.equal(await page.locator('#lib-items .lib-grid').count(), 0);
      assert.equal(await page.locator('#lib-items .lib-list .li').count(), 7);
      await waitUntil(async () => (await S.ok('/settings')).library_view === 'list', { message: 'library_view saved' });
      await page.reload();
      await waitView(page);
      await page.locator('#lib-items .lib-list').waitFor();
      assert.equal(await page.locator('#lib-sort').inputValue(), 'playtime', 'the sort in the URL survives a reload');
      await page.locator('[data-view="grid"]').click();
      await page.locator('#lib-items .lib-grid').waitFor();
      await waitUntil(async () => (await S.ok('/settings')).library_view === 'grid', { message: 'library_view back to grid' });

      await page.goto(`${S.origin}/library?q=hollow`);
      await waitView(page);
      await waitTitles((t) => t.length === 1, 'deep link');
      assert.deepEqual(await titles(), ['Hollow Knight']);
      assert.equal(await page.locator('#lib-q').inputValue(), 'hollow');
      clean(h);
    } finally { await h.close(); }
  });

  // ------------------------------------------------------------------ stats
  test('stats: estimated-history toggle and ranges update the URL and match the API', async () => {
    const h = await visit('/stats?range=all');
    const { page } = h;
    const played = async () => {
      await h.settle();
      return page.locator('#st-body .kpi', { has: page.locator('.label', { hasText: 'Played' }) }).locator('.value').innerText();
    };
    try {
      const inc = await S.ok('/stats?range=all&estimates=include');
      const exc = await S.ok('/stats?range=all&estimates=exclude');
      const lt = await S.ok('/stats/lifetime');
      assert.equal(exc.total_minutes, lt.tracked_minutes, 'without history, all-time play = tracked minutes');
      assert.ok(inc.total_minutes > exc.total_minutes, 'history adds dated minutes');
      assertHours(await played(), inc.total_minutes, 'all time incl. history');
      await page.locator('label.switch:has(#st-est) span').click();
      await waitUntil(() => new URL(page.url()).searchParams.get('estimates') === 'exclude', { message: 'estimates=exclude in URL' });
      await waitUntil(async () => Math.abs(Number.parseFloat(await played()) - exc.total_minutes / 60) < 0.06, { message: 'Played KPI without history' });
      await page.locator('#st-range [data-r="7d"]').click();
      await waitUntil(() => new URL(page.url()).searchParams.get('range') === '7d', { message: 'range=7d' });
      const wk = await S.ok('/stats?range=7d&estimates=exclude');
      await waitUntil(async () => Math.abs(Number.parseFloat(await played()) - wk.total_minutes / 60) < 0.06, { message: '7 day KPI' });
      assert.equal(await page.locator('#st-range button.on').innerText(), '7 days');
      assert.ok(await page.locator('#hm svg, #hm .heat, #hm *').count() > 0, 'heatmap rendered');
      clean(h);
    } finally { await h.close(); }
  });

  // ------------------------------------------------------------------ game page
  test('game page: status, rating (toggle), favorite, notes autosave and hide-from-library are saved', async () => {
    const g0 = await S.ok('/games', { method: 'POST', body: { title: 'Detail Lab' } });
    const h = await visit(`/game/${g0.id}`);
    const { page } = h;
    try {
      assert.equal((await page.locator('#view h1').innerText()).trim(), 'Detail Lab');
      await page.locator('#g-status [data-st="beaten"]').click();
      await waitUntil(async () => (await game(g0.id)).status === 'beaten', { message: 'status saved' });
      await page.locator('#g-stars [data-r="8"]').click();
      await waitUntil(async () => (await game(g0.id)).rating === 8, { message: 'rating saved' });
      assert.equal(await page.locator('#g-stars button.on').count(), 4, '4 of 5 stars lit for 8/10');
      await page.locator('#g-stars [data-r="8"]').click(); // same star again clears it
      await waitUntil(async () => (await game(g0.id)).rating === null, { message: 'rating cleared' });
      await page.locator('#g-fav').click();
      await toast(page, 'Added to favorites');
      await waitUntil(async () => (await game(g0.id)).favorite === 1 || (await game(g0.id)).favorite === true, { message: 'favorite saved' });
      await waitView(page);
      await page.locator('#g-notes').fill('Stuck on the second boss');
      await page.locator('#g-notes-st', { hasText: 'Saved' }).waitFor();
      assert.equal((await game(g0.id)).notes, 'Stuck on the second boss');
      await page.locator('label.switch:has(#g-hidden) span').click();
      await toast(page, 'Hidden from library');
      await waitUntil(async () => !!(await game(g0.id)).hidden, { message: 'hidden saved' });
      const lib = await S.ok('/games?limit=500');
      assert.ok(!lib.items.some((g) => g.id === g0.id), 'hidden games leave the library list');
      const hiddenOnly = await S.ok('/games?hidden=only');
      assert.deepEqual(hiddenOnly.items.map((g) => g.id), [g0.id]);
      await page.goto(`${S.origin}/library?hidden=only`);
      await waitView(page);
      await page.locator('#lib-items .tile .t', { hasText: 'Detail Lab' }).waitFor();
      clean(h);
    } finally {
      await h.close();
      await S.ok(`/games/${g0.id}`, { method: 'DELETE' });
    }
  });

  // ------------------------------------------------------------------ add a game
  test('add a game: desktop button and phone FAB; empty title refused; same title re-uses the game; HTML is shown as text', async () => {
    const before = (await S.ok('/games?limit=500&hidden=all')).total;
    const created = [];
    const d = await visit('/library');
    try {
      await d.page.locator('#lib-add').click();
      const m = d.page.locator('.modal', { hasText: 'Add a game' });
      await m.waitFor();
      await modalReady(d.page);
      await m.locator('#ag-save').click();
      await d.settle();
      assert.ok(await m.isVisible(), 'empty title: dialog stays open');
      assert.equal((await S.ok('/games?limit=500&hidden=all')).total, before, 'empty title creates nothing');
      await m.locator('[name=title]').fill('Tunic');
      await m.locator('[name=status]').selectOption('backlog');
      await spa(d, m.locator('#ag-save'), 'Tunic');
      const id = Number(new URL(d.page.url()).pathname.split('/').pop());
      created.push(id);
      const g = await game(id);
      assert.equal(g.title, 'Tunic');
      assert.equal(g.status, 'backlog');
      assert.equal(g.minutes, 0);
      assert.deepEqual(g.platforms, ['manual']);
      assert.equal(await d.page.locator('#g-status button.on').innerText(), 'Backlog');
      // adding a title that already exists joins it instead of creating a duplicate
      await d.page.goto(`${S.origin}/library`);
      await waitView(d.page);
      await d.page.locator('#lib-add').click();
      await modalReady(d.page);
      await d.page.locator('.modal [name=title]').fill('celeste');
      await spa(d, d.page.locator('.modal #ag-save'), 'Celeste');
      assert.equal(new URL(d.page.url()).pathname, `/game/${D.ids.celeste}`, 'lands on the existing Celeste');
      const cel = await S.ok('/games?q=celeste&hidden=all');
      assert.equal(cel.total, 1, 'still one Celeste');
      assert.equal(cel.items[0].minutes, D.minutes.celeste, 'its playtime is untouched');
      clean(d);
    } finally { await d.close(); }

    const p = await visit('/library', { viewport: PHONE });
    try {
      assert.ok(!(await p.page.locator('#lib-add').isVisible()), 'desktop Add button hidden on phone');
      assert.ok(!(await p.page.locator('[data-view="list"]').isVisible()), 'view switch hidden on phone');
      await p.page.locator('#fab-add').click();
      await modalReady(p.page);
      const evil = '<img src=x onerror="window.__xss=1"> Bad "Title" & Co';
      await p.page.locator('.modal [name=title]').fill(evil);
      await p.page.locator('.modal #ag-save').click();
      await waitUntil(() => /\/game\/\d+$/.test(p.page.url()), { message: 'navigated to the new game' });
      await waitView(p.page);
      await p.settle();
      created.push(Number(new URL(p.page.url()).pathname.split('/').pop()));
      assert.equal((await p.page.locator('#view h1').innerText()).trim(), evil.trim(), 'title is shown literally');
      assert.equal(await p.page.locator('#view h1 img').count(), 0, 'no markup injected');
      assert.equal(await p.page.evaluate(() => window.__xss), undefined, 'no script ran');
      const o = await overflow(p.page, PHONE.width);
      assert.ok(o.doc <= PHONE.width + 1, `game page fits the phone (${o.doc}px)`);
      clean(p);
    } finally {
      await p.close();
      for (const id of created) await S.ok(`/games/${id}`, { method: 'DELETE' });
    }
    assertInvariant('after adding games');
  });

  // ------------------------------------------------------------------ log a session
  test('log a session from a game page: quick chips, custom duration, past end time; zero duration refused', async () => {
    const g0 = await S.ok('/games', { method: 'POST', body: { title: 'Session Lab' } });
    const h = await visit(`/game/${g0.id}`);
    const { page } = h;
    try {
      await page.locator('#g-log').click();
      const m = page.locator('.modal', { hasText: 'Log a session' });
      await m.waitFor();
      await modalReady(page);
      assert.match(await m.innerText(), /Session Lab/, 'the dialog names the game');
      await m.locator('[data-quick="90"]').click();
      assert.equal(await m.locator('[name=h]').inputValue(), '1');
      assert.equal(await m.locator('[name=m]').inputValue(), '30');
      await m.locator('[name=note]').fill('Boss rush');
      const t0 = Date.now();
      await m.locator('#log-save').click();
      assert.match(await toast(page, 'Logged'), /Logged 1h 30m of Session Lab/);
      await waitView(page);
      await h.settle();
      let g = await game(g0.id);
      assert.equal(g.minutes, 90);
      assert.equal(g.summary.sessions, 1);
      const s1 = g.sessions[0];
      assert.equal(s1.minutes, 90);
      assert.equal(s1.source, 'manual');
      assert.equal(s1.note, 'Boss rush');
      assert.ok(Math.abs(s1.ended_at - t0) < 2 * MIN, 'default end time is now');
      assert.equal(s1.ended_at - s1.started_at, 90 * MIN, 'start = end - duration');
      assert.equal(await page.locator('.hero .big').innerText(), '1h 30m', 'hero shows the new lifetime');
      assert.match(await page.locator('#g-sessions').innerText(), /Boss rush/);

      // zero duration is refused
      await page.locator('#g-log').click();
      await m.waitFor();
      await modalReady(page);
      await m.locator('[name=h]').fill('0');
      await m.locator('[name=m]').fill('0');
      await m.locator('#log-save').click();
      await toast(page, 'Enter a duration');
      assert.equal((await game(g0.id)).summary.sessions, 1, 'nothing logged');
      // 2h 5m that ended two days ago at 20:00 local time
      const end = new Date(NOW - 2 * DAY); end.setHours(20, 0, 0, 0);
      await m.locator('[name=h]').fill('2');
      await m.locator('[name=m]').fill('5');
      await m.locator('[name=ended]').fill(localInput(end.getTime()));
      await m.locator('#log-save').click();
      await toast(page, 'Logged 2h 5m');
      g = await game(g0.id);
      assert.equal(g.minutes, 215);
      const s2 = g.sessions.find((s) => s.minutes === 125);
      assert.equal(s2.ended_at, end.getTime(), 'the chosen end time is stored exactly');
      assert.equal(s2.started_at, end.getTime() - 125 * MIN);
      clean(h);
    } finally { await h.close(); }
    assertInvariant('after logging sessions');
  });

  test('log a session from the Sessions page: game picker, "add as new game", no game refused; phone uses the FAB', async () => {
    const target = await S.ok('/games', { method: 'POST', body: { title: 'Picker Target' } });
    const h = await visit('/sessions');
    const { page } = h;
    let extra = null;
    try {
      const count = async () => Number((await page.locator('#s-count').innerText()).match(/^([\d,]+) session/)[1].replace(/,/g, ''));
      const n0 = (await S.ok('/sessions')).total;
      assert.equal(await count(), n0, 'session count matches the API');
      await page.locator('#s-log').click();
      const m = page.locator('.modal', { hasText: 'Log a session' });
      await m.waitFor();
      await modalReady(page);
      await m.locator('#log-save').click();
      await toast(page, 'Pick a game first');
      await m.locator('#gp').fill('Picker Tar');
      await m.locator('[data-pick]', { hasText: 'Picker Target' }).click();
      await waitUntil(async () => (await m.locator('#gp').inputValue()) === 'Picker Target', { message: 'picked game fills the field' });
      await m.locator('[data-quick="30"]').click();
      await m.locator('#log-save').click();
      await toast(page, 'Logged 30m of Picker Target');
      await waitUntil(async () => (await count()) === n0 + 1, { message: 'list reloaded with the new session' });
      assert.equal((await game(target.id)).minutes, 30);

      await page.locator('#s-log').click();
      await m.waitFor();
      await modalReady(page);
      await m.locator('#gp').fill('Brand New From Picker');
      await m.locator('[data-new]').click();
      await waitUntil(async () => (await m.locator('#gp').inputValue()) === 'Brand New From Picker', { message: 'new game picked' });
      await m.locator('[name=h]').fill('0');
      await m.locator('[name=m]').fill('45');
      await m.locator('#log-save').click();
      await toast(page, 'Logged 45m of Brand New From Picker');
      const found = await S.ok('/games?q=Brand%20New%20From%20Picker');
      assert.equal(found.total, 1, 'exactly one new game was created');
      extra = found.items[0].id;
      assert.equal(found.items[0].minutes, 45);
      await waitUntil(async () => (await count()) === n0 + 2, { message: 'two new sessions listed' });
      clean(h);
    } finally { await h.close(); }

    const p = await visit('/sessions', { viewport: PHONE });
    try {
      assert.ok(!(await p.page.locator('#s-log').isVisible()), 'desktop button hidden on phone');
      await p.page.locator('#fab-log').click();
      await p.page.locator('.modal', { hasText: 'Log a session' }).waitFor();
      const o = await overflow(p.page, PHONE.width);
      assert.ok(o.doc <= PHONE.width + 1, `log dialog fits the phone (${o.doc}px)`);
      await p.page.keyboard.press('Escape');
      await p.page.locator('.modal').waitFor({ state: 'detached' });
      clean(p);
    } finally {
      await p.close();
      await S.ok(`/games/${target.id}`, { method: 'DELETE' });
      if (extra) await S.ok(`/games/${extra}`, { method: 'DELETE' });
    }
    assertInvariant('after logging from the Sessions page');
  });

  // ------------------------------------------------------------------ edit / delete sessions
  test('edit a manual session (minutes, note, count-in-stats), reject end before start, delete it; bulk delete', async () => {
    const g0 = await S.ok('/games', { method: 'POST', body: { title: 'Edit Lab' } });
    const s0 = await S.ok('/sessions', { method: 'POST', body: { game_id: g0.id, minutes: 45, ended_at: NOW - 5 * HOUR, note: 'first try' } });
    const h = await visit('/sessions');
    const { page } = h;
    const modal = page.locator('.modal', { hasText: 'Edit Lab' });
    const openEdit = async () => { await page.locator(`[data-edit-session="${s0.id}"]`).click(); await modal.waitFor(); await modalReady(page); };
    try {
      await page.locator('#s-q').fill('Edit Lab');
      await waitUntil(async () => (await page.locator('#s-list .item').count()) === 1, { message: 'filtered to one session' });
      await openEdit();
      assert.equal(await modal.locator('[name=minutes]').inputValue(), '45');
      await modal.locator('[name=minutes]').fill('60');
      await modal.locator('[name=note]').fill('second try');
      await modal.locator('#s-save').click();
      await toast(page, 'Session updated');
      await waitUntil(async () => /second try/.test(await page.locator('#s-list').innerText()), { message: 'list shows the edit' });
      assert.match(await page.locator('#s-list .item .amt').innerText(), /^1h$/);
      let s = await S.ok(`/sessions/${s0.id}`);
      assert.equal(s.minutes, 60);
      assert.equal(s.note, 'second try');
      assert.equal((await game(g0.id)).minutes, 60, 'lifetime follows the edited minutes');
      assertInvariant('after editing minutes');

      // end before start is refused and nothing changes
      const beforeBad = await S.ok(`/sessions/${s0.id}`);
      await openEdit();
      const ended = await modal.locator('[name=ended]').inputValue();
      await modal.locator('[name=started]').fill(localInput(new Date(ended).getTime() + HOUR));
      await modal.locator('#s-save').click();
      assert.match(await toast(page, /after/), /ended_at must be after started_at/);
      assert.ok(await modal.isVisible(), 'dialog stays open on error');
      s = await S.ok(`/sessions/${s0.id}`);
      assert.deepEqual([s.started_at, s.ended_at, s.minutes], [beforeBad.started_at, beforeBad.ended_at, beforeBad.minutes], 'times and minutes unchanged');
      await page.keyboard.press('Escape');

      // "count in stats" off = history: leaves the play list, keeps lifetime
      await openEdit();
      await modal.locator('label.switch:has([name=play]) span').click();
      await modal.locator('#s-save').click();
      await toast(page, 'Session updated');
      await waitUntil(async () => (await page.locator('#s-list .item').count()) === 0, { message: 'session left the play list' });
      assert.equal((await S.ok(`/sessions/${s0.id}`)).kind, 'baseline');
      assert.equal((await game(g0.id)).minutes, 60, 'still counts toward lifetime');
      assert.equal((await S.ok(`/stats?range=all&estimates=exclude&game_id=${g0.id}`)).total_minutes, 0, 'no longer in stats');
      await page.locator('#s-chips [data-kind="baseline"]').click();
      await waitUntil(async () => (await page.locator(`[data-edit-session="${s0.id}"]`).count()) === 1, { message: 'listed under History' });
      await openEdit();
      await modal.locator('label.switch:has([name=play]) span').click();
      await modal.locator('#s-save').click();
      await toast(page, 'Session updated');
      await page.locator('#s-chips [data-kind="baseline"]').click();
      await waitUntil(async () => (await page.locator(`[data-edit-session="${s0.id}"]`).count()) === 1, { message: 'back in the play list' });

      // delete
      await openEdit();
      assert.match(await modal.locator('#s-del').innerText(), /Delete/);
      await modal.locator('#s-del').click();
      await toast(page, 'Session deleted');
      await waitUntil(async () => (await page.locator('#s-list .item').count()) === 0, { message: 'deleted session gone' });
      assert.equal((await S.api(`/sessions/${s0.id}`)).status, 404);
      assert.equal((await game(g0.id)).minutes, 0, 'lifetime drops by the deleted minutes');
      assertInvariant('after deleting');

      // bulk delete two sessions
      const b1 = await S.ok('/sessions', { method: 'POST', body: { game_id: g0.id, minutes: 20, ended_at: NOW - 7 * HOUR } });
      const b2 = await S.ok('/sessions', { method: 'POST', body: { game_id: g0.id, minutes: 25, ended_at: NOW - 8 * HOUR } });
      await page.reload();
      await waitView(page);
      await page.locator('#s-q').fill('Edit Lab');
      await waitUntil(async () => (await page.locator('#s-list .item').count()) === 2, { message: 'two sessions' });
      await page.locator('#s-select').click();
      await page.locator(`[data-sel="${b1.id}"]`).check();
      await page.locator(`[data-sel="${b2.id}"]`).check();
      assert.equal(await page.locator('#s-bulk-n').innerText(), '2 selected');
      await markToasts(page);
      await page.locator('[data-bulk="delete"]').click();
      await page.locator('.modal [data-ok]').click();
      await toast(page, 'Updated');
      await waitUntil(async () => (await page.locator('#s-list .item').count()) === 0, { message: 'bulk deleted' });
      assert.equal((await game(g0.id)).minutes, 0);
      clean(h, [400]);
    } finally {
      await h.close();
      await S.ok(`/games/${g0.id}`, { method: 'DELETE' });
    }
    assertInvariant('after bulk delete');
  });

  test('editing a manual session\'s minutes keeps its start/end times consistent with the new duration', async () => {
    const g0 = await S.ok('/games', { method: 'POST', body: { title: 'Span Lab' } });
    const s0 = await S.ok('/sessions', { method: 'POST', body: { game_id: g0.id, minutes: 45, ended_at: NOW - 6 * HOUR } });
    const h = await visit(`/game/${g0.id}`);
    try {
      await h.page.locator(`[data-edit-session="${s0.id}"]`).click();
      const m = h.page.locator('.modal', { hasText: 'Span Lab' });
      await m.waitFor();
      await modalReady(h.page);
      await m.locator('[name=minutes]').fill('60');
      await m.locator('#s-save').click();
      await toast(h.page, 'Session updated');
      const s = await S.ok(`/sessions/${s0.id}`);
      assert.equal(s.minutes, 60);
      assert.ok(s.precise, 'a manual session has exact times');
      assert.equal((s.ended_at - s.started_at) / MIN, s.minutes, `exact session spans ${(s.ended_at - s.started_at) / MIN} min but counts ${s.minutes} min`);
    } finally { await h.close(); await S.ok(`/games/${g0.id}`, { method: 'DELETE' }); }
  });

  test('a synced session can only be removed from stats: no minutes field, lifetime total unchanged', async () => {
    const zeldaBefore = await game(D.ids.zelda);
    const ltBefore = await S.ok('/stats/lifetime');
    const synced = (await S.ok(`/sessions?source=sync&game_id=${D.ids.zelda}`)).items;
    assert.equal(synced.length, 1, 'the follow-up report created one synced session');
    const sid = synced[0].id;
    const h = await visit('/sessions');
    const { page } = h;
    try {
      await page.locator('#s-chips [data-src="sync"]').click();
      await waitUntil(async () => (await page.locator('#s-list .item').count()) === 1, { message: 'synced filter' });
      await page.locator(`[data-edit-session="${sid}"]`).click();
      const m = page.locator('.modal', { hasText: 'Zelda: TotK' });
      await m.waitFor();
      assert.equal(await m.locator('[name=minutes]').count(), 0, 'synced minutes cannot be edited');
      assert.match(await m.innerText(), /Synced from/);
      assert.match(await m.locator('#s-del').innerText(), /Remove from stats/);
      await m.locator('#s-del').click();
      await toast(page, 'Removed from stats');
      await waitUntil(async () => (await page.locator('#s-list .item').count()) === 0, { message: 'removed from play list' });
      const s = await S.ok(`/sessions/${sid}`);
      assert.equal(s.kind, 'baseline');
      assert.equal(s.minutes, 12);
      assert.equal((await game(D.ids.zelda)).minutes, zeldaBefore.minutes, 'platform lifetime never changes');
      assert.equal((await S.ok('/stats/lifetime')).total_minutes, ltBefore.total_minutes);
      clean(h);
    } finally {
      await h.close();
      await S.ok(`/sessions/${sid}`, { method: 'PATCH', body: { kind: 'play' } }); // restore for later tests
    }
    assertInvariant('after removing a synced session from stats');
  });

  test('history from before tracking: no minutes field or count-in-stats switch, a note edit keeps it history', async () => {
    const acc = await S.ok('/accounts', { method: 'POST', body: { platform: 'custom', name: 'Pre-tracking', config: {} } });
    try {
      await S.ok(`/accounts/${acc.id}/report`, { method: 'POST', body: { games: [{ id: 'ul', title: 'Undated Lab', playtime_minutes: 300 }] } });
      const hist = (await S.ok(`/sessions?account_id=${acc.id}&kind=baseline`)).items.find((s) => s.source === 'inferred');
      assert.ok(hist, 'precondition: the undated history is listed under History');
      const ltBefore = await S.ok('/stats/lifetime');
      const h = await visit('/sessions');
      const { page } = h;
      try {
        await page.locator('#s-chips [data-kind="baseline"]').click();
        await page.locator('#s-q').fill('Undated Lab');
        await waitUntil(async () => (await page.locator('#s-list .item').count()) === 1, { message: 'history filtered to one session' });
        await page.locator(`[data-edit-session="${hist.id}"]`).click();
        const m = page.locator('.modal', { hasText: 'Undated Lab' });
        await m.waitFor();
        await modalReady(page);
        assert.equal(await m.locator('[name=minutes]').count(), 0, 'its minutes are part of the platform total');
        assert.equal(await m.locator('[name=play]').count(), 0, 'history can never be counted as tracked play');
        assert.match(await m.locator('#s-del').innerText(), /Remove from stats/);
        await m.locator('[name=note]').fill('from the old console');
        await m.locator('#s-save').click();
        await toast(page, 'Session updated');
        const s = await S.ok(`/sessions/${hist.id}`);
        assert.deepEqual([s.note, s.kind, s.source, s.minutes], ['from the old console', 'baseline', 'inferred', hist.minutes]);
        const lt = await S.ok('/stats/lifetime');
        assert.deepEqual([lt.total_minutes, lt.tracked_minutes, lt.baseline_minutes], [ltBefore.total_minutes, ltBefore.tracked_minutes, ltBefore.baseline_minutes]);
        clean(h);
      } finally { await h.close(); }
    } finally { await S.ok(`/accounts/${acc.id}`, { method: 'DELETE' }); }
    assertInvariant('after editing pre-tracking history');
  });

  // ------------------------------------------------------------------ customize home
  test('customize home: hide and reorder sections (persists after reload), hide everything, reset', async () => {
    const h = await visit('/');
    const { page } = h;
    const headings = async () => (await page.locator('#view .dash .card-h h2').allInnerTexts()).map((x) => x.trim());
    const row = (label) => page.locator('.modal .layout-row', { hasText: label });
    try {
      const h0 = await headings();
      assert.ok(h0.includes('Recent sessions') && h0.includes('Accounts'), `default home: ${h0}`);
      assert.ok(h0.indexOf('Last 30 days') < h0.indexOf('Accounts'));
      assert.ok(!h0.some((x) => /at a glance/.test(x)), 'heatmap is off by default');
      await page.locator('#dash-custom').click();
      await page.locator('.modal', { hasText: 'Customize home' }).waitFor();
      await row('Recent sessions').locator('label.switch span').click();
      for (let i = 0; i < 3; i++) await row('Accounts').locator('[data-up]').click();
      await row('Year heatmap').locator('label.switch span').click();
      await page.locator('#lay-save').click();
      await page.locator('.modal').waitFor({ state: 'detached' });
      await waitUntil(async () => { const hs = await headings(); return hs.includes('Accounts') && !hs.includes('Recent sessions'); }, { message: 'home re-rendered without Recent sessions' });
      const check = async () => {
        const hs = await headings();
        assert.ok(!hs.includes('Recent sessions'), 'hidden section is gone');
        assert.ok(hs.indexOf('Accounts') < hs.indexOf('Last 30 days'), `Accounts moved above the chart: ${hs}`);
        assert.ok(hs.some((x) => x === `${YEAR} at a glance`), 'heatmap turned on');
      };
      await check();
      const saved = (await S.ok('/settings')).dashboard_layout;
      assert.equal(saved, 'kpis,live,jump,accounts,chart,top,-recent,heatmap,-backlog');
      await page.reload();
      await waitView(page);
      await h.settle();
      await waitUntil(async () => (await headings()).includes('Accounts'), { message: 'home rendered after reload' });
      await check();
      const fresh = await visit('/'); // another device / browser
      try { const hs = (await fresh.page.locator('#view .dash .card-h h2').allInnerTexts()).map((x) => x.trim()); assert.ok(!hs.includes('Recent sessions') && hs.indexOf('Accounts') < hs.indexOf('Last 30 days')); } finally { await fresh.close(); }

      // hide everything -> explanatory message with a way back
      await page.locator('#dash-custom').click();
      await page.locator('.modal', { hasText: 'Customize home' }).waitFor();
      const rows = page.locator('.modal .layout-row');
      const n = await rows.count();
      assert.equal(n, 9, 'all nine home sections are listed');
      for (let i = 0; i < n; i++) if (await rows.nth(i).locator('input[data-on]').isChecked()) await rows.nth(i).locator('label.switch span').click();
      await page.locator('#lay-save').click();
      await page.locator('#view', { hasText: 'Every section is hidden' }).waitFor();
      assert.deepEqual(await headings(), []);
      await page.locator('#dash-custom2').click();
      await page.locator('#lay-reset').click();
      await page.locator('#lay-save').click();
      await waitUntil(async () => (await headings()).includes('Recent sessions'), { message: 'defaults back' });
      assert.equal((await S.ok('/settings')).dashboard_layout, DEFAULT_LAYOUT);
      clean(h);
    } finally {
      await h.close();
      await S.ok('/settings', { method: 'PUT', body: { dashboard_layout: DEFAULT_LAYOUT } });
    }
  });

  // ------------------------------------------------------------------ settings appearance
  test('settings appearance: theme black/light/auto, density, cover size, titles, time format and accent apply and persist', async () => {
    const fmt = await S.ok('/games', { method: 'POST', body: { title: 'Format Lab' } });
    await S.ok('/sessions', { method: 'POST', body: { game_id: fmt.id, minutes: 90, ended_at: NOW - 4 * HOUR } });
    const h = await visit('/settings', { colorScheme: 'light' });
    const { page } = h;
    const root = (k) => page.evaluate((key) => document.documentElement.dataset[key], k);
    const seg = (key, v) => page.locator(`[data-seg="${key}"] [data-v="${v}"]`);
    const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const themeColor = () => page.evaluate(() => document.querySelector('meta[name=theme-color]').content);
    const gridCols = async () => {
      await page.locator('.side a.nav-link', { hasText: 'Library' }).click();
      await waitH1(page, 'Library');
      await page.locator('#lib-items .lib-grid').waitFor();
      const n = await page.evaluate(() => getComputedStyle(document.querySelector('.lib-grid')).gridTemplateColumns.split(' ').length);
      await page.locator('.side a.nav-link', { hasText: 'Settings' }).click();
      await waitH1(page, 'Settings');
      return n;
    };
    try {
      assert.equal(await root('theme'), 'dark', 'default theme is dark');
      await seg('theme', 'black').click();
      await waitUntil(async () => (await root('theme')) === 'black', { message: 'black theme' });
      assert.equal(await bodyBg(), 'rgb(0, 0, 0)', 'black theme is pure black');
      assert.equal(await themeColor(), '#000000');
      await waitUntil(async () => (await S.ok('/settings')).theme === 'black', { message: 'theme saved' });
      await page.reload();
      await waitView(page);
      assert.equal(await root('theme'), 'black', 'theme survives a reload');
      const other = await visit('/', {}); // fresh browser storage: comes from the server
      try { assert.equal(await other.page.evaluate(() => document.documentElement.dataset.theme), 'black'); } finally { await other.close(); }

      await seg('theme', 'light').click();
      await waitUntil(async () => (await root('theme')) === 'light', { message: 'light theme' });
      assert.equal(await bodyBg(), 'rgb(244, 245, 249)');
      assert.equal(await themeColor(), '#f4f5f9');
      // auto follows the system, live
      await seg('theme', 'auto').click();
      await waitUntil(async () => (await S.ok('/settings')).theme === 'auto', { message: 'auto saved' });
      await h.settle(); // the page has applied the saved setting
      const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      assert.equal(await root('theme'), 'light', 'auto + light system = light');
      await frame();
      await page.emulateMedia({ colorScheme: 'dark' });
      await waitUntil(async () => (await root('theme')) === 'dark', { message: 'auto follows the system switching to dark' });
      await frame();
      await page.emulateMedia({ colorScheme: 'light' });
      await waitUntil(async () => (await root('theme')) === 'light', { message: 'and back to light' });

      await seg('ui_density', 'compact').click();
      await waitUntil(async () => (await root('density')) === 'compact', { message: 'compact density' });
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).fontSize), '14px');
      await seg('ui_density', 'comfortable').click();
      await waitUntil(async () => (await root('density')) === 'comfortable', { message: 'comfortable density' });
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).fontSize), '15px');

      const colsM = await gridCols();
      await seg('cover_size', 's').click();
      await waitUntil(async () => (await root('covers')) === 's', { message: 'small covers' });
      const colsS = await gridCols();
      await seg('cover_size', 'l').click();
      await waitUntil(async () => (await root('covers')) === 'l', { message: 'large covers' });
      const colsL = await gridCols();
      assert.ok(colsS > colsM && colsM > colsL, `small covers fit more per row than medium than large (${colsS} > ${colsM} > ${colsL})`);
      await seg('cover_titles', 'always').click();
      await waitUntil(async () => (await root('coverTitles')) === 'always', { message: 'titles on covers' });

      await seg('time_format', 'decimal').click();
      await waitUntil(async () => (await S.ok('/settings')).time_format === 'decimal', { message: 'decimal saved' });
      await page.goto(`${S.origin}/game/${fmt.id}`);
      await waitView(page);
      assert.equal(await page.locator('.hero .big').innerText(), '1.5h', '90 minutes in decimal format');
      await page.goto(`${S.origin}/settings`);
      await waitView(page);
      await seg('time_format', 'hm').click();
      await waitUntil(async () => (await S.ok('/settings')).time_format === 'hm', { message: 'hm saved' });
      await page.goto(`${S.origin}/game/${fmt.id}`);
      await waitView(page);
      assert.equal(await page.locator('.hero .big').innerText(), '1h 30m', '90 minutes in h/m format');

      await page.goto(`${S.origin}/settings`);
      await waitView(page);
      await page.locator('[data-accent="#34d399"]').click();
      await toast(page, 'Accent updated');
      const accent = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--accent').trim());
      assert.equal(await accent(), '#34d399');
      await page.reload();
      await waitView(page);
      assert.equal(await accent(), '#34d399', 'accent survives a reload');
      const tile = await page.evaluate(() => getComputedStyle(document.querySelector('.side .brand-mark')).backgroundImage);
      assert.ok(tile.includes('rgb(118, 86, 255)') && tile.includes('rgb(8, 145, 178)'), `the logo tile keeps the brand gradient whatever the accent (${tile})`);
      assert.equal((await S.ok('/settings')).accent, '#34d399');
      // invalid values are refused by the API (the UI never sends them)
      assert.equal((await S.api('/settings', { method: 'PUT', body: { theme: 'neon' } })).status, 400);
      assert.equal((await S.api('/settings', { method: 'PUT', body: { accent: 'red' } })).status, 400);
      clean(h);
    } finally {
      await h.close();
      await S.ok('/settings', { method: 'PUT', body: { theme: 'dark', ui_density: 'comfortable', cover_size: 'm', cover_titles: 'auto', time_format: 'hm', accent: '#7c5cff' } });
      await S.ok(`/games/${fmt.id}`, { method: 'DELETE' });
    }
  });

  test('settings: home sections editor autosaves; start page opens Library only when launching at /', async () => {
    const h = await visit('/settings');
    const { page } = h;
    try {
      await page.locator('#set-layout .layout-row', { hasText: 'Up next' }).locator('label.switch span').click();
      await toast(page, 'Home layout saved');
      assert.match((await S.ok('/settings')).dashboard_layout, /(^|,)backlog(,|$)/);
      await page.locator('[data-str="start_page"]').selectOption('library');
      await waitUntil(async () => (await S.ok('/settings')).start_page === 'library', { message: 'start page saved' });
      clean(h);
    } finally { await h.close(); }
    const l = await openPage(browser, S.origin);
    try {
      await l.page.goto(`${S.origin}/`);
      await waitH1(l.page, 'Library');
      assert.equal(new URL(l.page.url()).pathname, '/library', 'launching at / opens the start page');
      await spa(l, l.page.locator('.side a.nav-link', { hasText: 'Home' }), /Good|Late night/);
      assert.equal(new URL(l.page.url()).pathname, '/', 'Home stays reachable after launch');
      assert.ok((await l.page.locator('#view .card-h h2').allInnerTexts()).includes('Up next'), 'the section enabled in Settings shows on Home');
      await l.page.goto(`${S.origin}/sessions`);
      await waitH1(l.page, 'Sessions');
      clean(l);
    } finally { await l.close(); }
    const direct = await visit('/stats');
    try { assert.equal(new URL(direct.page.url()).pathname, '/stats', 'deep links are never redirected'); } finally { await direct.close(); }
    await S.ok('/settings', { method: 'PUT', body: { start_page: 'home', dashboard_layout: DEFAULT_LAYOUT } });
  });

  // ------------------------------------------------------------------ dark / light rendering
  test('dark, black and light themes render readable text on every main page (contrast) at desktop and phone', async () => {
    try {
      for (const theme of ['dark', 'black', 'light']) {
        await S.ok('/settings', { method: 'PUT', body: { theme } });
        for (const [viewport, paths] of [[DESKTOP, ['/', '/library', '/settings']], [PHONE, ['/', '/stats']]]) {
          const h = await openPage(browser, S.origin, { viewport });
          try {
            for (const path of paths) {
              await h.page.goto(`${S.origin}${path}`);
              await waitView(h.page);
              await h.settle();
              const c = await h.page.evaluate(() => {
                const cs = (el, p) => getComputedStyle(el)[p];
                const bg = cs(document.body, 'backgroundColor');
                const card = document.querySelector('#view .card, #view .kpi');
                const muted = document.querySelector('#view .page-h p, #view .muted');
                return { theme: document.documentElement.dataset.theme, bg, h1: cs(document.querySelector('#view h1'), 'color'), cardBg: card ? cs(card, 'backgroundColor') : null, muted: muted ? cs(muted, 'color') : null };
              });
              assert.equal(c.theme, theme);
              const lum = (rgb) => contrast(rgb, 'rgb(0,0,0)');
              if (theme === 'light') assert.ok(lum(c.bg) > 15, `${path} light background is light (${c.bg})`);
              else assert.ok(lum(c.bg) < 1.2, `${path} ${theme} background is dark (${c.bg})`);
              assert.ok(contrast(c.h1, c.bg) >= 7, `${theme} ${path}: heading contrast ${contrast(c.h1, c.bg).toFixed(2)} (${c.h1} on ${c.bg})`);
              if (c.muted) assert.ok(contrast(c.muted, c.bg) >= 4.5, `${theme} ${path}: secondary text contrast ${contrast(c.muted, c.bg).toFixed(2)} (${c.muted} on ${c.bg})`);
              if (c.cardBg) assert.notEqual(c.cardBg, c.bg, `${theme} ${path}: cards stand out from the page`);
              const o = await overflow(h.page, viewport.width);
              assert.ok(o.doc <= viewport.width + 1, `${theme} ${path} @${viewport.width}: no horizontal overflow (${o.doc}px)`);
            }
            clean(h);
          } finally { await h.close(); }
        }
      }
    } finally { await S.ok('/settings', { method: 'PUT', body: { theme: 'dark' } }); }
  });

  // ------------------------------------------------------------------ improve history
  test('improve history: "Looks right" pins the estimate exactly, "Don\'t chart" keeps lifetime, Skip is only local', async () => {
    const rev = await S.ok('/history/review');
    const titles = rev.items.map((i) => i.title);
    for (const t of ['Mario Kart 8 Deluxe', 'Hades', 'Stardew Valley']) assert.ok(titles.includes(t), `${t} (only a last-played date) is among the least certain games`);
    assert.ok(!titles.includes('Zelda: TotK'), 'Zelda (first + last played) is dated with confidence and not asked about');
    const mk8 = await game(D.ids.mk8);
    const mk8Entry = mk8.entries[0].id;
    const estimates = () => S.db.prepare("SELECT minutes, window_start, window_end, started_at, ended_at FROM sessions WHERE entry_id = ? AND source = 'inferred' ORDER BY id").all(mk8Entry);
    const estBefore = estimates();
    assert.ok(estBefore.length > 0, 'Mario Kart history is charted as estimates');
    const ltBefore = await S.ok('/stats/lifetime');
    const allBefore = await S.ok('/stats?range=all&estimates=include');
    const h = await visit('/history');
    const { page } = h;
    const row = (t) => page.locator('.hist-row', { has: page.locator('a.ttl', { hasText: t }) });
    try {
      const solid = async () => Number((await page.locator('.card-h b', { hasText: 'solid' }).innerText()).match(/(\d+)%/)[1]);
      const solid0 = await solid();
      assert.equal(await page.locator('.hist-row').count(), Math.min(30, rev.items.length), 'one row per uncertain game');
      assert.match(await page.locator('.card-h', { hasText: 'Least certain first' }).innerText(), new RegExp(`${rev.total} games`));

      await row('Mario Kart 8 Deluxe').locator('[data-confirm]').click();
      await toast(page, 'Kept as guessed');
      await waitUntil(async () => row('Mario Kart 8 Deluxe').locator('[data-confirm]').isDisabled(), { message: 'row disabled after answering' });
      const hist = (await game(D.ids.mk8)).entries[0].history;
      assert.equal(hist.confidence, 'high', 'a confirmed estimate counts as high confidence');
      assert.ok(hist.manual?.confirmed, 'the estimate is pinned');
      assert.deepEqual(estimates(), estBefore, '"Looks right" keeps the estimate exactly as it was');

      await row('Hades').locator('[data-undated]').click();
      await toast(page, 'Kept out of charts');
      const hades = await game(D.ids.hades);
      assert.equal(hades.minutes, D.minutes.hades, 'Hades lifetime unchanged');
      assert.equal(hades.entries[0].history.mode, 'undated');
      const ltAfter = await S.ok('/stats/lifetime');
      assert.equal(ltAfter.total_minutes, ltBefore.total_minutes, 'lifetime total unchanged');
      const allAfter = await S.ok('/stats?range=all&estimates=include');
      assert.equal(allBefore.total_minutes - allAfter.total_minutes, D.minutes.hades, 'Hades is no longer charted');

      await row('Stardew Valley').locator('[data-skip]').click();
      assert.equal(await row('Stardew Valley').count(), 0, 'skipped row disappears');
      assertInvariant('after answering history questions');

      await page.reload();
      await waitView(page);
      await h.settle();
      assert.equal(await row('Stardew Valley').count(), 1, 'Skip is not saved: the game is asked again');
      assert.equal(await row('Mario Kart 8 Deluxe').count(), 0, 'answered games are not asked again');
      assert.equal(await row('Hades').count(), 0, 'un-charted games are not asked again');
      assert.ok(await solid() > solid0, `share of solidly dated history grows (${solid0}% -> ${await solid()}%)`);
      clean(h);
    } finally {
      await h.close();
      const he = (await game(D.ids.hades)).entries[0].id;
      await S.ok(`/entries/${he}/history`, { method: 'PATCH', body: { reset: true } });
    }
    assertInvariant('after resetting Hades');
  });

  // ------------------------------------------------------------------ import
  test('import: preview changes nothing; apply joins the library (synced totals and your choices kept); skipped rows reported; re-import is a no-op', async () => {
    const snapshot = async () => (await S.ok('/games?limit=500&hidden=all&sort=title')).items.map((g) => [g.title, g.minutes, g.status, g.rating]);
    const csv = [
      'title,platform,playtime_hours,last_played,status,rating',
      'Outer Wilds,import,20,2026-02-10,completed,10',
      'Hollow Knight,import,30,2026-01-15,dropped,8',
      'Zelda: TotK,,40,2026-05-01,,',
      ',import,5,,,',
    ].join('\n');
    const hollowBefore = await game(D.ids.hollow);
    const h = await visit('/settings#import');
    const { page } = h;
    const out = page.locator('#imp-r');
    const paste = async (text) => {
      if (!(await page.locator('#imp-text').isVisible())) await page.locator('#import details summary').click();
      await page.locator('#imp-text').fill(text);
      await page.locator('#imp-go').click();
      await out.locator('b', { hasText: 'Preview: pasted data' }).waitFor();
    };
    try {
      const s0 = await snapshot();
      await paste(csv);
      const preview = await out.innerText();
      assert.match(preview, /Nothing has changed yet/);
      assert.match(preview, /1 game your synced accounts already track: their totals stay/);
      assert.match(preview, /1 rows skipped/);
      await h.settle();
      assert.deepEqual(await snapshot(), s0, 'a preview changes nothing');

      await out.locator('#imp-apply').click();
      await out.locator('b', { hasText: '✓ Imported pasted data' }).waitFor();
      assertInvariant('after import');
      const titles = (await snapshot()).map((x) => x[0]);
      assert.equal(titles.filter((t) => t === 'Zelda: TotK').length, 1, 'no duplicate Zelda');
      assert.equal(titles.filter((t) => t === 'Hollow Knight').length, 1, 'no duplicate Hollow Knight');
      const zelda = await game(D.ids.zelda);
      assert.equal(zelda.minutes, D.minutes.zelda, 'the synced account total stands (not replaced, not doubled)');
      const ow = (await S.ok('/games?q=Outer%20Wilds')).items[0];
      assert.equal(ow.minutes, 1200, 'new game: 20 h');
      assert.equal(ow.status, 'completed');
      assert.equal(ow.rating, 10);
      const hk = await game(D.ids.hollow);
      assert.equal(hk.status, hollowBefore.status, 'your status is never replaced by the file');
      assert.equal(hk.rating, 8, 'an empty rating is filled from the file');
      assert.ok(hk.sessions.some((s) => s.source === 'manual' && s.minutes === 120 && s.note === 'Mantis Lords'), 'your logged session is kept');
      assert.ok(hk.minutes >= 1800, 'lifetime covers at least the file total');
      const dup = await S.ok('/duplicates');
      assert.equal(dup.counts.double_counted, 0);

      // the result is visible in the UI right away
      await page.goto(`${S.origin}/library?q=Outer`);
      await waitView(page);
      await page.locator('#lib-items .tile .t', { hasText: 'Outer Wilds' }).waitFor();

      // the same file again: changes nothing
      await page.goto(`${S.origin}/settings#import`);
      await waitView(page);
      const s1 = await snapshot();
      await paste(csv);
      await out.locator('#imp-apply').click();
      await out.locator('b', { hasText: '✓ Imported pasted data' }).waitFor();
      assert.match(await out.innerText(), /Importing the same file again changes nothing/);
      assert.deepEqual(await snapshot(), s1, 're-importing the same file is idempotent');
      clean(h);
    } finally { await h.close(); }
    assertInvariant('after re-import');
  });

  test('import preview of an already-imported file says "Nothing new"', async () => {
    const csv = 'title,platform,playtime_hours,last_played,status,rating\nRepeat Me,import,3,2026-02-01,beaten,7\n';
    await S.ok('/import', { method: 'POST', body: csv });
    const h = await visit('/settings');
    try {
      await h.page.locator('#import details summary').click();
      await h.page.locator('#imp-text').fill(csv);
      await h.page.locator('#imp-go').click();
      await h.page.locator('#imp-r b', { hasText: 'Preview' }).waitFor();
      const text = await h.page.locator('#imp-r').innerText();
      assert.match(text, /Nothing new — everything in this file is already here/, `preview says: ${text}`);
    } finally { await h.close(); }
  });

  test('import of a title you only logged by hand joins that game instead of adding its hours on top', async () => {
    // Celeste exists only as a manual game with 2h 15m logged. A spreadsheet row without a platform
    // saying "Celeste: 1h total" is the same play; joined, the lifetime must stay 2h 15m (totals only
    // grow, never shrink) - the same rule the importer applies to synced games.
    const before = await game(D.ids.celeste);
    const h = await visit('/settings');
    try {
      await h.page.locator('#import details summary').click();
      await h.page.locator('#imp-text').fill('title,platform,playtime_hours\nCeleste,,1\n');
      await h.page.locator('#imp-go').click();
      await h.page.locator('#imp-r b', { hasText: 'Preview' }).waitFor();
      const preview = await h.page.locator('#imp-r').innerText();
      await h.page.locator('#imp-apply').click();
      await h.page.locator('#imp-r b', { hasText: '✓ Imported' }).waitFor();
      const after = await game(D.ids.celeste);
      assert.ok(!/new game/.test(preview), `preview should not announce a new game/entry for Celeste: ${preview}`);
      assert.equal(after.minutes, Math.max(before.minutes, 60), `Celeste lifetime ${after.minutes} min, expected ${Math.max(before.minutes, 60)} (no double counting)`);
    } finally { await h.close(); }
  });

  test('import from files: JSON with sessions becomes tracked sessions + history; invalid JSON is rejected without changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-e2e-'));
    const good = path.join(dir, 'tracker.json');
    const bad = path.join(dir, 'broken.json');
    fs.writeFileSync(good, JSON.stringify({ games: [{ title: 'Inscryption', platform: 'switch', playtime_minutes: 300, sessions: [{ date: '2026-03-01', minutes: 120 }] }] }));
    fs.writeFileSync(bad, '{ "games": [ { "title": ');
    const h = await visit('/settings');
    const { page } = h;
    const out = page.locator('#imp-r');
    try {
      const before = (await S.ok('/games?limit=500&hidden=all')).total;
      await page.locator('#imp-file').setInputFiles(bad);
      await out.locator('.card', { hasText: 'not valid JSON' }).waitFor();
      assert.equal((await S.ok('/games?limit=500&hidden=all')).total, before, 'a broken file changes nothing');

      await page.locator('#imp-file').setInputFiles(good);
      await out.locator('b', { hasText: 'Preview: tracker.json' }).waitFor();
      assert.match(await out.innerText(), /1 new game/);
      assert.match(await out.innerText(), /1 sessions \(2h\)/);
      assert.equal((await S.ok('/games?q=Inscryption')).total, 0, 'preview only');
      await out.locator('#imp-apply').click();
      await out.locator('b', { hasText: '✓ Imported tracker.json' }).waitFor();
      const id = (await S.ok('/games?q=Inscryption')).items[0].id;
      const g = await game(id);
      assert.equal(g.minutes, 300, 'lifetime = the file total');
      assert.equal(g.summary.tracked_minutes, 120, 'the listed session is tracked play');
      assert.equal(g.summary.sessions, 1);
      assert.equal(g.summary.tracked_minutes + g.summary.estimated_minutes + g.summary.baseline_minutes, 300, 'the rest is history, nothing lost');
      const sess = await S.ok(`/sessions?game_id=${id}`);
      assert.equal(sess.items[0].source, 'import');
      const day = new Date(sess.items[0].started_at); // the file's date, on your own calendar
      assert.equal(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`, '2026-03-01');
      await page.goto(`${S.origin}/sessions`);
      await waitView(page);
      await page.locator('#s-chips [data-src="import"]').click();
      await page.locator('#s-list .item', { hasText: 'Inscryption' }).waitFor();
      assert.match(await page.locator('#s-list .item', { hasText: 'Inscryption' }).innerText(), /imported/);
      clean(h);
    } finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    assertInvariant('after file import');
  });

  // ------------------------------------------------------------------ duplicates
  test('duplicates: double counting is flagged and one click excludes it; merge and "not the same" resolve suggestions; sequels are not suggested', async () => {
    // a spreadsheet that mirrors the custom account's Mario Kart hours = the same play counted twice
    await S.ok('/import', { method: 'POST', body: 'title,platform,playtime_hours,last_played\nMario Kart 8 Deluxe,switch,10,2026-08-01\n' });
    const extra = [];
    for (const title of ['Hades II', 'Stardew Valley Expanded Edition', 'Celeste Farewell']) extra.push((await S.ok('/games', { method: 'POST', body: { title, merge: false } })).id);
    const lt0 = await S.ok('/stats/lifetime');
    const d0 = await S.ok('/duplicates');
    assert.equal(d0.counts.double_counted, 1, 'the mirrored import is detected');
    assert.ok(!d0.suggestions.some((x) => x.games.some((g) => g.title === 'Hades II')), 'Hades II is a sequel, never suggested as a duplicate of Hades');
    const h = await visit('/duplicates');
    const { page } = h;
    const section = (name) => page.locator('.card', { has: page.locator('h2', { hasText: name }) });
    try {
      assert.equal(await page.locator('#dupe-badge').innerText(), String(d0.counts.suggestions + d0.counts.double_counted), 'sidebar badge counts open items');
      const dbl = section('Possible double counting');
      assert.match(await dbl.innerText(), /Mario Kart 8 Deluxe/);
      await dbl.locator('[data-exclude]').click();
      await toast(page, 'Excluded from totals');
      await section('Possible double counting').locator('text=Nothing is counted twice.').waitFor();
      const mk = await game(D.ids.mk8);
      assert.equal(mk.minutes, D.minutes.mk8, 'Mario Kart counted once again');
      assert.equal(mk.entries.filter((e) => e.excluded).length, 1, 'exactly one copy excluded');
      assert.ok(!mk.entries.find((e) => e.platform === 'custom').excluded, 'the live account keeps counting');
      assert.equal((await S.ok('/stats/lifetime')).total_minutes, lt0.total_minutes - 600, 'lifetime drops by the double-counted 10 h');

      const sugg = section('Merge suggestions');
      const pair = sugg.locator('.item', { hasText: 'Stardew Valley Expanded Edition' });
      await pair.locator('[data-merge]').click();
      await toast(page, 'Merged');
      await waitUntil(async () => (await section('Merge suggestions').locator('.item', { hasText: 'Stardew Valley Expanded Edition' }).count()) === 0, { message: 'merged pair gone' });
      const sv = await S.ok('/games?q=Stardew&hidden=all');
      assert.equal(sv.total, 1, 'one Stardew game after merging');
      assert.equal(sv.items[0].minutes, D.minutes.stardew, 'merging moves entries without changing playtime');
      assert.equal(sv.items[0].entry_count, 2);

      const cel = section('Merge suggestions').locator('.item', { hasText: 'Celeste Farewell' });
      await cel.locator('[data-dismiss]').click();
      await waitUntil(async () => (await section('Merge suggestions').locator('.item', { hasText: 'Celeste Farewell' }).count()) === 0, { message: 'dismissed pair gone' });
      await page.reload();
      await waitView(page);
      assert.equal(await section('Merge suggestions').locator('.item', { hasText: 'Celeste Farewell' }).count(), 0, 'a dismissed suggestion stays dismissed');
      assert.equal((await S.ok('/stats/lifetime')).total_minutes, lt0.total_minutes - 600, 'resolving suggestions never changes playtime');
      clean(h);
    } finally {
      await h.close();
      for (const id of extra) await S.api(`/games/${id}`, { method: 'DELETE' });
    }
    assertInvariant('after resolving duplicates');
  });

  // ------------------------------------------------------------------ system page
  test('system page: health numbers match the API, error log filters and clears, diagnostics download, re-date history keeps totals', async () => {
    S.db.prepare('INSERT INTO logs(time, level, source, message, context, stack) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now() - MIN, 'error', 'sync', 'ui-e2e simulated sync failure for Switch', JSON.stringify({ account: 'Switch' }), null);
    S.db.prepare('INSERT INTO logs(time, level, source, message, context, stack) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now() - 2 * MIN, 'warn', 'presence', 'ui-e2e presence warning', null, null);
    const sys = await S.ok('/system');
    const h = await visit('/system');
    const { page } = h;
    const kpi = (label) => page.locator('.kpi', { has: page.locator('.label', { hasText: label }) }).locator('.value');
    try {
      assert.match(await page.locator('.page-h p').innerText(), new RegExp(`Vestigo ${sys.version.replace(/\./g, '\\.')}`));
      assert.equal(await kpi('Library').innerText(), sys.counts.games.toLocaleString('en-US'));
      assert.equal(await kpi('Errors (24h)').innerText(), '1');
      assert.match(await page.locator('.page-h .badge').innerText(), /1 error in 24h/);
      assert.equal(await page.locator('#err-badge').innerText(), '1', 'sidebar error badge');
      const storage = await page.locator('.card', { has: page.locator('h2', { hasText: 'Storage' }) }).innerText();
      assert.match(storage, /Database file\s+in-memory/);
      assert.match(storage, /UI password\s+off/);
      assert.match(await page.locator('.card', { has: page.locator('h2', { hasText: 'Accounts' }) }).innerText(), /Switch[\s\S]*push/);

      const logText = () => page.locator('#log-list').innerText();
      assert.match(await logText(), /simulated sync failure/);
      assert.match(await logText(), /presence warning/);
      await page.locator('#log-lvl [data-l="warn"]').click();
      await waitUntil(async () => !/simulated sync failure/.test(await logText()), { message: 'warnings only' });
      assert.match(await logText(), /presence warning/);
      await page.locator('#log-lvl [data-l="error,warn"]').click();
      await page.locator('#log-q').fill('sync failure');
      await waitUntil(async () => !/presence warning/.test(await logText()) && /simulated sync failure/.test(await logText()), { message: 'search filter' });
      await page.locator('#log-q').fill('nothing-matches-this');
      await page.locator('#log-list', { hasText: 'All clear' }).waitFor();

      const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#sys-dl').click()]);
      assert.match(dl.suggestedFilename(), /^vestigo-diagnostics-\d{4}-\d{2}-\d{2}\.json$/);
      const diag = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
      assert.ok(diag.system && Array.isArray(diag.logs) && Array.isArray(diag.syncs), 'bundle has system, logs and syncs');
      assert.ok(diag.logs.some((l) => /simulated sync failure/.test(l.message)));
      assert.ok(diag.syncs.length >= 2, 'both reports of the custom account are in the sync history');

      const lt0 = await S.ok('/stats/lifetime');
      await page.locator('#sys-reinfer').click();
      assert.match(await toast(page, 'Re-dated history'), /Re-dated history for \d+ titles/);
      const lt1 = await S.ok('/stats/lifetime');
      assert.equal(lt1.total_minutes, lt0.total_minutes, 're-dating history never changes lifetime totals');
      assertInvariant('after re-dating all history');

      await page.locator('#log-clear').click();
      await page.locator('.modal [data-ok]').click();
      await waitView(page);
      await page.locator('#log-list', { hasText: 'All clear' }).waitFor();
      assert.equal((await S.ok('/logs')).items.length, 0, 'log cleared');
      clean(h);
    } finally { await h.close(); }
  });

  // ------------------------------------------------------------------ accounts
  test('accounts: custom account shows push details; connect, rename, pause and unlink a custom account in the UI', async () => {
    const h = await visit('/accounts');
    const { page } = h;
    const card = (name) => page.locator('.card.acct', { has: page.locator('h2', { hasText: name }) });
    try {
      const sw = await card('Switch').innerText();
      assert.match(sw, /API push/);
      assert.match(sw, /2\s*games/);
      const hist = await page.locator('.card', { has: page.locator('h2', { hasText: 'Sync history' }) }).innerText();
      assert.match(hist, /initial import/, 'the first report is listed as the initial import');
      await page.locator('details.card summary').click();
      const caps = await page.locator('details.card').innerText();
      for (const p of ['Steam', 'Xbox', 'PlayStation']) assert.ok(caps.includes(p), `platform notes list ${p}`);

      await page.locator('#acc-add').click();
      await page.locator('.modal', { hasText: 'Connect an account' }).locator('[data-p="custom"]').click();
      const m = page.locator('.modal', { hasText: 'Connect Custom' });
      await m.waitFor();
      await modalReady(page);
      assert.match(await m.innerText(), /POST \/api\/v1\/accounts\/:id\/report/);
      await m.locator('[name=name]').fill('Playnite');
      await m.locator('#acc-save').click();
      await toast(page, 'Account created');
      await toast(page, 'Sync complete');
      await waitView(page);
      await card('Playnite').waitFor();
      let acc = (await S.ok('/accounts')).find((a) => a.name === 'Playnite');
      assert.equal(acc.platform, 'custom');
      assert.ok(acc.enabled);

      await card('Playnite').locator('[data-edit]').click();
      const e = page.locator('.modal', { hasText: 'Edit Playnite' });
      await e.waitFor();
      await modalReady(page);
      await e.locator('[name=name]').fill('Playnite PC');
      await e.locator('#acc-save').click();
      await toast(page, 'Account saved');
      await card('Playnite PC').waitFor();
      await card('Playnite PC').locator('[data-toggle]').click();
      await waitUntil(async () => /Paused/.test(await card('Playnite PC').innerText()), { message: 'paused badge' });
      acc = (await S.ok('/accounts')).find((a) => a.id === acc.id);
      assert.equal(acc.enabled, false);

      await card('Playnite PC').locator('[data-edit]').click();
      await page.locator('.modal #acc-del').click();
      await page.locator('.modal [data-ok]', { hasText: 'Unlink & delete' }).click();
      await toast(page, 'Account removed');
      await waitUntil(async () => (await card('Playnite PC').count()) === 0, { message: 'card gone' });
      assert.ok(!(await S.ok('/accounts')).some((a) => a.id === acc.id));
      assert.equal(await card('Switch').count(), 1, 'other accounts untouched');
      clean(h);
    } finally { await h.close(); }
    assertInvariant('after account changes');
  });

  test('service worker: installs the Vestigo shell and drops the PlayTracker cache (pt-v1) of an existing install', async () => {
    const h = await visit('/');
    try {
      const r = await h.page.evaluate(async () => {
        await (await caches.open('pt-v1')).put('/old-shell', new Response('pre-rename shell'));
        const reg = await navigator.serviceWorker.register('/sw.js');
        const sw = reg.installing || reg.waiting || reg.active;
        await new Promise((ok, no) => {
          if (sw.state === 'activated') return ok();
          sw.addEventListener('statechange', () => { if (sw.state === 'activated') ok(); if (sw.state === 'redundant') no(new Error('service worker install failed (a shell file is missing?)')); });
        });
        const shell = (await (await caches.open('vestigo-v1')).keys()).map((q) => new URL(q.url).pathname);
        const out = { keys: await caches.keys(), scope: new URL(reg.scope).pathname, shell };
        await reg.unregister();
        return out;
      });
      assert.deepEqual(r.keys, ['vestigo-v1'], 'only the new cache is left');
      assert.equal(r.scope, '/', 'same scope as before');
      for (const p of ['/', '/app.js', '/pages.js', '/favicon.svg', '/icon-180.png', '/manifest.webmanifest']) assert.ok(r.shell.includes(p), `${p} is in the offline shell`);
      clean(h);
    } finally { await h.close(); }
  });

  test('"Sync all" with only push accounts explains there is nothing to sync', async () => {
    const h = await visit('/');
    try {
      await h.page.locator('.side #sync-all-btn').click();
      await toast(h.page, 'No accounts to sync');
      await waitH1(h.page, 'Accounts');
      clean(h);
    } finally { await h.close(); }
  });
});

// ======================================================================== login
describe('Vestigo web UI with a password', UI, () => {
  let S;
  before(async () => { S = await startApp(); await S.ok('/games', { method: 'POST', body: { title: 'Secret Game' } }); });
  after(() => S?.close());

  const loginForm = (page) => page.locator('#login-form');
  async function login(page, password) {
    await loginForm(page).locator('[name=password]').fill(password);
    await loginForm(page).locator('button', { hasText: 'Sign in' }).click();
  }

  test('set a password in Settings, then the UI and API require logging in; wrong password refused; logout ends the session', async () => {
    const PW = 'correct-horse-9';
    const a = await openPage(browser, S.origin);
    try {
      await a.page.goto(`${S.origin}/settings`);
      await waitView(a.page);
      const form = a.page.locator('#pw-f');
      assert.match(await form.innerText(), /No password set/);
      await form.locator('[name=password]').fill('abc');
      await form.locator('button').click();
      await toast(a.page, 'at least 6 characters');
      assert.equal((await S.ok('/auth/status')).auth_enabled, false, 'too-short password refused');
      await form.locator('[name=password]').fill(PW);
      await form.locator('button').click();
      await toast(a.page, 'Password saved');
      await waitView(a.page);
      assert.equal((await S.ok('/auth/status')).auth_enabled, true);
      assert.equal(await a.page.locator('.side [data-action="logout"]').count(), 1, 'Log out appears once a password is set');
      await a.page.goto(`${S.origin}/library`);
      await waitView(a.page);
      await a.page.locator('#lib-items .tile .t', { hasText: 'Secret Game' }).waitFor(); // the browser that set it stays signed in
      a.rec.consoleErrors.length = 0;
    } finally { await a.close(); }

    assert.equal((await S.api('/summary')).status, 401, 'the API now needs a login');
    assert.equal((await S.api('/games')).status, 401);

    const b = await openPage(browser, S.origin);
    try {
      await b.page.goto(`${S.origin}/library`);
      await loginForm(b.page).waitFor();
      assert.equal(await b.page.title(), 'Sign in · Vestigo');
      assert.equal((await loginForm(b.page).locator('.brand-word').innerText()).trim(), 'Vestigo', 'login shows the stacked lockup');
      assert.equal((await loginForm(b.page).locator('.tagline').innerText()).trim(), 'Every session leaves a trace.');
      assert.equal(await loginForm(b.page).locator('a').count(), 0, 'the login lockup is not a link');
      assert.equal((await loginForm(b.page).locator('.brand-mark').boundingBox()).width, 56);
      assert.equal(await b.page.locator('.shell').count(), 0, 'no app shell before login');
      assert.ok(!(await b.page.content()).includes('Secret Game'), 'no library data leaks to the login screen');
      await login(b.page, 'wrong-password');
      await toast(b.page, 'Wrong password');
      assert.equal(await loginForm(b.page).count(), 1, 'still on the login screen');
      await login(b.page, PW);
      await waitH1(b.page, 'Library');
      assert.equal(await b.page.title(), 'Library · Vestigo');
      await b.page.locator('#lib-items .tile .t', { hasText: 'Secret Game' }).waitFor();
      const cookie = (await b.ctx.cookies()).find((c) => c.name === 'pt_session');
      assert.ok(cookie, 'session cookie set');
      assert.equal(cookie.httpOnly, true, 'session cookie is HttpOnly');
      assert.equal(cookie.sameSite, 'Lax');
      await b.page.reload();
      await waitH1(b.page, 'Library');
      assert.equal((await b.page.request.get(`${S.origin}/api/v1/summary`)).status(), 200, 'the cookie authenticates API calls');
      await b.page.locator('.side [data-action="logout"]').click();
      await loginForm(b.page).waitFor();
      await b.page.reload();
      await loginForm(b.page).waitFor();
      assert.equal((await b.page.request.get(`${S.origin}/api/v1/summary`)).status(), 401, 'logged out: the old cookie no longer works');
      assert.deepEqual(b.rec.pageErrors, []);
      assert.deepEqual(b.unexpectedConsole([401]), []);
    } finally { await b.close(); }

    // phone: login fits the screen; logging out lives on the More page
    const p = await openPage(browser, S.origin, { viewport: PHONE });
    try {
      await p.page.goto(`${S.origin}/`);
      await loginForm(p.page).waitFor();
      const o = await overflow(p.page, PHONE.width);
      assert.ok(o.doc <= PHONE.width + 1, `login screen fits the phone (${o.doc}px)`);
      await login(p.page, PW);
      await waitH1(p.page, /Good|Late night/);
      await p.page.locator('.tabbar a', { hasText: 'More' }).click();
      await waitH1(p.page, 'More');
      await p.page.locator('#view [data-action="logout"]').click();
      await loginForm(p.page).waitFor();
      assert.deepEqual(p.rec.pageErrors, []);
    } finally { await p.close(); }

    // change it back: wrong current password refused, empty new password removes it
    const c = await openPage(browser, S.origin);
    try {
      await c.page.goto(`${S.origin}/settings`);
      await login(c.page, PW);
      await waitH1(c.page, 'Settings');
      const form = c.page.locator('#pw-f');
      await form.locator('[name=current]').fill('not-it');
      await form.locator('[name=password]').fill('');
      await form.locator('button').click();
      await toast(c.page, 'Current password is wrong');
      assert.equal((await S.api('/auth/status')).body.auth_enabled, true);
      await form.locator('[name=current]').fill(PW);
      await form.locator('button').click();
      await toast(c.page, 'Password removed');
      assert.equal((await S.api('/auth/status')).body.auth_enabled, false);
      assert.equal((await S.api('/summary')).status, 200, 'open again without a password');
    } finally { await c.close(); }
  });

  test('a password from the environment gates the UI and cannot be changed in Settings; Settings names the variable in use', async () => {
    const E = await startApp({ password: 'env-secret-77' });
    const h = await openPage(browser, E.origin);
    const security = () => h.page.locator('.card', { has: h.page.locator('h2', { hasText: 'Security' }) }).innerText();
    try {
      await h.page.goto(`${E.origin}/settings`);
      await loginForm(h.page).waitFor();
      await login(h.page, 'env-secret-77');
      await waitH1(h.page, 'Settings');
      // the server names the variable that supplied the password (password_env); without it the UI names the default
      const st = await (await h.page.request.get(`${E.origin}/api/v1/auth/status`)).json();
      assert.equal(st.password_source, 'env');
      assert.match(await security(), new RegExp(st.password_env || 'VESTIGO_PASSWORD'));
      assert.equal(await h.page.locator('#pw-f').count(), 0, 'no password form when it comes from the environment');
      // an install that still sets the legacy PLAYTRACKER_PASSWORD sees that name, not the new one
      for (const name of ['PLAYTRACKER_PASSWORD', 'VESTIGO_PASSWORD']) {
        await h.page.route('**/api/v1/auth/status', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...st, password_env: name }) }));
        await h.page.reload();
        await waitH1(h.page, 'Settings');
        const sec = await security();
        assert.match(sec, new RegExp(`Password is set with ${name}`));
        assert.ok(!sec.includes(name === 'VESTIGO_PASSWORD' ? 'PLAYTRACKER_PASSWORD' : 'VESTIGO_PASSWORD'), `only ${name} is named`);
        await h.page.unroute('**/api/v1/auth/status');
      }
      assert.deepEqual(h.rec.pageErrors, []);
    } finally { await h.close(); E.close(); }
  });
});

// ======================================================================== static assets (no browser)
describe('Vestigo web assets', () => {
  const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
  /** width, height and colour type (2 = RGB, i.e. no transparency; 6 = RGBA) from a PNG's IHDR chunk */
  const png = (f) => {
    const b = fs.readFileSync(path.join(PUBLIC, f));
    assert.equal(b.toString('latin1', 12, 16), 'IHDR', `${f} is a PNG`);
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: b[25] };
  };

  test('`grep -rni playtracker public/` finds nothing; the only pt- names left are compatibility identifiers', () => {
    // kept on purpose: renaming them would reset every browser's theme / start page or orphan the hatch patterns
    const COMPAT = new Set(['pt-theme', 'pt-accent', 'pt-ui', 'pt-started', 'pt-hatch', 'pt-hatch-ov', 'pt-v1']);
    const hits = [];
    const ids = new Set();
    for (const f of fs.readdirSync(PUBLIC)) {
      const text = fs.readFileSync(path.join(PUBLIC, f)).toString('latin1');
      text.split('\n').forEach((line, i) => { if (/playtracker/i.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`); });
      if (/\.(html|js|css|svg|webmanifest)$/.test(f)) for (const m of text.matchAll(/\bpt[-_][\w-]+/g)) ids.add(m[0]);
    }
    assert.deepEqual(hits, []);
    assert.deepEqual([...ids].filter((x) => !COMPAT.has(x)), [], 'no other pt-/pt_ identifiers');
    const app = read('app.js');
    for (const k of ['pt-theme', 'pt-accent', 'pt-ui']) {
      assert.ok(read('index.html').includes(`getItem('${k}')`), `the pre-paint script still reads ${k}`);
      assert.ok(app.includes(`'${k}'`), `applyTheme() still writes ${k}`);
    }
    assert.ok(app.includes("'pt-started'"));
    assert.ok(read('charts.js').includes('id="pt-hatch"'));
  });

  test('no emoji or pictographs in the UI markup', () => {
    for (const f of ['index.html', 'app.js', 'pages.js', 'charts.js']) {
      assert.deepEqual([...read(f).matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]), [], f);
    }
  });

  test('index.html: Vestigo title and meta; the favicon and a full-bleed 180px apple-touch-icon exist', () => {
    const html = read('index.html');
    assert.match(html, /<title>Vestigo<\/title>/);
    assert.match(html, /<meta name="application-name" content="Vestigo">/);
    assert.match(html, /<meta name="apple-mobile-web-app-title" content="Vestigo">/);
    assert.match(html, /<noscript>Vestigo needs JavaScript\.<\/noscript>/);
    const href = (rel) => new RegExp(`rel="${rel}" href="/([^"]+)"`).exec(html)?.[1];
    assert.ok(fs.existsSync(path.join(PUBLIC, href('icon'))), 'favicon exists');
    assert.equal(href('apple-touch-icon'), 'icon-180.png');
    assert.deepEqual(Object.values(png('icon-180.png')), [180, 180, 2], 'apple-touch-icon is 180x180 and full bleed (iOS shows transparent corners black)');
    for (const f of ['favicon.svg', 'icon.svg', 'icon-maskable.svg']) {
      const svg = read(f);
      assert.ok(/stroke="#fff"/.test(svg) && !/currentColor/.test(svg), `${f}: an explicit white mark`);
      assert.ok(svg.includes('#7656ff') && svg.includes('#0891b2'), `${f}: the brand gradient`);
    }
  });

  test('manifest: same id so installed apps keep their identity, Vestigo names, separate "any" and "maskable" icons at their declared sizes', () => {
    const m = JSON.parse(read('manifest.webmanifest'));
    assert.equal(m.id, '/');
    assert.equal(m.start_url, '/');
    assert.equal(m.scope, '/');
    assert.equal(m.name, 'Vestigo Media Tracker');
    assert.equal(m.short_name, 'Vestigo');
    assert.deepEqual(m.icons.map((i) => [i.src, i.purpose]), [['/icon.svg', 'any'], ['/icon-192.png', 'any'], ['/icon-512.png', 'any'], ['/icon-maskable-512.png', 'maskable']]);
    for (const i of m.icons.filter((x) => x.type === 'image/png')) {
      const p = png(i.src.slice(1));
      assert.equal(`${p.w}x${p.h}`, i.sizes, `${i.src} is ${i.sizes}`);
    }
    assert.equal(png('icon-maskable-512.png').type, 2, 'the maskable icon is full bleed');
  });

  test('service worker: Vestigo cache name, same /sw.js path, and every shell file exists (one missing file fails the install)', () => {
    const sw = read('sw.js');
    assert.equal(/const VERSION = '([^']+)'/.exec(sw)[1], 'vestigo-v1');
    const shell = JSON.parse(/const SHELL = (\[[^\]]+\])/.exec(sw)[1].replace(/'/g, '"'));
    for (const p of shell) assert.ok(fs.existsSync(path.join(PUBLIC, p === '/' ? 'index.html' : p)), `${p} exists`);
    assert.match(read('app.js'), /register\('\/sw\.js'\)/);
  });
});
