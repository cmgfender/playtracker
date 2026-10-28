// Vestigo web UI, end to end: batch 5 (command palette and shortcuts, library filters, the game
// page with achievements and its curve, sessions periods, unlocks on session rows, Insights, first
// run and empty states, Year in review) and a large library's performance budget.
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e-batch5.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chromium, installFetchGuard, startApp, seed, seedAchievements, openPage, waitView, overflow, waitUntil, toast, modalReady,
  chartReport, chartProblems, invariantViolations, DESKTOP, PHONE, PHONE_SMALL, HOUR, DAY, skipReason,
} from './helpers/ui-e2e-harness.js';
import { seedDemo } from '../../src/demo.js';
import { applyItems, parseAccount } from '../../src/services/sync.js';
import { Settings } from '../../src/services/settings.js';
import { storeAchievements, ACH_VERSION } from '../../src/services/achievements.js';
import { tx } from '../../src/db.js';

const UI = { skip: skipReason || false };
const NOW = Date.now();
const YEAR = new Date(NOW).getFullYear();

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
const h1 = (page) => page.locator('#view h1').innerText().then((t) => t.trim());
/** Scroll through Insights until every section has loaded (they load as they come near the screen). */
async function loadAllSections(page) {
  for (let i = 0; i < 12; i++) {
    const left = await page.evaluate(async () => {
      for (const s of document.querySelectorAll('#view [data-sec]')) { s.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 60)); }
      return document.querySelectorAll('#view .ins-ph, #view [data-sec] .ins-body[aria-busy="true"]').length;
    });
    if (!left) break;
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await waitUntil(() => page.evaluate(() => !document.querySelector('#view .ins-ph, #view .ins-body[aria-busy="true"]')), { message: 'every Insights section loaded', timeout: 15000 });
}
const minutesOf = (text) => { const m = /(\d[\d,]*)h(?: (\d+)m)?|(\d+)m/.exec(text); return m ? (m[3] ? Number(m[3]) : Number(m[1].replace(/,/g, '')) * 60 + Number(m[2] || 0)) : null; };

