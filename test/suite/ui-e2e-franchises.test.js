// Vestigo web UI, end to end: Franchises - the list, a franchise in release order (the games you
// don't own too), story order, and the game page's card with the main games either side.
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e-franchises.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, installFetchGuard, startApp, openPage, waitView, overflow, PHONE_SMALL, DESKTOP, skipReason } from './helpers/ui-e2e-harness.js';

const UI = { skip: skipReason || false };
const ago = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n - 1); return d.getTime(); };

describe('Vestigo web UI: franchises', UI, () => {
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
        await page.waitForURL(/\/franchise\/halo$/);
        await waitView(page);
        assert.equal((await page.locator('#view h1').innerText()).trim(), 'Halo');
        const rows = page.locator('#fr-items .fr-item');
        assert.deepEqual((await rows.locator('.fr-year').allInnerTexts()).slice(0, 3), ['2001', '2004', '2007']);
        assert.match(await rows.filter({ hasText: 'Halo 3:' }).first().innerText(), /Not in your library/, 'ODST: not owned');
        assert.equal(await rows.filter({ hasText: 'Halo 5: Guardians' }).locator('a').getAttribute('href'), `/game/${id.h5}`);
        assert.match(await page.locator('.fr-next').innerText(), /Halo Infinite/, 'after Halo 5: Infinite');
        await page.locator('[data-order="story"]').click();
        assert.equal((await rows.first().locator('.ttl').innerText()).trim(), 'Halo Wars');
        const o = await overflow(page, viewport.width);
        assert.ok(o.doc <= o.client, `no horizontal overflow: ${JSON.stringify(o)}`);
        clean(h);
      } finally { await h.close(); }
    });
  }

  test('the game page: its place in the series and the main games either side', async () => {
    const h = await openPage(browser, S.origin, { viewport: DESKTOP });
    try {
      await h.page.goto(`${S.origin}/game/${id.h5}`);
      await waitView(h.page);
      const c = h.page.locator('#g-franchise');
      assert.match(await c.innerText(), /7th of 8 main games, released 2015/);
      assert.match(await c.innerText(), /Halo 4[\s\S]*Halo Infinite/);
      assert.equal(await c.locator('a[href="/franchise/halo"]').count(), 1);
      clean(h);
    } finally { await h.close(); }
  });
});
