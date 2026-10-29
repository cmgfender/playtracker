// Vestigo web UI, end to end: what IGDB metadata unlocks, on the demo library with metadata stored
// directly (no network): Insights' Genres & series section, the Stats page's Genres card, the
// library's Genre filter and Release date sort, the game page's About card (time to beat, links,
// Wrong game?), and the Settings card. Nothing of it shows without metadata.
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e-igdb.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chromium, installFetchGuard, startApp, openPage, waitView, waitUntil, overflow, DESKTOP, PHONE_SMALL, skipReason,
} from './helpers/ui-e2e-harness.js';
import { seedDemo } from '../../src/demo.js';

const UI = { skip: skipReason || false };
const G = (id, name, genres, extra = {}) => ({ id, name, genres: genres.map((n) => ({ name: n })), game_modes: [{ name: 'Single player' }], ...extra });
const META = {
  "Baldur's Gate 3": G(119171, "Baldur's Gate 3", ['Role-playing (RPG)', 'Strategy', 'Adventure'], {
    first_release_date: 1691020800, total_rating: 95.1, total_rating_count: 800, franchises: [{ name: "Baldur's Gate" }], player_perspectives: [{ name: 'Bird view / Isometric' }],
    involved_companies: [{ developer: true, company: { name: 'Larian Studios' } }, { publisher: true, company: { name: 'Larian Studios' } }], summary: 'A party-based RPG.',
    ttb: { hastily: 60 * 3600, normally: 100 * 3600, completely: 150 * 3600 }, url: 'https://www.igdb.com/games/baldurs-gate-3',
  }),
  Balatro: G(251833, 'Balatro', ['Card & Board Game', 'Indie'], { first_release_date: 1708387200, involved_companies: [{ developer: true, company: { name: 'LocalThunk' } }] }),
  Hades: G(113112, 'Hades', ["Hack and slash/Beat 'em up", 'Indie', 'Role-playing (RPG)'], { first_release_date: 1600300800, ttb: { hastily: 22 * 3600, normally: 40 * 3600 }, involved_companies: [{ developer: true, company: { name: 'Supergiant Games' } }] }),
  'Stardew Valley': G(17000, 'Stardew Valley', ['Simulator', 'Indie', 'Role-playing (RPG)'], { first_release_date: 1456444800, involved_companies: [{ developer: true, company: { name: 'ConcernedApe' } }] }),
};

