// Vestigo web UI, end to end, at the edges of the newest pages: a fact about a game whose title is
// a word of the sentence around it ("You came back to You"), and the patterns of a game put down
// long ago on its page.
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e-edge.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, installFetchGuard, startApp, openPage, waitView, DESKTOP, skipReason } from './helpers/ui-e2e-harness.js';

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

describe('Vestigo web UI: facts and patterns at their edges', UI, () => {
  let S; let you; let shelved;
  before(async () => {
    S = await startApp();
    const add = async (title) => (await S.ok('/games', { method: 'POST', body: { title, status: 'playing' } })).id;
    const log = (game_id, minutes, ended_at) => S.ok('/sessions', { method: 'POST', body: { game_id, minutes, ended_at } });
    // a game called "You", come back to yesterday after 200 days
    you = await add('You');
    await log(you, 60, ago(201));
    await log(you, 60, ago(1));
    // two years ago: Monday to Wednesday 80 minutes each, then a weekend of 90 a day
    shelved = await add('Shelved');
    const monday = 728 + ((new Date().getDay() + 6) % 7); // days back to the Monday of the week 104 weeks ago
    for (const n of [monday, monday - 1, monday - 2]) await log(shelved, 80, ago(n));
    for (const n of [monday - 5, monday - 6]) await log(shelved, 90, ago(n));
  });
  after(() => {
    assert.deepEqual(guard.external, [], 'no server-side request left 127.0.0.1');
    S?.close();
  });

  async function visit(path) {
    const h = await openPage(browser, S.origin, { viewport: DESKTOP });
    await h.page.goto(`${S.origin}${path}`);
    await waitView(h.page);
    await h.settle();
    return h;
  }

  test('Home: a fact links the game\'s title where the title is, not the same word earlier in the sentence', async () => {
    const h = await visit('/');
    try {
      const fact = (await S.ok('/stats/facts?limit=4')).facts.find((f) => f.kind === 'comeback');
      assert.equal(fact.text, 'You came back to You after 7 months away.');
      const li = h.page.locator('#dash-facts .hl li', { hasText: 'came back' });
      assert.equal((await li.innerText()).trim(), fact.text);
      assert.equal(await li.locator('a').count(), 1);
      assert.equal(await li.locator('a').getAttribute('href'), `/game/${you}`);
      assert.match(await li.innerHTML(), /^You came back to <a [^>]*>You<\/a> after <b>7 months away<\/b>\.$/);
      assert.deepEqual(h.rec.pageErrors, [], 'no uncaught page errors');
    } finally { await h.close(); }
  });

  test('a game put down two years ago, played on both kinds of day: a ratio without averages of "0m", never "all on weekends"', async () => {
    const h = await visit(`/game/${shelved}`);
    try {
      const card = h.page.locator('#g-patterns');
      await card.waitFor();
      const lines = (await card.locator('.hl li').allInnerTexts()).map((x) => x.trim());
      const line = lines.find((l) => /weekend|weekday/.test(l));
      assert.match(line, /^[\d.]+× the play on a weekend day as on a weekday\.$/, lines.join('\n'));
      assert.deepEqual(h.rec.pageErrors, [], 'no uncaught page errors');
    } finally { await h.close(); }
  });
});
