// Vestigo web UI, end to end: "Did you know" on Home (facts for today, an anniversary first), the
// finish forecast on a game's page, and how long the backlog would take on Insights.
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e-facts.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, installFetchGuard, startApp, openPage, waitView, modalReady, overflow, PHONE_SMALL, DESKTOP, skipReason } from './helpers/ui-e2e-harness.js';

const UI = { skip: skipReason || false };
// local noon `n` days ago, so the day is the same in any timezone
const ago = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d.getTime(); };
// this date in an earlier year (four years back on Feb 29, which only leap years have)
const TODAY = new Date();
const YEARS = TODAY.getMonth() === 1 && TODAY.getDate() === 29 ? 4 : 2;
const yearsAgoToday = new Date(TODAY.getFullYear() - YEARS, TODAY.getMonth(), TODAY.getDate(), 12).getTime();

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

const clean = (h) => {
  assert.deepEqual(h.rec.pageErrors, [], 'no uncaught page errors');
  assert.deepEqual(h.unexpectedConsole([]), [], 'no unexpected console errors');
};

describe('Vestigo web UI: facts, forecast and backlog', UI, () => {
  let S; let anniversary; let rpg;
  before(async () => {
    S = await startApp();
    const add = async (title, status = 'playing') => (await S.ok('/games', { method: 'POST', body: { title, status } })).id;
    const meta = (id, main) => S.db.prepare("INSERT INTO game_meta(game_id, matched_by, ttb_main, fetched_at) VALUES (?, 'title', ?, ?)").run(id, main, Date.now());
    const log = (game_id, minutes, ended_at) => S.ok('/sessions', { method: 'POST', body: { game_id, minutes, ended_at } });
    anniversary = await add('Anniversary <Edition>');
    rpg = await add('Long RPG'); meta(rpg, 1800);
    for (const [title, main] of [['Waiting A', 600], ['Waiting B', 1200], ['Waiting C', 1800]]) meta(await add(title, 'backlog'), main);
    // started on this date, played again nine days later, not since
    await log(anniversary, 90, yearsAgoToday);
    await log(anniversary, 120, yearsAgoToday + 9 * 86_400_000);
    // two hours a week for four weeks: 8 of a typical 30 hours
    for (const n of [1, 8, 15, 22]) await log(rpg, 120, ago(n));
  });
  after(() => {
    assert.deepEqual(guard.external, [], 'no server-side request left 127.0.0.1');
    S?.close();
  });

  async function visit(path, viewport = DESKTOP) {
    const h = await openPage(browser, S.origin, { viewport });
    await h.page.goto(`${S.origin}${path}`);
    await waitView(h.page);
    await h.settle();
    return h;
  }

  for (const [name, viewport] of [['a 360px phone', PHONE_SMALL], ['a desktop', DESKTOP]]) {
    test(`Home: "Did you know" opens with what happened on this day, the game a link, on ${name}`, async () => {
      const h = await visit('/', viewport);
      const { page } = h;
      try {
        const want = await S.ok('/stats/facts?limit=4');
        assert.equal(want.facts[0].kind, 'on_this_day');
        const card = page.locator('#dash-facts');
        assert.equal((await card.locator('h2').innerText()).trim(), 'Did you know');
        const lines = await card.locator('.hl li').allInnerTexts();
        assert.deepEqual(lines.map((x) => x.trim()), want.facts.map((f) => f.text), 'the facts the API reports, in its order');
        assert.match(lines[0].trim(), new RegExp(`^${YEARS} years ago today you started Anniversary <Edition>: you played it for \\d+ (days?|weeks?), 3h 30m in all\\.$`));
        assert.equal(await card.locator('.hl li').first().locator('b').innerText(), `${YEARS} years ago today`);
        const link = card.locator('.hl li').first().locator('a');
        assert.equal(await link.innerText(), 'Anniversary <Edition>', 'the title is text, not markup');
        assert.equal(await link.getAttribute('href'), `/game/${anniversary}`);
        const o = await overflow(page, viewport.width);
        assert.ok(o.doc <= o.client, `no horizontal overflow: ${JSON.stringify(o)}`);
        clean(h);
      } finally { await h.close(); }
    });
  }

  test('Home: the section can be turned off in Customize, and comes back', async () => {
    const h = await visit('/');
    const { page } = h;
    try {
      const saved = (await S.ok('/settings')).dashboard_layout;
      assert.match(saved, /(^|,)facts(,|$)/, 'on by default');
      const toggle = async () => {
        await page.locator('#dash-custom').click();
        await modalReady(page);
        await page.locator('.modal .layout-row', { hasText: 'Did you know' }).locator('label.switch span').click();
        await page.locator('#lay-save').click();
        await page.locator('.modal').waitFor({ state: 'detached' });
      };
      await toggle();
      await page.locator('#dash-facts').waitFor({ state: 'detached' });
      assert.match((await S.ok('/settings')).dashboard_layout, /(^|,)-facts(,|$)/);
      await toggle();
      await page.locator('#dash-facts').waitFor();
      clean(h);
    } finally { await S.ok('/settings', { method: 'PUT', body: { dashboard_layout: (await S.ok('/settings')).dashboard_layout.replace('-facts', 'facts') } }); await h.close(); }
  });

  for (const [name, viewport] of [['a 360px phone', PHONE_SMALL], ['a desktop', DESKTOP]]) {
    test(`Game: the finish forecast says how long at this pace and what it rests on, on ${name}`, async () => {
      const h = await visit(`/game/${rpg}`, viewport);
      const { page } = h;
      try {
        const card = page.locator('#g-forecast');
        await card.waitFor();
        const want = await S.ok(`/games/${rpg}/forecast`);
        assert.deepEqual([want.state, want.remaining_minutes, want.weekly_minutes, want.weeks, want.percent], ['playing', 1320, 120, 11, 27]);
        assert.equal((await card.locator('h2').innerText()).trim(), 'Finish forecast');
        assert.match((await card.locator('.ins-lead').innerText()).trim(), /^About 3 months to finish at this pace, around \S.*\.$/);
        assert.equal(await card.locator('.ins-lead b').innerText(), 'About 3 months');
        assert.match(await card.innerText(), /8h of the typical 30h · 2h a week lately/);
        assert.equal(await card.locator('.split-bar').getAttribute('aria-label'), '27% of the expected length played');
        // below Notes, above the patterns
        assert.equal(await page.evaluate(() => document.querySelector('#g-notes').closest('.card').nextElementSibling?.id), 'g-forecast');
        const o = await overflow(page, viewport.width);
        assert.ok(o.doc <= o.client, `no horizontal overflow: ${JSON.stringify(o)}`);
        clean(h);
      } finally { await h.close(); }
    });
  }

  test('Game: without a typical time there is no forecast card', async () => {
    const h = await visit(`/game/${anniversary}`);
    try {
      assert.deepEqual(await S.ok(`/games/${anniversary}/forecast`), { available: false, reason: 'no_typical_time', game_id: anniversary });
      await h.settle();
      assert.equal(await h.page.locator('#g-forecast').count(), 0);
      clean(h);
    } finally { await h.close(); }
  });

  test('Insights: the backlog says how long it would take at your hours a week', async () => {
    const h = await visit('/insights', PHONE_SMALL);
    const { page } = h;
    try {
      await page.locator('[data-jump=library]').click();
      const line = page.locator('#lib-reality');
      await line.waitFor();
      const want = await S.ok('/stats/backlog');
      assert.deepEqual([want.games, want.with_typical_time, want.remaining_minutes, want.weekly_minutes], [3, 3, 3600, 40]); // 8 hours in the last twelve weeks
      assert.equal((await line.innerText()).trim(), 'About 60h of play: about 1.7 years if all your play went to it (40m a week).');
      const o = await overflow(page, PHONE_SMALL.width);
      assert.ok(o.doc <= o.client, `fits a 360px phone: ${JSON.stringify(o)}`);
      clean(h);
    } finally { await h.close(); }
  });
});
