// Vestigo web UI, end to end: polish. The Home sections editor keeps keyboard focus, Log session
// saves once however often Save is pressed, Edit game keeps what was typed when a save fails, and
// every Sessions filter is kept in the URL. On a one-game library: Notes says when a save failed,
// Add a game adds one game, Done gives focus back to Select, and one day is "1 day".
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e-polish.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chromium, installFetchGuard, startApp, seed, openPage, waitView, waitUntil, toast, modalReady, invariantViolations, skipReason,
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
async function visit(S, path, opts = {}) {
  const h = await openPage(browser, S.origin, opts);
  await h.page.goto(`${S.origin}${path}`);
  await waitView(h.page);
  await h.settle();
  return h;
}
/** The focused control of a Home sections editor: [its section, what it is], or null when focus left the editor. */
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  const row = a?.closest('.layout-row');
  if (!row) return null;
  return [row.querySelector('.grow').firstChild.textContent.trim(), a.matches('[data-up]') ? 'up' : a.matches('[data-down]') ? 'down' : a.matches('[data-on]') ? 'switch' : a.tagName];
});
const order = (page, root) => page.locator(`${root} .layout-row .grow`).evaluateAll((els) => els.map((e) => e.firstChild.textContent.trim()));
/** Answer the next `method` request to an API path with a 500, once. */
async function failOnce(page, path, method) {
  let done = false;
  await page.route(`**/api/v1${path}`, (route) => {
    if (done || route.request().method() !== method) return route.fallback();
    done = true;
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The database is busy' }) });
  });
}