// ======================================================================== the seeded library
describe('Vestigo web UI, batch 5: palette, filters, achievements, sessions', UI, () => {
  let S; let D;
  before(async () => {
    S = await startApp();
    D = await seed(S.ok, NOW);
    D.ach = await seedAchievements(S.ok, S.db, D.ids.zelda);
  });
  after(() => {
    assert.deepEqual(guard.external, [], 'no server-side request left 127.0.0.1');
    assert.deepEqual(invariantViolations(S.db), [], 'sessions add up to every lifetime total');
    S?.close();
  });

  test('palette: Ctrl+K from any page, type "hol", Enter opens Hollow Knight; Shift+Enter logs a session; pages and actions are found too', async () => {
    const h = await visit(S, '/stats');
    const { page } = h;
    try {
      await page.keyboard.press('Control+k');
      await page.keyboard.type('hol');
      await page.keyboard.press('Enter');
      await waitUntil(() => new URL(page.url()).pathname === `/game/${D.ids.hollow}`, { message: 'Hollow Knight opened' });
      await waitView(page);
      assert.equal(await h1(page), 'Hollow Knight');
      assert.equal(await page.locator('.overlay').count(), 0, 'the palette closed');
      // the sidebar button opens it too; it is a labelled combobox over a listbox in groups
      await page.locator('.side [data-action="palette"]').click();
      const q = page.locator('#pal-q');
      await q.waitFor();
      assert.ok(await q.evaluate((el) => el === document.activeElement), 'the field has focus');
      assert.equal(await q.getAttribute('role'), 'combobox');
      await page.keyboard.type('insi');
      await waitUntil(async () => JSON.stringify(await page.locator('#pal-list [role=group] .pal-gh').allTextContents()) === '["Pages"]', { message: 'only pages match "insi"' });
      assert.match(await page.locator('#pal-list [role=option]').first().innerText(), /Insights/);
      await page.keyboard.press('Enter');
      await waitUntil(() => new URL(page.url()).pathname === '/insights', { message: 'Insights opened from the palette' });
      await waitView(page);
      // arrow keys move the active option; Shift+Enter on a game logs a session for it
      await page.keyboard.press('Control+k');
      await page.keyboard.type('cel');
      await waitUntil(async () => (await page.locator('#pal-list .pal-gh').first().textContent()) === 'Games', { message: 'the results for "cel"' });
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowUp');
      const active = await page.evaluate(() => document.getElementById(document.querySelector('#pal-q').getAttribute('aria-activedescendant'))?.textContent);
      assert.match(active, /Celeste/, 'the active option is named by aria-activedescendant');
      await page.keyboard.press('Shift+Enter');
      await page.locator('.modal').filter({ has: page.locator('.mh h2', { hasText: /^Log a session$/ }) }).waitFor();
      assert.match(await page.locator('.modal').innerText(), /Celeste/, 'Log session for the game');
      await page.keyboard.press('Escape');
      // actions
      await page.keyboard.press('Control+k');
      await page.keyboard.type('shortcuts');
      await page.locator('#pal-list [role=option]', { hasText: 'Keyboard shortcuts' }).waitFor();
      await page.keyboard.press('Enter');
      await page.locator('.modal', { hasText: 'Keyboard shortcuts' }).waitFor();
      await page.keyboard.press('Escape');
      clean(h);
    } finally { await h.close(); }
  });

  test('shortcuts: g then l / s / i navigates, / focuses the page search, n logs a session, ? lists them; all ignored inside inputs and dialogs', async () => {
    const h = await visit(S, '/');
    const { page } = h;
    try {
      await page.keyboard.press('g');
      await page.keyboard.press('l');
      await waitUntil(() => new URL(page.url()).pathname === '/library', { message: 'g l: Library' });
      await waitView(page);
      // inside the search field "g l" is text, not a shortcut
      await page.locator('#lib-q').focus();
      await page.keyboard.press('g');
      await page.keyboard.press('s');
      await page.waitForTimeout(300);
      assert.equal(new URL(page.url()).pathname, '/library', 'typing in a field never navigates');
      assert.equal(await page.locator('#lib-q').inputValue(), 'gs');
      await page.locator('#lib-q').fill('');
      const away = () => page.evaluate(() => document.activeElement?.blur());
      await away();
      // "/" focuses the page's own search
      await page.keyboard.press('/');
      assert.ok(await page.locator('#lib-q').evaluate((el) => el === document.activeElement), '/ focuses the library search');
      assert.equal(await page.locator('#lib-q').inputValue(), '', 'the slash is not typed into it');
      await away();
      await page.keyboard.press('g');
      await page.keyboard.press('i');
      await waitUntil(() => new URL(page.url()).pathname === '/insights', { message: 'g i: Insights' });
      await waitView(page);
      // "/" on a page without a search opens the palette
      await page.keyboard.press('/');
      await page.locator('#pal-q').waitFor();
      // inside a dialog shortcuts wait
      await page.keyboard.type('n');
      assert.equal(await page.locator('.modal').filter({ has: page.locator('.mh h2', { hasText: /^Log a session$/ }) }).count(), 0, 'n inside the palette is text');
      await page.keyboard.press('Escape');
      await page.keyboard.press('n');
      await page.locator('.modal').filter({ has: page.locator('.mh h2', { hasText: /^Log a session$/ }) }).waitFor();
      await page.keyboard.press('Escape');
      await page.keyboard.press('?');
      await page.locator('.modal', { hasText: 'Keyboard shortcuts' }).waitFor();
      assert.match(await page.locator('.modal').innerText(), /Go to Insights/);
      clean(h);
    } finally { await h.close(); }
    // phone: the top bar's search opens the palette as a full-height sheet
    const p = await visit(S, '/sessions', { viewport: PHONE });
    try {
      const btn = p.page.locator('.topbar [data-action="palette"]');
      const box = await btn.boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `the search button is 44px (${box.width}x${box.height})`);
      await btn.click();
      await p.page.locator('#pal-q').waitFor();
      const m = await p.page.locator('.modal.palette').boundingBox();
      assert.ok(m.height >= PHONE.height - 2 && m.width >= PHONE.width - 1, `a full-height sheet (${m.width}x${m.height})`);
      await p.page.locator('#pal-q').fill('zel');
      await p.page.locator('#pal-list [role=option]', { hasText: 'Zelda' }).click();
      await waitUntil(() => new URL(p.page.url()).pathname === `/game/${D.ids.zelda}`, { message: 'tapped a result' });
      clean(p);
    } finally { await p.close(); }
  });

  test('library filters: Playing + Backlog on Custom give ?platform=custom&status=playing,backlog with the matching games; a reload restores them; one account at a time; Clear filters', async () => {
    const h = await visit(S, '/library');
    const { page } = h;
    const titles = async () => { await h.settle(); return new Set((await page.locator('#lib-items .tile .t').allInnerTexts()).map((x) => x.trim())); };
    try {
      await S.ok(`/games/${D.ids.zelda}`, { method: 'PATCH', body: { status: 'backlog' } });
      await page.locator('[data-menu="status"]').click();
      await page.locator('.fmenu input[value="playing"]').check();
      await page.locator('.fmenu input[value="backlog"]').check();
      await page.keyboard.press('Escape');
      await page.locator('[data-menu="platform"]').click();
      await page.locator('.fmenu input[name="platform"][value="custom"]').check();
      await page.keyboard.press('Escape');
      await waitUntil(async () => new URL(page.url()).search === '?platform=custom&status=playing%2Cbacklog', { message: `URL (${page.url()})` });
      const api = (await S.ok('/games?platform=custom&status=playing,backlog&limit=100')).items.map((g) => g.title);
      assert.deepEqual([...await titles()].sort(), api.sort(), 'the same games as the API');
      assert.deepEqual([...await titles()], ['Zelda: TotK']);
      const texts = (sel) => page.locator(sel).evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
      assert.deepEqual(await texts('[data-menu]'), ['Platform · 1', 'Status · 2', 'More']);
      await page.reload();
      await waitView(page);
      assert.deepEqual([...await titles()], ['Zelda: TotK'], 'a reload restores the filters');
      assert.deepEqual(await texts('#lib-pills .pill'), ['Custom', 'Playing', 'Backlog']);
      assert.deepEqual(await texts('[data-menu]'), ['Platform · 1', 'Status · 2', 'More']);
      // the account is a single choice (GET /games takes one account_id)
      await page.locator('#lib-pills .pill-clear').click();
      await waitUntil(async () => (await titles()).size === 7, { message: 'Clear all' });
      await S.ok('/accounts', { method: 'POST', body: { platform: 'custom', name: 'Second', config: {} } });
      await page.reload();
      await waitView(page);
      await page.locator('[data-menu="platform"]').click();
      const radios = page.locator('.fmenu input[name="account"]');
      assert.equal(await radios.first().getAttribute('type'), 'radio');
      await page.locator('.fmenu input[name="account"][value="' + D.account.id + '"]').check();
      await waitUntil(() => new URL(page.url()).searchParams.get('account_id') === String(D.account.id), { message: 'account_id' });
      assert.deepEqual([...await titles()].sort(), ['Mario Kart 8 Deluxe', 'Zelda: TotK']);
      await page.keyboard.press('Escape');
      // nothing matches: a way out
      await page.locator('#lib-q').fill('no such game at all');
      await page.locator('#lib-items .empty h2', { hasText: 'Nothing matches' }).waitFor();
      await page.locator('#lib-items [data-clear]').click();
      await waitUntil(async () => (await titles()).size === 7, { message: 'Clear filters' });
      assert.equal(new URL(page.url()).search, '');
      clean(h);
    } finally {
      await h.close();
      await S.ok(`/games/${D.ids.zelda}`, { method: 'PATCH', body: { status: 'unset' } });
    }
  });

  test('game page: achievements progress matches the API; the timeline groups unlocks by session (history apart); locked folded, hidden blurred until revealed; rare marked; the curve is tracked over hatched history', async () => {
    const api = await S.ok(`/games/${D.ids.zelda}/achievements`);
    const h = await visit(S, `/game/${D.ids.zelda}`);
    const { page } = h;
    try {
      const card = page.locator('#g-ach');
      assert.equal(await card.locator('.ap-num b').innerText(), String(api.summary.unlocked));
      assert.match(await card.locator('.ap-num').innerText(), new RegExp(`of ${api.summary.total}`));
      assert.equal(await card.locator('.ap-pct').innerText(), `${api.summary.percent}%`);
      const groups = await card.locator('.ach-g').evaluateAll((els) => els.map((g) => ({ head: g.querySelector('.ach-gh').textContent.trim(), names: [...g.querySelectorAll('.ach-row .ttl')].map((t) => t.textContent.trim()) })));
      const tracked = api.items.filter((x) => x.session_kind === 'tracked');
      assert.equal(tracked.length, 2, 'the fixture: two unlocks in a tracked session');
      assert.match(groups[0].head, /^Earned during the session on /);
      assert.deepEqual(groups[0].names, ['Paraglider', 'Shrine Seeker'], 'newest first, both in one session group');
      const hist = api.items.filter((x) => x.session_kind === 'history');
      if (hist.length) assert.ok(groups.some((g) => /^Before tracking/.test(g.head) && g.names.includes('Old Friend')), 'history unlocks: "Before tracking"');
      assert.ok(groups.some((g) => g.names.includes('Undated') && /time unknown/.test(g.head)), 'an unlock without a time');
      // the session group opens that session
      await card.locator('.ach-gh-link').first().click();
      await page.locator('.modal .ach-sess').waitFor();
      assert.match(await page.locator('.modal .ach-sess').innerText(), /2 achievements unlocked during this session[\s\S]*Shrine Seeker[\s\S]*Paraglider/);
      await page.keyboard.press('Escape');
      // rarity: a percent, "rare" under 10%
      const rare = card.locator('.ach-row', { hasText: 'Shrine Seeker' }).locator('.rar');
      assert.match(await rare.innerText(), /rare\s*4\.2%/i);
      assert.doesNotMatch(await card.locator('.ach-row', { hasText: 'Paraglider' }).locator('.rar').innerText(), /rare/i);
      // locked: folded; the hidden one blurred and unnamed for screen readers until revealed
      const locked = card.locator('details.ach-locked');
      assert.equal(await locked.evaluate((d) => d.open), false);
      assert.match(await locked.locator('summary').innerText(), /2 locked achievements/);
      await locked.locator('summary').click();
      const secret = locked.locator('.ach-row.secret');
      await secret.waitFor();
      assert.equal(await secret.count(), 1);
      assert.match(await secret.locator('.ttl .blur').evaluate((e) => getComputedStyle(e).filter), /blur/);
      assert.equal(await secret.locator('.ttl .blur').getAttribute('aria-hidden'), 'true');
      assert.equal(await secret.locator('.ttl .vh').innerText(), 'Hidden achievement');
      await secret.locator('[data-reveal]').click();
      assert.equal(await secret.locator('.ttl .blur').evaluate((e) => getComputedStyle(e).filter), 'none');
      assert.equal(await secret.locator('.ttl').innerText(), 'Secret Ending');
      // the session row carries its unlocks
      const row = page.locator(`#g-sessions .item:has([data-edit-session="${D.ach.sessionId}"])`);
      assert.match(await row.locator('.ach-line').innerText(), /^2 achievements · 1 rare \(4\.2%\)$/);
      // the curve: a labelled image, tracked play solid over hatched estimated history
      const curve = page.locator('#g-curve .chart svg');
      assert.equal(await curve.getAttribute('role'), 'img');
      assert.match(await curve.getAttribute('aria-label'), /playtime over time: .+ tracked/);
      const stats = await S.ok(`/games/${D.ids.zelda}/stats`);
      assert.equal(await page.locator('#g-curve [data-key="estimated"]').count(), stats.totals.estimated_minutes ? 1 : 0);
      assert.equal(await page.locator('#g-curve [data-key="tracked"]').count(), 1);
      await page.locator('#g-curve-mode [data-cm="month"]').click();
      await page.locator('#g-curve .chart.bar svg').waitFor();
      assert.deepEqual(chartProblems('game page', await chartReport(page)), []);
      clean(h);
    } finally { await h.close(); }
  });

  test('game page at 1400x900: status, rating, favourite and Log session without scrolling; the ⋯ menu holds edit, merge, hide, block auto-merge, delete', async () => {
    const h = await visit(S, `/game/${D.ids.celeste}`);
    const { page } = h;
    try {
      for (const sel of ['#g-status-sel', '#g-stars', '#g-fav', '#g-log', '#g-more']) {
        const b = await page.locator(sel).boundingBox();
        assert.ok(b && b.y + b.height <= DESKTOP.height, `${sel} is on the first screen (${JSON.stringify(b)})`);
      }
      assert.deepEqual(await page.locator('#g-status-sel option').first().innerText(), 'No status');
      await page.locator('#g-more').click();
      assert.equal(await page.locator('#g-more').getAttribute('aria-expanded'), 'true');
      assert.deepEqual((await page.locator('.fmenu.pop [role^="menuitem"]').allInnerTexts()).map((x) => x.split('\n')[0].trim()), ['Edit title & cover', 'Merge with…', 'Hide from library', 'Block auto-merge', 'Delete…']);
      assert.ok(await page.locator('#g-edit').evaluate((e) => e === document.activeElement), 'the first item has focus');
      await page.keyboard.press('ArrowDown');
      assert.ok(await page.locator('#g-merge').evaluate((e) => e === document.activeElement), 'arrow keys move along the menu');
      await page.locator('#g-lock').click();
      await toast(page, 'Auto-merge blocked');
      await waitUntil(async () => (await S.ok(`/games/${D.ids.celeste}`)).merge_locked, { message: 'merge lock saved' });
      await page.locator('#g-lock').click();
      await waitUntil(async () => !(await S.ok(`/games/${D.ids.celeste}`)).merge_locked, { message: 'merge lock off' });
      await page.locator('#view h1').click();
      assert.equal(await page.locator('.fmenu.pop').count(), 0, 'a click outside closes the menu');
      // the columns end close together (no 400px gap beside the shorter one)
      const cols = await page.locator('.game-cols > .stack').evaluateAll((els) => els.map((e) => e.lastElementChild.getBoundingClientRect().bottom));
      assert.ok(Math.abs(cols[0] - cols[1]) <= 400, `column ends ${cols.map(Math.round)}`);
      clean(h);
    } finally { await h.close(); }
  });

  test('sessions: rows with unlocks say so; This week follows the week start and its total; a day header selects the day; shift-click selects a range', async () => {
    const h = await visit(S, '/sessions');
    const { page } = h;
    try {
      const row = page.locator(`#s-list .item:has([data-edit-session="${D.ach.sessionId}"])`);
      assert.match(await row.locator('.ach-line').innerText(), /^2 achievements · 1 rare \(4\.2%\)$/);
      assert.equal(await row.locator('.ach-line .ach-ic').count(), 2, 'tiny icons');
      const list = await S.ok('/sessions?limit=200');
      assert.equal(list.items.find((x) => x.id === D.ach.sessionId).achievements.count, 2);
      // This week, with the week starting on Sunday and on Monday
      for (const ws of [0, 1]) {
        await S.ok('/settings', { method: 'PUT', body: { week_starts_on: ws } });
        await page.goto(`${S.origin}/sessions?period=week`);
        await waitView(page);
        await h.settle();
        const d = new Date(); d.setHours(12, 0, 0, 0);
        d.setDate(d.getDate() - ((d.getDay() - ws + 7) % 7));
        const p = (n) => String(n).padStart(2, '0');
        const from = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        const t = new Date();
        const to = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
        const r = await S.ok(`/sessions?from=${from}&to=${to}&limit=1`);
        const head = await page.locator('#s-count').innerText();
        assert.ok(head.startsWith(`This week · ${r.total} session${r.total === 1 ? '' : 's'} · `), `week start ${ws}: "${head}" (${r.total} sessions from ${from})`);
        assert.equal(minutesOf(head.split(' · ').pop()), r.total_minutes, `week start ${ws}: the total`);
        assert.equal(await page.locator('#s-period button.on').innerText(), 'This week');
      }
      await S.ok('/settings', { method: 'PUT', body: { week_starts_on: 1 } });
      // custom period: two dates, kept in the URL
      await page.locator('#s-period [data-period="custom"]').click();
      await page.locator('#s-from').fill(new Date(NOW - 2 * DAY).toISOString().slice(0, 10));
      await page.locator('#s-from').dispatchEvent('change');
      await waitUntil(() => new URL(page.url()).searchParams.get('period') === 'custom' && !!new URL(page.url()).searchParams.get('from'), { message: 'custom in the URL' });
      // all, then select a whole day by its header
      await page.locator('#s-period [data-period="all"]').click();
      await h.settle();
      await page.locator('#s-select').click();
      const day = page.locator('#s-list .day-h').first();
      const dayId = await day.getAttribute('data-day');
      const inDay = await page.evaluate((d) => { const out = []; let n = document.querySelector(`.day-h[data-day="${d}"]`).nextElementSibling; while (n && n.matches('.item')) { out.push(n.dataset.sid); n = n.nextElementSibling; } return out; }, dayId);
      await day.locator('[data-day-sel]').check();
      assert.equal(await page.locator('#s-bulk-n').innerText(), `${inDay.length} selected`);
      for (const id of inDay) assert.ok(await page.locator(`[data-sel="${id}"]`).isChecked(), `row ${id} of the day is ticked`);
      await day.locator('[data-day-sel]').uncheck();
      assert.equal(await page.locator('#s-bulk-n').innerText(), '0 selected');
      // shift-click: a range
      const boxes = page.locator('#s-list .item [data-sel]');
      const n = await boxes.count();
      assert.ok(n >= 4);
      await boxes.nth(0).click();
      await boxes.nth(3).click({ modifiers: ['Shift'] });
      assert.equal(await page.locator('#s-bulk-n').innerText(), '4 selected');
      assert.deepEqual(await page.locator('#s-bulk [data-bulk="baseline"]').evaluate((b) => [b.textContent.trim(), b.title]), ['Exclude from stats', 'Still counts toward lifetime']);
      assert.equal(await page.locator('#s-bulk [data-bulk="play"]').innerText(), 'Include in stats');
      assert.deepEqual(await page.locator('#s-chips .chip').allInnerTexts().then((x) => x.slice(-4)), ['Logged by me', 'From platforms', 'Imported', 'Pre-tracking history']);
      clean(h);
    } finally { await h.close(); await S.ok('/settings', { method: 'PUT', body: { week_starts_on: 1 } }); }
  });

  test('Home at 1400px: the This week mini chart does not overlap its sessions line or its value', async () => {
    const h = await visit(S, '/');
    try {
      const r = await h.page.evaluate(() => {
        const k = document.querySelector('#view .kpi.feature');
        const box = (el) => el.getBoundingClientRect();
        const s = box(k.querySelector('.spark-bars'));
        const hit = (b) => !(b.right <= s.left || b.left >= s.right || b.bottom <= s.top || b.top >= s.bottom);
        const text = (el) => { const rg = document.createRange(); rg.selectNodeContents(el); return rg.getBoundingClientRect(); };
        return { sub: hit(text(k.querySelector('.sub'))), value: hit(text(k.querySelector('.value'))), label: hit(text(k.querySelector('.label'))) };
      });
      assert.deepEqual(r, { sub: false, value: false, label: false });
      clean(h);
    } finally { await h.close(); }
  });

  test('pages with the new parts fit 360 and 390px phones (no horizontal overflow), Insights with every section loaded', async () => {
    const problems = [];
    for (const viewport of [PHONE_SMALL, PHONE]) {
      const h = await openPage(browser, S.origin, { viewport });
      try {
        for (const path of ['/insights', `/game/${D.ids.zelda}`, '/sessions?period=month', '/library?status=playing,backlog&platform=custom,manual&favorite=true', `/wrapped/${YEAR}`, '/stats']) {
          await h.page.goto(`${S.origin}${path}`);
          await waitView(h.page);
          await h.settle();
          if (path === '/insights') await loadAllSections(h.page);
          const o = await overflow(h.page, viewport.width);
          if (o.doc > viewport.width + 1 || o.doc > o.client) problems.push(`${viewport.width}px ${path}: ${o.doc}px wide, widest ${JSON.stringify(o.culprit)}`);
          problems.push(...chartProblems(`${viewport.width}px ${path}`, await chartReport(h.page)));
        }
        clean(h);
      } finally { await h.close(); }
    }
    assert.deepEqual(problems, []);
  });
});

