// Vestigo web UI, end to end: the Milestones section of Insights: what is coming up with how far
// along it is, and every milestone reached with its day, on a phone and on a desktop.
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e-milestones.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, installFetchGuard, startApp, openPage, waitView, overflow, PHONE_SMALL, DESKTOP, skipReason } from './helpers/ui-e2e-harness.js';

const UI = { skip: skipReason || false };
// local noon `n` days ago, so the day is the same in any timezone
const ago = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d.getTime(); };

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
  let S; let E; let big;
  before(async () => {
    S = await startApp();
    E = await startApp(); // a library with half an hour of play
    const first = (await E.ok('/games', { method: 'POST', body: { title: 'First', status: 'playing' } })).id;
    await E.ok('/sessions', { method: 'POST', body: { game_id: first, minutes: 30, ended_at: ago(0) } });
    const add = async (title) => (await S.ok('/games', { method: 'POST', body: { title, status: 'playing' } })).id;
    const log = (game_id, minutes, n) => S.ok('/sessions', { method: 'POST', body: { game_id, minutes, ended_at: ago(n) } });
    big = await add('Big <One>');
    // seven hours a day for eight days two months ago (56 h), then two hours on each of the last two days
    for (let i = 0; i < 8; i++) await log(big, 420, 60 + i);
    await log(big, 120, 1); await log(big, 120, 0);
  });
  after(() => {
    assert.deepEqual(guard.external, [], 'no server-side request left 127.0.0.1');
    S?.close(); E?.close();
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
    test(`reached milestones with their day, newest first, and what is coming up, on ${name}`, async () => {
      const { h, sec } = await section(S, viewport);
      try {
        const want = await S.ok('/stats/milestones?limit=40');
        assert.deepEqual(want.counts, { hours: 2, game_hours: 3, streak: 1, days: 1 });
        const rows = sec.locator('#ms-reached .item');
        assert.equal(await rows.count(), want.total);
        // (rows off screen are not laid out until scrolled to: read their text, then look at the first and the last)
        assert.deepEqual((await rows.locator('.ttl').allTextContents()).map((x) => x.trim()), want.reached.map((x) => x.text), 'what the API reports, in its order');
        for (const row of [rows.first(), rows.last()]) { await row.scrollIntoViewIfNeeded(); assert.ok(await row.locator('.ttl').isVisible()); }
        assert.match((await rows.first().locator('.sub').textContent()).trim(), /^\w{3} \d{1,2}, \d{4}$/, 'the day, in words');
        // a game's name is a link and stays text
        const link = sec.locator('#ms-reached .item', { hasText: '50 hours in' }).locator('a');
        assert.equal(await link.textContent(), 'Big <One>');
        assert.equal(await link.getAttribute('href'), `/game/${big}`);
        assert.equal((await sec.locator('#ms-reached .card-h .tiny').innerText()).trim(), `${want.total} in all`);
        // coming up: 60 of 100 hours in the game, 60 of 100 in all, ten of fifty days with play
        const coming = (await sec.locator('#ms-coming .mrow').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim());
        assert.ok(coming.some((x) => /^100 hours in Big <One>\s*60h of 100h$/.test(x)), coming.join(' | '));
        assert.ok(coming.some((x) => /^100 hours of play\s*60h of 100h$/.test(x)), coming.join(' | '));
        assert.ok(coming.some((x) => /^50 days with play\s*10 of 50$/.test(x)), coming.join(' | '));
        const o = await overflow(h.page, viewport.width);
        assert.ok(o.doc <= o.client, `no horizontal overflow: ${JSON.stringify(o)}`);
        clean(h);
      } finally { await h.close(); }
    });
  }

  test('a library that has reached nothing yet says so, and shows the first milestones ahead', async () => {
    const { h, sec } = await section(E, PHONE_SMALL);
    try {
      assert.match(await sec.locator('#ms-reached .ins-none').innerText(), /None reached yet\./);
      assert.equal((await sec.locator('#ms-reached .card-h .tiny').innerText()).trim(), '0 in all');
      const coming = (await sec.locator('#ms-coming .mrow').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim());
      assert.ok(coming.some((x) => /^10 hours of play\s*0h of 10h$/.test(x)), coming.join(' | '));
      assert.ok(coming.some((x) => /^10 days with play\s*1 of 10$/.test(x)), coming.join(' | '));
      clean(h);
    } finally { await h.close(); }
  });
});
