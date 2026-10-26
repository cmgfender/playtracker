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
  srgb, sampleContrasts, seedAchievements, chartReport, chartProblems, ringContrast, invariantViolations, viewReady, labelViolations, axeLoaded, DESKTOP, PHONE, PHONE_SMALL, MIN, HOUR, DAY, skipReason,
} from './helpers/ui-e2e-harness.js';
const UI = { skip: skipReason || false };

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const NOW = Date.now();
const YEAR = new Date(NOW).getFullYear();
const DEFAULT_LAYOUT = 'kpis,live,jump,chart,top,recent,accounts,-heatmap,-backlog';
// Home's heading: this week's playtime ("4h 27m this week"); the greeting is the eyebrow above it
const HOME_H1 = /^(\d[\d,.]*h(?: \d+m)?|\d+m) this week$/;

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
  if (!v || v.hidden || v.getAttribute('aria-busy') === 'true' || v.querySelector('.skel')) return false;
  const t = v.querySelector('h1')?.textContent.trim() || '';
  return e.startsWith('re:') ? new RegExp(e.slice(3)).test(t) : t === e;
}, expected instanceof RegExp ? `re:${expected.source}` : expected, { timeout });

describe('Vestigo web UI (no password)', UI, () => {
  let S; // started app
  let D; // seeded data

  before(async () => {
    S = await startApp();
    D = await seed(S.ok, NOW);
    D.ach = await seedAchievements(S.ok, S.db, D.ids.zelda);
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
    [`/game/${D.ids.zelda}`, 'Library', 'Zelda: TotK · Vestigo'], ['/sessions', 'Sessions', 'Sessions · Vestigo'], ['/stats', 'Stats', 'Stats · Vestigo'], ['/insights', 'Insights', 'Insights · Vestigo'],
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
      await waitH1(d.page, HOME_H1);
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
      const links = (await p.page.locator('#view .more-feature .ttl, #view .more-row .ttl').allInnerTexts()).map((x) => x.trim());
      assert.deepEqual(links, ['Year in review', 'Insights', 'Duplicates', 'Improve history', 'Accounts', 'Settings', 'System', 'API']);
      assert.deepEqual((await p.page.locator('#view .more-sec h2').allInnerTexts()).map((x) => x.trim().toLowerCase()), ['track', 'tidy up', 'setup', 'advanced'], 'the sidebar\'s groups, minus the tabs');
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
      await page.locator('#lib-items .empty h2', { hasText: 'Nothing matches' }).waitFor();
      await page.locator('#lib-q').fill('');
      await waitTitles((t) => t.length === 7, 'cleared search');

      // filter menus: a checkbox per platform / status, the "More" switches; the menu stays open while ticking
      const tick = async (menu, value, name = menu) => {
        if (!(await page.locator(`.fmenu input[name="${name}"][value="${value}"]`).count())) await page.locator(`#lib-filters [data-menu="${menu}"]`).click();
        await page.locator(`.fmenu input[name="${name}"][value="${value}"]`).click();
      };
      await tick('platform', 'custom');
      await waitTitles((t) => t.length === 2, 'platform filter');
      assert.deepEqual(await setOf(), new Set(['Zelda: TotK', 'Mario Kart 8 Deluxe']), 'Custom filter = games pushed by the custom account');
      assert.equal(new URL(page.url()).searchParams.get('platform'), 'custom');
      await tick('platform', 'manual');
      await waitTitles((t) => t.length === 5, 'custom + manual');
      assert.equal(new URL(page.url()).searchParams.get('platform'), 'custom,manual', 'several platforms: a comma list');
      await tick('platform', 'custom');
      await waitTitles((t) => t.includes('Celeste') && !t.includes('Zelda: TotK'), 'manual filter');
      assert.deepEqual(await setOf(), new Set(['Celeste', 'Hollow Knight', 'Ori and the Will of the Wisps']));
      assert.equal((await page.locator('#lib-filters [data-menu="platform"]').textContent()).replace(/\s+/g, ' ').trim(), 'Platform · 1');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.fmenu').count(), 0, 'Escape closes the menu');
      // a pill per active filter removes it
      await page.locator('#lib-pills [data-rm="platform:manual"]').click();
      await waitTitles((t) => t.length === 7, 'All platforms');

      await tick('status', 'playing');
      await waitTitles((t) => t.length === 2, 'status filter');
      assert.deepEqual(await setOf(), new Set(['Celeste', 'Hollow Knight']));
      await tick('status', 'playing'); // unticks
      await waitTitles((t) => t.length === 7, 'status filter off');
      await page.keyboard.press('Escape');

      await tick('more', 'never');
      await waitTitles((t) => t.length === 1, 'never played filter');
      assert.deepEqual(await titles(), ['Ori and the Will of the Wisps']);
      assert.match(await page.locator('#lib-items .tile .m').innerText(), /Unplayed/);
      await tick('more', 'never');
      await waitTitles((t) => t.length === 7, 'never played off');
      await page.keyboard.press('Escape');

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
      await page.locator('.switch:has(#st-est) > span').click();
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
      await page.locator('#g-status-sel').selectOption('beaten');
      await waitUntil(async () => (await game(g0.id)).status === 'beaten', { message: 'status saved' });
      await page.locator('#g-stars [data-r="8"]').click();
      await waitUntil(async () => (await game(g0.id)).rating === 8, { message: 'rating saved' });
      assert.equal(await page.locator('#g-stars button.on').count(), 4, '4 of 5 stars lit for 8/10');
      await page.locator('#g-stars [data-r="8"]').click(); // same star again clears it
      await waitUntil(async () => (await game(g0.id)).rating === null, { message: 'rating cleared' });
      const fav = await page.$('#g-fav');
      assert.equal(await fav.getAttribute('aria-pressed'), 'false');
      await page.locator('#g-fav').click();
      await toast(page, 'Added to favorites');
      await waitUntil(async () => (await game(g0.id)).favorite === 1 || (await game(g0.id)).favorite === true, { message: 'favorite saved' });
      assert.equal(await fav.getAttribute('aria-pressed'), 'true');
      assert.ok(await page.evaluate((b) => b === document.querySelector('#g-fav') && !!b.querySelector('path[fill="currentColor"]'), fav),
        'the same button (no re-render, focus kept) now shows the filled heart');
      await waitView(page);
      await page.locator('#g-notes').fill('Stuck on the second boss');
      await page.locator('#g-notes-st', { hasText: 'Saved' }).waitFor();
      assert.equal((await game(g0.id)).notes, 'Stuck on the second boss');
      // hide: in the ⋯ menu, a checkable item
      await page.locator('#g-more').click();
      assert.equal(await page.locator('#g-hidden').getAttribute('aria-checked'), 'false');
      await page.locator('#g-hidden').click();
      await toast(page, 'Hidden from library');
      await waitUntil(async () => !!(await game(g0.id)).hidden, { message: 'hidden saved' });
      assert.equal(await page.locator('#g-hidden').getAttribute('aria-checked'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#g-hidden').count(), 0, 'Escape closes the menu');
      assert.ok(await page.evaluate(() => document.activeElement?.id === 'g-more'), 'focus back on ⋯');
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
      assert.equal(await d.page.locator('#g-status-sel').inputValue(), 'backlog');
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
      const count = async () => Number((await page.locator('#s-count').innerText()).match(/ · ([\d,]+) sessions? · /)[1].replace(/,/g, ''));
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
      // manual sessions come back with Undo, so there is no "Are you sure?" first
      assert.equal(await page.locator('.modal').count(), 0, 'no confirm dialog for a reversible delete');
      await toast(page, 'Deleted 2 sessions');
      await waitUntil(async () => (await page.locator('#s-list .item').count()) === 0, { message: 'bulk deleted' });
      assert.equal((await game(g0.id)).minutes, 0);
      await page.locator('#toasts .toast', { hasText: 'Deleted 2 sessions' }).locator('.toast-act', { hasText: 'Undo' }).click();
      await toast(page, 'Undone');
      await waitUntil(async () => (await page.locator('#s-list .item').count()) === 2, { message: 'both sessions back after Undo' });
      const back = (await S.ok(`/sessions?game_id=${g0.id}`)).items.map((x) => [x.minutes, x.started_at, x.ended_at]).sort((a, b) => a[0] - b[0]);
      assert.deepEqual(back, [[b1.minutes, b1.started_at, b1.ended_at], [b2.minutes, b2.started_at, b2.ended_at]], 'restored with the same minutes and times');
      await page.locator('#s-select').click();
      await page.locator('#s-list .item .check').first().check();
      await page.locator('#s-list .item .check').nth(1).check();
      await page.locator('[data-bulk="delete"]').click();
      await toast(page, 'Deleted 2 sessions');
      await waitUntil(async () => (await page.locator('#s-list .item').count()) === 0, { message: 'bulk deleted again' });
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
      await page.locator('.setting:has(#accent-t) .saved').waitFor(); // a tick beside it, not a toast
      assert.equal(await page.locator('#toasts .toast').count(), 0, 'settings changes show no toast');
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
      await S.ok('/settings', { method: 'PUT', body: { theme: 'dark', ui_density: 'comfortable', cover_size: 'm', cover_titles: 'auto', time_format: 'hm', accent: '#7656ff' } });
      await S.ok(`/games/${fmt.id}`, { method: 'DELETE' });
    }
  });

  test('settings: home sections editor autosaves; start page opens Library only when launching at /', async () => {
    const h = await visit('/settings');
    const { page } = h;
    try {
      await page.locator('#set-layout .layout-row', { hasText: 'Up next' }).locator('label.switch span').click();
      await page.locator('#lay-h .saved').waitFor();
      assert.match(await page.locator('#set-st').innerText(), /Home sections saved/, 'the live line says what was saved');
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
      await spa(l, l.page.locator('.side a.nav-link', { hasText: 'Home' }), HOME_H1);
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

  // ------------------------------------------------------------------ readable in every theme, accent and input mode
  const PRESETS = [['Violet', '#7656ff'], ['Cyan', '#22d3ee'], ['Mint', '#34d399'], ['Rose', '#f472b6'], ['Ember', '#fb923c'], ['Gold', '#facc15'], ['Red', '#ef4444'], ['Sky', '#60a5fa']];
  // a dark custom accent: mixed toward white like the presets its link colour would be 3.3:1 on a dark card
  const ODD_ACCENT = ['Navy (custom)', '#1e3a8a'];
  /** Theme + accent applied in the open page the way Settings applies them (applyTheme), without a reload. */
  const paint = (page, theme, accent) => page.evaluate(async ([th, ac]) => {
    const app = await import('/app.js');
    app.applyTheme({ ...app.state.settings, theme: th, accent: ac });
  }, [theme, accent]);

  test('contrast: text reaches 4.5:1, icons and focus rings 3:1, in dark, black and light with all 8 accent presets and a custom accent', async (t) => {
    // [what, selector, minimum, depends on the accent?, options]; measured against the pixels painted behind each
    const CHECKS = {
      desktop: {
        home: [
          ['body text (h1)', '#view h1', 4.5, false],
          ['muted text', '#view .page-h p', 4.5, false],
          ['card link', '#view .card-h a', 4.5, false],
          ['KPI value', '#view .kpis .kpi:nth-child(2) .value', 4.5, false],
          ['KPI sub', '#view .kpis .kpi:nth-child(2) .sub', 4.5, false],
          ['feature KPI label', '#view .kpi.feature .label', 4.5, true],
          ['feature KPI value', '#view .kpi.feature .value', 4.5, true],
          ['feature KPI unit', '#view .kpi.feature .value small', 4.5, true],
          ['feature KPI sub', '#view .kpi.feature .sub', 4.5, true],
          ['platform chip', '#view .plat-ic', 4.5, false],
          ['badge.accent', '#dash-recent .badge.accent', 4.5, true],
          ['chart bar (top games)', '#view .hbar ~ .hbar .track i', 3, true, { fill: true }],
          ['active nav label', '.side .nav-link.active', 4.5, true],
          ['active nav icon', '.side .nav-link.active svg', 3, true],
          ['focus ring: nav link', '.side .nav-link.active', 3, true, { ring: true }],
          ['focus ring: button', '#dash-log', 3, true, { ring: true }],
          ['nav group label', '.side .nav-group', 4.5, false],
          ['tracking health pill', '#view .health > span:last-child', 4.5, false],
          ['attention card', '#view .attn-card b', 4.5, false],
          ['attention card line', '#view .attn-card .small', 4.5, false],
        ],
        settings: [
          ['primary button', '#sched-save', 4.5, true],
          ['link (.link)', '#view a.link', 4.5, true],
          ['badge.accent', '#sched-label', 4.5, true],
          ['dim text', '#view .field .help', 4.5, false],
          ['switch track (off)', '#view .switch input:not(:checked) + span', 3, false, { fill: true }],
          ['toast.bad', '#toasts .toast.bad .toast-msg', 4.5, false, { toast: true }],
          ['toast.bad close icon', '#toasts .toast.bad .toast-x svg', 3, false],
          ['toast action button', '#toasts .toast.bad .toast-act', 4.5, false],
          ['focus ring: input', '#view [data-num="min_session_minutes"]', 3, true, { ring: true }],
          ['focus ring: switch', '#view .switch input', 3, true, { ring: true }],
        ],
        library: [
          ['filter button (on)', '#lib-filters .fbtn.on', 4.5, false],
          ['filter button count', '#lib-filters .fbtn.on .fcount', 4.5, true],
          ['filter button', '#lib-filters .fbtn:not(.on)', 4.5, false],
          ['filter pill', '#lib-pills .pill', 4.5, false],
          ['Clear all', '#lib-pills .pill-clear', 4.5, true],
          ['sidebar search', '.side .side-search .grow', 4.5, false],
          ['sidebar search key', '.side .side-search kbd', 4.5, false],
          ['focus ring: tile', '#lib-items .tile', 3, true, { ring: true }],
        ],
        game: [
          ['rated star', '#g-stars button.on svg', 3, false],
          ['unrated star', '#g-stars button:not(.on) svg', 3, false],
          ['platform chip', '#view .plat-ic', 4.5, false],
          ['KPI value', '#view .kpis.k4 .kpi .value', 4.5, false],
          ['hero split legend', '#view .hero-split .legend span', 4.5, false],
          ['achievement progress', '#g-ach .ap-sub', 4.5, false],
          ['achievement completion %', '#g-ach .ap-pct', 4.5, false],
          ['unlock group link', '#g-ach .ach-gh-link', 4.5, false],
          ['rare tag', '#g-ach .rare-tag', 4.5, false],
          ['rarity', '#g-ach .rar:not(.rare)', 4.5, false],
          ['achievement description', '#g-ach .ach-row .sub', 4.5, false],
          ['achievement icon', '#g-ach .ach-ic svg', 3, false],
          ['session unlock line', '#g-sessions .ach-line > span:last-child', 4.5, false],
        ],
        insights: [
          ['section line', '#ins-when .ins-sh .small', 4.5, false],
          ['jump chip', '#view .ins-toc .chip', 4.5, false],
          ['card note', '#ins-when .legend span', 4.5, false],
          ['strip KPI label', '#ins-when .kpi .label', 4.5, false],
        ],
        sessions: [
          ['week subtotal', '#s-list .week-h', 4.5, false],
          ['period (on)', '#s-period button.on', 4.5, false],
          ['period', '#s-period button:not(.on)', 4.5, false],
        ],
        empty: [
          ['empty state line', '#view .empty p', 4.5, false],
          ['empty state button', '#view .empty .btn.primary', 4.5, true],
          ['year switcher', '#view .wr-y', 4.5, false],
        ],
        wrapped: [
          ['Year in review g1 number', '#view .wcard.g1 .big', 4.5, true],
          ['Year in review g1 line', '#view .wcard.g1 .muted', 4.5, true],
          ['Year in review g2 line', '#view .wcard.g2 .muted', 4.5, false],
          ['Year in review g3 line', '#view .wcard.g3 .muted', 4.5, false],
        ],
      },
      phone: {
        home: [
          ['FAB icon', '#fab-log svg', 3, true],
          ['tab bar active label', '.tabbar a.active', 4.5, true],
          ['tab bar active icon', '.tabbar a.active svg', 3, true],
          ['tab bar label', '.tabbar a:not(.active)', 4.5, false],
        ],
        more: [
          ['More: featured card title', '#view .more-feature .ttl', 4.5, true],
          ['More: featured card line', '#view .more-feature .sub', 4.5, true],
          ['More: group label', '#view .more-sec .nav-group', 4.5, false],
          ['More: row description', '#view .more-row .sub', 4.5, false],
        ],
      },
    };
    const PATHS = { more: '/more', home: '/', settings: '/settings', library: '/library?status=playing', game: `/game/${D.ids.zelda}`, wrapped: `/wrapped/${YEAR}`, insights: '/insights', sessions: '/sessions', empty: '/wrapped/2001' };
    const rows = [];
    const missing = [];
    await S.ok(`/games/${D.ids.zelda}`, { method: 'PATCH', body: { rating: 6 } }); // 3 stars lit, 2 not
    try {
      for (const theme of ['dark', 'black', 'light']) {
        await S.ok('/settings', { method: 'PUT', body: { theme, accent: '#7656ff' } });
        for (const [vp, viewport] of [['desktop', DESKTOP], ['phone', PHONE]]) {
          const h = await openPage(browser, S.origin, { viewport });
          try {
            for (const [key, checks] of Object.entries(CHECKS[vp])) {
              await h.page.goto(`${S.origin}${PATHS[key]}`);
              await waitView(h.page);
              await h.settle();
              // the toast goes to the bottom right corner, clear of the controls measured on the page
              if (checks.some((c) => c[4]?.toast)) await h.page.evaluate(async () => { Object.assign(document.querySelector('#toasts').style, { left: 'auto', right: '16px', transform: 'none' }); (await import('/app.js')).toast('Sync failed: example', { bad: true, ms: 60_000, action: { label: 'Fix', run() {} } }); });
              for (const [i, [accentName, accent]] of [...PRESETS, ODD_ACCENT].entries()) {
                await paint(h.page, theme, accent);
                const now = checks.filter((c) => c[3] || i === 0);
                const measured = await sampleContrasts(h.page, now.map(([, sel, , , opts = {}]) => ({ sel, fill: !!opts.fill, ring: !!opts.ring })));
                now.forEach(([what, sel, min, perAccent, opts = {}], j) => {
                  const r = measured[j];
                  if (!r) { missing.push(`${theme} ${vp} ${key}: nothing matches ${sel}`); return; }
                  if (opts.ring && !(r.focusVisible && r.style !== 'none' && r.width >= 2)) missing.push(`${theme} ${key}: no 2px focus ring on ${sel} (${JSON.stringify(r)})`);
                  rows.push({ theme, vp, page: key, accent: perAccent ? accentName : 'any', what, min, ratio: r.ratio, fg: r.fg, bg: r.bg });
                });
              }
            }
            clean(h);
          } finally { await h.close(); }
        }
      }
    } finally {
      await S.ok('/settings', { method: 'PUT', body: { theme: 'dark', accent: '#7656ff' } });
      await S.ok(`/games/${D.ids.zelda}`, { method: 'PATCH', body: { rating: null } });
    }
    // the worst sample of each check, per theme
    const fmt = (r) => `${r.what} ${r.ratio.toFixed(2)} (${r.accent}; ${r.fg} on ${r.bg})`;
    for (const theme of ['dark', 'black', 'light']) {
      const worst = new Map();
      for (const r of rows.filter((x) => x.theme === theme)) if (!worst.has(r.what) || r.ratio < worst.get(r.what).ratio) worst.set(r.what, r);
      t.diagnostic(`${theme}: ${[...worst.values()].sort((a, b) => a.ratio / a.min - b.ratio / b.min).map(fmt).join(' | ')}`);
    }
    if (process.env.E2E_CONTRAST_REPORT) fs.writeFileSync(process.env.E2E_CONTRAST_REPORT, JSON.stringify(rows, null, 1));
    assert.deepEqual(missing, [], 'every sampled element exists and draws a focus ring');
    assert.ok(rows.length > 400, `${rows.length} samples`);
    assert.deepEqual(rows.filter((r) => r.ratio < r.min).map((r) => `${r.theme} ${r.vp} ${r.page}: ${fmt(r)} < ${r.min}`), []);
  });

  test('accent: a stored #7c5cff (the old default) shows as #7656ff, other custom accents are kept, and the on-accent ink applies before the first paint', async () => {
    const root = (page) => page.evaluate(() => {
      const d = document.documentElement;
      return { accent: d.style.getPropertyValue('--accent').trim(), on: d.dataset.onAccent, onAccent: getComputedStyle(d).getPropertyValue('--on-accent').trim(), ink: d.style.getPropertyValue('--accent-ink').trim() };
    });
    try {
      await S.ok('/settings', { method: 'PUT', body: { accent: '#7c5cff' } });
      const h = await visit('/settings');
      const { page } = h;
      try {
        assert.deepEqual({ ...(await root(page)), ink: '' }, { accent: '#7656ff', on: 'light', onAccent: '#fff', ink: '' });
        const swatches = page.locator('[data-accent]');
        assert.deepEqual(await swatches.evaluateAll((els) => els.map((e) => [e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('aria-pressed')])), [
          ['Violet (default)', 'Violet (default)', 'true'], ['Cyan', 'Cyan', 'false'], ['Mint', 'Mint', 'false'], ['Rose', 'Rose', 'false'],
          ['Ember', 'Ember', 'false'], ['Gold', 'Gold', 'false'], ['Red', 'Red', 'false'], ['Sky', 'Sky', 'false']]);
        assert.equal(await page.locator('#accent-custom').inputValue(), '#7656ff');
        const ring = await page.locator('[data-accent="#7656ff"]').evaluate((e) => getComputedStyle(e).boxShadow);
        assert.match(ring, /0px 0px 0px 4px/, 'the chosen swatch carries a ring');
        // cyan: white would be 1.8:1, so accent fills switch to dark ink, live
        await page.locator('[data-accent="#22d3ee"]').click();
        await page.locator('.setting:has(#accent-t) .saved').waitFor();
        assert.equal(await page.locator('[data-accent="#22d3ee"]').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('[data-accent="#7656ff"]').getAttribute('aria-pressed'), 'false');
        assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#sched-save')).color), 'rgb(11, 13, 18)', 'dark text on a cyan button');
        clean(h);
        // reload with app.js blocked: only the pre-paint script in index.html runs, and it already has the dark ink
        await page.route('**/app.js', (r) => r.abort());
        await page.reload();
        const pre = await root(page);
        assert.deepEqual({ ...pre, ink: /^#[0-9a-f]{6}$/.test(pre.ink) }, { accent: '#22d3ee', on: 'dark', onAccent: '#0b0d12', ink: true }, 'no white flash before the app starts');
        // and a browser still holding the old default paints the new one straight away
        await page.evaluate(() => localStorage.setItem('pt-accent', '#7c5cff'));
        await page.reload();
        assert.equal((await root(page)).accent, '#7656ff');
      } finally { await h.close(); }
      // any other custom accent is kept as it is
      await S.ok('/settings', { method: 'PUT', body: { accent: '#1e3a8a' } });
      const c = await visit('/settings');
      try {
        assert.equal((await root(c.page)).accent, '#1e3a8a');
        assert.equal(await c.page.locator('#accent-custom').inputValue(), '#1e3a8a');
        assert.equal(await c.page.locator('[data-accent][aria-pressed="true"]').count(), 0);
        clean(c);
      } finally { await c.close(); }
      assert.equal((await S.ok('/settings')).accent, '#1e3a8a', 'the API keeps what was stored');
    } finally { await S.ok('/settings', { method: 'PUT', body: { accent: '#7656ff' } }); }
  });

  test('keyboard: the first Tab offers "Skip to content", which moves focus into the page without rebuilding it; the next stops are the brand and the Main navigation', async () => {
    const h = await visit('/');
    const { page } = h;
    const focused = () => page.evaluate(() => {
      const a = document.activeElement;
      const r = a.getBoundingClientRect();
      return { id: a.id, cls: String(a.className), text: a.textContent.trim().slice(0, 30), inSide: !!a.closest('.side'), inNav: !!a.closest('nav[aria-label="Main"]'), current: a.getAttribute('aria-current'), top: r.top, bottom: r.bottom };
    });
    try {
      const box = await page.locator('a.skip').boundingBox();
      assert.ok(box.y + box.height <= 0, `the skip link is out of view until focused (${JSON.stringify(box)})`);
      await page.keyboard.press('Tab');
      let f = await focused();
      assert.equal(f.text, 'Skip to content', 'the first Tab stop');
      assert.ok(f.top >= 0, 'it shows when focused');
      const side = await page.$('.side');
      const url = page.url();
      await page.keyboard.press('Enter');
      f = await focused();
      assert.equal(f.id, 'view', 'Enter moves focus to the content');
      assert.equal(page.url(), url, 'no navigation and no #view in the URL');
      assert.ok(await page.evaluate((s) => s.isConnected && s === document.querySelector('.side'), side), 'the shell was not rebuilt');
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => !!document.activeElement.closest('#view')), 'the next Tab continues inside the content');
      await page.reload();
      await waitView(page);
      await page.keyboard.press('Tab');
      assert.equal((await focused()).text, 'Skip to content');
      await page.keyboard.press('Tab');
      f = await focused();
      assert.ok(f.inSide && /\bbrand\b/.test(f.cls), `then the Vestigo home link (${JSON.stringify(f)})`);
      await page.keyboard.press('Tab');
      f = await focused();
      assert.ok(f.inSide && /side-search/.test(f.cls), `then the search (${JSON.stringify(f)})`);
      await page.keyboard.press('Tab');
      f = await focused();
      assert.ok(f.inNav && f.text === 'Home' && f.current === 'page', `then the Main navigation, at the current page (${JSON.stringify(f)})`);
      assert.equal(await page.locator('nav[aria-label="Main"] [aria-current="page"]').count(), 1);
      clean(h);
    } finally { await h.close(); }
    const p = await visit('/library', { viewport: PHONE });
    try {
      assert.equal(await p.page.locator('nav.tabbar').getAttribute('aria-label'), 'Tabs');
      assert.deepEqual((await p.page.locator('.tabbar [aria-current="page"]').allInnerTexts()).map((x) => x.trim()), ['Library']);
      clean(p);
    } finally { await p.close(); }
  });

  test('keyboard: every focusable control on Settings shows a 2px focus ring (switches, segments, swatches, inputs, links); chips, tiles and buttons on Library too', async () => {
    const h = await visit('/settings');
    const { page } = h;
    try {
      const stops = [];
      for (let i = 0; i < 300; i++) {
        await page.keyboard.press('Tab');
        const s = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          // a switch draws its ring on the track, the hidden file input on its label button
          const ringEl = el.matches('.switch input') ? el.nextElementSibling : el.matches('input.vh') ? el.closest('label') : el;
          const cs = getComputedStyle(ringEl);
          const kind = el.matches('.switch input') ? 'switch' : el.matches('.seg button') ? 'segment' : el.matches('.swatch') ? 'swatch'
            : el.matches('.btn, label.btn input') ? 'button' : el.matches('a') ? 'link' : el.matches('select') ? 'select' : el.matches('.input') ? 'input' : el.tagName.toLowerCase();
          return {
            kind, skip: el.matches('a.skip'), name: `${kind} "${(el.getAttribute('aria-label') || el.textContent || el.name || el.id || '').trim().slice(0, 30)}"`,
            ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 && cs.outlineColor !== 'rgba(0, 0, 0, 0)',
          };
        });
        if (!s || (s.skip && stops.length)) break; // past the last control
        stops.push(s);
      }
      assert.ok(stops.length > 40, `tabbed through ${stops.length} controls`);
      for (const kind of ['switch', 'segment', 'swatch', 'button', 'link', 'input', 'select']) assert.ok(stops.some((s) => s.kind === kind), `reached a ${kind}`);
      assert.deepEqual(stops.filter((s) => !s.ring).map((s) => s.name), [], 'every stop shows a ring');
      await page.goto(`${S.origin}/library`);
      await waitView(page);
      await h.settle();
      for (const sel of ['#lib-filters [data-menu="status"]', '#lib-items .tile', '#lib-q', '#view .seg [data-view="list"]', '#lib-add']) {
        const r = await ringContrast(page, sel);
        assert.ok(r.focusVisible && r.style !== 'none' && r.width >= 2, `${sel}: a 2px focus ring (${JSON.stringify(r)})`);
        assert.ok(r.ratio >= 3, `${sel}: ring contrast ${r.ratio.toFixed(2)} (${r.fg} on ${r.bg})`);
      }
      clean(h);
    } finally { await h.close(); }
  });

  test('reduced motion: nothing keeps animating on Home, on Library while it loads, or during a sync, and sync buttons say "Syncing…"', async () => {
    // two frames first: an animation started in this frame is still "running" until the timeline moves on
    const running = (page) => page.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return document.getAnimations().filter((a) => a.playState === 'running').map((a) => a.animationName || a.transitionProperty || 'animation');
    });
    // one account reported as syncing, whatever the server says
    const syncing = (page) => page.route('**/api/v1/accounts', async (route) => {
      const res = await route.fetch();
      const list = await res.json();
      await route.fulfill({ response: res, json: list.map((a, i) => (i ? a : { ...a, syncing: true })) });
    });
    const h = await openPage(browser, S.origin, { reducedMotion: 'reduce' });
    const { page } = h;
    try {
      await page.goto(`${S.origin}/`);
      await waitView(page);
      await h.settle();
      assert.deepEqual(await running(page), [], 'Home');
      assert.ok(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.btn')).transitionDuration) < 0.001), 'transitions are instant');
      // Library while its data is still on the way: the skeleton stands still
      let release;
      const gate = new Promise((r) => { release = r; });
      await page.route('**/api/v1/stats/lifetime', async (route) => { await gate; await route.continue(); });
      await page.goto(`${S.origin}/library`);
      await page.locator('#view .skel').first().waitFor();
      assert.deepEqual(await running(page), [], 'Library while it loads');
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.skel')).animationName), 'none');
      release();
      await waitView(page);
      await page.unroute('**/api/v1/stats/lifetime');
      // a sync in progress: the label says so, the spinner does not spin
      await syncing(page);
      await page.goto(`${S.origin}/accounts`);
      await waitView(page);
      await page.locator('#sync-all-btn.loading').waitFor();
      await waitUntil(async () => (await page.locator('#sync-all-btn').innerText()).trim() === 'Syncing Switch…', { message: 'the sync button names the account' });
      assert.equal(await page.locator('#sync-all-btn').getAttribute('aria-busy'), 'true');
      assert.equal(await page.locator('.topbar [data-action="sync-all"]').getAttribute('aria-label'), 'Syncing Switch…');
      assert.deepEqual(await running(page), [], 'during a sync');
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      clean(h);
    } finally { await h.close(); }
    // the same sync state with motion allowed does spin, so the check above is not vacuous
    const m = await openPage(browser, S.origin);
    try {
      await syncing(m.page);
      await m.page.goto(`${S.origin}/accounts`);
      await waitView(m.page);
      await m.page.locator('#sync-all-btn.loading').waitFor();
      assert.ok((await running(m.page)).includes('spin'), 'the spinner turns when motion is allowed');
      await m.page.unrouteAll({ behavior: 'ignoreErrors' });
    } finally { await m.close(); }
  });

  test('phone 390px with touch: tab bar, top bar, FAB, chips, buttons, segments, swatches and stars are at least 40x40 px', async () => {
    const h = await openPage(browser, S.origin, { viewport: PHONE });
    try {
      const small = [];
      for (const path of ['/', '/library', `/game/${D.ids.zelda}`, '/sessions', '/settings']) {
        await h.page.goto(`${S.origin}${path}`);
        await waitView(h.page);
        await h.settle();
        small.push(...await h.page.evaluate((p) => {
          const out = [];
          for (const el of document.querySelectorAll('.tabbar a, .topbar a, .topbar button, .fab, .chip, #view .btn, #view .seg button, #view .swatch, #view .stars button, #view .card-h a')) {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue; // not shown on a phone
            if (r.width < 39.5 || r.height < 39.5) out.push(`${p}: ${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, '.')} "${(el.getAttribute('aria-label') || el.textContent).trim().slice(0, 30)}" is ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
          return out;
        }, path));
      }
      assert.ok(await h.page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'the phone is emulated with a touch screen');
      assert.deepEqual(small, []);
      clean(h);
    } finally { await h.close(); }
  });

  test('charts and icons: stacks go Steam, PlayStation, Xbox, custom, manual with a 1px gap; the sidebar and More page show distinct stroke-2 icons', async () => {
    const h = await visit('/');
    try {
      const segs = await h.page.evaluate(async () => {
        const { barChart, mountCharts } = await import('/charts.js');
        const div = document.createElement('div');
        div.style.width = '300px';
        document.body.append(div);
        div.innerHTML = barChart([{ label: 'x', value: 60, stack: [['manual', 'm'], ['estimated', 'e'], ['custom', 'c'], ['xbox', 'x'], ['psn', 'p'], ['steam', 's']].map(([key, color]) => ({ key, value: 10, color })) }]);
        mountCharts(div);
        const out = [...div.querySelectorAll('svg .mk')].map((r) => ({ fill: r.getAttribute('fill'), stroke: r.getAttribute('stroke'), width: r.getAttribute('stroke-width'), y: r.getBBox().y, rounded: r.tagName === 'path' }));
        div.remove();
        return out;
      });
      assert.deepEqual(segs.map((s) => s.fill), ['s', 'p', 'x', 'c', 'm', 'e'], 'bottom to top, estimated history last');
      assert.ok(segs.every((s, i) => s.stroke === 'var(--panel)' && s.width === '1' && (!i || s.y < segs[i - 1].y)), 'stacked upward, split by a 1px card-coloured line');
      assert.deepEqual(segs.map((s) => s.rounded), [false, false, false, false, false, true], 'only the top segment is rounded');
      const [steam, psn] = await srgb(h.page, await h.page.evaluate(() => ['--steam', '--psn'].map((k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim())));
      assert.ok(contrast(steam, psn) >= 2.7, `Steam and PlayStation are ${contrast(steam, psn).toFixed(2)}:1 apart in dark`);
      const side = await h.page.locator('.side-nav svg').evaluateAll((els) => els.map((e) => [e.innerHTML, e.getAttribute('stroke-width')]));
      assert.equal(side.length, 12);
      assert.equal(new Set(side.map((x) => x[0])).size, 12, 'twelve distinct sidebar icons');
      assert.ok(side.every((x) => x[1] === '2'), 'all drawn at stroke 2');
      clean(h);
    } finally { await h.close(); }
    const p = await visit('/more', { viewport: PHONE });
    try {
      const more = await p.page.locator('#view .mi svg').evaluateAll((els) => els.map((e) => [e.innerHTML, e.getAttribute('stroke-width'), e.getBoundingClientRect().width]));
      assert.equal(more.length, 8);
      assert.equal(new Set(more.map((x) => x[0])).size, 8, 'eight distinct icons');
      assert.ok(more.every((x) => x[1] === '2' && x[2] === 18), 'stroke 2 at 18px (.ic-18)');
      clean(p);
    } finally { await p.close(); }
  });

  // ------------------------------------------------------------------ charts, phone layout and perceived speed
  test('charts are drawn at their real size: 11px axis text, labels neither overlap nor leave the chart at 360, 390 and 1400px, heights by role, each an img with a summary', async () => {
    await S.ok('/settings', { method: 'PUT', body: { dashboard_layout: DEFAULT_LAYOUT.replace('-heatmap', 'heatmap') } });
    const problems = [];
    let counted = 0;
    try {
      for (const viewport of [PHONE_SMALL, PHONE, DESKTOP]) {
        const h = await openPage(browser, S.origin, { viewport });
        try {
          for (const path of ['/', '/stats?range=7d', '/stats?range=30d', '/stats?range=90d', '/stats?range=365d', `/stats?range=year:${YEAR}`, '/stats?range=all', `/game/${D.ids.zelda}`, `/game/${D.ids.celeste}`]) {
            await h.page.goto(`${S.origin}${path}`);
            await waitView(h.page);
            await h.settle();
            const charts = await chartReport(h.page);
            counted += charts.length;
            problems.push(...chartProblems(`${viewport.width}px ${path}`, charts));
            // 220px page charts, 180px card charts, 150px time of day; 180 / 160 / 130 on a phone
            const want = { page: [220, 180], card: [180, 160], small: [150, 130] };
            for (const [size, height] of await h.page.locator('#view .chart.bar').evaluateAll((els) => els.map((e) => [e.dataset.size, e.clientHeight]))) {
              if (height !== want[size][viewport.width <= 600 ? 1 : 0]) problems.push(`${viewport.width}px ${path}: a ${size} chart is ${height}px tall`);
            }
          }
          clean(h);
        } finally { await h.close(); }
      }
    } finally { await S.ok('/settings', { method: 'PUT', body: { dashboard_layout: DEFAULT_LAYOUT } }); }
    assert.deepEqual(problems, []);
    assert.ok(counted >= 3 * 20, `${counted} charts checked`);
    // a chart of nothing: round ticks, no label twice (it used to read 0h, 1h, 1h)
    const h = await visit('/stats');
    try {
      const empty = await h.page.evaluate(async () => {
        const { barChart, mountCharts } = await import('/charts.js');
        const div = document.createElement('div');
        div.style.width = '600px';
        document.querySelector('#view').append(div);
        div.innerHTML = barChart(Array.from({ length: 30 }, (_, i) => ({ label: String(i + 1), value: 0 })), { size: 'page', title: 'Playtime per day, last 30 days' });
        mountCharts(div);
        const out = { ticks: [...div.querySelectorAll('.axis text[text-anchor="end"]')].map((t) => t.textContent), label: div.querySelector('svg').getAttribute('aria-label') };
        div.remove();
        return out;
      });
      assert.deepEqual(empty, { ticks: ['0', '30m', '1h'], label: 'Playtime per day, last 30 days: nothing played' });
      const tickSets = await h.page.evaluate(async () => {
        const { niceScale } = await import('/charts.js');
        return [5, 59, 61, 125, 600, 1000, 3000, 20000, 200000].map((m) => niceScale(m).ticks.map(niceScale(m).fmt));
      });
      for (const t of tickSets) assert.equal(new Set(t).size, t.length, `distinct ticks: ${t}`);
      assert.deepEqual(tickSets[4], ['0', '4h', '8h', '12h'], '10 hours: 4h steps');
      clean(h);
    } finally { await h.close(); }
  });

  test('heatmap: at 390px it opens on the current week, is a labelled keyboard scroller, and its tooltip names the day', async () => {
    const h = await visit('/stats', { viewport: PHONE });
    const { page } = h;
    try {
      const heat = page.locator('#hm .chart.heat');
      const st = await heat.evaluate((el) => {
        const name = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        const cell = [...el.querySelectorAll('rect[data-tip]')].find((r) => r.dataset.tip.startsWith(`${name}:`));
        const a = el.getBoundingClientRect();
        const b = cell.getBoundingClientRect();
        return { tabIndex: el.tabIndex, label: el.getAttribute('aria-label'), svg: el.querySelector('svg').getAttribute('aria-label'), role: el.querySelector('svg').getAttribute('role'), scrollLeft: el.scrollLeft, scrolls: el.scrollWidth > el.clientWidth + 50, todayShown: b.left >= a.left - 1 && b.right <= a.right + 1 };
      });
      assert.equal(st.tabIndex, 0, 'focusable');
      assert.equal(st.label, `Activity in ${YEAR}, by day`);
      assert.equal(st.role, 'img');
      assert.match(st.svg, new RegExp(`^${YEAR}: .+ total|^${YEAR}: \\d+h? .*|^${YEAR}: `));
      assert.ok(st.scrolls && st.scrollLeft > 0, `the year is wider than the phone and starts scrolled to the end (${st.scrollLeft}px)`);
      assert.ok(st.todayShown, "today's cell is in view");
      // Tab from the year buttons lands on the heatmap; arrow keys scroll it
      await page.locator('#hm-year button').last().focus();
      await page.keyboard.press('Tab');
      assert.ok(await heat.evaluate((el) => el === document.activeElement && el.matches(':focus-visible')), 'the heatmap is the next Tab stop and shows a focus ring');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await waitUntil(async () => (await heat.evaluate((el) => el.scrollLeft)) < st.scrollLeft, { message: 'arrow keys scroll the heatmap' });
      clean(h);
    } finally { await h.close(); }
  });

  test('charts redraw when their box resizes and are let go when they leave the page', async () => {
    const h = await visit('/stats?range=30d');
    const { page } = h;
    const fit = () => page.evaluate(() => [...document.querySelectorAll('#view .chart.bar')].map((c) => { const vb = c.querySelector('svg').viewBox.baseVal; return [c.clientWidth, vb.width, c.clientHeight, vb.height]; }));
    const fitted = (f) => f.length >= 2 && f.every(([w, vw, hh, vh]) => w === vw && hh === vh);
    try {
      const wide = await fit();
      assert.ok(fitted(wide), `drawn at their box size: ${JSON.stringify(wide)}`);
      await page.setViewportSize({ width: 390, height: 844 });
      await waitUntil(async () => { const f = await fit(); return fitted(f) && f[0][0] < wide[0][0] && f; }, { message: 'redrawn for the narrow window' });
      assert.deepEqual(chartProblems('390px after a resize', await chartReport(page)), []);
      await page.setViewportSize(DESKTOP);
      await waitUntil(async () => { const f = await fit(); return fitted(f) && f[0][0] === wide[0][0]; }, { message: 'and back' });
      // around the app a few times: only the charts on screen are kept
      for (let i = 0; i < 3; i++) for (const nav of ['Home', 'Stats', 'Sessions', 'Library']) await spa(h, page.locator('.side a.nav-link', { hasText: nav }));
      await spa(h, page.locator('.side a.nav-link', { hasText: 'Stats' }));
      const [live, onPage] = await page.evaluate(async () => [(await import('/charts.js')).liveCharts(), document.querySelectorAll('[data-chart]').length]);
      assert.ok(onPage >= 3, `Stats shows its charts (${onPage})`);
      assert.equal(live, onPage, 'no chart is kept after its page is gone');
      clean(h);
    } finally { await h.close(); }
  });

  test('navigation: no skeleton when the page answers within 150ms, nothing of a page navigated past, and the route\'s ready signal is reliable', async () => {
    const h = await visit('/');
    const { page } = h;
    try {
      const res = await page.evaluate(async (paths) => {
        const app = await import('/app.js');
        const frames = [];
        let on = true;
        const tick = () => {
          if (!on) return;
          const shown = [...document.querySelectorAll('#app main')].filter((m) => !m.hidden);
          frames.push({ t: performance.now(), shown: shown.map((m) => ({ h1: m.querySelector('h1')?.textContent.trim() || '', skel: !!m.querySelector('.skel'), empty: !m.firstElementChild })) });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        const ready = () => new Promise((r) => { const f = () => { const v = document.querySelector('#view'); if (v && !v.hidden && !v.hasAttribute('aria-busy')) r(); else requestAnimationFrame(f); }; f(); });
        const navs = [];
        for (const p of paths) { const t0 = performance.now(); app.navigate(p); await ready(); navs.push({ p, t0, t1: performance.now() }); }
        // three navigations at once: only the last one is ever shown
        const t0 = performance.now();
        app.navigate('/library'); app.navigate('/sessions'); app.navigate('/stats');
        await ready();
        await new Promise((r) => setTimeout(r, 200));
        on = false;
        return { frames, navs, burst: { t0, t1: performance.now() } };
      }, ['/library', '/sessions', '/stats', '/', `/game/${D.ids.zelda}`, '/accounts', '/settings', '/library', '/stats', '/']);
      const fast = res.navs.filter((n) => n.t1 - n.t0 < 140);
      assert.ok(fast.length >= 3, `most navigations answer quickly against the local server (${res.navs.map((n) => Math.round(n.t1 - n.t0)).join(', ')} ms)`);
      const during = (a, b) => res.frames.filter((f) => f.t >= a && f.t <= b);
      for (const n of fast) assert.deepEqual(during(n.t0, n.t1 + 50).filter((f) => f.shown.some((s) => s.skel)).length, 0, `no skeleton frame while ${n.p} loaded in ${Math.round(n.t1 - n.t0)}ms`);
      assert.deepEqual(res.frames.filter((f) => f.shown.length !== 1 || f.shown[0].empty).map((f) => JSON.stringify(f.shown)).slice(0, 3), [], 'every frame shows exactly one page with content');
      const burst = [...new Set(during(res.burst.t0, res.burst.t1).flatMap((f) => f.shown.map((s) => s.h1)))];
      assert.ok(burst.every((t) => /this week$|Stats/.test(t)) && burst.includes('Stats'), `only the page being left and the last target are shown: ${burst}`);
      clean(h);

      // a slow server: the page being left stays (inert) for 150ms, then a skeleton in the new page's shape
      await page.route('**/api/v1/**', async (route) => { await new Promise((r) => setTimeout(r, 800)); await route.continue().catch(() => {}); });
      await page.locator('.side a.nav-link', { hasText: 'Library' }).click();
      assert.equal(await page.evaluate(viewReady), false, 'ready is false the moment a navigation starts, although the old page is still on screen');
      assert.ok(await page.locator('main.leaving').count() === 1 && await page.locator('main.leaving').evaluate((m) => m.inert && !m.querySelector('[id]')), 'the page being left is inert and has given up its ids');
      await page.locator('#view .lib-grid .skel').first().waitFor({ timeout: 3000 });
      const sk = await page.evaluate(() => ({
        tiles: document.querySelectorAll('#view .lib-grid .skel').length, kpis: document.querySelectorAll('#view .kpis .skel').length, busy: document.querySelector('#view').getAttribute('aria-busy'),
        hidden: !!document.querySelector('#view .skel').closest('[aria-hidden="true"]'), leaving: document.querySelectorAll('main.leaving').length,
      }));
      assert.deepEqual(sk, { tiles: 12, kpis: 0, busy: 'true', hidden: true, leaving: 0 }, 'Library waits behind a grid of 12 tiles, not KPI blocks');
      await waitView(page, 15000);
      assert.equal((await page.locator('#view h1').innerText()).trim(), 'Library', 'waitView returned on the new page');
      assert.ok(await page.locator('#lib-items .tile').count() > 0, 'with its games');
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      assert.deepEqual(h.rec.pageErrors, [], 'pages navigated past finish quietly');
    } finally { await h.close(); }
  });

  test('phone 390px: the floating button never covers an edit pencil or tile once scrolled to the bottom; KPIs compact; "Jump back in" on the first screen', async () => {
    const h = await openPage(browser, S.origin, { viewport: PHONE });
    const { page } = h;
    try {
      const covered = [];
      let checked = 0;
      for (const path of ['/', '/library', '/sessions']) {
        await page.goto(`${S.origin}${path}`);
        await waitView(page);
        await h.settle();
        if (path === '/') {
          const top = await page.locator('#view .card-h h2', { hasText: 'Jump back in' }).evaluate((e) => e.getBoundingClientRect().top + scrollY);
          assert.ok(top < PHONE.height, `"Jump back in" starts at ${top}px`);
          const k = await page.evaluate(() => ({ pad: getComputedStyle(document.querySelector('.kpi')).padding, value: getComputedStyle(document.querySelector('.kpi .value')).fontSize, spark: getComputedStyle(document.querySelector('.kpi .spark')).display, feature: document.querySelector('.kpi.feature').getBoundingClientRect().width > innerWidth / 2 }));
          assert.deepEqual(k, { pad: '10px 12px', value: '22px', spark: 'none', feature: true });
        }
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const r = await page.evaluate((p) => {
          const out = { bad: [], n: 0 };
          const bar = document.querySelector('.tabbar').getBoundingClientRect();
          const top = document.querySelector('.topbar').getBoundingClientRect();
          for (const el of document.querySelectorAll('#view [data-edit-session], #view .carousel .tile, #view .lib-grid .tile')) {
            const b = el.getBoundingClientRect();
            const x = b.left + b.width / 2; const y = b.top + b.height / 2;
            if (y < top.bottom || y > bar.top || x < 0 || x > innerWidth) continue; // off screen, or scrolled under the top or tab bar
            out.n++;
            const hit = document.elementFromPoint(x, y);
            // what this checks is the floating button; rows passing under the sticky toolbar and day
            // headers are meant to (how many sit there depends on how far infinite scroll has loaded)
            if (!el.contains(hit) && hit?.closest('.fab')) out.bad.push(`${p}: ${el.className || el.tagName} at ${Math.round(x)},${Math.round(y)} is under ${hit?.className || hit?.tagName}`);
          }
          return out;
        }, path);
        covered.push(...r.bad);
        checked += r.n;
      }
      assert.deepEqual(covered, []);
      assert.ok(checked >= 8, `${checked} controls checked`);
      clean(h);
    } finally { await h.close(); }
  });

  test('chips and segments: every Library chip shows at 1400px; on a phone a row that scrolls fades its edge, Stats ranges fit 360px and all 8 statuses are one select away', async () => {
    // Library: no filter control is clipped at 1400 or 390, even with every kind of filter on
    for (const viewport of [DESKTOP, PHONE]) {
      const d = await visit('/library?status=playing,wishlist&platform=custom,manual&favorite=true&hidden=all', { viewport });
      try {
        const r = await d.page.evaluate(() => {
          const out = [];
          for (const el of document.querySelectorAll('#lib-filters button, .lib-row1 > *')) {
            const b = el.getBoundingClientRect();
            if (b.width && (b.right > innerWidth + 0.5 || b.left < -0.5)) out.push(el.textContent.trim() || el.getAttribute('aria-label'));
          }
          return { cut: out, pills: document.querySelectorAll('#lib-pills .pill').length, labels: [...document.querySelectorAll('[data-menu]')].map((b) => b.textContent.trim()) };
        });
        assert.deepEqual(r.cut, [], `${viewport.width}px: nothing cut off`);
        assert.equal(r.pills, 6, 'a pill per filter');
        assert.deepEqual(r.labels, ['Platform · 2', 'Status · 2', 'More · 2'], 'menu buttons count what is on');
        clean(d);
      } finally { await d.close(); }
    }

    const s = await visit('/stats?range=30d', { viewport: PHONE_SMALL });
    try {
      const seg = await s.page.locator('#st-range').evaluate((el) => ({ fits: el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= innerWidth, labels: [...el.querySelectorAll('button')].map((b) => b.innerText.trim()) }));
      assert.deepEqual(seg, { fits: true, labels: ['7d', '30d', '90d', '12m'] });
      const years = await s.page.locator('#st-year option').allInnerTexts();
      assert.ok(years.includes(String(YEAR)) && years.includes('All time'), `years and All time in the select: ${years}`);
      await s.page.locator('#st-year').selectOption('all');
      await waitUntil(() => new URL(s.page.url()).searchParams.get('range') === 'all', { message: 'range=all' });
      assert.equal(await s.page.locator('#st-range button.on').count(), 0, 'no rolling range is marked');
      await s.page.locator('#st-range [data-r="7d"]').click();
      await waitUntil(() => new URL(s.page.url()).searchParams.get('range') === '7d', { message: 'range=7d' });
      assert.equal(await s.page.locator('#st-year').inputValue(), '');
      clean(s);
    } finally { await s.close(); }

    const g0 = await S.ok('/games', { method: 'POST', body: { title: 'Status Lab' } });
    const g = await visit(`/game/${g0.id}`, { viewport: PHONE });
    try {
      const sel = g.page.locator('#g-status-sel');
      assert.ok(await sel.isVisible());
      assert.deepEqual(await sel.locator('option').allInnerTexts(), ['No status', 'Playing', 'Backlog', 'Paused', 'Beaten', 'Completed', 'Dropped', 'Wishlist']);
      await sel.selectOption('dropped');
      await waitUntil(async () => (await game(g0.id)).status === 'dropped', { message: 'status saved from the select' });
      const o = await overflow(g.page, PHONE.width);
      assert.ok(o.doc <= PHONE.width + 1, `no side-scrolling (${o.doc}px)`);
      clean(g);
    } finally { await g.close(); await S.ok(`/games/${g0.id}`, { method: 'DELETE' }); }
  });

  test('home at 1400px: half-width cards are as tall as their content; the weekly sparkline is 7 mini bars', async () => {
    const h = await visit('/');
    try {
      const m = await h.page.evaluate(() => {
        const card = (t) => [...document.querySelectorAll('#view .card')].find((c) => c.querySelector('.card-h h2')?.textContent.trim() === t);
        const slack = (c, inner) => c.getBoundingClientRect().bottom - inner.getBoundingClientRect().bottom - parseFloat(getComputedStyle(c).paddingBottom);
        const chart = card('Last 30 days');
        const acc = card('Accounts');
        return { band: slack(chart, chart.querySelector('.legend')), acc: slack(acc, acc.lastElementChild), bars: document.querySelectorAll('#view .kpi.feature .spark-bars i').length, area: document.querySelectorAll('#view .kpi.feature svg.spark').length };
      });
      assert.ok(m.band <= 24, `empty band under the Last 30 days legend: ${m.band}px`);
      assert.ok(m.acc <= 1, `Accounts card slack: ${m.acc}px`);
      assert.deepEqual([m.bars, m.area], [7, 0]);
      clean(h);
    } finally { await h.close(); }
  });

  test('cover placeholders: a monogram plus the caption (each title once), light tints in the light theme, and "No art" differs from "Never"', async () => {
    const h = await visit('/library');
    const { page } = h;
    try {
      const r = await page.evaluate(async () => {
        const app = await import('/app.js');
        const tiles = [...document.querySelectorAll('#lib-items .tile')].map((t) => {
          const title = t.querySelector('.t').textContent.trim();
          return { title, times: t.innerText.split(title).length - 1, ini: getComputedStyle(t.querySelector('.cover .ini')).display !== 'none' && t.querySelector('.cover .ini').textContent };
        });
        return { tiles, mono: ['God of War', "Baldur's Gate 3", 'The Witness', 'A Short Hike', 'Zelda: TotK', '!!!'].map(app.monogram) };
      });
      assert.deepEqual(r.mono, ['GW', 'BG', 'W', 'SH', 'ZT', '']);
      assert.ok(r.tiles.length >= 7);
      for (const t of r.tiles) {
        assert.equal(t.times, 1, `${t.title} is written once in its tile`);
        assert.ok(t.ini, `${t.title} shows its monogram`);
      }
      const colours = async () => {
        const c = await page.locator('#lib-items .tile .cover').first().evaluate((el) => ({ bg: getComputedStyle(el).backgroundImage, ink: getComputedStyle(el.querySelector('.ph')).color }));
        const stops = c.bg.match(/rgba?\([^)]+\)/g);
        return { stops, ink: c.ink };
      };
      const dark = await colours();
      assert.ok(dark.stops.every((x) => contrast(x, 'rgb(255,255,255)') >= 4.5), `dark placeholder: white ink reads (${dark.stops})`);
      await paint(page, 'light', '#7656ff');
      const light = await colours();
      assert.ok(light.stops.every((x) => contrast(x, 'rgb(0,0,0)') >= 9), `light placeholder is a light tint (${light.stops})`);
      assert.ok(light.stops.every((x) => contrast(x, light.ink) >= 4.5), `its ink reads (${light.ink} on ${light.stops})`);
      const shown = (mode) => page.evaluate((m) => { document.documentElement.dataset.coverTitles = m; const t = document.querySelector('#lib-items .tile .cover .ph'); return ['full', 'ini'].filter((k) => getComputedStyle(t.querySelector(`.${k}`)).display !== 'none'); }, mode);
      assert.deepEqual(await shown('auto'), ['ini'], 'No art: the monogram');
      assert.deepEqual(await shown('never'), [], 'Never: a plain tint');
      assert.deepEqual(await shown('always'), ['full'], 'Always: the title on the cover (the caption is hidden)');
      clean(h);
    } finally { await h.close(); }
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
      // the filtered list (not the full one it replaces); textContent, since rows off screen are not rendered
      await page.waitForFunction(() => {
        const rows = [...document.querySelectorAll('#s-list .item')];
        return rows.length && rows.every((r) => /imported/.test(r.textContent)) && rows.some((r) => r.textContent.includes('Inscryption'));
      });
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
    const h = await openPage(browser, S.origin, { serviceWorkers: 'allow' });
    // the app would register the worker itself at once: this test registers it, after planting the old cache
    await h.ctx.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
    await h.page.goto(`${S.origin}/`);
    await waitView(h.page);
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

  test('"Sync all" with only push accounts explains there is nothing to sync, and offers to add one without leaving the page', async () => {
    const h = await visit('/');
    try {
      await h.page.locator('.side #sync-all-btn').click();
      await toast(h.page, 'No accounts to sync');
      assert.equal(new URL(h.page.url()).pathname, '/', 'still on Home');
      await h.page.locator('#toasts .toast-act', { hasText: 'Add account' }).click();
      await waitH1(h.page, 'Accounts');
      await h.page.locator('.modal', { hasText: 'Connect an account' }).waitFor();
      clean(h);
    } finally { await h.close(); }
  });
});

// ======================================================================== navigation, status, feedback
// Batch 4: the shell is built once and focus follows navigation; grouped navigation and phone badges;
// a finished sync never wipes what you were doing; toasts are announced and can undo; dialogs trap
// focus; every control is labelled; the Log session game picker works by keyboard.
describe('Vestigo web UI: navigation, status and feedback', UI, () => {
  let S; let D;
  before(async () => {
    S = await startApp();
    D = await seed(S.ok, NOW);
    // a long library: 320 more games, so Library can be scrolled past its 300th tile
    const rows = Array.from({ length: 320 }, (_, i) => `Filler ${String(i + 1).padStart(3, '0')},import,${1 + (i % 9)},2025-0${1 + (i % 9)}-15`);
    await S.ok('/import', { method: 'POST', body: `title,platform,playtime_hours,last_played\n${rows.join('\n')}\n` });
  });
  after(() => S?.close());

  async function visit(path, opts = {}) {
    const h = await openPage(browser, S.origin, opts);
    await h.page.goto(`${S.origin}${path}`);
    await waitView(h.page);
    await h.settle();
    return h;
  }
  async function spa(h, locator, h1) {
    await locator.click();
    if (h1) await waitH1(h.page, h1); else await waitView(h.page);
    await h.settle();
  }
  const clean = (h, allow = []) => {
    assert.deepEqual(h.rec.pageErrors, [], 'no uncaught page errors');
    assert.deepEqual(h.unexpectedConsole(allow), [], 'no unexpected console errors');
  };
  /** The first account reported as syncing while `fake.running`; /syncs answers with `fake.runs` (started now). */
  async function fakeSync(page) {
    const fake = { running: false, runs: [] };
    await page.route('**/api/v1/accounts', async (route) => {
      const res = await route.fetch();
      const list = await res.json();
      await route.fulfill({ response: res, json: list.map((a, i) => (i || !fake.running ? a : { ...a, syncing: true })) });
    });
    await page.route('**/api/v1/syncs?*', (route) => route.fulfill({ json: fake.runs.map((r) => ({ account_name: 'Switch', status: 'ok', sessions_created: 0, minutes_added: 0, ...r, started_at: Date.now() })) }));
    fake.start = async (runs = []) => {
      fake.running = true;
      fake.runs = runs;
      await page.evaluate(async () => (await import('/app.js')).watchSync());
      await page.locator('#sync-all-btn.loading').waitFor();
    };
    return fake;
  }
  const activeH1 = (page) => page.evaluate(() => { const a = document.activeElement; return a?.tagName === 'H1' && a.closest('#view') ? a.textContent.trim() : `${a?.tagName}${a?.id ? `#${a.id}` : ''}`; });

  test('4.1 navigation: Enter on a sidebar link or Back focuses the new page\'s h1; the sidebar stays one node; a running sync keeps spinning across pages', async () => {
    const h = await visit('/');
    const { page } = h;
    try {
      assert.equal(await page.evaluate(() => document.activeElement === document.body), true, 'the first load leaves focus alone');
      const side = await page.$('.side');
      await page.locator('.side a.nav-link', { hasText: 'Library' }).focus();
      await page.keyboard.press('Enter');
      await waitH1(page, 'Library');
      assert.equal(await activeH1(page), 'Library', 'focus moved to the new page\'s heading, not <body>');
      await page.locator('.side a.nav-link', { hasText: 'Stats' }).focus();
      await page.keyboard.press('Enter');
      await waitH1(page, 'Stats');
      assert.equal(await activeH1(page), 'Stats');
      await page.goBack();
      await waitH1(page, 'Library');
      assert.equal(await activeH1(page), 'Library', 'Back focuses the heading too');
      assert.ok(await page.evaluate((s) => s.isConnected && s === document.querySelector('.side'), side), 'the sidebar is the same node after every navigation');
      assert.deepEqual((await page.locator('.side [aria-current="page"]').allTextContents()).map((x) => x.trim()), ['Library']);

      // a sync running: the sidebar's spinner is the same animation, still turning, two pages later
      const fake = await fakeSync(page);
      await fake.start();
      assert.equal(await page.locator('#sync-all-btn').getAttribute('aria-busy'), 'true');
      assert.equal((await page.locator('#sync-all-btn').innerText()).trim(), 'Syncing Switch…', 'the button names what is syncing');
      const t0 = await page.evaluate(() => { const svg = document.querySelector('#sync-all-btn svg'); window.__spin = svg.getAnimations()[0]; window.__svg = svg; return window.__spin.currentTime; });
      await spa(h, page.locator('.side a.nav-link', { hasText: 'Sessions' }), 'Sessions');
      await spa(h, page.locator('.side a.nav-link', { hasText: 'Home' }), HOME_H1);
      const spin = await page.evaluate(() => { const svg = document.querySelector('#sync-all-btn svg'); const a = svg.getAnimations()[0]; return { same: svg === window.__svg && a === window.__spin, state: a?.playState, t: a?.currentTime }; });
      assert.ok(spin.same && spin.state === 'running' && spin.t > t0, `the spinner kept turning (${JSON.stringify(spin)}, started at ${t0})`);
      assert.ok(await page.locator('#view [data-action="sync-all"].loading').count() >= 1, 'a sync button drawn meanwhile (Home\'s "Sync now") shows the sync too');
      fake.running = false;
      await toast(page, 'Sync complete');
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      clean(h);
    } finally { await h.close(); }
  });

  test('4.2 grouped navigation: Track (with Year in review), Tidy up, Setup, Advanced; the phone More tab shows a dot named with the counts, and More counts them per row', async () => {
    const extra = await S.ok('/games', { method: 'POST', body: { title: 'Hollow Knight Voidheart Edition', merge: false } });
    const log = S.db.prepare('INSERT INTO logs(time, level, source, message) VALUES (?, ?, ?, ?)').run(Date.now(), 'error', 'sync', 'e2e: Steam said no').lastInsertRowid;
    try {
      const sum = await S.ok('/duplicates?summary=true');
      const dupes = sum.counts.suggestions + sum.counts.double_counted;
      const errors = (await S.ok('/logs?level=error&limit=1')).counts_24h.error;
      assert.ok(dupes > 0 && errors > 0, `the fixture has duplicates (${dupes}) and errors (${errors})`);
      const accounts = (await S.ok('/accounts')).length;
      const d = await visit('/');
      try {
        const groups = await d.page.locator('.side-nav .nav-sec').evaluateAll((els) => els.map((g) => {
          const label = document.getElementById(g.getAttribute('aria-labelledby'));
          return [g.getAttribute('role'), label?.textContent.trim(), [...g.querySelectorAll('a.nav-link')].map((a) => [...a.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim())];
        }));
        assert.deepEqual(groups, [
          ['group', 'Track', ['Home', 'Library', 'Sessions', 'Stats', 'Insights', 'Year in review']],
          ['group', 'Tidy up', ['Duplicates', 'Improve history']],
          ['group', 'Setup', ['Accounts', 'Settings']],
          ['group', 'Advanced', ['System', 'API']],
        ]);
        await waitUntil(async () => (await d.page.locator('#dupe-badge').textContent()) === String(dupes) && (await d.page.locator('#err-badge').textContent()) === String(errors), { message: 'sidebar badges' });
        await spa(d, d.page.locator('.side a.nav-link', { hasText: 'Year in review' }), `Your ${YEAR} trail`);
        assert.equal(new URL(d.page.url()).pathname, `/wrapped/${YEAR}`, 'Year in review opens the latest year');
        assert.deepEqual((await d.page.locator('.side .nav-link.active').allTextContents()).map((x) => x.trim()), ['Year in review']);
        clean(d);
      } finally { await d.close(); }

      const p = await visit('/', { viewport: PHONE });
      try {
        const tab = p.page.locator('.tabbar [data-nav="/more"]');
        await tab.locator('.pip:not(.hide)').waitFor();
        assert.ok(await tab.locator('.pip').evaluate((e) => e.classList.contains('bad')), 'errors make the dot the error colour');
        assert.equal(await tab.getAttribute('aria-label'), `More, ${errors} error${errors === 1 ? '' : 's'}, ${dupes} duplicate${dupes === 1 ? '' : 's'}`, 'the tab says what the dot means');
        assert.equal((await tab.innerText()).trim(), 'More');
        await spa(p, tab, 'More');
        const row = (t) => p.page.locator('#view .more-row', { hasText: t });
        await waitUntil(async () => (await row('Duplicates').locator('[data-count="dupes"]').textContent()) === String(dupes), { message: 'More counts duplicates' });
        assert.equal(await row('System').locator('[data-count="errors"]').textContent(), String(errors));
        assert.match(await row('Accounts').innerText(), new RegExp(`${accounts} accounts?`));
        assert.equal(await row('Settings').locator('.badge').count(), 0, 'rows without anything to count show no number');
        assert.equal(await p.page.locator('#view .more-feature').getAttribute('href'), `/wrapped/${YEAR}`, 'Year in review is the featured card on top');
        clean(p);
      } finally { await p.close(); }
    } finally {
      await S.ok(`/games/${extra.id}`, { method: 'DELETE' });
      S.db.prepare('DELETE FROM logs WHERE id = ?').run(log);
    }
  });

  test('4.4 a finished sync keeps your place: Notes keep text, caret and focus; Library keeps its scroll and 300+ loaded tiles; an open dialog stays; a toast sums it up, failures persist with Fix', async () => {
    const h = await visit(`/game/${D.ids.hollow}`);
    const { page } = h;
    try {
      const fake = await fakeSync(page);
      // typing in Notes
      await page.locator('#g-notes').click();
      await page.keyboard.type('Halfway up the mountain');
      await page.evaluate(() => document.querySelector('#g-notes').setSelectionRange(7, 7));
      const notes = await page.$('#g-notes');
      await fake.start([{ sessions_created: 3, minutes_added: 252 }]);
      fake.running = false;
      const msg = await toast(page, 'Sync complete');
      assert.match(msg, /Sync complete · 3 new sessions \(4h 12m\)/);
      assert.equal(await page.locator('#toasts[role="status"][aria-live="polite"] .toast', { hasText: 'Sync complete' }).count(), 1, 'the toast is inside the polite live region (announced)');
      const st = await page.evaluate((n) => ({ same: n === document.querySelector('#g-notes'), focused: document.activeElement === n, value: n.value, caret: n.selectionStart }), notes);
      assert.deepEqual(st, { same: true, focused: true, value: 'Halfway up the mountain', caret: 7 }, 'the text, caret and focus survive the sync');

      // Library, scrolled past item 300
      await page.goto(`${S.origin}/library`);
      await waitView(page);
      await h.settle();
      await waitUntil(async () => {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await h.settle(80);
        return (await page.locator('#lib-items .tile').count()) > 300;
      }, { timeout: 20_000, message: 'over 300 tiles loaded' });
      await page.locator('#lib-items .tile').nth(300).scrollIntoViewIfNeeded();
      await h.settle();
      await page.evaluate(() => document.querySelector('#lib-items .tile').setAttribute('data-e2e-first', ''));
      const before = await page.evaluate(() => ({ y: Math.round(scrollY), tiles: document.querySelectorAll('#lib-items .tile').length }));
      assert.ok(before.y > 3000, `scrolled well down (${before.y}px)`);
      await fake.start([{ sessions_created: 3, minutes_added: 252 }]);
      fake.running = false;
      await toast(page, 'Sync complete · 3 new sessions');
      const afterSync = await page.evaluate(() => ({ y: Math.round(scrollY), tiles: document.querySelectorAll('#lib-items .tile').length, kept: !!document.querySelector('#lib-items .tile[data-e2e-first]') }));
      assert.deepEqual(afterSync, { ...before, kept: true }, 'same scroll, same loaded items, nothing re-rendered');
      await page.locator('#toasts .toast', { hasText: 'Sync complete · 3 new sessions' }).last().locator('.toast-act', { hasText: 'Show' }).click();
      await waitH1(page, 'Sessions');

      // Home with a dialog open: the dialog and the page stay; once nothing is in the way Home re-renders
      await page.goto(`${S.origin}/`);
      await waitView(page);
      await page.locator('#dash-custom').click();
      await modalReady(page);
      const view = await page.$('#view');
      await fake.start([]);
      fake.running = false;
      await toast(page, 'Sync complete · no new play');
      assert.ok(await page.locator('.modal', { hasText: 'Customize home' }).isVisible(), 'the dialog is still open');
      assert.ok(await page.evaluate((v) => v === document.querySelector('#view'), view), 'Home was not re-rendered under it');
      await page.keyboard.press('Escape');
      await fake.start([{ sessions_created: 1, minutes_added: 30 }]);
      fake.running = false;
      await toast(page, 'Sync complete · 1 new session (30m)');
      await waitUntil(() => page.evaluate((v) => v !== document.querySelector('#view'), view), { message: 'Home re-rendered with nothing in the way' });

      // a failure: an error toast that stays (close button), repeated in the alert region, with Fix
      await fake.start([{ status: 'error', error: 'Steam API key rejected', sessions_created: 0 }]);
      fake.running = false;
      await toast(page, 'Switch sync failed');
      const bad = page.locator('#toasts .toast.bad', { hasText: 'Steam API key rejected' });
      assert.equal(await bad.locator('.toast-x').count(), 1, 'an error toast can be closed');
      await waitUntil(async () => /Switch sync failed — Steam API key rejected/.test(await page.locator('#alerts[role="alert"]').textContent()), { message: 'the alert region repeats it' });
      await bad.locator('.toast-act', { hasText: 'Fix' }).click();
      await waitH1(page, 'Accounts');
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      clean(h);
    } finally { await h.close(); }
  });

  test('4.5 toasts: errors close with a 44px button and pause on hover; Undo brings back a deleted manual session exactly, a status, favourite, rating, hidden flag, excluded entry and paused account', async () => {
    const g0 = await S.ok('/games', { method: 'POST', body: { title: 'Undo Lab' } });
    const s0 = await S.ok('/sessions', { method: 'POST', body: { game_id: g0.id, minutes: 45, ended_at: NOW - 5 * HOUR, note: 'keep me' } });
    const h = await visit(`/game/${g0.id}`);
    const { page } = h;
    const undo = async (text) => {
      await page.locator('#toasts .toast', { hasText: text }).last().locator('.toast-act', { hasText: 'Undo' }).click();
      await toast(page, 'Undone');
    };
    try {
      assert.deepEqual(await page.evaluate(() => [document.querySelector('#toasts').getAttribute('role'), document.querySelector('#toasts').getAttribute('aria-live'), document.querySelector('#alerts').getAttribute('role')]), ['status', 'polite', 'alert']);
      // delete a manual session: no "Are you sure?", Undo logs it again as it was
      await page.locator(`[data-edit-session="${s0.id}"]`).click();
      await modalReady(page);
      await page.locator('.modal #s-del').click();
      await toast(page, 'Session deleted');
      assert.equal(await page.locator('.modal').count(), 0, 'no confirm dialog for a reversible delete');
      assert.equal((await S.api(`/sessions/${s0.id}`)).status, 404);
      // an action keeps the toast up 6s; pointing at it holds it
      const t = page.locator('#toasts .toast', { hasText: 'Session deleted' }).last();
      await t.hover();
      await page.waitForTimeout(6500);
      assert.ok(await t.isVisible(), 'still there after 6.5s while the pointer is on it');
      await undo('Session deleted');
      const back = (await S.ok(`/sessions?game_id=${g0.id}`)).items;
      assert.equal(back.length, 1);
      assert.deepEqual([back[0].minutes, back[0].started_at, back[0].ended_at, back[0].note, back[0].source], [s0.minutes, s0.started_at, s0.ended_at, 'keep me', 'manual'], 'same start, end, minutes and note');
      assert.equal((await S.ok(`/games/${g0.id}`)).minutes, 45);
      assert.deepEqual(invariantViolations(S.db), [], 'after undoing a delete: sessions add up to every lifetime total');

      await page.locator('#g-status-sel').selectOption('beaten');
      await toast(page, 'Status: Beaten');
      await waitUntil(async () => (await S.ok(`/games/${g0.id}`)).status === 'beaten', { message: 'status saved' });
      await undo('Status: Beaten');
      await waitUntil(async () => (await S.ok(`/games/${g0.id}`)).status === 'unset', { message: 'status back' });
      assert.equal(await page.locator('#g-status-sel').inputValue(), 'unset');

      await page.locator('#g-fav').click();
      await toast(page, 'Added to favorites');
      await undo('Added to favorites');
      await waitUntil(async () => !(await S.ok(`/games/${g0.id}`)).favorite, { message: 'favourite back' });
      assert.equal(await page.locator('#g-fav').getAttribute('aria-pressed'), 'false');

      await page.locator('#g-stars [data-r="6"]').click();
      await toast(page, 'Rated 3 of 5');
      assert.equal(await page.locator('#g-stars [data-r="6"]').getAttribute('aria-checked'), 'true');
      await undo('Rated 3 of 5');
      await waitUntil(async () => (await S.ok(`/games/${g0.id}`)).rating === null, { message: 'rating back' });
      assert.equal(await page.locator('#g-stars button.on').count(), 0);

      await page.locator('#g-more').click();
      await page.locator('#g-hidden').click();
      await toast(page, 'Hidden from library');
      await undo('Hidden from library');
      await waitUntil(async () => !(await S.ok(`/games/${g0.id}`)).hidden, { message: 'hidden back' });
      if (await page.locator('#g-hidden').count()) assert.equal(await page.locator('#g-hidden').getAttribute('aria-checked'), 'false');
      await page.keyboard.press('Escape');

      await page.locator('[data-entry-menu]').first().click();
      await modalReady(page);
      await page.locator('.modal label.switch:has(#en-ex) span').click();
      await toast(page, 'Excluded from totals');
      await undo('Excluded from totals');
      await waitUntil(async () => !(await S.ok(`/games/${g0.id}`)).entries[0].excluded, { message: 'entry counted again' });

      await page.goto(`${S.origin}/accounts`);
      await waitView(page);
      const card = page.locator('.card.acct', { hasText: 'Switch' });
      await card.locator('[data-toggle]').click();
      await toast(page, 'Switch paused');
      await undo('Switch paused');
      await waitUntil(async () => (await S.ok('/accounts')).find((a) => a.name === 'Switch').enabled, { message: 'account resumed' });

      // an error: 44px close button, repeated for screen readers in the alert region
      await page.evaluate(async () => (await import('/app.js')).fail(new Error('e2e: something broke')));
      const err = page.locator('#toasts .toast.bad', { hasText: 'e2e: something broke' });
      await err.waitFor();
      const x = await err.locator('.toast-x').boundingBox();
      assert.ok(x.width >= 44 && x.height >= 44, `close button is ${x.width}x${x.height}`);
      await waitUntil(async () => (await page.locator('#alerts').textContent()) === 'e2e: something broke', { message: 'alert region' });
      await err.locator('.toast-x').click();
      await err.waitFor({ state: 'detached' });
      clean(h);
    } finally {
      await h.close();
      await S.ok(`/games/${g0.id}`, { method: 'DELETE' });
    }
  });

  test('4.6 dialogs: titled by their heading; Tab wraps inside; Escape closes only the top one and focus returns to its opener; the page behind is inert; phone sheets fit, do not scroll the page and focus their title unless they are a search', async () => {
    const d = await visit('/sessions');
    const { page } = d;
    const focus = () => page.evaluate(() => { const a = document.activeElement; return a.id || a.getAttribute('data-close') !== null && 'close' || a.tagName; });
    try {
      await page.locator('#s-log').focus();
      await page.keyboard.press('Enter');
      await modalReady(page);
      const m = page.locator('.modal', { hasText: 'Log a session' });
      assert.equal(await page.evaluate(() => { const m = document.querySelector('.modal'); return document.getElementById(m.getAttribute('aria-labelledby'))?.textContent; }), 'Log a session', 'aria-labelledby names it by its heading');
      assert.deepEqual(await page.evaluate(() => [document.querySelector('#app').inert, document.documentElement.style.overflow]), [true, 'hidden'], 'the page behind is inert and cannot scroll');
      assert.equal(await focus(), 'gp', 'the search has focus');
      await m.locator('#log-save').focus();
      await page.keyboard.press('Tab');
      assert.equal(await focus(), 'close', 'Tab on the last control wraps to the first (Close)');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await focus(), 'log-save', 'Shift+Tab on the first wraps to the last');
      await page.keyboard.press('Escape');
      await m.waitFor({ state: 'detached' });
      assert.equal(await focus(), 's-log', 'focus is back on the button that opened it');
      assert.deepEqual(await page.evaluate(() => [document.querySelector('#app').inert, document.documentElement.style.overflow]), [false, '']);

      // a dialog over a dialog: Escape closes the top one only
      await page.goto(`${S.origin}/accounts`);
      await waitView(page);
      const edit = page.locator('.card.acct', { hasText: 'Switch' }).locator('[data-edit]');
      await edit.click();
      await modalReady(page);
      await page.locator('.modal #acc-del').click();
      await page.locator('.modal', { hasText: 'Unlink account?' }).waitFor();
      await page.keyboard.press('Escape');
      await page.locator('.modal', { hasText: 'Unlink account?' }).waitFor({ state: 'detached' });
      assert.equal(await page.locator('.modal').count(), 1, 'the account dialog is still open');
      assert.equal(await focus(), 'acc-del', 'focus back on the delete button inside it');
      await page.keyboard.press('Escape');
      await page.locator('.modal').waitFor({ state: 'detached' });
      assert.ok(await edit.evaluate((b) => b === document.activeElement), 'and then on Edit');
      clean(d);
    } finally { await d.close(); }

    const p = await visit('/', { viewport: PHONE });
    try {
      const pencil = p.page.locator('#dash-recent [data-edit-session]').first();
      await pencil.scrollIntoViewIfNeeded();
      await p.page.evaluate(() => window.scrollBy(0, 120));
      const y0 = await p.page.evaluate(() => scrollY);
      assert.ok(y0 > 200, `Home is scrolled (${y0}px)`);
      await pencil.click();
      const sheet = p.page.locator('.modal');
      await sheet.waitFor();
      await modalReady(p.page);
      assert.equal(await p.page.evaluate(() => document.activeElement.matches('.modal .mh h2')), true, 'Edit session on a touch screen focuses its title: no keyboard pops up');
      await sheet.evaluate((m) => Promise.all(m.getAnimations().map((a) => a.finished))); // slid all the way up
      const box = await sheet.boundingBox();
      assert.ok(box.height <= PHONE.height - 8 && box.y + box.height <= PHONE.height + 1, `the sheet fits the screen (${JSON.stringify(box)})`);
      await p.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.page.mouse.wheel(0, 900);
      await p.page.waitForTimeout(300);
      assert.equal(await p.page.evaluate(() => scrollY), y0, 'wheeling over the sheet does not scroll the page behind');
      await p.page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'detached' });
      await p.page.locator('#fab-log').click();
      await modalReady(p.page);
      assert.equal(await p.page.evaluate(() => document.activeElement.id), 'gp', 'Log session opts in: its search takes focus');
      clean(p);
    } finally { await p.close(); }
  });

  test('4.7 labels and states: no unlabelled control and no nested interactive element on Home, Library, Sessions, Stats, a game, Settings, Improve history or any dialog; chips, segments and stars expose their state', async () => {
    const h = await visit('/');
    const { page } = h;
    const found = [];
    const check = async (where) => { for (const v of await labelViolations(page)) found.push(`${where}: ${v}`); };
    try {
      // the check is not vacuous: an unlabelled field is reported
      await page.evaluate(() => document.querySelector('#view').insertAdjacentHTML('beforeend', '<input id="e2e-unlabelled">'));
      assert.ok((await labelViolations(page)).some((v) => v.includes('e2e-unlabelled')), `the ${axeLoaded ? 'axe' : 'built-in'} check reports an unlabelled field`);
      await page.evaluate(() => document.querySelector('#e2e-unlabelled').remove());
      for (const path of ['/', '/library', '/sessions', '/stats', '/insights', `/wrapped/${YEAR}`, `/game/${D.ids.zelda}`, `/game/${D.ids.celeste}`, '/settings', '/history', '/accounts', '/system', '/more']) {
        await page.goto(`${S.origin}${path}`);
        await waitView(page);
        await h.settle();
        await check(path);
      }
      const dialogs = [
        ['/sessions', '#s-log', 'Log a session', async () => { await page.locator('#gp').fill('ce'); await page.locator('#gp-list [role=option]').first().waitFor(); }],
        ['/sessions', '[data-edit-session]', null], ['/library', '#lib-add', 'Add a game'], ['/', '#dash-custom', 'Customize home'],
        [`/game/${D.ids.celeste}`, ['#g-more', '#g-edit'], 'Edit game'], [`/game/${D.ids.celeste}`, '[data-entry-menu]', null], [`/game/${D.ids.celeste}`, ['#g-more', '#g-merge'], 'Merge', () => h.settle()],
        ['/library', '#lib-add', 'Add a game'], ['/', '[data-action="palette"]', 'Search', async () => { await page.keyboard.type('ce'); await page.locator('#pal-list [role=option]').first().waitFor(); }],
        ['/insights', '[data-action="palette"]', 'Search'],
        [`/game/${D.ids.zelda}`, '[data-hist-edit]', 'When did you play this?'], ['/accounts', '[data-edit]', 'Edit'], ['/settings', '#tok-new', 'New API token'],
        ['/accounts', '#acc-add', 'Connect', async () => { await page.locator('[data-p="custom"]').click(); await page.locator('.modal', { hasText: 'Connect Custom' }).waitFor(); }],
      ];
      for (const [path, sel, title, then] of dialogs) {
        await page.goto(`${S.origin}${path}`);
        await waitView(page);
        for (const s of [sel].flat()) await page.locator(s).first().click();
        await (title ? page.locator('.modal', { hasText: title }) : page.locator('.modal')).last().waitFor();
        await then?.();
        await check(`${path} ${sel} dialog`);
      }
      // the menus that are not dialogs: a library filter menu and the game's ⋯ menu
      for (const [path, sel, menu] of [['/library', '[data-menu="platform"]', '.fmenu'], ['/library', '[data-menu="more"]', '.fmenu'], [`/game/${D.ids.zelda}`, '#g-more', '.fmenu.pop']]) {
        await page.goto(`${S.origin}${path}`);
        await waitView(page);
        await page.locator(sel).click();
        await page.locator(menu).waitFor();
        await check(`${path} ${sel} menu`);
      }
      assert.deepEqual(found, [], `no "label" or "nested-interactive" violations (${axeLoaded ? 'axe-core' : 'built-in check'})`);

      // toggle states
      await page.goto(`${S.origin}/library`);
      await waitView(page);
      const fb = page.locator('#lib-filters [data-menu="status"]');
      assert.equal(await fb.getAttribute('aria-expanded'), 'false');
      await fb.click();
      assert.equal(await fb.getAttribute('aria-expanded'), 'true', 'a menu button says it is open');
      await page.locator('.fmenu input[value="playing"]').check();
      await waitUntil(async () => (await fb.getAttribute('aria-label')) === 'Status filter, 1 on', { message: 'the button names its count' });
      await page.locator('.fmenu input[value="playing"]').uncheck();
      await page.keyboard.press('Escape');
      assert.equal(await fb.getAttribute('aria-expanded'), 'false');
      await page.goto(`${S.origin}/sessions`);
      await waitView(page);
      const chip = page.locator('#s-chips [data-src="manual"]');
      assert.equal(await chip.getAttribute('aria-pressed'), 'false');
      await chip.click();
      await waitUntil(async () => (await chip.getAttribute('aria-pressed')) === 'true', { message: 'chip pressed' });
      await chip.click();
      await waitUntil(async () => (await chip.getAttribute('aria-pressed')) === 'false', { message: 'chip released' });
      await page.goto(`${S.origin}/library`);
      await waitView(page);
      const seg = page.locator('#view .seg').first();
      assert.equal(await seg.getAttribute('role'), 'radiogroup');
      assert.equal(await seg.getAttribute('aria-label'), 'View');
      assert.deepEqual(await seg.locator('button').evaluateAll((bs) => bs.map((b) => [b.getAttribute('role'), b.getAttribute('aria-checked')])), [['radio', 'true'], ['radio', 'false']]);
      // a segment is a radio group for the keyboard too: arrows move the choice
      await page.goto(`${S.origin}/stats`);
      await waitView(page);
      await page.locator('#st-range [data-r="30d"]').focus();
      await page.keyboard.press('ArrowRight');
      await waitUntil(async () => new URL(page.url()).searchParams.get('range') === '90d', { message: 'ArrowRight picked 90 days' });
      assert.equal(await page.locator('#st-range [data-r="90d"]').getAttribute('aria-checked'), 'true');
      assert.ok(await page.locator('#st-range [data-r="90d"]').evaluate((b) => b === document.activeElement), 'focus moved with it');
      await page.goto(`${S.origin}/game/${D.ids.celeste}`);
      await waitView(page);
      assert.equal(await page.locator('#g-stars').getAttribute('role'), 'radiogroup');
      assert.deepEqual(await page.locator('#g-stars button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label'))), ['Rate 1 of 5', 'Rate 2 of 5', 'Rate 3 of 5', 'Rate 4 of 5', 'Rate 5 of 5']);
      await page.goto(`${S.origin}/settings`);
      await waitView(page);
      const named = await page.evaluate(() => ['[data-str="start_page"]', '[data-num="week_starts_on"]', '[data-seg="theme"]'].map((s) => document.getElementById(document.querySelector(s).getAttribute('aria-labelledby'))?.textContent.trim()));
      assert.deepEqual(named, ['Start page', 'Week starts on', 'Theme'], 'settings controls are named by their row titles');
      clean(h);
    } finally { await h.close(); }
  });

  test('4.8 Log session by keyboard alone: type "had", ArrowDown and Enter pick Hades, Escape closes the list but not the dialog, Tab to Save', async () => {
    const h = await visit('/sessions');
    const { page } = h;
    try {
      const n0 = (await S.ok(`/games/${D.ids.hades}`)).summary.sessions;
      await page.locator('#s-log').focus();
      await page.keyboard.press('Enter');
      await modalReady(page);
      const gp = page.locator('#gp');
      assert.ok(await gp.evaluate((e) => e === document.activeElement));
      assert.deepEqual(await gp.evaluate((e) => ['role', 'aria-expanded', 'aria-controls', 'aria-autocomplete'].map((a) => e.getAttribute(a))), ['combobox', 'false', 'gp-list', 'list']);
      await page.keyboard.type('had');
      const list = page.locator('#gp-list');
      await list.locator('[role=option]').first().waitFor();
      assert.equal(await list.getAttribute('role'), 'listbox');
      assert.equal(await gp.getAttribute('aria-expanded'), 'true');
      await waitUntil(async () => /\d+ games? found/.test(await page.locator('.modal [aria-live="polite"]').first().textContent()), { message: 'a live line says how many were found' });
      const heights = await list.locator('[role=option]').evaluateAll((os) => os.map((o) => o.getBoundingClientRect().height));
      assert.ok(heights.every((x) => x >= 52), `options are at least 52px tall (${heights})`);
      await page.keyboard.press('ArrowDown');
      const active = await gp.getAttribute('aria-activedescendant');
      assert.match(await page.locator(`#${active}`).innerText(), /Hades/, 'ArrowDown makes the first match active');
      assert.equal(await page.locator(`#${active}`).getAttribute('aria-selected'), 'true');
      await page.keyboard.press('Escape');
      assert.equal(await gp.getAttribute('aria-expanded'), 'false', 'Escape closes the list');
      assert.ok(await list.isHidden());
      assert.equal(await page.locator('.modal').count(), 1, 'but not the dialog');
      await page.keyboard.press('ArrowDown'); // opens it again on the first match
      await waitUntil(async () => (await gp.getAttribute('aria-expanded')) === 'true' && !!(await gp.getAttribute('aria-activedescendant')), { message: 'reopened' });
      await page.keyboard.press('Enter');
      await waitUntil(async () => (await gp.inputValue()) === 'Hades', { message: 'Enter picked Hades' });
      assert.equal(await gp.getAttribute('aria-expanded'), 'false');
      for (let i = 0; i < 20 && !(await page.evaluate(() => document.activeElement.id === 'log-save')); i++) await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await toast(page, 'Logged 1h of Hades');
      assert.equal((await S.ok(`/games/${D.ids.hades}`)).summary.sessions, n0 + 1, 'the session was saved');
      clean(h);
    } finally { await h.close(); }
  });
});

// ======================================================================== tracking health
// Home says whether tracking works: healthy, a sync overdue, a failing account, paused accounts; and
// what needs a look (duplicates, rough history dates, sync errors), only while there is something.
describe('Home: tracking health', UI, () => {
  let S; let steam;
  const day = (k) => { const d = new Date(NOW - k * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  before(async () => {
    S = await startApp();
    const g = await S.ok('/games', { method: 'POST', body: { title: 'Celeste' } });
    // last week only: 30 minutes 7 days ago, 20 more on the first day of last week when weeks start on Sunday
    await S.ok('/sessions', { method: 'POST', body: { game_id: g.id, minutes: 30, date: day(7) } });
    await S.ok('/sessions', { method: 'POST', body: { game_id: g.id, minutes: 20, date: day(7 + new Date(NOW).getDay()) } });
    // a Steam account that synced two hours ago, daily (written straight to the database: no real Steam here)
    steam = S.db.prepare("INSERT INTO accounts(platform, name, config, enabled, last_sync_at, next_sync_at, last_status, created_at) VALUES ('steam', 'Steam', '{}', 1, ?, ?, 'ok', ?)")
      .run(NOW - 2 * HOUR, NOW + 22 * HOUR, NOW - 30 * DAY).lastInsertRowid;
  });
  after(() => S?.close());
  const clean = (h) => { assert.deepEqual(h.rec.pageErrors, [], 'no uncaught page errors'); assert.deepEqual(h.unexpectedConsole(), [], 'no unexpected console errors'); };
  const set = (sql, ...args) => S.db.prepare(`UPDATE accounts SET ${sql} WHERE id = ?`).run(...args, steam);

  async function home() {
    const h = await openPage(browser, S.origin);
    await h.page.goto(`${S.origin}/`);
    await waitView(h.page);
    await h.settle();
    const pill = h.page.locator('#view .health');
    return { h, page: h.page, pill, text: async () => (await pill.innerText()).replace(/\s+/g, ' ').trim(), level: () => pill.evaluate((e) => [...e.classList].find((c) => c.startsWith('h-'))) };
  }

  test('healthy: a green "Up to date" pill with the last and next sync, no attention row; the week line compares like with like and follows the week start', async () => {
    const { h, page, pill, text, level } = await home();
    try {
      assert.equal(await level(), 'h-good');
      assert.match(await text(), /^Up to date · synced 2 hours ago · next \d{1,2}:\d{2}\s?[AP]M$/);
      assert.equal(await pill.getAttribute('href'), '/accounts');
      assert.equal(await page.locator('#view .attn').count(), 0, 'nothing needs attention');
      assert.match(await page.locator('#view .dash-h .eyebrow').innerText(), /good (morning|afternoon|evening)|late night/i, 'the greeting is the eyebrow');
      assert.equal((await page.locator('#view h1').innerText()).trim(), '0m this week');
      // this week so far against the same days of last week (Monday weeks: today's weekday a week ago, back to Monday)
      const dow = new Date(NOW).getDay();
      const span = (ws) => ((dow - ws + 7) % 7) + 1;
      const lastWeek = (ws) => 30 * (7 <= 7 + span(ws) - 1 ? 1 : 0) + 20 * (7 + dow <= 7 + span(ws) - 1 ? 1 : 0);
      const line = async () => (await page.locator('#view .dash-h p').innerText()).replace(/\s+/g, ' ').trim();
      assert.equal(await line(), `down ${lastWeek(1)}m vs last week · 0 games · 0 sessions`.replace(/^down 0m vs last week/, 'Same as last week'));
      await S.ok('/settings', { method: 'PUT', body: { week_starts_on: 0 } });
      await page.reload();
      await waitView(page);
      assert.equal(await line(), `down ${lastWeek(0)}m vs last week · 0 games · 0 sessions`, 'Sunday weeks reach back to last Sunday');
      clean(h);
    } finally { await h.close(); await S.ok('/settings', { method: 'PUT', body: { week_starts_on: 1 } }); }
  });

  test('stale: "Last sync 2 days ago (expected daily)" in amber when a sync is overdue by half its interval', async () => {
    set('last_sync_at = ?, next_sync_at = ?', NOW - 2 * DAY - HOUR, NOW - DAY);
    const { h, text, level } = await home();
    try {
      assert.equal(await level(), 'h-warn');
      assert.equal(await text(), 'Last sync 2 days ago (expected daily)');
      clean(h);
    } finally { await h.close(); set('last_sync_at = ?, next_sync_at = ?', NOW - 2 * HOUR, NOW + 22 * HOUR); }
  });

  test('failing: "Steam sync failed · Fix" in red, linking to Accounts; a sync error in the log adds an attention card', async () => {
    set("last_status = 'error', last_error = 'Steam API key rejected'");
    const log = S.db.prepare('INSERT INTO logs(time, level, source, message) VALUES (?, ?, ?, ?)').run(Date.now(), 'error', 'sync', 'e2e: Steam API key rejected').lastInsertRowid;
    const { h, page, pill, text, level } = await home();
    try {
      assert.equal(await level(), 'h-bad');
      assert.equal(await text(), 'Steam sync failed · Fix');
      const cards = (await page.locator('#view .attn .attn-card').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim());
      assert.deepEqual(cards, ['1 sync error in 24 hours View log']);
      assert.equal(await page.locator('#view .attn .attn-card').getAttribute('href'), '/system');
      await pill.click();
      await waitH1(page, 'Accounts');
      clean(h);
    } finally {
      await h.close();
      set("last_status = 'ok', last_error = NULL");
      S.db.prepare('DELETE FROM logs WHERE id = ?').run(log);
    }
  });

  test('paused: "1 account paused · Resume" in amber, linking to Accounts; possible duplicates add a card', async () => {
    set('enabled = 0');
    const extra = [];
    for (const title of ['Celeste', 'Celeste Deluxe Edition']) extra.push((await S.ok('/games', { method: 'POST', body: { title, merge: false } })).id);
    const dupes = await S.ok('/duplicates?summary=true');
    const n = dupes.counts.suggestions + dupes.counts.double_counted;
    const { h, page, pill, text, level } = await home();
    try {
      assert.equal(await level(), 'h-warn');
      assert.equal(await text(), '1 account paused · Resume');
      assert.equal(await pill.getAttribute('href'), '/accounts');
      assert.ok(n > 0, 'the fixture has duplicates');
      assert.deepEqual((await page.locator('#view .attn .attn-card').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ').trim()), [`${n} possible duplicate${n === 1 ? '' : 's'} Merge or exclude`]);
      await page.locator('#view .attn-card').click();
      await waitH1(page, 'Duplicates');
      clean(h);
    } finally {
      await h.close();
      set('enabled = 1');
      for (const id of extra) await S.api(`/games/${id}`, { method: 'DELETE' });
    }
  });
});

// ======================================================================== offline
// The service worker keeps only what offline pages need, never searches, at most 60 API answers;
// with the server gone Home shows its last data under an "Offline" banner; install needs HTTPS.
describe('Offline: service worker cache and banner', UI, () => {
  let S;
  before(async () => { S = await startApp(); await seed(S.ok, NOW); });
  after(() => S?.close());

  test('only an allowlist of API answers is cached (no ?q=), at most 60; with the server stopped Home shows the offline banner with the cached time; an uncached page says it is offline', async () => {
    const h = await openPage(browser, S.origin, { serviceWorkers: 'allow' });
    const { page } = h;
    try {
      await page.goto(`${S.origin}/`);
      await waitView(page);
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await page.reload(); // now controlled: the API goes through the worker
      await waitView(page);
      assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the page is controlled by the worker');
      await page.goto(`${S.origin}/library`);
      await waitView(page);
      for (let i = 0; i < 20; i++) {
        await page.locator('#lib-q').fill(`search ${i}`);
        await page.waitForResponse((r) => r.url().includes(`q=search+${i}`) || r.url().includes(`q=search%20${i}`));
      }
      await page.goto(`${S.origin}/game/1`);
      await waitView(page);
      await page.goto(`${S.origin}/`);
      await waitView(page);
      await h.settle(300);
      const cached = await page.evaluate(async () => (await (await caches.open('vestigo-v1')).keys()).map((r) => new URL(r.url)).filter((u) => u.pathname.startsWith('/api/')).map((u) => u.pathname + u.search));
      assert.ok(cached.length > 0 && cached.length <= 60, `${cached.length} API answers cached`);
      assert.deepEqual(cached.filter((u) => /[?&]q=/.test(u)), [], 'no searches cached');
      for (const u of ['/api/v1/summary', '/api/v1/settings', '/api/v1/stats/lifetime', '/api/v1/games/1']) assert.ok(cached.includes(u), `${u} is kept for offline use (${cached})`);
      const shown = await page.locator('#view h1').innerText();

      // the server goes away
      S.inst.server.closeAllConnections?.();
      S.close();
      await page.reload();
      await page.locator('#offline-bar').filter({ hasText: 'Offline' }).waitFor({ timeout: 10_000 });
      await waitView(page);
      assert.equal(await page.locator('#view h1').innerText(), shown, 'Home shows its last data');
      assert.match(await page.locator('#offline-bar').innerText(), /^Offline · showing data from \d{1,2}:\d{2}\s?[AP]M\s*Retry$/);
      assert.equal(await page.locator('#offline-bar').getAttribute('role'), 'status');
      await page.locator('.side a.nav-link', { hasText: 'Sessions' }).click();
      await waitView(page);
      assert.match(await page.locator('#view').innerText(), /You’re offline/, 'a page never cached says so instead of failing');
      assert.deepEqual(h.rec.pageErrors, []);
    } finally { await h.close(); }
  });

  test('Settings explains that install and offline need HTTPS when the page is not a secure context', async () => {
    const E = await startApp();
    const h = await openPage(browser, E.origin);
    try {
      await h.ctx.addInitScript(() => Object.defineProperty(window, 'isSecureContext', { value: false }));
      await h.page.goto(`${E.origin}/settings`);
      await waitView(h.page);
      assert.match(await h.page.locator('#install').innerText(), /Install and offline need HTTPS, e\.g\. through your reverse proxy/);
      assert.equal(await h.page.locator('#inst-go').count(), 0);
    } finally { await h.close(); E.close(); }
  });
});

// ======================================================================== login
// A long history: 20 games x 150 sessions. The Sessions page draws 150 rows at a time and appends the
// next 150 on "Load more"; rows off screen skip layout and paint (content-visibility: auto).
describe('Vestigo web UI with a long history (3,000 sessions)', UI, () => {
  let S;
  let first; // the first game
  const ymd = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  before(async () => {
    S = await startApp();
    const games = Array.from({ length: 20 }, (_, g) => {
      const sessions = Array.from({ length: 150 }, (__, i) => ({ date: ymd(NOW - (2 * i + (g % 2) + 1) * DAY), minutes: 30 + ((g * 7 + i * 13) % 60) }));
      return { title: `Long Game ${g + 1}`, platform: 'switch', playtime_minutes: sessions.reduce((a, s) => a + s.minutes, 0) + 60, sessions };
    });
    await S.ok('/import', { method: 'POST', body: { games } });
    first = (await S.ok('/games?q=Long%20Game%201&sort=title&limit=1')).items[0];
  });
  after(() => S?.close());
  const clean = (h) => {
    assert.deepEqual(h.rec.pageErrors, [], 'no uncaught page errors');
    assert.deepEqual(h.unexpectedConsole(), [], 'no unexpected console errors');
  };

  test('seeded: 3,000 tracked sessions', async () => {
    assert.equal((await S.ok('/sessions?limit=1')).total, 3000);
  });

  // Budget: the first 150 rows within 1,500 ms of opening the page (boot, two API calls, one render:
  // ~350 ms here, the rest is headroom for a loaded CI machine), and each next page, loaded as the
  // end of the list comes near, within 300 ms of scrolling there (~70-120 ms here, flat). It appends
  // 150 rows to a list whose off-screen rows skip layout; redrawing the whole list instead grew
  // linearly, to 1.4 s at 3,000 rows.
  test('Sessions with 3,000 sessions: first rows within 1.5s, every next page (on scrolling to the end) up to all 3,000 within 300ms', async (t) => {
    const h = await openPage(browser, S.origin);
    const { page } = h;
    try {
      await page.goto(`${S.origin}/sessions`);
      await page.waitForFunction(viewReady, null, { timeout: 8000, polling: 'raf' });
      const firstMs = await page.evaluate(() => performance.now());
      assert.equal(await page.locator('#s-list .item').count(), 150);
      assert.equal(await page.locator('#s-list .item').first().evaluate((e) => getComputedStyle(e).contentVisibility), 'auto');
      assert.equal(await page.locator('#s-load, #view button', { hasText: 'Load more' }).count(), 0, 'no "Load more" button: the list continues by itself');
      const loads = [];
      for (let i = 0; i < 40 && (await page.locator('#s-list .item').count()) < 3000; i++) {
        // from the request for the next page (sent as the end comes near) to its rows on screen
        loads.push(await page.evaluate(() => new Promise((res) => {
          const n0 = document.querySelectorAll('#s-list .item').length;
          window.scrollTo(0, document.documentElement.scrollHeight);
          const f = () => {
            if (document.querySelectorAll('#s-list .item').length <= n0) return requestAnimationFrame(f);
            requestAnimationFrame(() => {
              const req = performance.getEntriesByType('resource').filter((e) => /\/api\/v1\/sessions\?.*before=/.test(e.name)).pop();
              res(performance.now() - req.startTime);
            });
          };
          f();
        })));
      }
      assert.equal(await page.locator('#s-list .item').count(), 3000, 'all 3,000 rows');
      t.diagnostic(`first rows after ${Math.round(firstMs)}ms; next pages: ${loads.map(Math.round).join(', ')} ms`);
      assert.ok(firstMs < 1500, `first rows after ${Math.round(firstMs)}ms`);
      assert.ok(Math.max(...loads) < 300, `slowest next page: ${Math.round(Math.max(...loads))}ms`);
      // a week subtotal ahead of each week, counting every loaded row of it
      const weeks = await page.locator('#s-list .week-h').count();
      assert.ok(weeks > 40, `${weeks} week subtotals`);
      // and the long page still scrolls to its end
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.locator('#s-more', { hasText: 'That’s everything' }).waitFor();
      clean(h);
    } finally { await h.close(); }
  });

  test('phone 390px Sessions: top bar, toolbar, day headers and the bulk bar stack without hiding each other while scrolling; rows at most 64px', async () => {
    const h = await openPage(browser, S.origin, { viewport: PHONE });
    const { page } = h;
    const geo = () => page.evaluate(() => {
      const r = (el) => el.getBoundingClientRect();
      const bulk = document.querySelector('#s-bulk');
      return {
        bar: r(document.querySelector('.topbar')), tb: r(document.querySelector('#view .toolbar')),
        heads: [...document.querySelectorAll('#s-list .day-h')].map((e) => ({ t: r(e).top, b: r(e).bottom })),
        bulk: bulk.classList.contains('hide') ? null : r(bulk),
      };
    });
    const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    try {
      await page.goto(`${S.origin}/sessions`);
      await waitView(page);
      await h.settle();
      // the rows on screen (rows off screen are placeholders until they come into view)
      const rows = await page.locator('#s-list .item').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((r) => r.top >= 0 && r.bottom <= innerHeight).map((r) => r.height));
      assert.ok(rows.length >= 6, `${rows.length} rows on screen`);
      assert.ok(Math.max(...rows) <= 64.5, `session rows are ${Math.max(...rows)}px at most`);
      const problems = [];
      const check = async (label) => {
        const g = await geo();
        if (g.tb.top < g.bar.bottom - 0.5) problems.push(`${label}: toolbar (top ${g.tb.top}) under the top bar (bottom ${g.bar.bottom})`);
        const stuck = g.heads.filter((x) => Math.abs(x.t - g.tb.bottom) < 1.5);
        const hidden = g.heads.filter((x) => x.b > g.bar.top + 0.5 && x.t < g.tb.bottom - 1.5);
        if (!stuck.length) problems.push(`${label}: no day header right under the toolbar (toolbar bottom ${g.tb.bottom}, headers ${g.heads.slice(0, 3).map((x) => Math.round(x.t))})`);
        if (hidden.length) problems.push(`${label}: ${hidden.length} day header(s) partly under the toolbar`);
        if (g.bulk && g.bulk.top < g.tb.bottom - 0.5) problems.push(`${label}: bulk bar (top ${g.bulk.top}) covers the toolbar (bottom ${g.tb.bottom})`);
      };
      for (let y = 600; y <= 6000; y += 700) {
        await page.evaluate((v) => window.scrollTo(0, v), y);
        await frame();
        await check(`scrolled ${y}px`);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator('#s-select').click();
      for (let y = 600; y <= 3000; y += 800) {
        await page.evaluate((v) => window.scrollTo(0, v), y);
        await frame();
        await check(`selecting, scrolled ${y}px`);
      }
      assert.deepEqual(problems, []);
      clean(h);
    } finally { await h.close(); }
  });

  test('game page: the 10 most recent sessions and a link to all of them; under 3,000px tall on a 390px phone', async () => {
    const h = await openPage(browser, S.origin, { viewport: PHONE });
    const { page } = h;
    try {
      await page.goto(`${S.origin}/game/${first.id}`);
      await waitView(page);
      await h.settle();
      assert.equal(await page.locator('#g-sessions .item').count(), 10);
      const rows = await page.locator('#g-sessions .item').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      assert.ok(Math.max(...rows) <= 64.5, `rows ${Math.max(...rows)}px`);
      const tall = await page.evaluate(() => document.documentElement.scrollHeight);
      assert.ok(tall < 3000, `the game page is ${tall}px tall`);
      const all = page.locator('#view a', { hasText: 'All 150 sessions' });
      assert.equal(await all.getAttribute('href'), `/sessions?game_id=${first.id}`);
      await all.click();
      await waitH1(page, 'Sessions');
      assert.match(await page.locator('#s-count').innerText(), /^All time · 150 sessions/);
      clean(h);
    } finally { await h.close(); }
  });
});

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
      const side = await a.page.$('.side');
      await form.locator('button').click();
      await toast(a.page, 'Password saved');
      await waitView(a.page);
      assert.equal((await S.ok('/auth/status')).auth_enabled, true);
      await a.page.locator('.side [data-action="logout"]').waitFor();
      assert.equal(await a.page.locator('.side [data-action="logout"]').count(), 1, 'Log out appears once a password is set');
      assert.ok(await a.page.evaluate((s) => s === document.querySelector('.side'), side), 'in the same sidebar: the shell is not rebuilt');
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
      assert.ok(await b.page.evaluate(() => document.activeElement === document.querySelector('#view h1')), 'after signing in, focus is on the page heading (the form it was in is gone)');
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
      await waitH1(p.page, HOME_H1);
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
    for (const f of ['index.html', 'app.js', 'pages.js', 'charts.js', 'insights.js']) {
      assert.deepEqual([...read(f).matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]), [], f);
    }
  });

  test('one design system: no fixed `.hex` platform colours, icons instead of → ↗ ↑ ↓ ♥ glyphs, five font weights, reduced-motion and touch rules', () => {
    for (const f of fs.readdirSync(PUBLIC).filter((x) => /\.(js|css|html)$/.test(x))) assert.ok(!/\.hex\b/.test(read(f)), `${f} uses theme colours, not .hex`);
    assert.deepEqual([...read('pages.js').matchAll(/[→↗↑↓♥]/gu)].map((m) => m[0]), [], 'pages.js draws arrows and hearts with icon()');
    const css = read('app.css');
    assert.deepEqual([...new Set([...css.matchAll(/font-weight: ?(\d+)/g)].map((m) => m[1]))].sort(), ['400', '500', '600', '700', '800']);
    assert.match(css, /@media \(prefers-reduced-motion: ?reduce\)/);
    assert.match(css, /@media \(pointer: ?coarse\)/);
    assert.match(css, /:focus-visible \{ outline: 2px solid var\(--accent-ink\)/);
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
