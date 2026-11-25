// Vestigo web UI, end to end: Legends - the page, a series' legend (its story, then the series in
// release order with the games you don't own too, its eras, versions linked to their originals, story
// order), an era of your own added and removed, and the game page's card with its era and the main
// games either side.
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e-franchises.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, installFetchGuard, startApp, openPage, waitView, overflow, PHONE_SMALL, DESKTOP, skipReason } from './helpers/ui-e2e-harness.js';

const UI = { skip: skipReason || false };
const ago = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n - 1); return d.getTime(); };

describe('Vestigo web UI: legends and series', UI, () => {
  let browser; let guard; let S; const id = {};
  before(async () => {
    guard = installFetchGuard();
    browser = await chromium.launch();
    S = await startApp();
    const add = async (title) => (await S.ok('/games', { method: 'POST', body: { title } })).id;
    id.h3 = await add('Halo 3');
    id.h5 = await add('Halo 5: Guardians');
    await S.ok('/sessions', { method: 'POST', body: { game_id: id.h3, minutes: 300, ended_at: ago(20) } });
    await S.ok('/sessions', { method: 'POST', body: { game_id: id.h5, minutes: 120, ended_at: ago(2) } });
  });
  after(async () => {
    await browser?.close();
    assert.deepEqual(guard?.external || [], [], 'nothing left 127.0.0.1');
    guard?.restore();
    S?.close();
  });
  const clean = (h) => {
    assert.deepEqual(h.rec.pageErrors, [], 'no uncaught page errors');
    assert.deepEqual(h.unexpectedConsole([]), [], 'no unexpected console errors');
  };

  for (const [name, viewport] of [['a 360px phone', PHONE_SMALL], ['a desktop', DESKTOP]]) {
    test(`the list and a franchise in release order, on ${name}`, async () => {
      const h = await openPage(browser, S.origin, { viewport });
      const { page } = h;
      try {
        await page.goto(`${S.origin}/franchises`);
        await waitView(page);
        const card = page.locator('.fr-card', { hasText: 'Halo' });
        assert.match(await card.innerText(), /2 of 8 main games played/);
        await card.click();
        await page.waitForURL(/\/legend\/series\/halo$/);
        await waitView(page);
        assert.equal((await page.locator('#view h1').innerText()).trim(), 'Halo');
        const rows = page.locator('#fr-items .fr-item');
        assert.deepEqual((await rows.locator('.fr-year').allInnerTexts()).slice(0, 3), ['2001', '2004', '2007']);
        assert.match(await rows.filter({ hasText: 'Halo 3:' }).first().innerText(), /Not in your library/, 'ODST: not owned');
        assert.equal(await rows.filter({ hasText: 'Halo 5: Guardians' }).locator('a').getAttribute('href'), `/game/${id.h5}`);
        assert.match(await page.locator('.fr-next').innerText(), /Halo Infinite/, 'after Halo 5: Infinite');
        // eras: a card of them, and each one heading its games in release order
        assert.deepEqual(await page.locator('.fr-era .nm').allInnerTexts(), ['Bungie', '343 Industries', 'Halo Studios']);
        assert.deepEqual(await page.locator('#fr-items .fr-era-h b').allInnerTexts(), ['Bungie', '343 Industries', 'Halo Studios']);
        await page.locator('.fr-era', { hasText: '343 Industries' }).click();
        await page.locator('#fr-era-1').waitFor();
        // a remaster says what it is a version of; the original lists its versions
        const row = (t) => rows.filter({ has: page.locator('.ttl', { hasText: new RegExp(`^${t}$`) }) });
        assert.match(await row('Halo: Combat Evolved Anniversary').innerText(), /Remaster of Halo: Combat Evolved \(2001\)/);
        assert.match(await row('Halo 2').innerText(), /Also as Halo 2: Anniversary \(2014\)/);
        await page.locator('[data-order="story"]').click();
        assert.equal((await rows.first().locator('.ttl').innerText()).trim(), 'Halo Wars');
        const o = await overflow(page, viewport.width);
        assert.ok(o.doc <= o.client, `no horizontal overflow: ${JSON.stringify(o)}`);
        clean(h);
      } finally { await h.close(); }
    });
  }

  test('Legends: the career, the series found, a series told as a story; the old series address still opens it', async () => {
    const h = await openPage(browser, S.origin, { viewport: DESKTOP });
    const { page } = h;
    try {
      await page.goto(`${S.origin}/legends`);
      await waitView(page);
      assert.equal((await page.locator('#view h1').innerText()).trim(), 'Legends');
      assert.match(await page.locator('.lg-career').innerText(), /across 2 games/);
      assert.deepEqual(await page.locator('.lg-sec h2').allInnerTexts(), ['Your eras', 'Series', 'Console generations', 'Trends', 'Makers']);
      assert.equal(await page.locator('.side-nav a.active').innerText(), 'Legends');
      await page.locator('#lg-series .fr-card', { hasText: 'Halo' }).click();
      await page.waitForURL(/\/legend\/series\/halo$/);
      await waitView(page);
      assert.deepEqual(await page.locator('.lg-ch h3').allInnerTexts(), ['Where it began', 'The peak', 'What defined it', 'How far it went', 'Where you stand', 'Where it stands']);
      assert.match(await page.locator('.lg-ch[data-ch="began"] p').innerText(), /^The series began in 2001\. You arrived on .+ with Halo 3, \d+ years in\.$/);
      assert.equal(await page.locator('.lg-ch[data-ch="defined"] a').first().getAttribute('href'), `/game/${id.h3}`);
      assert.equal(await page.locator('#lg-series #fr-items .fr-item').count() > 10, true, 'the series, game by game, under its story');
      await page.goto(`${S.origin}/franchise/halo`);
      await waitView(page);
      assert.equal((await page.locator('#view h1').innerText()).trim(), 'Halo');
      await page.goto(`${S.origin}/legend/trend/space-marines`);
      await waitView(page);
      assert.equal((await page.locator('#view h1').innerText()).trim(), 'When space marines were cool');
      clean(h);
    } finally { await h.close(); }
  });

  test('an era of your own: added from the page, told from what you played then, removed', async () => {
    const h = await openPage(browser, S.origin, { viewport: PHONE_SMALL });
    const { page } = h;
    try {
      await page.goto(`${S.origin}/legends`);
      await waitView(page);
      await page.locator('[data-era-add]').first().click();
      const m = page.locator('.modal', { hasText: 'Add an era' });
      await m.locator('[name=name]').fill('These weeks');
      const now = new Date(); const from = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      await m.locator('[name=fm]').selectOption(String(from.getMonth() + 1));
      await m.locator('[name=fy]').selectOption(String(from.getFullYear()));
      await m.locator('[name=ongoing]').check();
      await m.locator('#era-save').click();
      await page.waitForURL(/\/legend\/era\/1$/);
      await waitView(page);
      assert.equal((await page.locator('#view h1').innerText()).trim(), 'These weeks');
      assert.match(await page.locator('.lg-ch[data-ch="defined"] p').innerText(), /^Halo 3 is the heart of it: 5 hours, 71% of the total\. Then Halo 5: Guardians \(2 hours\)\.$/);
      assert.equal(await page.locator('#lg-games .item').count(), 2);
      const o = await overflow(page, PHONE_SMALL.width);
      assert.ok(o.doc <= o.client, `fits a 360px phone: ${JSON.stringify(o)}`);
      await page.goto(`${S.origin}/legends`);
      await waitView(page);
      assert.match(await page.locator('#lg-eras .fr-card').innerText(), /These weeks/);
      await page.locator('#lg-eras .fr-card').click();
      await waitView(page);
      await page.locator('#lg-del').click();
      await page.locator('.modal button', { hasText: 'Remove' }).click();
      await page.waitForURL(/\/legends$/);
      await waitView(page);
      assert.equal(await page.locator('#lg-eras .fr-card').count(), 0);
      assert.deepEqual((await S.ok('/legends')).eras, []);
      clean(h);
    } finally { await h.close(); }
  });

  test('the game page: its place in the series and the main games either side', async () => {
    const h = await openPage(browser, S.origin, { viewport: DESKTOP });
    try {
      await h.page.goto(`${S.origin}/game/${id.h5}`);
      await waitView(h.page);
      const c = h.page.locator('#g-franchise');
      assert.match(await c.innerText(), /7th of 8 main games, released 2015/);
      assert.match(await c.innerText(), /343 Industries era \(2011–2021\)/);
      assert.match(await c.innerText(), /Halo 4[\s\S]*Halo Infinite/);
      assert.equal(await c.locator('a[href="/legend/series/halo"]').count(), 1);
      clean(h);
    } finally { await h.close(); }
  });
});
