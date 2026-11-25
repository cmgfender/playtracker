// Vestigo web UI, end to end: the Milestones section of Insights (what is coming up, the latest
// highlights) and the career page (badges by year, highlights or everything, a category at a time).
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e-milestones.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, installFetchGuard, startApp, openPage, waitView, overflow, PHONE_SMALL, DESKTOP, skipReason } from './helpers/ui-e2e-harness.js';

const UI = { skip: skipReason || false };
// local noon `n` days before yesterday: the same day in any timezone, and never in the future
// (noon today has not come yet for half of every day)
const ago = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n - 1); return d.getTime(); };

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

describe('Vestigo web UI: milestones', UI, () => {
  let S; let E; let G; let big;
  before(async () => {
    S = await startApp();
    E = await startApp(); // a library with half an hour of play
    const first = (await E.ok('/games', { method: 'POST', body: { title: 'First', status: 'playing' } })).id;
    await E.ok('/sessions', { method: 'POST', body: { game_id: first, minutes: 30, ended_at: ago(0) } });
    const add = async (title) => (await S.ok('/games', { method: 'POST', body: { title, status: 'playing' } })).id;
    const log = (game_id, minutes, n) => S.ok('/sessions', { method: 'POST', body: { game_id, minutes, ended_at: ago(n) } });
    // a longer career with a series: 110 hours in one game, and three Halo games
    G = await startApp();
    const addG = async (title) => (await G.ok('/games', { method: 'POST', body: { title, status: 'playing' } })).id;
    const long = await addG('Long Haul');
    for (let i = 0; i < 11; i++) await G.ok('/sessions', { method: 'POST', body: { game_id: long, minutes: 600, ended_at: ago(40 + i) } });
    for (const [i, t] of ['Halo 3', 'Halo: Reach', 'Halo Infinite'].entries()) await G.ok('/sessions', { method: 'POST', body: { game_id: await addG(t), minutes: 30, ended_at: ago(5 - i) } });
    big = await add('Big <One>');
    // seven hours a day for eight days two months ago (56 h), then two hours on each of the last two days
    for (let i = 0; i < 8; i++) await log(big, 420, 60 + i);
    await log(big, 120, 1); await log(big, 120, 0);
  });
  after(() => {
    assert.deepEqual(guard.external, [], 'no server-side request left 127.0.0.1');
    S?.close(); E?.close(); G?.close();
  });

  async function section(app, viewport) {
    const h = await openPage(browser, app.origin, { viewport });
    await h.page.goto(`${app.origin}/insights`);
    await waitView(h.page);
    await h.page.locator('[data-jump=milestones]').click();
    const sec = h.page.locator('#ins-milestones');
    await sec.locator('.ins-body:not([aria-busy]) :is(.card, .ins-none)').first().waitFor();
    await h.settle();
    return { h, sec };
  }
  const clean = (h) => {
    assert.deepEqual(h.rec.pageErrors, [], 'no uncaught page errors');
    assert.deepEqual(h.unexpectedConsole([]), [], 'no unexpected console errors');
  };

  for (const [name, viewport] of [['a 360px phone', PHONE_SMALL], ['a desktop', DESKTOP]]) {
    test(`the latest highlights with their day, and what is coming up, on ${name}`, async () => {
      const { h, sec } = await section(S, viewport);
      try {
        const want = await S.ok('/stats/milestones?limit=8');
        // 60 hours: 10 and 50 in all; the first game; ten days, seven in a row, a 7-hour session (the 5-hour rung)
        assert.deepEqual(want.counts, { hours: 2, games: 1, days: 1, streak: 1, long_session: 1 });
        assert.equal(want.reached.find((x) => x.kind === 'games').text, 'Your first game: Big <One>');
        const rows = sec.locator('#ms-notable .item');
        // (rows off screen are not laid out until scrolled to: read their text, then look at the first and the last)
        assert.deepEqual((await rows.locator('.ttl').allTextContents()).map((x) => x.trim()), want.reached.map((x) => x.text), 'what the API reports, in its order');
        for (const row of [rows.first(), rows.last()]) { await row.scrollIntoViewIfNeeded(); assert.ok(await row.locator('.ttl').isVisible()); }
        assert.match((await rows.first().locator('.sub').textContent()).trim(), /^\w{3} \d{1,2}, \d{4}$/, 'the day, in words');
        // a game's name is a link and stays text
        const link = sec.locator('#ms-notable .item', { hasText: 'Your first game' }).locator('a');
        assert.equal(await link.textContent(), 'Big <One>');
        assert.equal(await link.getAttribute('href'), `/game/${big}`);
        assert.equal((await sec.locator('#ms-reached .card-h .tiny').innerText()).trim(), `${want.total} in all`);
        assert.equal(await sec.locator('#ms-reached a[href="/milestones"]').count(), 1, 'the whole career is a link away');
        // coming up: 60 of 100 hours in all, ten of fifty days with play
        const coming = (await sec.locator('#ms-coming .mrow').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim());
        assert.ok(coming.some((x) => /^100 hours of play\s*60h of 100h$/.test(x)), coming.join(' | '));
        assert.ok(coming.some((x) => /^50 days with tracked play\s*10 of 50$/.test(x)), coming.join(' | '));
        const o = await overflow(h.page, viewport.width);
        assert.ok(o.doc <= o.client, `no horizontal overflow: ${JSON.stringify(o)}`);
        clean(h);
      } finally { await h.close(); }
    });
  }

  test('the career page: badges by year, the highlights or everything, a category at a time', async () => {
    const h = await openPage(browser, G.origin, { viewport: PHONE_SMALL });
    try {
      await h.page.goto(`${G.origin}/milestones`);
      await waitView(h.page);
      await h.page.locator('.ms-badge').first().waitFor();
      await h.settle();
      const all = await G.ok('/stats/milestones?all=true&limit=1000');
      const notable = all.reached.filter((x) => x.notable);
      assert.ok(all.reached.some((x) => x.text === '100 hours in Long Haul'), all.reached.map((x) => x.text).join(' | '));
      assert.ok(all.reached.some((x) => x.text === '3 games of the Halo series'));
      assert.equal(await h.page.locator('.ms-badge').count(), notable.length, 'the highlights first');
      assert.deepEqual(await h.page.locator('.ms-year .ms-yh h2').allInnerTexts(), [...new Set(notable.map((x) => x.day.slice(0, 4)))]);
      await h.page.locator('[data-every="1"]').click();
      assert.equal(await h.page.locator('.ms-badge').count(), all.total, 'everything');
      assert.match(h.page.url(), /show=all/);
      await h.page.locator('[data-cat="series"]').click();
      const series = all.reached.filter((x) => x.category === 'series');
      assert.equal(await h.page.locator('.ms-badge').count(), series.length);
      assert.ok(await h.page.locator('.ms-badge', { hasText: '3 games of the Halo series' }).isVisible());
      assert.match((await h.page.locator('.ms-badge .ms-when span').first().innerText()).trim(), /^\w{3} \d{1,2}, \d{4}$/, 'tracked play: the day');
      const o = await overflow(h.page, PHONE_SMALL.width);
      assert.ok(o.doc <= o.client, `fits a 360px phone: ${JSON.stringify(o)}`);
      clean(h);
    } finally { await h.close(); }
  });

  test('half an hour of play: the first game reached, the first rungs ahead', async () => {
    const { h, sec } = await section(E, PHONE_SMALL);
    try {
      assert.deepEqual((await sec.locator('#ms-notable .item .ttl').allTextContents()).map((x) => x.trim()), ['Your first game: First']);
      assert.equal((await sec.locator('#ms-reached .card-h .tiny').innerText()).trim(), '1 in all');
      const coming = (await sec.locator('#ms-coming .mrow').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim());
      assert.ok(coming.some((x) => /^10 hours of play\s*0h of 10h$/.test(x)), coming.join(' | '));
      assert.ok(coming.some((x) => /^10 days with tracked play\s*1 of 10$/.test(x)), coming.join(' | '));
      clean(h);
    } finally { await h.close(); }
  });
});
