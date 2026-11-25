// Vestigo web UI, end to end: the patterns of a game on its own page ("How you play it"), a split
// that fails, and counts of one ("1 launch", "1 game gets").
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e-followups.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chromium, installFetchGuard, startApp, seed, openPage, waitView, toast, modalReady, overflow, PHONE_SMALL, DESKTOP, skipReason,
} from './helpers/ui-e2e-harness.js';

const UI = { skip: skipReason || false };
const NOW = Date.now();
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

const clean = (h, allow = []) => {
  assert.deepEqual(h.rec.pageErrors, [], 'no uncaught page errors');
  assert.deepEqual(h.unexpectedConsole(allow), [], 'no unexpected console errors');
};
async function visit(S, path, viewport = DESKTOP) {
  const h = await openPage(browser, S.origin, { viewport });
  await h.page.goto(`${S.origin}${path}`);
  await waitView(h.page);
  await h.settle();
  return h;
}

describe('Vestigo web UI: a game\'s patterns on its page', UI, () => {
  let S; let steady; let once;
  before(async () => {
    S = await startApp();
    const add = async (title) => (await S.ok('/games', { method: 'POST', body: { title, status: 'playing' } })).id;
    steady = await add('Steady');
    once = await add('Once');
    // an hour on six days over three weeks, nothing from 19 to 14 days ago
    for (const n of [20, 13, 12, 6, 5, 2]) await S.ok('/sessions', { method: 'POST', body: { game_id: steady, minutes: 60, ended_at: ago(n) } });
    await S.ok('/sessions', { method: 'POST', body: { game_id: once, minutes: 30, ended_at: ago(1) } });
  });
  after(() => {
    assert.deepEqual(guard.external, [], 'no server-side request left 127.0.0.1');
    S?.close();
  });

  for (const [name, viewport] of [['a 360px phone', PHONE_SMALL], ['a desktop', DESKTOP]]) {
    test(`a game with enough tracked days shows "How you play it" below Notes, on ${name}`, async () => {
      const h = await visit(S, `/game/${steady}`, viewport);
      const { page } = h;
      try {
        const card = page.locator('#g-patterns');
        await card.waitFor();
        assert.equal((await card.locator('h2').innerText()).trim(), 'How you play it');
        const want = (await S.ok(`/stats/records?range=all&game_id=${steady}`)).patterns.map((x) => x.id);
        assert.deepEqual(want, ['days_played', 'typical_day', 'weekend', 'longest_break'], 'what the API reports for the game');
        const lines = await card.locator('.hl li').allInnerTexts();
        assert.equal(lines.length, 3, lines.join('\n'));
        assert.match(lines[0], /^1h on a typical day with play\.$/);
        assert.match(lines[1], /weekend|weekday/i);
        assert.match(lines[2], /^6 days without play, your longest break \(.+ – .+\)\.$/);
        assert.ok(!lines.some((l) => /had play/.test(l)), 'days with play out of every day since is left out');
        // below Notes: nothing above it moved when it arrived
        assert.equal(await page.evaluate(() => document.querySelector('#g-notes').closest('.card').nextElementSibling?.id), 'g-patterns');
        assert.equal(await page.locator('#g-patterns').count(), 1, 'one card');
        const o = await overflow(page, viewport.width);
        assert.ok(o.doc <= o.client, `no horizontal overflow: ${JSON.stringify(o)}`);
        clean(h);
      } finally { await h.close(); }
    });
  }

  test('a game played on one day has no such card', async () => {
    const h = await visit(S, `/game/${once}`);
    try {
      assert.deepEqual((await S.ok(`/stats/records?range=all&game_id=${once}`)).patterns, []);
      await h.settle();
      assert.equal(await h.page.locator('#g-patterns').count(), 0);
      clean(h);
    } finally { await h.close(); }
  });
});

describe('Vestigo web UI: a failed split and counts of one', UI, () => {
  let S; let multi;
  before(async () => {
    S = await startApp();
    await seed(S.ok, NOW);
    // one game with two entries: a manual one (a logged session) and an imported one of its title
    const a = await S.ok('/games', { method: 'POST', body: { title: 'Twin', merge: false } });
    await S.ok('/sessions', { method: 'POST', body: { game_id: a.id, minutes: 40, ended_at: NOW - 3600_000 } });
    await S.ok('/import', { method: 'POST', body: { games: [{ title: 'Twin', platform: 'pc', playtime_minutes: 100 }] } });
    multi = S.db.prepare('SELECT game_id id, MIN(id) entry FROM entries WHERE game_id = ? GROUP BY game_id HAVING COUNT(*) > 1').get(a.id);
  });
  after(() => { S?.close(); });

  test('Split into its own game: a failure says why, the dialog stays and the game keeps its entries', async () => {
    assert.ok(multi, 'a game with two entries');
    const h = await visit(S, `/game/${multi.id}`);
    const { page } = h;
    try {
      const entries = () => S.db.prepare('SELECT COUNT(*) n FROM entries WHERE game_id = ?').get(multi.id).n;
      const n = entries();
      await page.locator(`[data-entry-menu="${multi.entry}"]`).click();
      await modalReady(page);
      let failed = false;
      await page.route('**/api/v1/entries/*/split', (route) => {
        if (failed) return route.fallback();
        failed = true;
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The database is busy' }) });
      });
      await page.locator('#en-split').click();
      await toast(page, 'The database is busy');
      assert.equal(await page.locator('.modal').count(), 1, 'the dialog is still open');
      assert.equal(entries(), n, 'nothing was split');
      assert.ok(page.url().endsWith(`/game/${multi.id}`), 'still on the game');
      clean(h, [500]);
    } finally { await h.close(); }
  });

  test('an entry launched once reads "1 launch"', async () => {
    S.db.prepare('UPDATE entries SET play_count = 1 WHERE id = ?').run(multi.entry);
    const h = await visit(S, `/game/${multi.id}`);
    try {
      const text = await h.page.locator('#view').innerText();
      assert.match(text, /· 1 launch\b(?!es)/);
      assert.doesNotMatch(text, /1 launches/);
      clean(h);
    } finally { await h.close(); }
  });

  test('import preview: one game that gets details reads "1 game gets … it did not have"', async () => {
    const h = await visit(S, '/settings#import');
    const { page } = h;
    try {
      const out = page.locator('#imp-r');
      if (!(await page.locator('#imp-text').isVisible())) await page.locator('#import details summary').click();
      await page.locator('#imp-text').fill(['title,platform,playtime_hours,last_played,status,rating', 'Brand New Game,import,20,2026-02-10,completed,10'].join('\n'));
      await page.locator('#imp-go').click();
      await out.locator('b', { hasText: 'Preview: pasted data' }).waitFor();
      const preview = await out.innerText();
      assert.match(preview, /1 game gets a status, rating or notes it did not have/);
      assert.doesNotMatch(preview, /1 games get/);
      clean(h);
    } finally { await h.close(); }
  });
});
