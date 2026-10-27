// Vestigo web UI, end to end: "What should I play?" on Home and in its dialog (command palette, P):
// the card renders the API's picks with their reasons, Pick again rerolls without repeating and
// says so in a live region, the time and mood choices change the picks (and are remembered), Not
// now / Never set a game aside (undo from the toast or from "Set aside"), Log session opens the
// Log a session dialog with the game and the time chosen, the card is a Home section that can be
// hidden, and it fits phone screens.
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e-suggest.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chromium, installFetchGuard, startApp, seed, seedAchievements, openPage, waitView, overflow, waitUntil, toast, modalReady, invariantViolations, labelViolations, DESKTOP, PHONE, PHONE_SMALL, skipReason,
} from './helpers/ui-e2e-harness.js';

const UI = { skip: skipReason || false };
const NOW = Date.now();

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
  assert.deepEqual(h.rec.dialogs, [], 'no unexpected browser dialogs');
};

describe('What should I play?', UI, () => {
  let S; let D;
  before(async () => {
    S = await startApp();
    D = await seed(S.ok, NOW);
    D.ach = await seedAchievements(S.ok, S.db, D.ids.zelda); // some unlocked, two locked
  });
  after(() => {
    assert.deepEqual(guard.external, [], 'no server-side request left 127.0.0.1');
    assert.deepEqual(invariantViolations(S.db), [], 'sessions add up to every lifetime total');
    S?.close();
  });

  /** Home, with this device's choices preset (minutes, mode) or none. */
  async function home(opts = {}, choice = null) {
    const h = await openPage(browser, S.origin, opts);
    if (choice) await h.ctx.addInitScript((c) => { try { localStorage.setItem('vg-suggest', JSON.stringify(c)); } catch { /* */ } }, choice);
    await h.page.goto(`${S.origin}/`);
    await waitView(h.page);
    await picked(h.page);
    await h.settle();
    return h;
  }
  const card = (page) => page.locator('#dash-suggest');
  /** Wait for the picks (or the empty state) to be on screen. */
  const picked = (page, root = '#dash-suggest') => page.locator(`${root} .sg-body:not([aria-busy]) :is(.sg-main, .sg-empty)`).first().waitFor();
  const mainTitle = (page, root = '#dash-suggest') => page.locator(`${root} .sg-title`).innerText().then((t) => t.trim());
  const altTitles = (page, root = '#dash-suggest') => page.locator(`${root} .sg-alt .ttl`).allInnerTexts().then((x) => x.map((t) => t.trim()));
  const reasons = (page, root = '#dash-suggest') => page.locator(`${root} .sg-why li`).allInnerTexts().then((x) => x.map((t) => t.trim()));
  const api = (q) => S.ok(`/suggest?${new URLSearchParams(q)}`);

  test('Home card: the API\'s main pick and two alternates with their reasons; labelled controls; links to the game', async () => {
    const h = await home();
    const { page } = h;
    try {
      assert.equal(await card(page).locator('.card-h h2').innerText(), 'What should I play?');
      assert.equal(await card(page).getAttribute('role'), 'region');
      const want = await api({ minutes: '60', mode: 'auto' });
      assert.equal(want.picks.length, 3);
      assert.equal(await mainTitle(page), want.picks[0].title);
      assert.deepEqual(await altTitles(page), want.picks.slice(1).map((p) => p.title));
      assert.deepEqual(await reasons(page), want.picks[0].reasons.map((r) => r.text));
      assert.equal(await card(page).locator('.sg-title a').getAttribute('href'), `/game/${want.picks[0].game_id}`);
      assert.ok(!want.picks.some((p) => p.title === 'Celeste'), 'the game played most in the last 3 days is left for Keep going');
      assert.ok(!want.picks.some((p) => p.title === 'Hades'), 'completed games are never suggested');
      // controls: a radio group of times (1h by default), a labelled mood select, the platforms
      const time = card(page).locator('.seg');
      assert.equal(await time.getAttribute('role'), 'radiogroup');
      assert.equal(await time.getAttribute('aria-label'), 'Time you have');
      assert.equal(await time.locator('[aria-checked=true]').innerText(), '1h');
      assert.equal(await card(page).locator('[data-sg-mode]').getAttribute('aria-label'), 'Mood');
      assert.deepEqual(await card(page).locator('[data-sg-mode] option').allInnerTexts(), ['Best match', 'Quick fix', 'Keep going', 'Finish something', 'Start something new', 'Rediscover', 'Surprise me']);
      assert.match(await card(page).locator('.sg-foot').innerText(), /What is installed is unknown/);
      assert.match(await card(page).locator('[data-sg-count]').innerText(), /^\d+ games considered$/);
      assert.equal(await card(page).locator('[aria-live=polite]').count(), 1, 'a live region for rerolls');
      assert.deepEqual(await labelViolations(page), [], 'every control has a name');
      // the title opens the game
      await card(page).locator('.sg-title a').click();
      await waitUntil(() => new URL(page.url()).pathname === `/game/${want.picks[0].game_id}`, { message: 'game page' });
      clean(h);
    } finally { await h.close(); }
  });

  test('Pick again: three new games each time (announced, focus stays), then starts over; an alternate becomes the main pick', async () => {
    const h = await home();
    const { page } = h;
    try {
      const seen = [await mainTitle(page), ...(await altTitles(page))];
      const again = card(page).locator('[data-sg-act=again]');
      await again.focus();
      await page.keyboard.press('Enter');
      await waitUntil(async () => !seen.includes(await mainTitle(page)), { message: 'a new main pick' });
      const next = [await mainTitle(page), ...(await altTitles(page))];
      assert.ok(next.every((t) => !seen.includes(t)), `no repeats: ${seen} then ${next}`);
      await waitUntil(async () => (await card(page).locator('[aria-live=polite]').textContent()).startsWith(`Suggested: ${next[0]}`), { message: 'the live region names the new pick' });
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.sgAct), 'again', 'focus stays on Pick again');
      // the library has 5 candidates (Celeste was just played, Hades is completed): the third round starts over
      await again.click();
      await toast(page, 'That was every match');
      assert.equal(await mainTitle(page), seen[0], 'back to the best match');
      // an alternate swaps with the main pick
      const alt = (await altTitles(page))[0];
      await card(page).locator('[data-sg-swap="1"]').click();
      assert.equal(await mainTitle(page), alt);
      assert.equal((await altTitles(page))[0], seen[0]);
      await waitUntil(async () => (await card(page).locator('[aria-live=polite]').textContent()) === `Showing ${alt}`);
      clean(h);
    } finally { await h.close(); }
  });

  test('time and mood: the picks follow them, and this device remembers them', async () => {
    const h = await home();
    const { page } = h;
    try {
      await card(page).locator('[data-sg-min="15"]').click();
      const q15 = await api({ minutes: '15', mode: 'auto' });
      await waitUntil(async () => (await mainTitle(page)) === q15.picks[0].title && (await altTitles(page)).join() === q15.picks.slice(1).map((p) => p.title).join(), { message: 'picks for 15 minutes' });
      await card(page).locator('[data-sg-mode]').selectOption('rediscover');
      await waitUntil(async () => (await mainTitle(page)) === 'Stardew Valley', { message: 'Rediscover: 80h, untouched for months' });
      assert.match((await reasons(page))[0], /^80h played, untouched for \d+ (months|years?)$/);
      await card(page).locator('[data-sg-mode]').selectOption('new');
      await waitUntil(async () => (await mainTitle(page)) === 'Ori and the Will of the Wisps', { message: 'Start something new: the backlog game never played' });
      assert.equal((await reasons(page))[0], 'Never played, added to your backlog today');
      assert.equal(await card(page).locator('[data-sg-chase]').isVisible(), false, 'Include beaten is a Finish something option');
      await card(page).locator('[data-sg-mode]').selectOption('finish');
      assert.equal(await card(page).locator('[data-sg-chase]').isVisible(), true);
      await waitUntil(async () => (await mainTitle(page)) === 'Zelda: TotK', { message: 'Finish something: the game with achievements left' });
      const unlocked = D.ach.items.filter((x) => x.unlocked).length;
      assert.equal((await reasons(page))[0], `${Math.floor((unlocked * 1000) / D.ach.items.length) / 10}% of achievements, ${D.ach.items.length - unlocked} left`);
      // remembered on this device
      await page.reload();
      await waitView(page);
      await picked(page);
      assert.equal(await card(page).locator('.seg [aria-checked=true]').innerText(), '15m');
      assert.equal(await card(page).locator('[data-sg-mode]').inputValue(), 'finish');
      // a mode with nothing to offer says so, and still shows the closest
      await S.ok(`/games/${D.ids.ori}`, { method: 'PATCH', body: { status: 'wishlist' } });
      await card(page).locator('[data-sg-mode]').selectOption('new');
      await card(page).locator('.sg-nomatch').waitFor();
      assert.match(await card(page).locator('.sg-nomatch').innerText(), /Nothing in your library fits “Start something new” yet/);
      await S.ok(`/games/${D.ids.ori}`, { method: 'PATCH', body: { status: 'backlog' } });
      clean(h);
    } finally {
      await h.close();
    }
  });

  test('Not now and Never: set aside with an Undo, listed under "Set aside" with Allow again', async () => {
    const h = await home({}, { minutes: 60, mode: 'new' });
    const { page } = h;
    try {
      assert.equal(await mainTitle(page), 'Ori and the Will of the Wisps');
      await card(page).locator('[data-sg-act=snooze]').click();
      assert.match(await toast(page, 'Not now'), /Ori and the Will of the Wisps is left out for 7 days/);
      await waitUntil(async () => (await mainTitle(page)) !== 'Ori and the Will of the Wisps', { message: 'the next pick moves up' });
      const fb = await S.ok('/suggest/feedback');
      assert.deepEqual(fb.items.map((x) => [x.game_id, x.action]), [[D.ids.ori, 'snooze']]);
      assert.ok(Math.abs(fb.items[0].until - (Date.now() + 7 * 86_400_000)) < 120_000, 'for a week');
      assert.equal(await card(page).locator('[data-sg-act=manage]').innerText(), '1 game set aside');
      // undo from the toast
      await page.locator('#toasts .toast-act', { hasText: 'Undo' }).click();
      await waitUntil(async () => (await mainTitle(page)) === 'Ori and the Will of the Wisps', { message: 'back after Undo' });
      assert.deepEqual((await S.ok('/suggest/feedback')).items, []);
      // never: until allowed again from the list
      await card(page).locator('[data-sg-act=never]').click();
      await toast(page, 'will not be suggested again');
      await waitUntil(async () => (await mainTitle(page)) !== 'Ori and the Will of the Wisps');
      await card(page).locator('[data-sg-act=manage]').click();
      const dlg = page.locator('.modal', { hasText: 'Set aside' });
      await dlg.waitFor();
      assert.match(await dlg.locator('.item').textContent(), /Ori and the Will of the Wisps\s*Never suggested/);
      await dlg.locator('[data-fb-reset]').click();
      await toast(page, 'can be suggested again');
      assert.match(await dlg.innerText(), /Nothing is set aside/);
      await page.keyboard.press('Escape');
      await waitUntil(async () => (await mainTitle(page)) === 'Ori and the Will of the Wisps', { message: 'suggested again' });
      clean(h);
    } finally { await h.close(); }
  });

  test('palette action and P: the picker in a dialog; P is listed with the shortcuts', async () => {
    const h = await home();
    const { page } = h;
    try {
      await page.keyboard.press('Control+k');
      await page.keyboard.type('what should');
      await page.locator('#pal-list [role=option]', { hasText: 'What should I play?' }).waitFor();
      await page.keyboard.press('Enter');
      const dlg = page.locator('.modal.sg-dialog');
      await dlg.waitFor();
      await picked(page, '.modal.sg-dialog');
      assert.equal(await dlg.locator('.mh h2').innerText(), 'What should I play?');
      assert.equal(await mainTitle(page, '.modal.sg-dialog'), await mainTitle(page), 'the same pick as the card');
      await page.keyboard.press('Escape');
      await dlg.waitFor({ state: 'detached' });
      // P opens it too (not while typing)
      await page.locator('#view h1').click();
      await page.keyboard.press('p');
      await dlg.waitFor();
      await picked(page, '.modal.sg-dialog');
      // a game link in the dialog closes it and opens the game
      const href = await dlg.locator('.sg-title a').getAttribute('href');
      await dlg.locator('.sg-title a').click();
      await dlg.waitFor({ state: 'detached' });
      await waitUntil(() => new URL(page.url()).pathname === href);
      await waitView(page);
      await page.keyboard.press('?');
      assert.match(await page.locator('.modal', { hasText: 'Keyboard shortcuts' }).innerText(), /P\s+What should I play\?/);
      clean(h);
    } finally { await h.close(); }
  });

  test('a Home section: hidden and shown again from Customize home', async () => {
    const h = await home();
    const { page } = h;
    try {
      await page.locator('#dash-custom').click();
      const row = page.locator('.modal .layout-row', { hasText: 'What should I play?' });
      await row.locator('label.switch span').click();
      await page.locator('#lay-save').click();
      await page.locator('.modal').waitFor({ state: 'detached' });
      await waitUntil(async () => !(await card(page).count()), { message: 'the card is gone' });
      assert.match((await S.ok('/settings')).dashboard_layout, /(^|,)-suggest(,|$)/);
      await page.keyboard.press('p'); // still a key away
      await page.locator('.modal.sg-dialog .sg-title').waitFor();
      await page.keyboard.press('Escape');
    } finally {
      await S.ok('/settings', { method: 'PUT', body: { dashboard_layout: 'kpis,live,jump,suggest,chart,top,recent,accounts,-heatmap,-backlog' } });
      await h.close();
    }
  });

  for (const vp of [PHONE, PHONE_SMALL]) {
    test(`fits a ${vp.width}px phone: no sideways scrolling, every control on screen and tappable`, async () => {
      const h = await home({ viewport: vp });
      const { page } = h;
      try {
        await card(page).scrollIntoViewIfNeeded();
        const o = await overflow(page, vp.width);
        assert.ok(o.doc <= vp.width + 1 && o.doc <= o.client, `document is ${o.doc}px wide; widest: ${JSON.stringify(o.culprit)}`);
        const box = await card(page).boundingBox();
        for (const sel of ['.seg button', '[data-sg-mode]', '.sg-act .btn', '.sg-alt']) {
          for (const b of await card(page).locator(sel).all()) {
            const r = await b.boundingBox();
            assert.ok(r.x >= box.x - 1 && r.x + r.width <= box.x + box.width + 1, `${sel} inside the card (${JSON.stringify(r)})`);
            assert.ok(r.height >= 31, `${sel} is ${r.height}px tall`);
          }
        }
        const first = await mainTitle(page);
        await card(page).locator('[data-sg-act=again]').tap();
        await waitUntil(async () => (await mainTitle(page)) !== first, { message: 'rerolled by tap' });
        clean(h);
      } finally { await h.close(); }
    });
  }

  // last: it adds a session
  test('Log session: the Log a session dialog with the game and the time chosen; saving logs it', async () => {
    const h = await home({}, { minutes: 30, mode: 'new' });
    const { page } = h;
    try {
      assert.equal(await mainTitle(page), 'Ori and the Will of the Wisps');
      await card(page).locator('[data-sg-act=log]').click();
      const dlg = page.locator('.modal').filter({ has: page.locator('.mh h2', { hasText: /^Log a session$/ }) });
      await dlg.waitFor();
      await modalReady(page);
      assert.match(await dlg.locator('.field').first().innerText(), /Ori and the Will of the Wisps/, 'preselected');
      assert.equal(await dlg.locator('#gp').count(), 0, 'no game search');
      assert.deepEqual([await dlg.locator('[name=h]').inputValue(), await dlg.locator('[name=m]').inputValue()], ['0', '30']);
      await dlg.locator('#log-save').click();
      await toast(page, 'Logged 30m of Ori and the Will of the Wisps');
      const g = await S.ok(`/games/${D.ids.ori}`);
      assert.equal(g.minutes, 30);
      assert.equal(g.sessions.length, 1);
      clean(h);
    } finally { await h.close(); }
  });
});
