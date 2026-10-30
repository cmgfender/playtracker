// Vestigo web UI, end to end: the Stats page's comparison with the previous period, highlights,
// bars that open their sessions and platform rows that filter; Insights' How you play; Home's
// Last week; Settings' automatic backups (back up now, the list, delete) and the weekly summary
// preview; System's backup line. On the demo library, in a database file (backups need one).
// Run: node --disable-warning=ExperimentalWarning --test test/suite/ui-e2e-stats-backups.test.js
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chromium, installFetchGuard, startApp, openPage, waitView, waitUntil, toast, overflow, DESKTOP, PHONE_SMALL, skipReason,
} from './helpers/ui-e2e-harness.js';
import { seedDemo } from '../../src/demo.js';

const UI = { skip: skipReason || false };

describe('Stats, Insights, Home recap, backups', UI, () => {
  let browser; let guard; let S; let dir;
  before(async () => {
    if (skipReason) return;
    guard = installFetchGuard();
    browser = await chromium.launch();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-ui-bk-'));
    S = await startApp({ dbFile: path.join(dir, 'vestigo.db') });
    seedDemo(S.db, { now: Date.now() });
  });
  after(async () => {
    await browser?.close();
    guard?.restore();
    S?.close();
  });

  async function visit(url, viewport = DESKTOP) {
    const h = await openPage(browser, S.origin, { viewport });
    await h.page.goto(`${S.origin}${url}`);
    await waitView(h.page);
    return h;
  }
  const clean = (h) => {
    assert.deepEqual(h.rec.pageErrors, [], 'no uncaught page errors');
    assert.deepEqual(h.unexpectedConsole([]), [], 'no unexpected console errors');
  };

  test('Stats: change vs the previous period, highlights, a bar opens its sessions, a platform row filters', async () => {
    const want = await S.ok('/stats?range=90d&compare=true&highlights=true');
    const h = await visit('/stats?range=90d');
    const { page } = h;
    try {
      await page.locator('#st-body .kpis').waitFor();
      const d = page.locator('#st-body .kpi').first().locator('.delta');
      assert.equal(await d.count(), 1, 'Played shows its change');
      const pct = Math.abs(Math.round(((want.total_minutes - want.previous.total_minutes) / want.previous.total_minutes) * 100));
      assert.match(await d.innerText(), new RegExp(`${pct}%|same`));
      assert.match(await d.getAttribute('title'), /^vs the 90 days before: /);
      const hl = page.locator('.card', { has: page.locator('h2', { hasText: 'Highlights' }) });
      assert.match(await hl.innerText(), new RegExp(`ACHIEVEMENTS\\s+${want.highlights.achievements.unlocked}`, 'i'));
      // the 4th bar: its week's sessions
      const bar = page.locator('#st-body .chart.bar').first().locator('.hit.go').nth(3);
      assert.match(await bar.getAttribute('data-tip'), / · see sessions$/);
      await bar.click();
      await waitUntil(() => new URL(page.url()).pathname === '/sessions', { message: 'sessions page' });
      const u = new URL(page.url());
      const from = new Date(`${u.searchParams.get('from')}T12:00`); const to = new Date(`${u.searchParams.get('to')}T12:00`);
      assert.equal(Math.round((to - from) / 86_400_000), 6, 'a week of sessions');
      await page.goBack();
      await waitView(page);
      await page.locator('[data-st-plat]').first().waitFor();
      const first = await page.locator('[data-st-plat]').first().getAttribute('data-st-plat');
      await page.locator('[data-st-plat]').first().click();
      await waitUntil(() => new URL(page.url()).searchParams.get('platform') === first, { message: 'filtered by the platform' });
      assert.equal(await page.locator('#st-plat').inputValue(), first);
      // weekday: average per day, or the total
      const avg = await page.locator('#st-wdrows').innerText();
      await page.locator('#st-wd [data-wd=total]').click();
      assert.notEqual(await page.locator('#st-wdrows').innerText(), avg);
      // This week, from More…
      await page.selectOption('#st-year', 'week');
      await waitUntil(async () => /vs last week, to the same point/.test((await page.locator('#st-body .kpi .delta').first().getAttribute('title')) || ''), { message: 'compared with last week' });
      clean(h);
    } finally { await h.close(); }
  });

  test('Stats: a slow answer for an earlier range never replaces the latest one', async () => {
    const h = await visit('/stats?range=30d');
    const { page } = h;
    try {
      await page.locator('#st-body .kpis').waitFor();
      await page.route('**/api/v1/stats?range=365d*', async (route) => { await new Promise((r) => setTimeout(r, 1200)); await route.continue(); });
      await page.locator('#st-range [data-r="365d"]').click();
      await page.locator('#st-range [data-r="7d"]').click();
      await waitUntil(async () => /vs the 7 days before/.test((await page.locator('#st-body .kpi .delta').first().getAttribute('title')) || ''), { message: '7 days shown' });
      await page.waitForTimeout(1500);
      assert.match(await page.locator('#st-body .kpi .delta').first().getAttribute('title'), /vs the 7 days before/, 'still 7 days after the slow answer');
      clean(h);
    } finally { await h.close(); }
  });

  test('Insights: How you play has focus, staying power, the games started and comebacks', async () => {
    const h = await visit('/insights?range=all');
    const { page } = h;
    try {
      await page.locator('[data-jump=style]').click();
      const sec = page.locator('#ins-style');
      await sec.locator('.card h3').first().waitFor();
      assert.deepEqual(await sec.locator('.card h3').allInnerTexts(), ['Focus', 'Staying power', 'Games you started', 'Comebacks']);
      const s = await S.ok('/stats/style?range=all');
      assert.match(await sec.locator('.ins-lead').first().innerText(), new RegExp(`^(Focused|Balanced|Varied): .*${s.focus.games_per_week} games a week`));
      clean(h);
    } finally { await h.close(); }
  });

  test('Home: Last week, as the weekly summary has it', async () => {
    const w = await S.ok('/summary/week');
    const h = await visit('/');
    const { page } = h;
    try {
      const card = page.locator('.card.recap');
      await card.waitFor();
      assert.equal(await card.locator('h2').innerText(), 'Last week');
      assert.equal(await card.locator('.card-h a').getAttribute('href'), `/sessions?from=${w.week.start_day}&to=${w.week.end_day}`);
      assert.equal(await card.locator('.kpi').nth(1).locator('.value').innerText(), String(w.sessions));
      assert.deepEqual((await card.locator('.hbar .ellipsis').allInnerTexts()).map((x) => x.trim()), w.top_games.map((g) => g.title));
      clean(h);
    } finally { await h.close(); }
  });

  test('Settings: back up now, the list of backups, delete one; the weekly summary preview', async () => {
    const h = await visit('/settings#backups');
    const { page } = h;
    try {
      const box = page.locator('#bk-box');
      await box.waitFor();
      assert.match(await box.innerText(), /No backup yet/);
      await page.locator('#bk-now').click();
      await toast(page, 'Backup saved');
      await waitUntil(async () => /Last backup just now/.test(await box.innerText()), { message: 'the last backup is shown' });
      await box.locator('details summary').click();
      const rows = box.locator('.item');
      assert.equal(await rows.count(), 1);
      const name = (await rows.first().locator('.ttl').textContent()).trim();
      assert.match(name, /^vestigo-\d{4}-\d\d-\d\d-\d{6}\.db$/);
      assert.ok(fs.existsSync(path.join(dir, 'backups', name)));
      // the schedule control saves
      await page.locator('[data-seg=backup_mode] [data-v=weekly]').click();
      await waitUntil(async () => (await S.ok('/settings')).backup_mode === 'weekly', { message: 'saved' });
      await page.locator('[data-seg=backup_mode] [data-v=daily]').click();
      await waitUntil(async () => (await S.ok('/settings')).backup_mode === 'daily', { message: 'saved back' });
      // delete
      await rows.first().locator('[data-bk-del]').click();
      await page.locator('.modal button', { hasText: 'Delete' }).click();
      await waitUntil(() => !fs.existsSync(path.join(dir, 'backups', name)), { message: 'deleted' });
      // preview the summary
      await page.locator('#wk-preview').click();
      const pre = page.locator('.modal pre');
      await pre.waitFor();
      assert.match(await pre.innerText(), /^Vestigo · your week \(/);
      await page.locator('.modal [data-close]').first().click();
      clean(h);
    } finally { await h.close(); }
  });

  test('System lists the backups; the new parts fit a 360px phone', async () => {
    await S.ok('/backups', { method: 'POST' });
    const h = await visit('/system');
    try {
      await h.page.locator('.cap-table').first().waitFor();
      assert.match(await h.page.locator('.cap-table').first().innerText(), /Backups\s+last just now/);
      clean(h);
    } finally { await h.close(); }
    // the account dialog's platform grid keeps its own layout (a Stats class once shared its name)
    const a = await visit('/accounts?add=1', PHONE_SMALL);
    try {
      const pp = a.page.locator('.modal .plat-pick');
      await pp.waitFor();
      assert.equal(await pp.evaluate((el) => getComputedStyle(el).display), 'grid');
      assert.ok(await pp.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'every platform fits');
    } finally { await a.close(); }
    for (const url of ['/stats?range=90d', '/insights?range=all', '/', '/settings']) {
      const p = await visit(url, PHONE_SMALL);
      try {
        await p.page.waitForTimeout(400);
        const o = await overflow(p.page, 360);
        assert.ok(o.doc <= o.client && o.body <= 360, `${url} at 360px: ${o.doc}px wide, widest ${JSON.stringify(o.culprit)}`);
      } finally { await p.close(); }
    }
  });
});
