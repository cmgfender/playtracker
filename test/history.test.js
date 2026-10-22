// Ways history dating gets sharper: the player's learned style, Steam's licenses page, trophy /
// capture timestamps, and quick answers on the review page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { allocate, inferHistory, learnStyle, styleOf, STYLE_BINS } from '../src/services/inference.js';
import { parseLicenses } from '../src/services/licenses.js';
import { earnedTimes } from '../src/providers/psn.js';
import { captureTimes, outline } from '../src/providers/xbox.js';

const DAY = 86_400_000;
const NOW = Date.now();
let app; let base;
const quiet = { info() {}, warn() {}, error() {} };

before(async () => {
  app = createApp({ dbFile: ':memory:', password: '', log: quiet, scheduler: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
});
after(() => app.close());

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}

test('allocate keeps a long low-intensity tail spread out instead of moving it to busy days', () => {
  // 10 busy days then 90 quiet days: the quiet period holds most of the minutes
  const weights = Array.from({ length: 100 }, (_, i) => (i < 10 ? 10 : 0.5));
  const alloc = allocate(1000, weights, { cap: 600, minDay: 15 });
  const total = alloc.reduce((a, x) => a + x, 0);
  assert.ok(Math.abs(total - 1000) < 0.01);
  const tail = alloc.slice(10).reduce((a, x) => a + x, 0);
  assert.ok(tail > 300 && tail < 400, `tail keeps its share (${tail})`);
  assert.ok(alloc.every((x) => x === 0 || x >= 15), 'no day below the minimum');
  assert.ok(alloc.slice(10).filter((x) => x > 0).length >= 10, 'tail stays spread over the period');
});

test('learnStyle: needs 3+ usable games and summarises each by size, span and shape', () => {
  const game = (start, days, every) => Array.from({ length: Math.floor(days / every) }, (_, i) => ({ t: start + i * every * DAY, minutes: 60 }));
  assert.equal(learnStyle([game(NOW - 400 * DAY, 60, 2), game(NOW - 300 * DAY, 60, 2)]), null);
  const st = learnStyle([game(NOW - 400 * DAY, 60, 2), game(NOW - 300 * DAY, 90, 3), game(NOW - 200 * DAY, 30, 1), [{ t: NOW, minutes: 10 }]]);
  assert.equal(st.games, 3);
  for (const s of st.samples) {
    assert.equal(s.rel.length, STYLE_BINS);
    assert.ok(Math.abs(s.rel.reduce((a, x) => a + x, 0) - 1) < 0.01);
    assert.ok(Math.abs(s.back.reduce((a, x) => a + x, 0) - 1) < 0.01);
  }
});

test('a learned steady style spreads history evenly over a known window', () => {
  const steady = (start) => Array.from({ length: 40 }, (_, i) => ({ t: start + i * 4 * DAY, minutes: 90 }));
  const style = learnStyle([0, 1, 2, 3, 4, 5, 6, 7].map((k) => steady(NOW - (900 - k * 60) * DAY)));
  const e = { minutes: 3600, trackingStart: NOW, firstPlayedAt: NOW - 400 * DAY, lastPlayedAt: NOW - 240 * DAY };
  const share = (res) => res.chunks.filter((c) => c.start < NOW - 360 * DAY).reduce((a, c) => a + c.minutes, 0) / 3600;
  const plain = share(inferHistory(e));
  const learned = share(inferHistory(e, { style }));
  // the first quarter of the window really holds ~25% for a steady player; 8 games' evidence
  // outweighs the default (front-loaded) shape but does not replace it
  assert.ok(learned < plain - 0.1, `less front-loaded with the steady style (${plain} -> ${learned})`);
  assert.ok(learned < 0.4, `closer to even (${learned})`);
});

test('import of fully tracked games teaches the style and re-dates history', async () => {
  const games = [];
  for (let g = 0; g < 6; g++) {
    const start = NOW - (500 - g * 40) * DAY;
    const sessions = Array.from({ length: 20 }, (_, i) => ({ started_at: new Date(start + i * 5 * DAY).toISOString(), minutes: 60 }));
    games.push({ title: `Tracked ${g}`, platform: 'pc', playtime_minutes: 1200, sessions });
  }
  games.push({ title: 'Old Favourite', platform: 'pc', playtime_minutes: 3000, first_played: new Date(NOW - 700 * DAY).toISOString(), last_played: new Date(NOW - 600 * DAY).toISOString() });
  const res = await call('/import', { method: 'POST', body: { games } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.style_relearned, true);
  const sum = await call('/history/summary');
  assert.equal(sum.data.style.games, 6);
  assert.equal(styleOf(app.app.db).games, 6);
  const fav = app.app.db.prepare("SELECT e.inferred_v, (SELECT SUM(minutes) FROM sessions WHERE entry_id = e.id) m FROM entries e WHERE title = 'Old Favourite'").get();
  assert.equal(fav.m, 3000);
  // turning learning off forgets the style and re-dates again
  await call('/settings', { method: 'PUT', body: { history_learn: false } });
  assert.equal(styleOf(app.app.db), null);
  await call('/settings', { method: 'PUT', body: { history_learn: true } });
  assert.equal(styleOf(app.app.db).games, 6);
});

test('Steam licenses page: parsed in both date formats, matched by title, dates the history', async () => {
  const rows = parseLicenses('Date\tItem\tAcquisition Method\n20 Nov, 2015\tPortal 2\tSteam Store\nMar 3, 2019 Hades Complimentary\n2021-01-05\tHades - Soundtrack\tSteam Store\tRemove\nnot a row');
  assert.deepEqual(rows.map((r) => r.title), ['Portal 2', 'Hades', 'Hades - Soundtrack']);
  assert.equal(new Date(rows[0].date).getFullYear(), 2015);
  assert.equal(new Date(rows[1].date).getMonth(), 2);

  const acc = await call('/accounts', { method: 'POST', body: { platform: 'custom', name: 'Pushed Steam' } });
  const id = acc.data.id;
  await call(`/accounts/${id}/report`, { method: 'POST', body: { games: [
    { id: '620', title: 'Portal 2', playtime_minutes: 900, last_played_at: new Date(NOW - 100 * DAY).toISOString() },
    { id: '1145360', title: 'Hades', playtime_minutes: 1200, last_played_at: new Date(NOW - 50 * DAY).toISOString() },
  ] } });
  const before_ = app.app.db.prepare("SELECT json_extract(hist, '$.inference.confidence') c FROM entries WHERE title = 'Portal 2' AND account_id = ?").get(id).c;
  assert.equal(before_, 'low');
  const lic = await call(`/accounts/${id}/licenses`, { method: 'POST', body: { text: '20 Nov, 2015\tPortal 2 Collector\'s Edition\tRetail\n3 Mar, 2019\tHades\tSteam Store\n3 Mar, 2019\tHades Soundtrack\tSteam Store\n1 Jan, 2014\tSome Bundle\tRetail' } });
  assert.equal(lic.status, 200, JSON.stringify(lic.data));
  assert.equal(lic.data.matched, 2);
  assert.equal(lic.data.unmatched, 1);
  const portal = app.app.db.prepare("SELECT hist FROM entries WHERE title = 'Portal 2' AND account_id = ?").get(id);
  const h = JSON.parse(portal.hist);
  assert.equal(new Date(h.date_added).getFullYear(), 2015);
  assert.equal(h.inference.confidence, 'medium');
  assert.ok(h.inference.window[0] >= h.date_added - DAY);
});

test('review page lists least certain history first; an answer removes it from the list', async () => {
  const rev = await call('/history/review?limit=50');
  assert.equal(rev.status, 200);
  assert.ok(rev.data.items.length >= 1);
  const unc = rev.data.items.map((i) => i.uncertain_minutes);
  assert.deepEqual(unc, [...unc].sort((a, b) => b - a));
  const total = Object.values(rev.data.meter).reduce((a, x) => a + x, 0);
  assert.ok(total > 0);
  const first = rev.data.items[0];
  const r = await call(`/entries/${first.entry_id}/history`, { method: 'PATCH', body: { first_played_at: '2024-04-01T12:00:00', last_played_at: '2024-06-30T20:00:00', mode: 'auto' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after_ = await call('/history/review?limit=50');
  assert.ok(!after_.data.items.some((i) => i.entry_id === first.entry_id));
  assert.ok(after_.data.meter.manual > 0);
});

test('"looks right" keeps the estimate exactly and survives re-dating', async () => {
  const rev = await call('/history/review?limit=50');
  const it = rev.data.items.find((i) => i.window);
  const before_ = app.app.db.prepare("SELECT window_start, window_end, minutes FROM sessions WHERE entry_id = ? AND source = 'inferred' ORDER BY window_start").all(it.entry_id);
  const r = await call(`/entries/${it.entry_id}/history`, { method: 'PATCH', body: { confirm: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after_ = app.app.db.prepare("SELECT window_start, window_end, minutes, confidence FROM sessions WHERE entry_id = ? AND source = 'inferred' ORDER BY window_start").all(it.entry_id);
  assert.deepEqual(after_.map(({ confidence, ...x }) => x), before_.map((x) => ({ ...x })));
  assert.ok(after_.filter((x) => x.window_start).every((x) => x.confidence === 'high'));
  assert.ok(!(await call('/history/review?limit=50')).data.items.some((i) => i.entry_id === it.entry_id));
  // a later full re-date keeps it inside the confirmed window, still high confidence
  await call('/history/reinfer', { method: 'POST' });
  const h = JSON.parse(app.app.db.prepare('SELECT hist FROM entries WHERE id = ?').get(it.entry_id).hist);
  assert.equal(h.inference.confidence, 'high');
  assert.equal(h.inference.reasons[0], 'You confirmed this estimate');
  assert.ok(h.inference.window[0] >= it.window[0] - 86_400_000 && h.inference.window[1] <= it.window[1]);
});

test('PSN trophy and Xbox capture payloads yield timestamps', () => {
  assert.deepEqual(earnedTimes({ trophies: [
    { earned: true, earnedDateTime: '2021-05-01T10:00:00Z' }, { earned: false }, { earned: true, earnedDateTime: 'bad' },
  ] }), [Date.parse('2021-05-01T10:00:00Z')]);
  const m = captureTimes({ values: [
    { titleId: 219630713, captureDate: '2022-02-02T20:00:00Z' }, { titleId: '219630713', dateRecorded: '2022-03-02T20:00:00Z' },
    { titleId: 1, dateTaken: '2001-01-01T00:00:00Z' }, { contentId: 'x' },
  ] });
  assert.deepEqual(m.get('219630713'), [Date.parse('2022-02-02T20:00:00Z'), Date.parse('2022-03-02T20:00:00Z')]);
  assert.equal(m.has('1'), false);
  // outline for diagnostics: shape and stat names only, never values
  const o = outline({ groups: [{ statlistscollection: [{ stats: [{ name: 'Kills', value: '42' }] }] }], statlistscollection: [] });
  assert.deepEqual(o.keys, ['groups', 'statlistscollection']);
  assert.deepEqual(o.stat_names, ['Kills']);
  assert.ok(!JSON.stringify(o).includes('42'));
});
