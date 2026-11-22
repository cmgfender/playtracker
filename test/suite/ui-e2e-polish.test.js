// Vestigo web UI, end to end: polish. The Home sections editor keeps keyboard focus, Log session
// saves once however often Save is pressed, Edit game keeps what was typed when a save fails, and
// every Sessions filter is kept in the URL.
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
});
