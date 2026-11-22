// Vestigo web UI, end to end: what Insights says on a tiny library (one game played, one game
// waiting): the sentences stay true when the range cuts into older play, a year is over, a week
// holds one game or the backlog is days old.
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e-insights-wording.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, installFetchGuard, startApp, openPage, waitView, overflow, DESKTOP, PHONE_SMALL, HOUR, DAY, skipReason } from './helpers/ui-e2e-harness.js';

const UI = { skip: skipReason || false };
const NOW = Date.now();
const YEAR = new Date(NOW).getFullYear();
// local noon, so the day is the same in any timezone
const noon = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

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

describe('Vestigo web UI: Insights wording on a tiny library', UI, () => {
  let S;
  before(async () => {
    S = await startApp();
    const solo = await S.ok('/games', { method: 'POST', body: { title: 'Solo', status: 'playing' } });
    const log = (minutes, ended_at) => S.ok('/sessions', { method: 'POST', body: { game_id: solo.id, minutes, ended_at } });
    // two years ago: 100 minutes in January, 100 on the last day; last year: 300 in January
    await log(100, noon(YEAR - 2, 1, 15));
    await log(100, noon(YEAR - 2, 12, 31));
    await log(300, noon(YEAR - 1, 1, 15));
    // and one game a week for the last three weeks
    for (const d of [3, 10, 17]) await log(60, NOW - d * DAY);
    const waiting = await S.ok('/games', { method: 'POST', body: { title: 'Waiting', status: 'backlog' } });
    S.db.prepare('UPDATE games SET created_at = ? WHERE id = ?').run(NOW - 10 * DAY - HOUR, waiting.id);
  });
  after(() => {
    assert.deepEqual(guard.external, [], 'no server-side request left 127.0.0.1');
    S?.close();
  });

  /** Open Insights and load one section through its chip. */
  async function section(path, id, viewport = DESKTOP) {
    const h = await openPage(browser, S.origin, { viewport });
    await h.page.goto(`${S.origin}${path}`);
    await waitView(h.page);
    await h.page.locator(`[data-jump=${id}]`).click();
    const sec = h.page.locator(`#ins-${id}`);
    await sec.locator('.ins-body:not([aria-busy]) :is(.card, .rec, .ins-none)').first().waitFor();
    await h.settle();
    return { h, sec };
  }

  test('Records: the first session of a range is not called the start of the trail when older sessions exist', async () => {
    // the default range is the last 12 months; the sessions of two years ago came before it
    const { h, sec } = await section('/insights', 'records', PHONE_SMALL);
    try {
      const lines = (await sec.locator('.hl li').allInnerTexts()).join('\n');
      assert.match(lines, /Your first session in this range was on .*: Solo, /);
      assert.doesNotMatch(lines, /Your trail starts/);
      const labels = (await sec.locator('.rec .eyebrow').allInnerTexts()).map((x) => x.trim().toLowerCase());
      assert.ok(labels.includes('first session in range'), labels.join(', '));
      assert.ok(!labels.includes('first tracked session'), labels.join(', '));
      const o = await overflow(h.page, PHONE_SMALL.width);
      assert.ok(o.doc <= o.client, `fits a 360px phone: ${JSON.stringify(o)}`);
      clean(h);
    } finally { await h.close(); }
  });

  test('Records: over all time the first session is where the trail starts', async () => {
    const { h, sec } = await section('/insights?range=all', 'records');
    try {
      const lines = (await sec.locator('.hl li').allInnerTexts()).join('\n');
      assert.match(lines, new RegExp(`Your trail starts on .*${YEAR - 2}: Solo, 1h 40m`));
      const labels = (await sec.locator('.rec .eyebrow').allInnerTexts()).map((x) => x.trim().toLowerCase());
      assert.ok(labels.includes('first tracked session'), labels.join(', '));
      clean(h);
    } finally { await h.close(); }
  });

  test('Year over year: two finished years are compared whole, not "so far" to today\'s date', async () => {
    const { h, sec } = await section(`/insights?years=${YEAR - 2},${YEAR - 1}`, 'yoy');
    try {
      const y = await S.ok(`/stats/year-over-year?years=${YEAR - 2},${YEAR - 1}`);
      const [a, b] = [y.years[1].total_minutes, y.years[0].total_minutes];
      assert.ok(b >= 200 && a > b, `the fixture: ${a} against ${b}`);
      const lead = await sec.locator('.ins-lead').innerText();
      assert.doesNotMatch(lead, /so far/, lead);
      assert.match(lead, new RegExp(`^${Math.floor(a / 60)}h.* in ${YEAR - 1} — ${Math.round(((a - b) / b) * 100)}% more than ${YEAR - 2} \\(${Math.floor(b / 60)}h`), lead);
      // the column of every year's total to today's date names the day, not one year's
      assert.match(await sec.locator('th', { hasText: 'So far' }).innerText(), /^so far \(to [^\d]*\d{1,2}[^\d]*\)$/i);
      clean(h);
    } finally { await h.close(); }
  });

  test('Year over year: the year under way is still compared so far, to the same date', async () => {
    const { h, sec } = await section(`/insights?years=${YEAR - 1},${YEAR}`, 'yoy');
    try {
      assert.match(await sec.locator('.ins-lead').innerText(), new RegExp(`in ${YEAR} so far — .*${YEAR - 1}`));
      clean(h);
    } finally { await h.close(); }
  });
});