describe('Vestigo web UI, polish', UI, () => {
  let S; let D;
  before(async () => {
    S = await startApp();
    D = await seed(S.ok, NOW);
  });
  after(() => {
    assert.deepEqual(guard.external, [], 'no server-side request left 127.0.0.1');
    assert.deepEqual(invariantViolations(S.db), [], 'sessions add up to every lifetime total');
    S?.close();
  });

  test('Home sections in Settings: Move down, Move up and the switch keep keyboard focus on the section they changed', async () => {
    const h = await visit(S, '/settings');
    const { page } = h;
    try {
      const saved = (await S.ok('/settings')).dashboard_layout;
      const name = (await order(page, '#set-layout'))[1];
      await page.locator('#set-layout .layout-row').nth(1).locator('[data-down]').focus();
      await page.keyboard.press('Enter');
      assert.deepEqual(await focused(page), [name, 'down'], 'focus moved along with the section');
      assert.equal((await order(page, '#set-layout')).indexOf(name), 2);
      await page.keyboard.press('Enter'); // the same key moves it on, without tabbing back
      assert.equal((await order(page, '#set-layout')).indexOf(name), 3);
      assert.deepEqual(await focused(page), [name, 'down']);
      await page.keyboard.press('Shift+Tab');
      assert.deepEqual(await focused(page), [name, 'up']);
      for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
      // at the top Move up is disabled: focus goes to the row's other arrow
      assert.equal((await order(page, '#set-layout')).indexOf(name), 0);
      assert.deepEqual(await focused(page), [name, 'down'], 'the first row cannot move up: its Move down has focus');
      // the switch
      const sw = page.locator('#set-layout .layout-row').nth(2).locator('[data-on]');
      const was = await sw.isChecked();
      const third = (await order(page, '#set-layout'))[2];
      await sw.focus();
      await page.keyboard.press('Space');
      assert.deepEqual(await focused(page), [third, 'switch'], 'the switch keeps focus');
      assert.equal(await page.locator('#set-layout .layout-row').nth(2).locator('[data-on]').isChecked(), !was);
      await page.keyboard.press('Space'); // and back, with the same key
      assert.equal(await page.locator('#set-layout .layout-row').nth(2).locator('[data-on]').isChecked(), was);
      await waitUntil(async () => (await S.ok('/settings')).dashboard_layout !== saved, { message: 'the new order was saved' });
      await h.settle();
      clean(h);
    } finally { await h.close(); }
  });

  test('Customize home dialog: moving a section keeps focus in the dialog, on that section', async () => {
    const h = await visit(S, '/');
    const { page } = h;
    try {
      await page.locator('#dash-custom').click();
      await modalReady(page);
      const rows = page.locator('.modal .layout-row');
      const n = await rows.count();
      const name = (await order(page, '.modal'))[n - 2];
      await rows.nth(n - 2).locator('[data-down]').focus();
      await page.keyboard.press('Enter');
      // now the last row: Move down is disabled, Move up takes the focus
      assert.equal((await order(page, '.modal')).indexOf(name), n - 1);
      assert.deepEqual(await focused(page), [name, 'up']);
      await page.keyboard.press('Enter');
      assert.equal((await order(page, '.modal')).indexOf(name), n - 2);
      assert.deepEqual(await focused(page), [name, 'up']);
      await page.keyboard.press('Escape');
      await page.locator('.modal').waitFor({ state: 'detached' });
      clean(h);
    } finally { await h.close(); }
  });

  test('Log session: pressing Save twice logs one session; after a failed save the dialog stays and Save works again', async () => {
    const h = await visit(S, `/game/${D.ids.hollow}`);
    const { page } = h;
    try {
      const count = async () => (await S.ok(`/sessions?game_id=${D.ids.hollow}&limit=1`)).total;
      const n0 = await count();
      await page.locator('#g-log').click();
      await modalReady(page);
      await page.locator('.modal [name=note]').fill('Twice');
      // two clicks before the first answer is back (a double click, or Enter held on the button)
      await page.evaluate(() => { const b = document.querySelector('#log-save'); b.click(); b.click(); });
      await toast(page, 'Logged 1h of Hollow Knight');
      await page.locator('.modal').waitFor({ state: 'detached' });
      await h.settle();
      assert.equal(await count(), n0 + 1, 'one session');
      assert.equal(await page.locator('#toasts .toast', { hasText: 'Logged 1h' }).count(), 1, 'one toast');

      // a save that fails: the dialog and its fields stay, and Save is not left switched off
      await page.locator('#g-log').click();
      await modalReady(page);
      await page.locator('.modal [name=note]').fill('Second try');
      await failOnce(page, '/sessions', 'POST');
      await page.locator('#log-save').click();
      await toast(page, 'The database is busy');
      assert.equal(await page.locator('.modal').count(), 1, 'the dialog is still open');
      assert.equal(await page.locator('.modal [name=note]').inputValue(), 'Second try');
      assert.equal(await count(), n0 + 1, 'nothing logged by the failed save');
      await page.locator('#log-save').click();
      await toast(page, 'Logged 1h of Hollow Knight');
      await h.settle();
      assert.equal(await count(), n0 + 2);
      clean(h, [500]);
    } finally { await h.close(); }
  });

  test('Edit game: an empty title or a failed save keeps the dialog open with what was typed', async () => {
    const h = await visit(S, `/game/${D.ids.ori}`);
    const { page } = h;
    try {
      const open = async () => { await page.locator('#g-more').click(); await page.locator('#g-edit').click(); await modalReady(page); };
      await open();
      const m = page.locator('.modal');
      await m.locator('[name=title]').fill('   ');
      await m.locator('[name=cover_url]').fill('https://cdn.example.invalid/ori.jpg');
      await page.locator('#ge-save').click();
      await toast(page, 'Enter a title');
      assert.equal(await m.count(), 1, 'the dialog is still open');
      assert.equal(await m.locator('[name=cover_url]').inputValue(), 'https://cdn.example.invalid/ori.jpg', 'the cover URL typed is still there');
      assert.equal((await S.ok(`/games/${D.ids.ori}`)).title, 'Ori and the Will of the Wisps', 'nothing was saved');
      assert.equal((await S.ok(`/games/${D.ids.ori}`)).cover_url || '', '');

      // the server refuses: same
      await m.locator('[name=title]').fill('Ori 2');
      await failOnce(page, `/games/${D.ids.ori}`, 'PATCH');
      await page.locator('#ge-save').click();
      await toast(page, 'The database is busy');
      assert.equal(await m.count(), 1, 'the dialog is still open after a failed save');
      assert.equal(await m.locator('[name=title]').inputValue(), 'Ori 2');
      assert.equal(await page.locator('#toasts .toast', { hasText: /^Saved$/ }).count(), 0, 'no "Saved" for a save that failed');

      await page.locator('#ge-save').click();
      await toast(page, 'Saved');
      await m.waitFor({ state: 'detached' });
      await waitUntil(async () => (await page.locator('#view h1').innerText()).trim() === 'Ori 2', { message: 'the page shows the new title' });
      assert.equal((await S.ok(`/games/${D.ids.ori}`)).cover_url, 'https://cdn.example.invalid/ori.jpg');
      clean(h, [500]);
    } finally { await h.close(); }
  });

  test('sessions: the source chips, Pre-tracking history and the game search are kept in the URL and restored by a reload', async () => {
    const h = await visit(S, '/sessions');
    const { page } = h;
    try {
      const search = () => new URL(page.url()).searchParams;
      const total = async () => Number((await page.locator('#s-count').innerText()).match(/ · ([\d,]+) sessions? · /)[1].replace(/,/g, ''));
      const pressed = (sel) => page.locator(`#s-chips ${sel}`).getAttribute('aria-pressed');
      await page.locator('#s-chips [data-src="manual"]').click();
      await page.locator('#s-q').fill('celeste');
      await waitUntil(() => search().get('q') === 'celeste', { message: 'the search is in the URL' });
      assert.equal(search().get('source'), 'manual');
      assert.equal(search().get('kind'), null, 'the default kind is not spelled out');
      await h.settle();
      const want = (await S.ok('/sessions?source=manual&q=celeste&limit=1')).total;
      assert.equal(want, 2);
      // the URL is written before the filtered list is back: wait for the list, not only the URL
      await waitUntil(async () => (await total()) === want, { message: 'the list shows the filtered sessions' });

      await page.reload();
      await waitView(page);
      await h.settle();
      assert.equal(await pressed('[data-src="manual"]'), 'true', 'Logged by me is on again');
      assert.equal(await pressed('[data-src="sync"]'), 'false');
      assert.equal(await page.locator('#s-q').inputValue(), 'celeste');
      assert.equal(await total(), want, 'the same sessions as before the reload');
      assert.equal(await page.locator('#s-list .item.sess').count(), want);

      // history and another source, then everything off again
      await page.locator('#s-chips [data-kind="baseline"]').click();
      await page.locator('#s-chips [data-src="sync"]').click();
      await waitUntil(() => search().get('source') === 'sync' && search().get('kind') === 'baseline', { message: 'source and kind in the URL' });
      await h.settle();
      await page.reload();
      await waitView(page);
      await h.settle();
      assert.equal(await pressed('[data-kind="baseline"]'), 'true');
      assert.equal(await pressed('[data-src="sync"]'), 'true');
      assert.equal(await pressed('[data-src="manual"]'), 'false');
      await page.locator('#s-chips [data-kind="baseline"]').click();
      await page.locator('#s-chips [data-src="sync"]').click();
      await page.locator('#s-q').fill('');
      await waitUntil(() => page.url() === `${S.origin}/sessions`, { message: 'no filter, no query string' });
      await h.settle();

      // a link with a source opens filtered; one the page does not know is ignored
      await page.goto(`${S.origin}/sessions?source=sync&period=month`);
      await waitView(page);
      await h.settle();
      assert.equal(await pressed('[data-src="sync"]'), 'true');
      assert.ok((await page.locator('#s-count').innerText()).startsWith('This month'));
      await page.goto(`${S.origin}/sessions?source=nope&kind=nope`);
      await waitView(page);
      await h.settle();
      assert.equal(await page.locator('#s-chips [aria-pressed="true"]').count(), 1, 'only All platforms is on');
      assert.equal(await total(), (await S.ok('/sessions?limit=1')).total);
      clean(h);
    } finally { await h.close(); }
  });
});

