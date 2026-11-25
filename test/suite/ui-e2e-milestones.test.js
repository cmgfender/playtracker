// Vestigo web UI, end to end: Milestones - the badges of a career by year, highlights or everything,
// a category at a time, and what is coming up. (Insights holds no badges: it points here.)
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

  /** The Milestones page of an app, its badges drawn. */
  async function page(app, viewport) {
    const h = await openPage(browser, app.origin, { viewport });
    await h.page.goto(`${app.origin}/milestones`);
    await waitView(h.page);
    await h.page.locator('.ms-badge').first().waitFor();
    await h.settle();
    return h;
  }
  const clean = (h) => {
    assert.deepEqual(h.rec.pageErrors, [], 'no uncaught page errors');
    assert.deepEqual(h.unexpectedConsole([]), [], 'no unexpected console errors');
  };

  for (const [name, viewport] of [['a 360px phone', PHONE_SMALL], ['a desktop', DESKTOP]]) {
    test(`the badges with their day, and what is coming up, on ${name}`, async () => {
      const h = await page(S, viewport);
      try {
        const want = await S.ok('/stats/milestones?limit=8');
        // 60 hours: 10 and 50 in all; the first game; ten days, seven in a row, a 7-hour session (the 5-hour rung)
        assert.deepEqual(want.counts, { hours: 2, games: 1, days: 1, streak: 1, long_session: 1 });
        assert.equal(want.reached.find((x) => x.kind === 'games').text, 'Your first game: Big <One>');
        // a title is text (never markup), and a link to its game
        const first = h.page.locator('.ms-badge', { hasText: 'Your first game' });
        assert.match(await first.innerText(), /Big <One>/);
        assert.equal(await first.locator('a').getAttribute('href'), `/game/${big}`);
        const coming = (await h.page.locator('#ms-next .ms-next').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim());
        assert.ok(coming.some((x) => /^100 hours of play\s*60h of 100h · 60%$/.test(x)), coming.join(' | '));
        assert.ok(coming.some((x) => /^50 days with tracked play\s*10 of 50 · 20%$/.test(x)), coming.join(' | '));
        const o = await overflow(h.page, viewport.width);
        assert.ok(o.doc <= o.client, `no horizontal overflow: ${JSON.stringify(o)}`);
        clean(h);
      } finally { await h.close(); }
    });
  }

  test('badges live on Milestones only: Insights tells findings and points here', async () => {
    const h = await openPage(browser, S.origin, { viewport: DESKTOP });
    try {
      await h.page.goto(`${S.origin}/insights`);
      await waitView(h.page);
      assert.equal(await h.page.locator('[data-jump=milestones], #ins-milestones').count(), 0, 'no badges on Insights');
      assert.equal((await h.page.locator('.ins-sec h2').first().innerText()).trim(), 'Findings');
      await h.page.locator('#ins-findings .ins-body:not([aria-busy]) :is(.ins-finding, .ins-none)').first().waitFor();
      clean(h);
    } finally { await h.close(); }
  });

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
    const h = await page(E, PHONE_SMALL);
    try {
      assert.deepEqual((await h.page.locator('.ms-badge .ms-t').allTextContents()).map((x) => x.trim()), ['Your first game: First']);
      const coming = (await h.page.locator('#ms-next .ms-next').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim());
      assert.ok(coming.some((x) => /^10 days with tracked play\s*1 of 10 · 10%$/.test(x)), coming.join(' | '));
      clean(h);
    } finally { await h.close(); }
  });
});