// ======================================================================== the demo library
describe('Vestigo web UI, batch 5: Insights and Year in review on the demo library', UI, () => {
  let S;
  before(async () => {
    S = await startApp();
    seedDemo(S.db, { now: NOW });
  });
  after(() => S?.close());

  test('Insights: every section renders with data, each chart an img with a summary; the controls reload the sections and stay in the URL', async () => {
    const h = await visit(S, '/insights');
    const { page } = h;
    try {
      assert.equal(await page.title(), 'Insights · Vestigo');
      assert.equal(await page.locator('.side .nav-link.active').innerText(), 'Insights');
      await loadAllSections(page);
      const sec = (id) => page.locator(`#ins-${id}`);
      const n = async (id, sel) => sec(id).locator(sel).count();
      assert.equal(await n('when', '.chart.punch svg'), 1, 'punchcard');
      assert.equal(await n('when', '.chart.hist svg'), 1, 'session lengths');
      assert.match(await sec('when').locator('.kpi', { hasText: 'Median' }).innerText(), /\d/);
      assert.equal(await n('what', '.chart.lanes svg'), 1, 'swimlanes');
      assert.ok(await n('what', '.chart.erastrip [data-tip]') >= 2, 'eras strip');
      assert.ok(await n('what', '.era-list li') >= 2, 'eras list');
      assert.equal(await n('what', '.chart.area svg'), 1, 'platforms over time');
      assert.ok(await n('records', '.rec') >= 6, 'record cards');
      assert.ok(await n('records', '.hl li') >= 4, 'highlight lines');
      assert.ok(await n('ach', '.chart.bar svg') >= 2, 'unlocks per month and completion');
      assert.ok(await n('ach', '.ach-row') >= 3, 'rarest unlocks');
      assert.ok(await n('ach', '.item .badge.good') >= 1, 'recently completed');
      assert.equal(await n('yoy', '.chart.lines svg'), 1, 'year over year');
      assert.match(await sec('yoy').locator('.ins-lead').innerText(), /so far/);
      assert.ok(await n('library', '.mrow') >= 4, 'status and platform rows');
      assert.equal(await n('library', '.chart.scatter svg'), 1, 'completion vs hours');
      assert.equal(await page.locator('#view .ins-none', { hasText: 'Could not load' }).count(), 0);
      const charts = await chartReport(page);
      assert.ok(charts.length >= 9, `${charts.length} charts`);
      assert.deepEqual(chartProblems('/insights', charts), []);
      // the estimates switch: estimated history leaves the platform chart (hatched layers) and the URL says so
      const hatched = () => sec('what').locator('.chart.area [data-key="estimated"]').count();
      assert.ok(await hatched() > 0, 'estimated history is hatched');
      await page.locator('.switch:has(#in-est) > span').click();
      await waitUntil(() => new URL(page.url()).searchParams.get('estimates') === 'exclude', { message: 'estimates=exclude' });
      await waitUntil(async () => (await hatched()) === 0, { message: 'no hatched layers without estimated history' });
      // the range: the sections on screen reload for it
      await page.locator('#in-range [data-r="30d"]').click();
      await waitUntil(() => new URL(page.url()).searchParams.get('range') === '30d', { message: 'range=30d' });
      await waitUntil(async () => /Last 30 days/.test(await sec('when').locator('.card-h .tiny').first().innerText()), { message: 'the first section reloaded' });
      // platform: by device
      await page.locator('#in-by [data-by="device"]').click();
      await waitUntil(() => new URL(page.url()).searchParams.get('by') === 'device', { message: 'by=device' });
      // keyboard: the punchcard's arrow keys read each hour out
      const punch = sec('when').locator('.chart.punch');
      await punch.focus();
      assert.equal(await punch.getAttribute('role'), 'group');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowDown');
      const live = await punch.locator('.chart-live').innerText();
      assert.match(live, /^Tuesday .+: /, `the second row's first hour is read out ("${live}")`);
      assert.equal(await punch.locator('.tip.on').count(), 1, 'its tooltip shows');
      clean(h);
    } finally { await h.close(); }
  });

  test('eras: a strip on a true time axis (equal months, years under it, titles inside wide blocks, tooltips, arrow keys, a summary) and the list by year; 1400, 390 and 360px', async () => {
    const tl = await S.ok('/stats/timeline?range=all');
    assert.ok(tl.eras.some((e) => e.kind === 'variety') && tl.eras.some((e) => e.ordinal > 1), 'the demo has a mix and a return');
    const from = tl.era_range.from;
    const idx = (k) => (Number(k.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(k.slice(5)) - Number(from.slice(5));
    const first = tl.eras.find((e) => e.kind === 'game');
    const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const viewport of [DESKTOP, PHONE, PHONE_SMALL]) {
      const where = `${viewport.width}px`;
      const h = await visit(S, '/insights?range=all', { viewport });
      const { page } = h;
      try {
        await page.evaluate(() => document.querySelector('#ins-what').scrollIntoView());
        const card = page.locator('#ins-what .ins-eras');
        const strip = card.locator('.chart.erastrip');
        await strip.locator('svg').waitFor();
        const g = await strip.evaluate((el) => {
          const svg = el.querySelector('svg');
          const box = (n) => { const b = n.getBBox(); return { x: b.x, w: b.width, r: b.x + b.width }; };
          return {
            hostW: el.clientWidth, w: svg.viewBox.baseVal.width, label: svg.getAttribute('aria-label'),
            blocks: [...svg.querySelectorAll('.era-b, .era-break')].map((r) => ({ ...box(r), tip: r.dataset.tip })),
            texts: [...svg.querySelectorAll('text.era-l')].map((t) => ({ ...box(t), s: t.textContent })),
            years: [...svg.querySelectorAll('.axis text.yr')].map((t) => ({ ...box(t), s: t.textContent })),
          };
        });
        assert.ok(Math.abs(g.w - g.hostW) < 1, `${where}: drawn at its width`);
        // every month the same width: each block starts at its first month and spans its months
        const mw = g.w / tl.era_range.months;
        assert.equal(g.blocks.length, tl.eras.length);
        tl.eras.forEach((e, i) => {
          const b = g.blocks[i];
          assert.ok(Math.abs(b.x - idx(e.from) * mw) <= 1.2 && Math.abs(b.w - e.months * mw) <= 2.2, `${where} era ${i} (${e.from}..${e.to}): x ${b.x.toFixed(1)} w ${b.w.toFixed(1)}, a month is ${mw.toFixed(1)}px`);
        });
        // the years under it, each from its January
        assert.ok(g.years.length >= 2, `${where}: year labels (${g.years.map((y) => y.s)})`);
        assert.match(g.years[0].s, new RegExp(`${from.slice(0, 4)}$`), `${where}: the axis opens with its first year`);
        for (const y of g.years.slice(1)) {
          assert.match(y.s, /^\d{4}$/);
          assert.ok(Math.abs(y.x - (idx(`${y.s}-01`) * mw + 4)) <= 1, `${where}: ${y.s} sits at its January`);
        }
        // titles inside the wide blocks, never past their edge
        // how many blocks are wide enough for a name depends on the demo data, which moves with
        // today's date: the rule below (every wide block is named) is what is checked
        if (g.blocks.some((b) => b.w >= 120)) assert.ok(g.texts.length >= 1, `${where}: labels inside blocks`);
        for (const t of g.texts) {
          const b = g.blocks.find((x) => t.x >= x.x && t.x < x.r);
          assert.ok(b && t.r <= b.r + 0.5, `${where}: "${t.s}" stays inside its block`);
        }
        for (const [i, e] of tl.eras.entries()) {
          if (e.kind === 'game' && g.blocks[i].w >= 120) assert.ok(g.texts.some((t) => e.title.startsWith(t.s.replace(/…$/, ''))), `${where}: ${e.title} is named in its block`);
        }
        // the summary: "8 eras in 30 months: Marvel's Spider-Man 2 led May – Aug 2024, …"
        assert.match(g.label, new RegExp(`^\\d+ eras in ${tl.era_range.months} months: ${reEsc(first.title)} led `));
        // hover and keyboard read the same tooltips
        await strip.locator('.era-b').first().hover();
        assert.equal(await strip.locator('.tip.on').innerText(), g.blocks[0].tip);
        assert.match(g.blocks[0].tip, /^.+ · .+ \(\d+ months?\) · \d+% of play · /);
        await strip.focus();
        assert.equal(await strip.getAttribute('role'), 'group');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        assert.equal(await strip.locator('.chart-live').innerText(), g.blocks[1].tip);
        await page.keyboard.press('End');
        assert.equal(await strip.locator('.chart-live').innerText(), g.blocks.at(-1).tip);
        // the list: a head per year, a row per era in the strip's order
        assert.deepEqual(await card.locator('.era-yh').allInnerTexts(), [...new Set(tl.eras.map((e) => e.from.slice(0, 4)))]);
        const rows = card.locator('.era-row');
        assert.equal(await rows.count(), tl.eras.length);
        for (const [i, e] of tl.eras.entries()) {
          const row = rows.nth(i);
          const text = (await row.innerText()).replace(/\s+/g, ' ');
          if (e.kind === 'game') {
            assert.equal(await row.locator('.era-t a').getAttribute('href'), `/game/${e.game_id}`);
            assert.ok(text.includes(`${Math.round(e.share * 100)}% of your play`), `${where} row ${i}: ${text}`);
            if (e.alongside.length) assert.ok(text.includes(`alongside ${e.alongside[0].title}`), `${where} row ${i}: ${text}`);
            assert.equal(await row.locator('.era-tag').count(), e.ordinal > 1 ? 1 : 0, `${where} row ${i}: a return is marked`);
            if (e.ordinal === 2) assert.match(text, /2nd era/);
            assert.equal(await row.locator('.cover').count(), 1, 'a cover (or its monogram)');
          } else if (e.kind === 'variety') {
            assert.ok(text.startsWith('A mix of games') && text.includes(`mostly ${e.games[0].title}`), `${where} row ${i}: ${text}`);
          }
          assert.match(text, /\d+ months?/);
          assert.equal(/mostly estimated/.test(text), e.estimated_minutes * 2 > e.minutes, `${where} row ${i}: mostly estimated marked as such`);
        }
        // phones: nothing wider than the screen, every row inside the card
        const o = await overflow(page, viewport.width);
        assert.ok(o.doc <= viewport.width + 1, `${where}: ${o.doc}px wide, widest ${JSON.stringify(o.culprit)}`);
        const spill = await card.evaluate((c) => { const r = c.getBoundingClientRect(); return [...c.querySelectorAll('.era-row, .era-row *')].filter((n) => n.getBoundingClientRect().right > r.right + 0.5).length; });
        assert.equal(spill, 0, `${where}: rows stay inside the card`);
        assert.deepEqual(chartProblems(where, (await chartReport(page)).filter((c) => /erastrip/.test(c.kind))), []);
        clean(h);
      } finally { await h.close(); }
    }
  });

  test('Insights and Year in review: dark and light, desktop and phone, without overflow or page errors', async () => {
    for (const colorScheme of ['dark', 'light']) {
      await S.ok('/settings', { method: 'PUT', body: { theme: colorScheme } });
      for (const viewport of [DESKTOP, PHONE]) {
        const h = await openPage(browser, S.origin, { viewport, colorScheme });
        try {
          for (const path of ['/insights', `/wrapped/${YEAR}`, '/game/1']) {
            await h.page.goto(`${S.origin}${path}`);
            await waitView(h.page);
            if (path === '/insights') await loadAllSections(h.page);
            const o = await overflow(h.page, viewport.width);
            assert.ok(o.doc <= viewport.width + 1 && o.doc <= o.client, `${colorScheme} ${viewport.width}px ${path}: ${o.doc}px, widest ${JSON.stringify(o.culprit)}`);
          }
          clean(h);
        } finally { await h.close(); }
      }
    }
    await S.ok('/settings', { method: 'PUT', body: { theme: 'dark' } });
  });

  test('Year in review: the switcher moves a year (URL and figures); without estimated history the headline is tracked play; achievements, eras, favourite time and longest session', async () => {
    const years = (await S.ok('/stats/years')).sort();
    const prev = years[years.indexOf(YEAR) - 1];
    assert.ok(prev, `the demo has an earlier year (${years})`);
    const h = await visit(S, `/wrapped/${YEAR}`);
    const { page } = h;
    try {
      assert.equal(await h1(page), `Your ${YEAR} trail`);
      assert.equal(await page.title(), `${YEAR} in review · Vestigo`);
      const big = () => page.locator('.wcard.g1 .big').innerText();
      const w = await S.ok(`/stats/year/${YEAR}`);
      assert.equal(await big(), `${Math.round(w.total_minutes / 60).toLocaleString()} hours`);
      for (const t of ['Achievements', 'Favourite time', 'Longest session', 'Best month', 'Game of the year']) assert.equal(await page.locator('.wcard', { hasText: t }).count(), 1, t);
      assert.ok(await page.locator('.wr-eras .chart.erastrip [data-tip]').count() >= 2, 'the eras of the year');
      const tl = await S.ok(`/stats/timeline?range=year:${YEAR}&group=month`);
      assert.equal(await page.locator('.wr-eras .era-row').count(), tl.eras.length, 'a row per era');
      assert.equal(await page.locator('.wr-eras .era-yh').count(), 0, 'one year: no year heads');
      // the axis runs to December: the months still to come are drawn, empty
      const axis = await page.locator('.wr-eras .erastrip svg').evaluate((svg) => ({ w: svg.viewBox.baseVal.width, future: svg.querySelector('.era-future')?.getBBox().width ?? 0 }));
      const later = 12 - Number(tl.era_range.to.slice(5));
      assert.ok(Math.abs(axis.future - (later * axis.w) / 12) < 3, `${later} months still to come on the axis (${JSON.stringify(axis)})`);
      assert.equal(await page.locator('.wr-months span').count(), 12, 'J F M … under the month bars');
      assert.equal(await page.locator('.wr-months i.best').count(), 1, 'the best month marked');
      const ach = await S.ok(`/stats/achievements?range=year:${YEAR}`);
      assert.equal(await page.locator('.wcard.wr-ach .big').innerText(), ach.unlocked.toLocaleString());
      await page.locator(`.wr-years a[href="/wrapped/${prev}"]`).click();
      await waitUntil(() => new URL(page.url()).pathname === `/wrapped/${prev}`, { message: 'previous year' });
      await waitView(page);
      assert.equal(await h1(page), `Your ${prev} trail`);
      const wp = await S.ok(`/stats/year/${prev}`);
      assert.equal(await big(), `${Math.round(wp.total_minutes / 60).toLocaleString()} hours`);
      await page.goto(`${S.origin}/wrapped/${YEAR}`);
      await waitView(page);
      await page.locator('.switch:has(#wr-est) > span').click();
      await waitUntil(() => new URL(page.url()).searchParams.get('estimates') === 'exclude', { message: 'estimates=exclude' });
      await waitView(page);
      const wt = await S.ok(`/stats/year/${YEAR}?estimates=exclude`);
      assert.equal(wt.total_minutes, wt.tracked_minutes);
      await waitUntil(async () => (await big()) === `${Math.round(wt.tracked_minutes / 60).toLocaleString()} hours`, { message: 'the headline is tracked play' });
      clean(h);
    } finally { await h.close(); }
  });
});

// ======================================================================== eras with little data
describe('Vestigo web UI, batch 5: eras with one month, a break, and none', UI, () => {
  let S;
  before(async () => { S = await startApp(); });
  after(() => S?.close());

  test('one month of play is one era on the axis; months without play between two are a break; a range without play says so', async () => {
    const solo = await S.ok('/games', { method: 'POST', body: { title: 'Solo Quest' } });
    await S.ok('/sessions', { method: 'POST', body: { game_id: solo.id, minutes: 90, ended_at: NOW - 2 * HOUR } });
    const h = await visit(S, '/insights?range=30d', { viewport: PHONE_SMALL });
    const { page } = h;
    const eras = async () => {
      await page.evaluate(() => document.querySelector('#ins-what').scrollIntoView());
      await page.locator('#ins-what .ins-eras .ins-none, #ins-what .ins-eras .erastrip svg').first().waitFor();
      return page.locator('#ins-what .ins-eras');
    };
    try {
      let card = await eras();
      const tl = await S.ok('/stats/timeline?range=30d');
      assert.equal(tl.eras.length, 1);
      assert.equal(await card.locator('.erastrip .era-b').count(), 1);
      const n = tl.era_range.months;
      assert.match(await card.locator('.erastrip svg').getAttribute('aria-label'), new RegExp(`^1 era in ${n} months?: Solo Quest led `));
      assert.match((await card.locator('.era-row').innerText()).replace(/\s+/g, ' '), /Solo Quest .*1 month 100% of your play · 1h 30m/);
      assert.equal(await card.locator('.era-yh').count(), 0);
      // a game played 70 days ago: a month or two without play between them
      const old = await S.ok('/games', { method: 'POST', body: { title: 'Old Flame' } });
      await S.ok('/sessions', { method: 'POST', body: { game_id: old.id, minutes: 120, ended_at: NOW - 70 * DAY } });
      await page.goto(`${S.origin}/insights?range=365d`);
      await waitView(page);
      card = await eras();
      const rows = (await card.locator('.era-row').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
      assert.equal(rows.length, 3, rows.join(' | '));
      assert.match(rows[1], /^Break · [12] months?, no play/);
      assert.equal(await card.locator('.erastrip .era-break').count(), 1);
      assert.match(await card.locator('.era-legend').innerText(), /No play/);
      const o = await overflow(page, PHONE_SMALL.width);
      assert.ok(o.doc <= PHONE_SMALL.width + 1, `${o.doc}px wide`);
      // nothing in the range
      await page.goto(`${S.origin}/insights?range=year:2001`);
      await waitView(page);
      card = await eras();
      assert.equal(await card.locator('.ins-none').innerText(), 'No months with play in this range.');
      assert.equal(await card.locator('.erastrip').count(), 0);
      clean(h);
    } finally { await h.close(); }
  });
});

// ======================================================================== an empty install
describe('Vestigo web UI, batch 5: first run and empty states', UI, () => {
  let S;
  before(async () => { S = await startApp(); });
  after(() => S?.close());

  test('a fresh install: the checklist with step 1 active and the password step; connecting an account ticks step 1 without a reload', async () => {
    const h = await visit(S, '/');
    const { page } = h;
    try {
      const steps = () => page.locator('#checklist .ck').evaluateAll((els) => els.map((e) => [e.querySelector('b').textContent.trim(), e.classList.contains('done') ? 'done' : e.classList.contains('active') ? 'active' : '']));
      assert.deepEqual(await steps(), [['Connect an account', 'active'], ['First import', ''], ['Review duplicates', ''], ['Date old playtime', ''], ['Protect with a password', '']]);
      assert.equal(await page.locator('#checklist .ck.active').getAttribute('aria-current'), 'step');
      await page.locator('#checklist [data-ck="connect"]').click();
      await page.locator('.modal [data-p="custom"]').click();
      await page.locator('.modal', { hasText: 'Connect Custom' }).waitFor();
      await page.locator('.modal [name=name]').fill('Deck');
      await page.locator('.modal #acc-save').click();
      await waitUntil(async () => (await steps())[0][1] === 'done', { message: 'step 1 ticked' });
      assert.equal(new URL(page.url()).pathname, '/', 'still on Home');
      assert.deepEqual((await steps())[1], ['First import', 'active']);
      assert.match(await page.locator('#checklist .ck-acc').innerText(), /Deck\s*Waiting for the first report/);
      clean(h);
    } finally { await h.close(); }
  });

  test('empty states: Library, Sessions, Stats, Insights and Year in review say what to do next', async () => {
    const h = await openPage(browser, S.origin);
    const { page } = h;
    try {
      for (const [path, title, buttons] of [
        ['/library', 'No tracks yet', ['Connect an account', 'Import CSV / JSON']],
        ['/sessions', 'No sessions yet', ['Log session']],
        ['/stats', 'No play to chart yet', ['Connect an account', 'Log a session']],
        ['/insights', 'No tracks yet', ['Connect an account', 'Import CSV / JSON']],
        [`/wrapped/${YEAR}`, `No tracks in ${YEAR}`, ['Improve history']],
      ]) {
        await page.goto(`${S.origin}${path}`);
        await waitView(page);
        await h.settle();
        const empty = page.locator('#view .empty');
        assert.equal(await empty.locator('h2').innerText(), title, path);
        assert.deepEqual((await empty.locator('.btn').allInnerTexts()).map((x) => x.trim()), buttons, `${path} actions`);
        assert.equal(await empty.locator('svg.em-trail').count(), 1, `${path}: the faded trail`);
        assert.equal(await page.locator('#view .kpi').count(), 0, `${path}: no zero KPIs`);
      }
      clean(h);
    } finally { await h.close(); }
  });
});

// ======================================================================== a large library
// Budget (headroom for a loaded CI machine): with 1,500 games and 50,000 sessions the first screen of
// Library, Sessions, a game and Insights (its first section; the rest load on the way down) within
// 3 s, a palette search within 1.5 s; Insights never asks for every section at once.
describe('Vestigo web UI, batch 5: a large library (1,500 games, 50,000 sessions)', UI, () => {
  let S;
  before(async () => {
    S = await startApp();
    const { db } = S;
    const settings = new Settings(db);
    const now = Date.now();
    for (const [i, platform] of ['steam', 'xbox', 'psn'].entries()) {
      const id = Number(db.prepare('INSERT INTO accounts(platform, name, enabled, created_at) VALUES (?, ?, 0, ?)').run(platform, platform, now - 900 * DAY).lastInsertRowid);
      const items = Array.from({ length: [900, 400, 200][i] }, (_, g) => ({ extId: `${platform}-${g}`, title: `${['Star', 'Dark', 'Hollow', 'Neon', 'Iron'][g % 5]} ${['Knight', 'Saga', 'Drift', 'Arena'][g % 4]} ${platform} ${g}`, playtimeMin: (g * 37) % 4000 }));
      tx(db, () => applyItems(db, parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id)), items, { settings: settings.all(), now: now - 800 * DAY, syncId: null, initial: true }));
    }
    const entries = db.prepare('SELECT id FROM entries').all().map((e) => e.id);
    tx(db, () => {
      const ins = db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at) VALUES (?, 'sync', 'play', ?, ?, ?, ?, ?, ?)");
      let seedN = 7;
      const rnd = () => { seedN = (seedN * 1664525 + 1013904223) >>> 0; return seedN / 4294967296; };
      for (let i = 0; i < 50_000; i++) {
        const end = now - Math.floor(rnd() * 700 * DAY);
        const m = 15 + Math.floor(rnd() * 180);
        const precise = i % 3 === 0;
        ins.run(entries[Math.floor(rnd() ** 2 * entries.length)], m, end - DAY, end, precise ? end - m * 60000 : null, precise ? end : null, end);
      }
    });
    for (const id of entries.slice(0, 300)) {
      storeAchievements(db, id, Array.from({ length: 30 }, (_, k) => ({ id: `A${k}`, name: `Achievement ${k}`, unlocked: k % 3 !== 0, unlocked_at: k % 3 ? now - k * 20 * DAY : null, rarity: (k * 7) % 90 + 0.5 })));
      db.prepare('UPDATE entries SET ach_v = ?, ach_at = ? WHERE id = ?').run(ACH_VERSION, now, id);
    }
    S.app.rebuildRollups();
  });
  after(() => S?.close());

  test('seeded: 1,500 games, 50,000 sessions', async () => {
    assert.equal((await S.ok('/games?limit=1&hidden=all')).total, 1500);
    assert.ok((await S.ok('/sessions?limit=1')).total >= 50_000);
  });

  test('first screens within budget; Insights loads its sections as they come near the screen', async (t) => {
    const h = await openPage(browser, S.origin);
    const { page } = h;
    const requested = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/v1/stats/')) requested.push(u.pathname); });
    const time = async (path, ready) => {
      const t0 = Date.now();
      await page.goto(`${S.origin}${path}`);
      await waitView(page, 15000);
      if (ready) await page.locator(ready).first().waitFor({ timeout: 15000 });
      return Date.now() - t0;
    };
    try {
      const ms = {
        library: await time('/library', '#lib-items .tile'),
        sessions: await time('/sessions', '#s-list .item'),
        game: await time(`/game/${(await S.ok('/games?sort=playtime&limit=1')).items[0].id}`, '#g-sessions .item'),
      };
      requested.length = 0;
      ms.insights = await time('/insights', '#ins-when .chart.punch svg');
      const first = [...requested];
      t.diagnostic(`first screens: ${JSON.stringify(ms)} ms; Insights asked first for ${first.join(', ')}`);
      for (const [k, v] of Object.entries(ms)) assert.ok(v < 3000, `${k}: ${v}ms`);
      assert.ok(!first.some((p) => /library|year-over-year|records/.test(p)), `sections below the fold wait (${first})`);
      await loadAllSections(page);
      assert.match(await page.locator('#ins-library .kpi', { hasText: 'Games' }).innerText(), /1,500/);
      // the palette answers a search quickly
      const t0 = Date.now();
      await page.keyboard.press('Control+k');
      await page.keyboard.type('neon');
      await page.locator('#pal-list [role=option]', { hasText: 'Neon' }).first().waitFor();
      const pal = Date.now() - t0;
      t.diagnostic(`palette search: ${pal}ms`);
      assert.ok(pal < 1500, `palette search: ${pal}ms`);
      clean(h);
    } finally { await h.close(); }
  });
});
