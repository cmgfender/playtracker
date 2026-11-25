// Vestigo web UI, end to end: the Patterns under Records & highlights on Insights: the change from
// the period before, days with play, a typical day, the weekend and the longest break, on a phone
// and on a desktop; nothing where there is too little play to see a pattern in.
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e-insights-patterns.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, installFetchGuard, startApp, openPage, waitView, overflow, DESKTOP, PHONE_SMALL, skipReason } from './helpers/ui-e2e-harness.js';

const UI = { skip: skipReason || false };
// local noon `n` days ago, so the day is the same in any timezone (and across a clock change)
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

describe('Vestigo web UI: Insights patterns', UI, () => {
  let S; let T;
  before(async () => {
    S = await startApp();
    const steady = (await S.ok('/games', { method: 'POST', body: { title: 'Steady', status: 'playing' } })).id;
    const log = (game_id, minutes, n, app = S) => app.ok('/sessions', { method: 'POST', body: { game_id, minutes, ended_at: ago(n) } });
    // tracked for 70 days; 200 minutes in the 30 days before the last 30
    await log(steady, 60, 70); await log(steady, 100, 45); await log(steady, 100, 40);
    // the last 30: an hour on six days (360 minutes), nothing between 20 and 6 days ago
    for (const n of [20, 6, 5, 4, 3, 2]) await log(steady, 60, n);
    // a second library with one session: too little to see a pattern in
    T = await startApp();
    const rare = (await T.ok('/games', { method: 'POST', body: { title: 'Rare', status: 'playing' } })).id;
    await log(rare, 30, 1, T);
  });
  after(() => {
    assert.deepEqual(guard.external, [], 'no server-side request left 127.0.0.1');
    S?.close();
    T?.close();
  });

  async function records(app, path, viewport) {
    const h = await openPage(browser, app.origin, { viewport });
    await h.page.goto(`${app.origin}${path}`);
    await waitView(h.page);
    await h.page.locator('[data-jump=records]').click();
    const sec = h.page.locator('#ins-records');
    await sec.locator('.ins-body:not([aria-busy]) :is(.card, .rec, .ins-none)').first().waitFor();
    await h.settle();
    return { h, sec };
  }
  const clean = (h) => {
    assert.deepEqual(h.rec.pageErrors, [], 'no uncaught page errors');
    assert.deepEqual(h.unexpectedConsole([]), [], 'no unexpected console errors');
  };

  for (const [name, viewport] of [['a 360px phone', PHONE_SMALL], ['a desktop', DESKTOP]]) {
    test(`Records: the patterns of the last 30 days, numbers first, on ${name}`, async () => {
      const { h, sec } = await records(S, '/insights?range=30d', viewport);
      try {
        const want = await S.ok('/stats/records?range=30d');
        assert.deepEqual(want.patterns.map((x) => x.id), ['trend', 'days_played', 'typical_day', 'weekend', 'longest_break'], 'what the API reports');
        assert.match((await sec.locator('.eyebrow', { hasText: /^patterns$/i }).innerText()).trim(), /^patterns$/i);
        const lines = await sec.locator('[data-patterns] li').allInnerTexts();
        assert.equal(lines.length, 5, lines.join('\n'));
        assert.match(lines[0], /^80% more play than the 30 days before: 6h against 3h 20m\.$/);
        assert.match(lines[1], /^6 of 30 days had play \(20%\)\.$/);
        assert.match(lines[2], /^1h on a typical day with play\.$/);
        assert.match(lines[3], /weekend|weekday/i);
        assert.match(lines[4], /^13 days without play, your longest break \(.+ – .+\)\.$/);
        // the number of each line is what stands out
        assert.deepEqual(await sec.locator('[data-patterns] li:nth-child(-n+3) b').allInnerTexts(), ['80% more', '6 of 30 days', '1h']);
        // the highlights above them are still there, in a list of their own
        assert.ok((await sec.locator('.hl:not([data-patterns]) li').count()) >= 5);
        const o = await overflow(h.page, viewport.width);
        assert.ok(o.doc <= o.client, `no horizontal overflow: ${JSON.stringify(o)}`);
        clean(h);
      } finally { await h.close(); }
    });
  }

  test('Records: a library played on one day shows its highlights and no Patterns heading', async () => {
    const { h, sec } = await records(T, '/insights?range=30d', PHONE_SMALL);
    try {
      assert.ok((await sec.locator('.hl li').count()) >= 1, 'highlights are shown');
      assert.equal(await sec.locator('[data-patterns]').count(), 0);
      assert.equal(await sec.locator('.eyebrow', { hasText: /^patterns$/i }).count(), 0);
      clean(h);
    } finally { await h.close(); }
  });
});