describe('IGDB metadata in the UI', UI, () => {
  let browser; let guard; let S; const ids = {};
  before(async () => {
    if (skipReason) return;
    guard = installFetchGuard();
    browser = await chromium.launch();
    S = await startApp();
    seedDemo(S.db, { now: Date.now() });
    for (const [title, rec] of Object.entries(META)) {
      ids[title] = S.db.prepare('SELECT id FROM games WHERE title = ?').get(title).id;
      S.app.igdb.store(ids[title], rec, 'title');
    }
  });
  after(async () => {
    await browser?.close();
    assert.deepEqual(guard?.external || [], [], 'nothing left 127.0.0.1');
    guard?.restore();
    S?.close();
  });
  async function visit(url, viewport = DESKTOP) {
    const h = await openPage(browser, S.origin, { viewport });
    await h.page.goto(`${S.origin}${url}`);
    await waitView(h.page);
    return h;
  }
  const clean = (h, allow = []) => {
    assert.deepEqual(h.rec.pageErrors, [], 'no uncaught page errors');
    assert.deepEqual(h.unexpectedConsole(allow), [], 'no unexpected console errors');
  };

  test('Insights: Genres & series appears with genres, their trend, series, developers and your pace', async () => {
    const h = await visit('/insights?range=all');
    const { page } = h;
    try {
      assert.ok(await page.locator('[data-jump=genres]').count(), 'listed among the sections');
      await page.locator('[data-jump=genres]').click();
      const sec = page.locator('#ins-genres');
      await sec.locator('.card h3').first().waitFor();
      assert.deepEqual(await sec.locator('.card h3').allInnerTexts(), ['Genres', 'Genres over time', 'Series', 'Developers', 'Your pace']);
      const t = await S.ok('/stats/tags?kind=genre&range=all');
      assert.equal(await sec.locator('a.mrow.mlink .ml').first().innerText(), t.items[0].name);
      assert.equal(await sec.locator('a.mrow.mlink').first().getAttribute('href'), `/library?tag=${encodeURIComponent(`genre:${t.items[0].name}`)}`);
      assert.match(await sec.locator('.card', { hasText: 'Your pace' }).innerText(), /You finish games in [\d.]+× the typical main story time/);
      clean(h);
    } finally { await h.close(); }
  });

  test('Stats: a Genres card; Library: the Genre filter and Release date sort', async () => {
    let h = await visit('/stats?range=all');
    try {
      const card = h.page.locator('.card', { has: h.page.locator('h2', { hasText: 'Genres' }) });
      await card.waitFor();
      assert.ok(await card.locator('a.mrow').count() >= 3);
      clean(h);
    } finally { await h.close(); }
    h = await visit('/library');
    const { page } = h;
    try {
      const btn = page.locator('[data-menu=tag]');
      await btn.click();
      await page.locator('#lib-menu-tag input[value="genre:Indie"]').check();
      await waitUntil(() => new URL(page.url()).searchParams.get('tag') === 'genre:Indie', { message: 'tag in the URL' });
      const want = await S.ok('/games?tag=genre:Indie&limit=50');
      await waitUntil(async () => (await page.locator('#lib-count').innerText()).startsWith(`${want.total} game`), { message: 'filtered count' });
      assert.equal(want.total, 3);
      assert.ok(await page.locator('#lib-pills [data-rm="tag:genre:Indie"]').count());
      assert.ok(await page.locator('#lib-sort option[value=released]').count(), 'Release date sort offered');
      clean(h);
    } finally { await h.close(); }
  });

  test('Game page: About with links, the time to beat against yours, and Wrong game?', async () => {
    const h = await visit(`/game/${ids["Baldur's Gate 3"]}`);
    const { page } = h;
    try {
      const about = page.locator('#g-about');
      await about.waitFor();
      const text = await about.innerText();
      assert.match(text, /Role-playing \(RPG\)/);
      assert.match(text, /Developer\s+Larian Studios/);
      assert.doesNotMatch(text, /Publisher/, 'the same company as the developer is not repeated');
      assert.match(text, /Main story\s+60h/);
      assert.match(text, /You\s+\d/);
      assert.equal(await about.locator('a.chip', { hasText: 'Strategy' }).getAttribute('href'), `/library?tag=${encodeURIComponent('genre:Strategy')}`);
      assert.match(text, /matched by its title/);
      await about.locator('#g-meta-fix').click();
      const m = page.locator('.modal', { hasText: 'Match on IGDB' });
      await m.waitFor();
      // no IGDB credentials in this test: the search says so instead of failing silently
      await waitUntil(async () => /IGDB is not set up/.test(await m.locator('#mm-r').innerText()), { message: 'a plain error' });
      await m.locator('[data-close]').first().click();
      clean(h, [422]);
    } finally { await h.close(); }
  });

  test('Settings: the IGDB card, the secret never shown; everything fits a 360px phone', async () => {
    const h = await visit('/settings#metadata');
    try {
      const card = h.page.locator('#metadata');
      await card.waitFor();
      assert.match(await card.innerText(), /Game metadata/);
      assert.equal(await card.locator('#ig-secret').getAttribute('type'), 'password');
      assert.equal(await card.locator('#ig-secret').inputValue(), '');
      assert.match(await card.locator('#ig-st').innerText(), /^$|games have metadata/);
      clean(h);
    } finally { await h.close(); }
    for (const url of ['/insights?range=all', `/game/${ids["Baldur's Gate 3"]}`, '/library', '/stats?range=all']) {
      const p = await visit(url, PHONE_SMALL);
      try {
        if (url.startsWith('/insights')) { await p.page.locator('[data-jump=genres]').click(); await p.page.locator('#ins-genres .card').first().waitFor(); }
        await p.page.waitForTimeout(300);
        const o = await overflow(p.page, 360);
        assert.ok(o.doc <= o.client && o.body <= 360, `${url} at 360px: ${o.doc}px wide, widest ${JSON.stringify(o.culprit)}`);
      } finally { await p.close(); }
    }
  });
});