describe('Vestigo web UI, polish on a one-game library', UI, () => {
  let T; let solo;
  before(async () => {
    T = await startApp();
    solo = (await T.ok('/games', { method: 'POST', body: { title: 'Solo', status: 'playing' } })).id;
    // at noon yesterday: one day of play whatever the time now (a session ending a minute ago spans two days just after midnight)
    const noon = new Date(NOW); noon.setHours(12, 0, 0, 0); noon.setDate(noon.getDate() - 1);
    await T.ok('/sessions', { method: 'POST', body: { game_id: solo, minutes: 45, ended_at: noon.getTime() } });
  });
  after(() => { T?.close(); });

  test('Notes: a save that fails says "Not saved", not "Saved"; the next keystroke saves', async () => {
    const h = await visit(T, `/game/${solo}`);
    const { page } = h;
    try {
      const status = () => page.locator('#g-notes-st').innerText();
      await failOnce(page, `/games/${solo}`, 'PATCH');
      await page.locator('#g-notes').fill('Left off at the lighthouse');
      await toast(page, 'The database is busy');
      await waitUntil(async () => (await status()).trim() === 'Not saved', { message: 'the status says the note was not saved' });
      assert.equal((await T.ok(`/games/${solo}`)).notes || '', '', 'nothing was saved');
      await page.locator('#g-notes').pressSequentially('.');
      await waitUntil(async () => (await status()).trim() === 'Saved', { message: 'the next keystroke saves' });
      assert.equal((await T.ok(`/games/${solo}`)).notes, 'Left off at the lighthouse.');
      clean(h, [500]);
    } finally { await h.close(); }
  });

  test('Add a game: an empty title says so; pressing Add game twice adds one game', async () => {
    const h = await visit(T, '/library');
    const { page } = h;
    try {
      const count = async () => T.db.prepare('SELECT COUNT(*) n FROM games').get().n;
      const before_ = await count();
      await page.locator('#lib-add').click();
      await modalReady(page);
      await page.locator('#ag-save').click();
      await toast(page, 'Enter a title');
      assert.equal(await page.locator('.modal').count(), 1, 'the dialog is still open');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'title', 'focus is in the title field');
      await page.locator('.modal [name=title]').fill('Twice Pressed');
      // two presses before the first answer is back
      await page.evaluate(() => { const b = document.querySelector('#ag-save'); b.click(); b.click(); });
      await page.waitForURL(/\/game\/\d+$/);
      await waitView(page);
      await h.settle();
      assert.equal(await count(), before_ + 1, 'one game was added');
      assert.equal(T.db.prepare("SELECT COUNT(*) n FROM games WHERE title = 'Twice Pressed'").get().n, 1);
      clean(h);
    } finally { await h.close(); }
  });

  test('Add a game with past hours: the year is asked for, never assumed to be this one', async () => {
    const h = await visit(T, '/library');
    const { page } = h;
    try {
      await page.locator('#lib-add').click();
      await modalReady(page);
      await page.locator('.modal [name=title]').fill('An Old One');
      await page.locator('.modal [name=hours]').fill('30');
      assert.equal(await page.locator('.modal #ag-when [name=y]').inputValue(), '', 'no year picked for you');
      await page.locator('#ag-save').click();
      await toast(page, 'Pick the year you played it');
      assert.equal(await page.locator('.modal').count(), 1, 'the dialog is still open');
      await page.locator('.modal #ag-when [name=y]').selectOption('2004');
      await page.locator('#ag-save').click();
      await page.waitForURL(/\/game\/\d+$/);
      await h.settle();
      const g = T.db.prepare("SELECT id FROM games WHERE title = 'An Old One'").get();
      const last = T.db.prepare('SELECT MAX(COALESCE(s.ended_at, s.window_end)) t FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.game_id = ?').get(g.id).t;
      assert.equal(new Date(last).getFullYear(), 2004, 'its 30 hours are dated in 2004, not this year');
      clean(h);
    } finally { await h.close(); }
  });

  test('Add a game: when you played it is asked from the start - a year or period, exact dates, or not sure', async () => {
    const h = await visit(T, '/library');
    const { page } = h;
    const rows = (title) => T.db.prepare(`SELECT COUNT(*) n, MIN(COALESCE(s.started_at, s.window_start)) a, MAX(COALESCE(s.ended_at, s.window_end)) b, SUM(s.minutes) m, GROUP_CONCAT(DISTINCT s.kind) kinds
      FROM sessions s JOIN entries e ON e.id = s.entry_id JOIN games g ON g.id = e.game_id WHERE g.title = ?`).get(title);
    try {
      await page.locator('#lib-add').click();
      await modalReady(page);
      // the choices are there before any hours are typed
      assert.deepEqual(await page.locator('.modal #ag-mode button').allTextContents(), ['A year or period', 'Exact dates', 'Not sure']);
      assert.equal(await page.locator('.modal #ag-when').isVisible(), true, 'the period, to begin with');
      assert.equal(await page.locator('.modal #ag-dates').isVisible(), false);
      await page.locator('.modal [name=title]').fill('Dated By Day');
      // exact dates set, and no hours for them: asked for, nothing added
      await page.locator('.modal [data-mode=dates]').click();
      assert.equal(await page.locator('.modal #ag-when').isVisible(), false);
      await page.locator('.modal [name=s]').fill('2010-03-01');
      await page.locator('#ag-save').click();
      await toast(page, 'Enter the hours you played');
      assert.equal(await page.locator('.modal').count(), 1, 'the dialog is still open');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('name')), 'hours', 'focus is in the hours');
      await page.locator('.modal [name=hours]').fill('12');
      await page.locator('.modal [name=e]').fill('2010-06-15');
      assert.equal(await page.locator('.modal #ag-sum').textContent(), '12h between Mar 1, 2010 and Jun 15, 2010.');
      await page.locator('#ag-save').click();
      await page.waitForURL(/\/game\/\d+$/);
      await h.settle();
      const exact = rows('Dated By Day');
      assert.equal(exact.m, 720);
      assert.equal(exact.kinds, 'estimate', 'history, not play');
      assert.ok(exact.a >= new Date(2010, 2, 1).getTime() && exact.b < new Date(2010, 5, 16).getTime(), `between the dates given: ${new Date(exact.a)} - ${new Date(exact.b)}`);
      // not sure when: the hours count, dated nowhere
      await page.goto(`${T.origin}/library`);
      await waitView(page);
      await page.locator('#lib-add').click();
      await modalReady(page);
      await page.locator('.modal [name=title]').fill('Sometime Long Ago');
      await page.locator('.modal [name=hours]').fill('5');
      await page.locator('.modal [data-mode=none]').click();
      assert.equal(await page.locator('.modal #ag-sum').textContent(), '5h count in your totals, but in no year and on no chart until you date them.');
      await page.locator('#ag-save').click();
      await page.waitForURL(/\/game\/\d+$/);
      await h.settle();
      const unsure = rows('Sometime Long Ago');
      assert.equal(unsure.m, 300);
      assert.equal(unsure.kinds, 'baseline', 'kept undated');
      clean(h);
    } finally { await h.close(); }
  });

  test('Sessions: Done in the selection bar gives keyboard focus back to Select', async () => {
    const h = await visit(T, '/sessions');
    const { page } = h;
    try {
      await page.locator('#s-select').focus();
      await page.keyboard.press('Enter');
      await page.locator('#s-bulk:not(.hide)').waitFor();
      await page.locator('#s-bulk-x').focus();
      await page.keyboard.press('Enter');
      await page.locator('#s-bulk.hide').waitFor({ state: 'attached' });
      assert.equal(await page.evaluate(() => document.activeElement?.id), 's-select', 'focus is on Select, not lost to the page');
      clean(h);
    } finally { await h.close(); }
  });

  test('Stats: a longest streak of one day is "1 day"', async () => {
    const h = await visit(T, '/stats?range=30d');
    const { page } = h;
    try {
      const want = await T.ok('/stats?range=30d');
      assert.equal(want.streaks.longest, 1, 'one day played');
      const text = await page.locator('#view').innerText();
      assert.match(text, /longest 1 day\b(?!s)/i);
      assert.doesNotMatch(text, /longest 1 days/i);
      clean(h);
    } finally { await h.close(); }
  });
});
