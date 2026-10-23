// Settings, scheduling and observability - black-box suite (README, docs/PLATFORMS.md, OpenAPI).
// Run: node --disable-warning=ExperimentalWarning --test test/suite/settings-system.test.js
import './helpers/settings-system-tz.js'; // must stay first: pins TZ before the app loads
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../src/server.js';
import { createLogger } from '../../src/logger.js';
import { nextRun } from '../../src/services/schedule.js';
import {
  PKG, SILENT, HOUR, DAY, sleep, quietLogger, startApp, brokenTotals, waitFor, installFetchMock,
  steamHandler, xboxHandler, jsonResponse, local, dayKey, hhmm, fmt, localDate, nextDayKey,
  nextLocalTime, withTZ, tmpDir, diagnosticsText,
} from './helpers/settings-system-harness.js';

const MIN = 60_000;
const strip = (s) => { const { schedule_label, next_global_run, ...rest } = s; return rest; };
const fetchMock = installFetchMock();
after(() => fetchMock.restore());

/** Pick a session that lies entirely inside today and ends now (null right after midnight). */
function todaySession(minutes) {
  const now = Date.now();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const room = Math.floor((now - start.getTime()) / MIN) - 1;
  const m = Math.min(minutes, room);
  return m >= 1 ? { minutes: m, ended_at: now } : null;
}

// =====================================================================================
// GET/PUT /settings validation
// =====================================================================================
describe('settings: GET/PUT /api/v1/settings validation', () => {
  let S;
  before(async () => { S = await startApp(); });
  after(() => S?.close());
  const get = async () => (await S.get('/api/v1/settings')).body;
  const put = (b) => S.put('/api/v1/settings', b);
  const KNOWN_GOOD = { schedule_mode: 'daily', schedule_time: '04:00', schedule_every: 2, schedule_weekday: 1, schedule_monthday: 1, stats_estimates: 'include', webhook_on: 'sessions', week_starts_on: 1, min_session_minutes: 2, max_overage_minutes: 15, history_max_day_minutes: 720, history_max_game_day_minutes: 600 };
  const restore = () => put(KNOWN_GOOD);

  /** Every patch must be refused with a 400 that names the field, and must change nothing. */
  async function expectRejected(patches) {
    for (const patch of patches) {
      const before_ = strip(await get());
      const r = await put(patch);
      const key = Object.keys(patch)[0];
      assert.equal(r.status, 400, `${JSON.stringify(patch)} should be rejected, got ${r.status} ${r.text.slice(0, 200)}`);
      assert.match(r.body.error, new RegExp(key), `error for ${JSON.stringify(patch)} should name ${key}`);
      assert.deepEqual(strip(await get()), before_, `${JSON.stringify(patch)} must not change anything`);
    }
  }

  test('defaults follow the documented behaviour and never include secrets', async () => {
    const r = await S.get('/api/v1/settings');
    assert.equal(r.status, 200);
    const s = r.body;
    assert.equal(s.schedule_mode, 'daily', 'README: daily syncs are the default');
    assert.equal(s.min_session_minutes, 2, 'README: minimum session defaults to 2 min');
    assert.equal(s.history_max_game_day_minutes, 600, 'README: each game is capped at 10 hours a day');
    assert.equal(s.history_max_day_minutes, 720, 'README: all games together are capped at 12 hours a day');
    assert.match(s.accent, /^#[0-9a-f]{6}$/i);
    assert.ok(['dark', 'black', 'light', 'auto'].includes(s.theme));
    assert.ok(['include', 'exclude'].includes(s.stats_estimates));
    assert.equal(typeof s.schedule_label, 'string');
    assert.match(s.schedule_label, /daily/i);
    const names = s.dashboard_layout.split(',').map((x) => x.replace(/^-/, ''));
    assert.ok(names.length >= 5 && names.every(Boolean));
    assert.equal(new Set(names).size, names.length, 'every home section listed once');
    for (const k of ['password_hash', 'history_style']) assert.ok(!(k in s), `${k} must not be exposed`);
  });

  test('a partial PUT changes only the keys it names', async () => {
    const before_ = strip(await get());
    const r = await put({ theme: 'light' });
    assert.equal(r.status, 200);
    assert.equal(r.body.theme, 'light');
    assert.deepEqual(strip(await get()), { ...before_, theme: 'light' });
    await put({ theme: before_.theme });
  });

  test('every appearance option is accepted, echoed and persisted', async () => {
    const OPTIONS = {
      theme: ['dark', 'black', 'light', 'auto'], ui_density: ['comfortable', 'compact'], cover_size: ['s', 'm', 'l'],
      cover_titles: ['auto', 'always', 'never'], library_view: ['grid', 'list'], time_format: ['hm', 'decimal'],
      start_page: ['home', 'library', 'sessions', 'stats'], default_library_sort: ['recent', 'playtime', 'title', 'trending', 'added', 'rating'],
      stats_estimates: ['include', 'exclude'], library_hide_unplayed: [true, false],
    };
    const original = await get();
    for (const [k, values] of Object.entries(OPTIONS)) {
      for (const v of values) {
        const r = await put({ [k]: v });
        assert.equal(r.status, 200, `${k}=${v}: ${r.text}`);
        assert.equal(r.body[k], v);
        assert.equal((await get())[k], v, `${k}=${v} persisted`);
      }
      await put({ [k]: original[k] });
    }
  });

  test('invalid enum values are rejected with a 400 naming the field, and nothing is written', async () => {
    const bad = ['neon', '', 42, 'dark; DROP TABLE settings', null];
    const patches = [];
    for (const k of ['theme', 'ui_density', 'cover_size', 'cover_titles', 'library_view', 'time_format', 'start_page', 'default_library_sort']) {
      for (const v of bad) patches.push({ [k]: v });
    }
    patches.push({ stats_estimates: 'sometimes' }, { schedule_mode: 'fortnightly' }, { schedule_mode: 'Daily' }, { schedule_mode: 7 });
    await expectRejected(patches);
    // a patch with one bad field is refused as a whole
    const before_ = strip(await get());
    const r = await put({ theme: before_.theme === 'light' ? 'dark' : 'light', cover_size: 'xl' });
    assert.equal(r.status, 400);
    assert.deepEqual(strip(await get()), before_, 'no partial write');
  });

  test('webhook_on only accepts sessions, always or errors', { todo: 'APP BUG settings-system-1: webhook_on is not validated, any value is stored' }, async () => {
    try {
      await expectRejected([{ webhook_on: 'banana' }, { webhook_on: 'ERRORS' }, { webhook_on: 1 }]);
    } finally { await restore(); }
  });

  test('accent colour must be a #rrggbb colour (no CSS injection)', async () => {
    for (const ok of ['#000000', '#FFFFFF', '#a1B2c3', '#7c5cff']) {
      const r = await put({ accent: ok });
      assert.equal(r.status, 200, ok);
      assert.equal((await get()).accent, ok);
    }
    await expectRejected(['red', '#fff', '#12345', '#1234567', '7c5cff', '#12345g', '#7c5cff;background:url(//x)', ' #7c5cff', '', 'rgb(1,2,3)', null, 0x7c5cff]
      .map((accent) => ({ accent })));
    await put({ accent: '#7c5cff' });
  });

  test('dashboard_layout keeps the chosen order, lists every section once and hides the rest', async () => {
    const all = (await get()).dashboard_layout.split(',').map((x) => x.replace(/^-/, ''));
    const [a, b, c] = all;
    let r = await put({ dashboard_layout: `${c},${a}` });
    assert.equal(r.status, 200, r.text);
    let parts = r.body.dashboard_layout.split(',');
    assert.deepEqual(parts.slice(0, 2), [c, a], 'chosen order first');
    assert.deepEqual([...parts.map((x) => x.replace(/^-/, ''))].sort(), [...all].sort(), 'every section exactly once');
    assert.deepEqual(parts.filter((x) => !x.startsWith('-')), [c, a], 'sections not chosen are hidden');
    assert.equal((await get()).dashboard_layout, r.body.dashboard_layout, 'persisted');
    // hidden markers and whitespace
    r = await put({ dashboard_layout: ` ${b} , -${a} ,${c}` });
    assert.equal(r.status, 200);
    parts = r.body.dashboard_layout.split(',');
    assert.deepEqual(parts.slice(0, 3), [b, `-${a}`, c]);
    // everything hidden is a legal (if empty) home page
    r = await put({ dashboard_layout: '' });
    assert.equal(r.status, 200);
    assert.ok(r.body.dashboard_layout.split(',').every((x) => x.startsWith('-')));
    await expectRejected([`${a},nonsense`, `${a},-${a}`, `${a},${a}`, `--${a}`, '-', 5].map((dashboard_layout) => ({ dashboard_layout })));
    await put({ dashboard_layout: all.join(',') });
  });

  test('schedule settings: every mode is accepted and labelled, boundaries hold, malformed values are refused', async () => {
    const cases = [
      [{ schedule_mode: 'off' }, /manual/i],
      [{ schedule_mode: 'hourly' }, /hour/i],
      [{ schedule_mode: 'hours', schedule_every: 6 }, /6.*hour/i],
      [{ schedule_mode: 'daily', schedule_time: '21:15' }, /21:15/],
      [{ schedule_mode: 'days', schedule_every: 3, schedule_time: '21:15' }, /3.*21:15/],
      [{ schedule_mode: 'weekly', schedule_weekday: 0, schedule_time: '21:15' }, /Sunday.*21:15/],
      [{ schedule_mode: 'weekly', schedule_weekday: 6, schedule_time: '07:05' }, /Saturday.*07:05/],
      [{ schedule_mode: 'monthly', schedule_monthday: 28, schedule_time: '21:15' }, /28.*21:15/],
    ];
    for (const [patch, label] of cases) {
      const r = await put(patch);
      assert.equal(r.status, 200, JSON.stringify(patch));
      assert.match(r.body.schedule_label, label, JSON.stringify(patch));
      for (const [k, v] of Object.entries(patch)) assert.equal(r.body[k], v);
    }
    for (const patch of [{ schedule_time: '00:00' }, { schedule_time: '23:59' }, { schedule_every: 1 }, { schedule_every: 365 }, { schedule_weekday: 0 }, { schedule_weekday: 6 }, { schedule_monthday: 1 }, { schedule_monthday: 28 }]) {
      assert.equal((await put(patch)).status, 200, JSON.stringify(patch));
    }
    await expectRejected([
      ...['24:00', '12:60', '4:00', '0400', 'noon', '12:00:00', ' 04:00', '04:00pm'].map((schedule_time) => ({ schedule_time })),
      ...[0, 366, -1, 'two'].map((schedule_every) => ({ schedule_every })),
      ...[-1, 7].map((schedule_weekday) => ({ schedule_weekday })),
      ...[0, 29, 31].map((schedule_monthday) => ({ schedule_monthday })),
    ]);
    await restore();
  });

  test('an empty or null schedule mode, sync time or estimates mode is refused', { todo: 'APP BUG settings-system-2: "" / null skip validation for schedule_mode, schedule_time and stats_estimates (stored, label becomes empty)' }, async () => {
    try {
      await expectRejected([{ schedule_mode: '' }, { schedule_mode: null }, { schedule_time: '' }, { stats_estimates: '' }]);
    } finally { await restore(); }
  });

  test('fractional schedule numbers are refused', { todo: 'APP BUG settings-system-3: schedule_every / schedule_weekday / schedule_monthday accept fractions (1.5 h runs hourly, weekday 2.5 runs Tuesday)' }, async () => {
    try {
      await expectRejected([{ schedule_every: 1.5 }, { schedule_weekday: 2.5 }, { schedule_monthday: 10.5 }]);
    } finally { await restore(); }
  });

  test('numeric settings: numeric strings are coerced to numbers, text is refused', async () => {
    const r = await put({ min_session_minutes: '7' });
    assert.equal(r.status, 200);
    assert.equal(r.body.min_session_minutes, 7);
    assert.equal(typeof (await get()).min_session_minutes, 'number');
    await expectRejected([{ min_session_minutes: 'abc' }, { history_max_day_minutes: '1e400' }, { max_overage_minutes: 'NaN' }, { week_starts_on: 'monday' }, { schedule_every: {} }]);
    await restore();
  });

  test('numeric settings refuse null, booleans, arrays and empty strings', { todo: 'APP BUG settings-system-4: Number() coercion turns null/""/[] into 0 and true into 1 instead of rejecting them' }, async () => {
    try {
      await expectRejected([{ min_session_minutes: null }, { max_overage_minutes: '' }, { schedule_every: [3] }, { history_max_day_minutes: true }]);
    } finally { await restore(); }
  });

  test('week_starts_on only takes a weekday number 0..6', { todo: 'APP BUG settings-system-5: week_starts_on accepts 9, -1, 7 and 0.5' }, async () => {
    try {
      for (const ok of [0, 1]) assert.equal((await put({ week_starts_on: ok })).status, 200);
      await expectRejected([{ week_starts_on: 9 }, { week_starts_on: 7 }, { week_starts_on: -1 }, { week_starts_on: 0.5 }]);
    } finally { await restore(); }
  });

  test('session detection thresholds cannot be negative', { todo: 'APP BUG settings-system-6: min_session_minutes and max_overage_minutes accept negative values' }, async () => {
    try {
      for (const ok of [{ min_session_minutes: 0 }, { max_overage_minutes: 0 }]) assert.equal((await put(ok)).status, 200);
      await expectRejected([{ min_session_minutes: -5 }, { max_overage_minutes: -1 }]);
    } finally { await restore(); }
  });

  test('history caps must fit in a day (1..1440 minutes)', { todo: 'APP BUG settings-system-7: history caps accept 0 (silently means the default), negatives (all history becomes undated) and >1440' }, async () => {
    try {
      for (const ok of [{ history_max_day_minutes: 1 }, { history_max_day_minutes: 1440 }, { history_max_game_day_minutes: 1 }, { history_max_game_day_minutes: 1440 }]) {
        assert.equal((await put(ok)).status, 200, JSON.stringify(ok));
      }
      await restore();
      await expectRejected([
        { history_max_day_minutes: 0 }, { history_max_day_minutes: -1 }, { history_max_day_minutes: 1441 }, { history_max_day_minutes: 100000 },
        { history_max_game_day_minutes: 0 }, { history_max_game_day_minutes: -100 }, { history_max_game_day_minutes: 5000 },
      ]);
    } finally { await restore(); }
  });

  test('boolean settings accept booleans and their usual spellings and store real booleans', async () => {
    const original = await get();
    for (const k of ['library_hide_unplayed', 'use_recent_on_import', 'auto_merge_titles', 'history_learn']) {
      for (const [v, want] of [[true, true], [false, false], ['true', true], ['false', false], [1, true], [0, false]]) {
        const r = await put({ [k]: v });
        assert.equal(r.status, 200);
        assert.equal(r.body[k], want, `${k}=${JSON.stringify(v)}`);
        assert.equal((await get())[k], want);
      }
      await put({ [k]: original[k] });
    }
  });

  test('boolean settings refuse values that are not booleans', { todo: 'APP BUG settings-system-8: any unrecognised value ("banana", "ture", "yes") silently becomes false' }, async () => {
    const original = await get();
    try {
      await expectRejected([{ auto_merge_titles: 'banana' }, { history_learn: 'ture' }, { use_recent_on_import: 'yes please' }, { library_hide_unplayed: { on: true } }]);
    } finally {
      await put({ auto_merge_titles: original.auto_merge_titles, history_learn: original.history_learn, use_recent_on_import: original.use_recent_on_import, library_hide_unplayed: original.library_hide_unplayed });
    }
  });

  test('unknown keys are ignored, and secrets or internal state cannot be written through settings', async () => {
    const before_ = await get();
    const r = await put({ password_hash: 'scrypt:00:00', history_style: { games: 3 }, rollup_tz: 'Mars/Olympus', not_a_setting: 'x', theme: 'black' });
    assert.ok([200, 400].includes(r.status));
    const s = await get();
    for (const k of ['password_hash', 'history_style', 'not_a_setting']) assert.ok(!(k in s), `${k} must not appear`);
    assert.equal(s.rollup_tz, before_.rollup_tz);
    const auth = (await S.get('/api/v1/auth/status')).body;
    assert.equal(auth.auth_enabled, false, 'a password cannot be planted through /settings');
    assert.equal((await S.get('/api/v1/system')).status, 200, 'still open, no lock-out');
    await put({ theme: before_.theme });
  });

  test('Object.prototype names are not settings and are not stored', { todo: 'APP BUG settings-system-9: "toString", "constructor", "hasOwnProperty", "valueOf" pass the known-key check (`in` sees the prototype) and are persisted and served' }, async () => {
    const T = await startApp();
    try {
      const r = await T.put('/api/v1/settings', { toString: 'x', constructor: 'y', hasOwnProperty: 'z', valueOf: 'w' });
      assert.ok([200, 400].includes(r.status));
      const s = (await T.get('/api/v1/settings')).body;
      for (const k of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
        assert.ok(!Object.prototype.hasOwnProperty.call(s, k), `${k} was stored as a setting`);
      }
      const rows = T.db.prepare("SELECT key FROM settings WHERE key IN ('toString','constructor','hasOwnProperty','valueOf')").all();
      assert.deepEqual(rows, []);
    } finally { T.close(); }
  });

  test('bodies that are not an object change nothing; malformed JSON is a clean 400', async () => {
    const before_ = strip(await get());
    for (const raw of ['[1,2,3]', '"dark"', 'null', '42', 'true']) {
      const r = await S.call('PUT', '/api/v1/settings', raw);
      assert.ok(r.status < 500, `${raw} -> ${r.status}`);
      assert.deepEqual(strip(await get()), before_, `${raw} must not change settings`);
    }
    const r = await S.call('PUT', '/api/v1/settings', '{"theme":');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /json/i);
    assert.deepEqual(strip(await get()), before_);
  });
});

// =====================================================================================
// Settings: persistence and side effects
// =====================================================================================
describe('settings: persistence and effects', () => {
  test('appearance, schedule and layout survive a restart (file database)', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'pt.db');
    try {
      const S1 = await startApp({ dbFile: file });
      const layout = (await S1.get('/api/v1/settings')).body.dashboard_layout.split(',').map((x) => x.replace(/^-/, ''));
      const patch = {
        theme: 'light', accent: '#22d3ee', ui_density: 'compact', cover_size: 'l', cover_titles: 'never', library_view: 'list',
        time_format: 'decimal', start_page: 'stats', default_library_sort: 'title', library_hide_unplayed: true,
        dashboard_layout: [layout[2], `-${layout[0]}`, ...layout.slice(3), layout[1]].join(','),
        schedule_mode: 'weekly', schedule_weekday: 5, schedule_time: '22:45', week_starts_on: 0, min_session_minutes: 5,
      };
      const r = await S1.put('/api/v1/settings', patch);
      assert.equal(r.status, 200, r.text);
      S1.close();
      const S2 = await startApp({ dbFile: file });
      try {
        const s = (await S2.get('/api/v1/settings')).body;
        for (const [k, v] of Object.entries(patch)) assert.deepEqual(s[k], v, k);
        assert.match(s.schedule_label, /Friday.*22:45/);
      } finally { S2.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('stats_estimates decides whether stats include estimated history by default', async () => {
    const S = await startApp();
    try {
      const csv = 'title,platform,playtime_hours,first_played,last_played\nOld Favourite,switch,40,2025-03-01,2025-04-30\n';
      assert.equal((await S.call('POST', '/api/v1/import', csv, { type: 'text/csv' })).status, 200);
      const year = async (q = '') => (await S.get(`/api/v1/stats?range=year:2025${q}`)).body.total_minutes;
      assert.ok(await year() > 0, 'default (include) charts the dated history');
      assert.equal(await year('&estimates=exclude'), 0, 'nothing was tracked');
      assert.equal((await S.put('/api/v1/settings', { stats_estimates: 'exclude' })).status, 200);
      assert.equal(await year(), 0, 'exclude hides estimated history by default');
      assert.ok(await year('&estimates=include') > 0, 'an explicit query still overrides the setting');
      assert.deepEqual(brokenTotals(S.db), []);
    } finally { S.close(); }
  });

  const HISTORY_CSV = 'title,platform,playtime_hours,first_played,last_played\n'
    + 'Alpha Saga,switch,300,2025-03-01,2025-04-29\nBeta Quest,switch,200,2025-03-20,2025-04-28\nGamma Run,switch,50,2025-04-20,2025-04-27\n';

  test('changing the history caps re-dates history without losing or double counting a minute', async () => {
    const S = await startApp();
    try {
      assert.equal((await S.call('POST', '/api/v1/import', HISTORY_CSV, { type: 'text/csv' })).status, 200);
      const list = (await S.get('/api/v1/games?limit=50')).body.items;
      assert.equal(list.length, 3);
      const total0 = (await S.get('/api/v1/stats/lifetime')).body.total_minutes;
      assert.equal(total0, (300 + 200 + 50) * 60);
      const est = async () => (await S.get('/api/v1/stats/lifetime')).body.estimated_minutes;
      const est0 = await est();
      for (const caps of [{ history_max_game_day_minutes: 60, history_max_day_minutes: 90 }, { history_max_game_day_minutes: 600, history_max_day_minutes: 720 }]) {
        const r = await S.put('/api/v1/settings', caps);
        assert.equal(r.status, 200);
        const l = (await S.get('/api/v1/stats/lifetime')).body;
        assert.equal(l.total_minutes, total0, 'lifetime totals never change');
        assert.equal(l.tracked_minutes, 0, 'history is never turned into tracked play');
        assert.equal(l.estimated_minutes + l.baseline_minutes, total0, 'every minute is either dated or undated history');
        for (const g of list) {
          const d = (await S.get(`/api/v1/games/${g.id}`)).body.summary;
          assert.equal(d.estimated_minutes + d.baseline_minutes, d.total_minutes, `${g.title} history adds up`);
        }
        assert.deepEqual(brokenTotals(S.db), []);
      }
      assert.ok(await est() >= est0 - 1, 'restoring the default caps dates at least as much as before');
    } finally { S.close(); }
  });

  test('after lowering the caps no day holds more estimated history than they allow', { todo: 'APP BUG settings-system-10: re-dated history exceeds history_max_game_day_minutes and history_max_day_minutes (e.g. 65 min/game and 95 min/day with caps 60/90)' }, async () => {
    const S = await startApp();
    try {
      assert.equal((await S.call('POST', '/api/v1/import', HISTORY_CSV, { type: 'text/csv' })).status, 200);
      assert.equal((await S.put('/api/v1/settings', { history_max_game_day_minutes: 60, history_max_day_minutes: 90 })).status, 200);
      const all = (await S.get('/api/v1/stats/heatmap?year=2025&estimates=only')).body.days;
      const worstDay = Object.entries(all).sort((a, b) => b[1] - a[1])[0];
      assert.ok(worstDay, 'some history is dated');
      assert.ok(worstDay[1] <= 91, `all games on ${worstDay[0]}: ${worstDay[1]} min > 90`);
      for (const g of (await S.get('/api/v1/games?limit=50')).body.items) {
        const days = (await S.get(`/api/v1/stats/heatmap?year=2025&estimates=only&game_id=${g.id}`)).body.days;
        for (const [d, m] of Object.entries(days)) assert.ok(m <= 61, `${g.title} on ${d}: ${m} min > 60`);
      }
    } finally { S.close(); }
  });

  test('history stays inside the window the file gives (first..last played), also under tight caps', { todo: 'APP BUG settings-system-17: history that does not fit under the caps is dated before first_played (Gamma Run, first played 2025-04-20, is dated 2023-12-16..2024-07-04 with caps 60/90 and from 2025-04-05 with the defaults) instead of staying undated' }, async () => {
    const S = await startApp();
    try {
      assert.equal((await S.call('POST', '/api/v1/import', HISTORY_CSV, { type: 'text/csv' })).status, 200);
      const windows = { 'Alpha Saga': ['2025-03-01', '2025-04-29'], 'Beta Quest': ['2025-03-20', '2025-04-28'], 'Gamma Run': ['2025-04-20', '2025-04-27'] };
      const games = (await S.get('/api/v1/games?limit=50')).body.items;
      const check = async (label) => {
        for (const g of games) {
          const [from, to] = windows[g.title];
          for (const y of [2023, 2024, 2025, 2026]) {
            const days = (await S.get(`/api/v1/stats/heatmap?year=${y}&estimates=only&game_id=${g.id}`)).body.days;
            for (const d of Object.keys(days)) assert.ok(d >= from && d <= to, `${label}: ${g.title} has history on ${d}, outside ${from}..${to}`);
          }
        }
      };
      await check('default caps');
      assert.equal((await S.put('/api/v1/settings', { history_max_game_day_minutes: 60, history_max_day_minutes: 90 })).status, 200);
      await check('caps 60/90');
      assert.deepEqual(brokenTotals(S.db), []);
    } finally { S.close(); }
  });

  test('default_library_sort decides the library order when no sort is asked for', async () => {
    const S = await startApp();
    try {
      for (const [title, minutes] of [['Zeta Long', 100], ['Alpha Short', 10], ['Mid Game', 50]]) {
        const g = (await S.post('/api/v1/games', { title })).body;
        assert.equal((await S.post('/api/v1/sessions', { game_id: g.id, minutes, date: '2025-02-02' })).status, 200);
      }
      const order = async (q = '') => (await S.get(`/api/v1/games${q}`)).body.items.map((g) => g.title);
      await S.put('/api/v1/settings', { default_library_sort: 'title' });
      assert.deepEqual(await order(), ['Alpha Short', 'Mid Game', 'Zeta Long']);
      await S.put('/api/v1/settings', { default_library_sort: 'playtime' });
      assert.deepEqual(await order(), ['Zeta Long', 'Mid Game', 'Alpha Short']);
      assert.deepEqual(await order('?sort=title'), ['Alpha Short', 'Mid Game', 'Zeta Long'], 'an explicit sort wins');
    } finally { S.close(); }
  });

  test('week_starts_on decides where "this week" begins (Monday default)', async () => {
    const S = await startApp();
    try {
      // default Monday: a session on this week's Monday counts, one on the Sunday before does not
      const today = new Date(); today.setHours(12, 0, 0, 0);
      const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
      const sundayBefore = new Date(monday); sundayBefore.setDate(monday.getDate() - 1);
      const g = (await S.post('/api/v1/games', { title: 'Week Boundary' })).body;
      assert.equal((await S.post('/api/v1/sessions', { game_id: g.id, minutes: 60, date: dayKey(monday.getTime()) })).status, 200);
      assert.equal((await S.post('/api/v1/sessions', { game_id: g.id, minutes: 30, date: dayKey(sundayBefore.getTime()) })).status, 200);
      assert.equal((await S.get('/api/v1/summary')).body.week.total_minutes, 60);
      assert.equal((await S.get('/api/v1/widget')).body.week_hours, 1);
    } finally { S.close(); }
  });

  test('week_starts_on = Sunday moves "this week" to start on Sunday', { todo: 'APP BUG settings-system-11: "this week" (summary, widget, stats range=week) always starts on Monday; week_starts_on is ignored' }, async () => {
    const S = await startApp();
    try {
      assert.equal((await S.put('/api/v1/settings', { week_starts_on: 0 })).status, 200);
      const today = new Date(); today.setHours(12, 0, 0, 0);
      const sunday = new Date(today); sunday.setDate(today.getDate() - today.getDay());
      const saturdayBefore = new Date(sunday); saturdayBefore.setDate(sunday.getDate() - 1);
      const g = (await S.post('/api/v1/games', { title: 'Sunday Starter' })).body;
      await S.post('/api/v1/sessions', { game_id: g.id, minutes: 60, date: dayKey(sunday.getTime()) });
      await S.post('/api/v1/sessions', { game_id: g.id, minutes: 30, date: dayKey(saturdayBefore.getTime()) });
      assert.equal((await S.get('/api/v1/summary')).body.week.total_minutes, 60, 'summary week from Sunday');
      assert.equal((await S.get('/api/v1/widget')).body.week_hours, 1, 'widget week from Sunday');
    } finally { S.close(); }
  });
});

// =====================================================================================
// Schedule: next-run computation (service level, process TZ America/New_York)
// =====================================================================================
describe('schedule: next-run computation', () => {
  const cfg = (o) => ({ schedule_mode: 'daily', schedule_every: 2, schedule_time: '04:00', schedule_weekday: 1, schedule_monthday: 1, ...o });
  const run = (o, last, now = last) => nextRun(cfg(o), last, now);
  /** Feed every result back as the next "last sync" (what the scheduler does). */
  const simulate = (o, start, n) => { const out = []; let last = start; for (let i = 0; i < n; i++) { last = run(o, last); out.push(last); } return out; };
  const assertDaily = (runs, time, what) => {
    for (let i = 0; i < runs.length; i++) {
      assert.equal(hhmm(runs[i]), time, `${what}: run ${i} at ${fmt(runs[i])}`);
      if (i) assert.equal(dayKey(runs[i]), nextDayKey(dayKey(runs[i - 1])), `${what}: ${fmt(runs[i - 1])} -> ${fmt(runs[i])} skips or repeats a day`);
    }
  };

  test('the process really runs in America/New_York (sanity)', () => {
    assert.equal(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset(), 300);
    assert.equal(new Date(Date.UTC(2026, 6, 15)).getTimezoneOffset(), 240);
  });

  test('"off" never schedules; a never-synced account is due immediately in every other mode', () => {
    const NOW = local(2026, 6, 15, 13, 7, 9);
    assert.equal(run({ schedule_mode: 'off' }, null, NOW), null);
    assert.equal(run({ schedule_mode: 'off' }, NOW - DAY, NOW), null);
    for (const m of ['hourly', 'hours', 'daily', 'days', 'weekly', 'monthly']) assert.equal(run({ schedule_mode: m }, null, NOW), NOW, m);
  });

  test('hourly and every-N-hours count real elapsed time', () => {
    const L = local(2026, 6, 15, 10, 17, 23);
    assert.equal(run({ schedule_mode: 'hourly' }, L), L + HOUR);
    for (const n of [1, 2, 6, 24, 365]) assert.equal(run({ schedule_mode: 'hours', schedule_every: n }, L), L + n * HOUR, `every ${n} hours`);
  });

  test('daily: later today, tomorrow, exactly at the slot, a late scheduler tick, month and year ends', () => {
    const at = (h, m = 0) => ({ schedule_mode: 'daily', schedule_time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` });
    assert.equal(run(at(4), local(2026, 6, 15, 3, 0)), local(2026, 6, 15, 4, 0), 'slot later today');
    assert.equal(run(at(4), local(2026, 6, 15, 9, 0)), local(2026, 6, 16, 4, 0), 'slot passed -> tomorrow');
    assert.equal(run(at(4), local(2026, 6, 15, 4, 0)), local(2026, 6, 16, 4, 0), 'a run exactly at the slot is not repeated');
    assert.equal(run(at(4), local(2026, 6, 15, 4, 0, 25)), local(2026, 6, 16, 4, 0), 'a run a few seconds late is not repeated');
    assert.equal(run(at(4), local(2026, 6, 30, 9, 0)), local(2026, 7, 1, 4, 0), 'month end');
    assert.equal(run(at(4), local(2026, 12, 31, 23, 59)), local(2027, 1, 1, 4, 0), 'year end');
    assert.equal(run(at(0, 0), local(2026, 6, 15, 0, 0)), local(2026, 6, 16, 0, 0), 'midnight slot');
    assert.equal(run(at(23, 59), local(2026, 2, 28, 23, 59, 30)), local(2026, 3, 1, 23, 59), 'last minute of the day, end of February');
    assert.equal(run(at(12, 0), local(2028, 2, 28, 13, 0)), local(2028, 2, 29, 12, 0), 'leap day');
  });

  test('every N days at a time of day', () => {
    assert.equal(run({ schedule_mode: 'days', schedule_every: 3, schedule_time: '21:15' }, local(2026, 6, 15, 21, 15, 10)), local(2026, 6, 18, 21, 15));
    assert.equal(run({ schedule_mode: 'days', schedule_every: 3, schedule_time: '21:15' }, local(2026, 1, 30, 21, 15, 5)), local(2026, 2, 2, 21, 15), 'over a month end');
    assert.equal(run({ schedule_mode: 'days', schedule_every: 1, schedule_time: '08:00' }, local(2026, 6, 15, 9, 0)), local(2026, 6, 16, 8, 0));
  });

  test('weekly: each weekday (0 = Sunday) at the chosen time', () => {
    const L = local(2026, 6, 15, 12, 0);
    assert.equal(new Date(L).getDay(), 1, 'fixture: 2026-06-15 is a Monday');
    for (let wd = 0; wd < 7; wd++) {
      let want = null;
      for (let i = 0; i <= 7 && !want; i++) { const c = local(2026, 6, 15 + i, 10, 0); if (c > L && new Date(c).getDay() === wd) want = c; }
      assert.equal(run({ schedule_mode: 'weekly', schedule_weekday: wd, schedule_time: '10:00' }, L), want, `weekday ${wd}`);
    }
  });

  test('monthly: day of month, month and year roll-over, February and leap years', () => {
    const m = (md, t = '04:00') => ({ schedule_mode: 'monthly', schedule_monthday: md, schedule_time: t });
    assert.equal(run(m(15), local(2026, 1, 10, 9)), local(2026, 1, 15, 4), 'later this month');
    assert.equal(run(m(15), local(2026, 1, 20, 9)), local(2026, 2, 15, 4), 'next month');
    assert.equal(run(m(15), local(2026, 12, 20, 9)), local(2027, 1, 15, 4), 'next year');
    assert.equal(run(m(28), local(2026, 1, 28, 4, 0, 30)), local(2026, 2, 28, 4), 'day 28 in February');
    assert.equal(run(m(28), local(2028, 1, 28, 5)), local(2028, 2, 28, 4), 'leap year February');
    assert.equal(run(m(1), local(2026, 1, 1, 4, 0, 10)), local(2026, 2, 1, 4), 'day 1');
    const late = run(m(1), local(2026, 1, 31, 23, 0));
    assert.ok(late > local(2026, 1, 31, 23, 0), 'never in the past');
    assert.equal(new Date(late).getDate(), 1);
    assert.equal(hhmm(late), '04:00');
  });

  test('long runs: one sync per period, always at the configured local time (spans two DST years)', () => {
    assertDaily(simulate({ schedule_mode: 'daily', schedule_time: '04:00' }, local(2026, 1, 1, 4), 450), '04:00', 'daily 04:00');
    assertDaily(simulate({ schedule_mode: 'daily', schedule_time: '23:30' }, local(2026, 1, 1, 23, 30), 450), '23:30', 'daily 23:30');
    const weekly = simulate({ schedule_mode: 'weekly', schedule_weekday: 0, schedule_time: '10:15' }, local(2026, 1, 4, 10, 15), 70);
    for (let i = 0; i < weekly.length; i++) {
      assert.equal(new Date(weekly[i]).getDay(), 0);
      assert.equal(hhmm(weekly[i]), '10:15', fmt(weekly[i]));
      const prev = i ? weekly[i - 1] : local(2026, 1, 4, 10, 15);
      assert.ok(Math.abs(weekly[i] - prev - 7 * DAY) <= HOUR, `weekly gap ${fmt(prev)} -> ${fmt(weekly[i])}`);
    }
    const monthly = simulate({ schedule_mode: 'monthly', schedule_monthday: 28, schedule_time: '09:00' }, local(2026, 1, 28, 9), 30);
    monthly.forEach((t, i) => {
      const d = new Date(t);
      assert.equal(d.getDate(), 28);
      assert.equal(hhmm(t), '09:00');
      assert.equal((d.getFullYear() - 2026) * 12 + d.getMonth(), i + 1, `month ${i + 1}: ${fmt(t)}`);
    });
    const twoDays = simulate({ schedule_mode: 'days', schedule_every: 2, schedule_time: '04:00' }, local(2026, 1, 1, 4), 250);
    twoDays.forEach((t, i) => { assert.equal(hhmm(t), '04:00'); if (i) assert.equal(dayKey(t), nextDayKey(nextDayKey(dayKey(twoDays[i - 1])))); });
    const hourly = simulate({ schedule_mode: 'hourly' }, local(2026, 1, 1, 0, 0), 24 * 400);
    hourly.forEach((t, i) => { if (i) assert.equal(t - hourly[i - 1], HOUR); });
  });

  test('DST (America/New_York): wall-clock schedules keep their local time, interval schedules keep real time', () => {
    const daily = { schedule_mode: 'daily', schedule_time: '04:00' };
    let n = run(daily, local(2026, 3, 7, 4));
    assert.equal(n, local(2026, 3, 8, 4), 'spring forward keeps 04:00');
    assert.equal(n - local(2026, 3, 7, 4), 23 * HOUR);
    n = run(daily, local(2026, 10, 31, 4));
    assert.equal(n, local(2026, 11, 1, 4), 'fall back keeps 04:00');
    assert.equal(n - local(2026, 10, 31, 4), 25 * HOUR);
    // hourly through the repeated 01:xx hour: three distinct instants one hour apart
    const h = simulate({ schedule_mode: 'hourly' }, local(2026, 11, 1, 0, 30), 3);
    assert.deepEqual(h.map((t, i) => t - (i ? h[i - 1] : local(2026, 11, 1, 0, 30))), [HOUR, HOUR, HOUR]);
    assert.deepEqual(h.map(hhmm), ['01:30', '01:30', '02:30'], 'the 01:30 hour happens twice, the schedule does not skip it');
    assert.equal(run({ schedule_mode: 'hours', schedule_every: 6 }, local(2026, 3, 7, 23, 0)), local(2026, 3, 7, 23, 0) + 6 * HOUR);
    // the repeated 01:30 on fall-back day: exactly one daily run that day
    assertDaily(simulate({ schedule_mode: 'daily', schedule_time: '01:30' }, local(2026, 10, 28, 1, 30), 8), '01:30', 'daily 01:30 over fall back');
    // weekly and every-2-days across both transitions
    for (const t of simulate({ schedule_mode: 'weekly', schedule_weekday: 0, schedule_time: '04:00' }, local(2026, 3, 1, 4), 40)) assert.equal(hhmm(t), '04:00', fmt(t));
    for (const t of simulate({ schedule_mode: 'days', schedule_every: 2, schedule_time: '04:00' }, local(2026, 3, 6, 4), 140)) assert.equal(hhmm(t), '04:00', fmt(t));
  });

  test('DST gap: a time that does not exist on the change day runs once that day, then returns to its time', { todo: 'APP BUG settings-system-12: after the spring-forward run at 03:30 the next daily/weekly/monthly slot inherits 03:30 instead of 02:30' }, () => {
    // daily 02:30 (does not exist on 2026-03-08 in New York)
    const d = simulate({ schedule_mode: 'daily', schedule_time: '02:30' }, local(2026, 3, 5, 2, 30), 8);
    for (let i = 1; i < d.length; i++) assert.equal(dayKey(d[i]), nextDayKey(dayKey(d[i - 1])), 'one run per day');
    for (const t of d) if (dayKey(t) !== '2026-03-08') assert.equal(hhmm(t), '02:30', `daily ${fmt(t)}`);
    // weekly Sunday 02:30 and monthly day 8 at 02:30
    const w = simulate({ schedule_mode: 'weekly', schedule_weekday: 0, schedule_time: '02:30' }, local(2026, 3, 1, 2, 30), 2);
    assert.equal(dayKey(w[0]), '2026-03-08');
    assert.equal(fmt(w[1]), '2026-03-15 02:30');
    const mo = simulate({ schedule_mode: 'monthly', schedule_monthday: 8, schedule_time: '02:30' }, local(2026, 2, 8, 2, 30), 2);
    assert.equal(dayKey(mo[0]), '2026-03-08');
    assert.equal(fmt(mo[1]), '2026-04-08 02:30');
  });

  test('other time zones: London, Sydney (southern DST), Lord Howe (30-minute DST), Kolkata (no DST)', () => {
    const zones = [
      ['Europe/London', [0, -60]], ['Australia/Sydney', [-660, -600]], ['Australia/Lord_Howe', [-660, -630]], ['Asia/Kolkata', [-330, -330]],
    ];
    for (const [tz, [jan, jul]] of zones) {
      withTZ(tz, () => {
        assert.equal(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset(), jan, `${tz} active (January)`);
        assert.equal(new Date(Date.UTC(2026, 6, 15)).getTimezoneOffset(), jul, `${tz} active (July)`);
        assertDaily(simulate({ schedule_mode: 'daily', schedule_time: '04:00' }, local(2026, 1, 1, 4), 400), '04:00', `${tz} daily 04:00`);
        const h = simulate({ schedule_mode: 'hours', schedule_every: 5 }, local(2026, 1, 1, 0), 2000);
        h.forEach((t, i) => { if (i) assert.equal(t - h[i - 1], 5 * HOUR); });
      });
    }
    assert.equal(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset(), 300, 'TZ restored');
  });
});

// =====================================================================================
// Schedule over the API: global schedule, per-account overrides
// =====================================================================================
describe('schedule: global schedule and per-account overrides (API)', () => {
  let S; let X1; let X2; let P;
  const L = local(2026, 10, 20, 10, 0); // a fixed "last sync": Tuesday 2026-10-20 10:00 New York
  const account = async (id) => (await S.get('/api/v1/accounts')).body.find((a) => a.id === id);
  const patch = (id, b) => S.patch(`/api/v1/accounts/${id}`, b);
  before(async () => {
    S = await startApp();
    X1 = (await S.post('/api/v1/accounts', { platform: 'xbox', name: 'Global follower', config: { api_key: 'xbox-key-global-1', presence: 'off' }, sync: false })).body;
    X2 = (await S.post('/api/v1/accounts', { platform: 'xbox', name: 'Own schedule', config: { api_key: 'xbox-key-own-2', presence: 'off' }, sync: false, schedule: { schedule_mode: 'hours', schedule_every: 6 } })).body;
    P = (await S.post('/api/v1/accounts', { platform: 'custom', name: 'Pusher' })).body;
    for (const a of [X1, X2]) assert.ok(a?.id, 'account created');
    S.db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id IN (?, ?)').run(L, X1.id, X2.id);
    await patch(X1.id, {}); await patch(X2.id, {}); // recompute next runs from the last sync
  });
  after(() => S?.close());

  test('POST /accounts refuses an invalid schedule override and creates nothing', async () => {
    const n0 = (await S.get('/api/v1/accounts')).body.length;
    for (const schedule of [{ schedule_mode: 'every-tuesday' }, { schedule_mode: 'hours', schedule_every: 0 }, { schedule_time: '25:00' }, { schedule_mode: 'weekly', schedule_weekday: 7 }, { schedule_mode: 'monthly', schedule_monthday: 31 }]) {
      const r = await S.post('/api/v1/accounts', { platform: 'xbox', config: { api_key: 'xbox-key-x' }, sync: false, schedule });
      assert.equal(r.status, 400, JSON.stringify(schedule));
      assert.ok(r.body.error);
    }
    assert.equal((await S.get('/api/v1/accounts')).body.length, n0);
  });

  test('a valid override is stored and labelled; accounts without one show the global schedule', async () => {
    const g = (await S.get('/api/v1/settings')).body;
    const a1 = await account(X1.id); const a2 = await account(X2.id);
    assert.equal(a1.schedule, null);
    assert.equal(a1.schedule_label, g.schedule_label);
    assert.equal(a2.schedule.schedule_mode, 'hours');
    assert.equal(a2.schedule.schedule_every, 6);
    assert.match(a2.schedule_label, /6.*hour/i);
    assert.equal(a2.next_sync_at, L + 6 * HOUR);
    assert.equal(a1.next_sync_at, local(2026, 10, 21, 4, 0), 'global daily 04:00 after the last sync');
  });

  test('next_sync_at follows the effective schedule from the last sync', async () => {
    const cases = [
      [{ schedule_mode: 'hourly' }, L + HOUR, /hour/i],
      [{ schedule_mode: 'hours', schedule_every: 12 }, L + 12 * HOUR, /12/],
      [{ schedule_mode: 'daily', schedule_time: '18:30' }, local(2026, 10, 20, 18, 30), /18:30/],
      [{ schedule_mode: 'days', schedule_every: 3, schedule_time: '06:00' }, local(2026, 10, 23, 6, 0), /3.*06:00/],
      [{ schedule_mode: 'weekly', schedule_weekday: 5, schedule_time: '08:00' }, local(2026, 10, 23, 8, 0), /Friday.*08:00/],
      [{ schedule_mode: 'monthly', schedule_monthday: 5, schedule_time: '04:00' }, local(2026, 11, 5, 4, 0), /5.*04:00/],
      [{ schedule_mode: 'off' }, null, /manual/i],
    ];
    for (const [schedule, want, label] of cases) {
      const r = await patch(X1.id, { schedule });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.body.next_sync_at, want, `${JSON.stringify(schedule)}: got ${fmt(r.body.next_sync_at)}, want ${fmt(want)}`);
      assert.match(r.body.schedule_label, label);
      assert.equal((await account(X1.id)).next_sync_at, want, 'persisted');
    }
    const r = await patch(X1.id, { schedule: null });
    assert.equal(r.status, 200);
    assert.equal(r.body.schedule, null, 'override removed');
    assert.equal(r.body.next_sync_at, local(2026, 10, 21, 4, 0), 'back on the global daily 04:00');
  });

  test('invalid PATCH schedules are refused and the current schedule is kept', async () => {
    assert.equal((await patch(X1.id, { schedule: { schedule_mode: 'hourly' } })).status, 200);
    for (const schedule of [{ schedule_mode: 'whenever' }, { schedule_mode: 'hours', schedule_every: 0 }, { schedule_mode: 'hours', schedule_every: 400 }, { schedule_time: '7pm' }, { schedule_weekday: -1 }, { schedule_monthday: 0 }]) {
      const r = await patch(X1.id, { schedule });
      assert.equal(r.status, 400, JSON.stringify(schedule));
      const a = await account(X1.id);
      assert.equal(a.schedule.schedule_mode, 'hourly');
      assert.equal(a.next_sync_at, L + HOUR);
    }
    // the rest of a refused PATCH is not applied either
    const r = await patch(X1.id, { name: 'Renamed?', schedule: { schedule_mode: 'nope' } });
    assert.equal(r.status, 400);
    assert.equal((await account(X1.id)).name, 'Global follower');
    await patch(X1.id, { schedule: null });
  });

  test('changing the global schedule moves every account without an override, and only those', async () => {
    let r = await S.put('/api/v1/settings', { schedule_mode: 'hourly' });
    assert.equal(r.status, 200);
    assert.equal((await account(X1.id)).next_sync_at, L + HOUR);
    assert.equal((await account(X2.id)).next_sync_at, L + 6 * HOUR, 'override wins');
    r = await S.put('/api/v1/settings', { schedule_mode: 'off' });
    assert.equal(r.status, 200);
    assert.equal((await account(X1.id)).next_sync_at, null, 'global off: manual only');
    assert.match((await account(X1.id)).schedule_label, /manual/i);
    assert.equal((await account(X2.id)).next_sync_at, L + 6 * HOUR, 'an account override still syncs when the global schedule is off');
    r = await S.put('/api/v1/settings', { schedule_mode: 'daily', schedule_time: '04:00' });
    assert.equal((await account(X1.id)).next_sync_at, local(2026, 10, 21, 4, 0));
  });

  test('disabled accounts and push (custom) accounts are never scheduled', async () => {
    assert.equal((await patch(X1.id, { enabled: false })).body.next_sync_at, null);
    assert.equal((await patch(X1.id, { enabled: true })).body.next_sync_at, local(2026, 10, 21, 4, 0));
    const p = await account(P.id);
    assert.equal(p.push, true);
    assert.equal(p.next_sync_at, null);
    await S.put('/api/v1/settings', { schedule_mode: 'hourly' });
    assert.equal((await account(P.id)).next_sync_at, null);
    await S.put('/api/v1/settings', { schedule_mode: 'daily', schedule_time: '04:00' });
  });

  test('extra keys in an account override do not leak into the global settings', async () => {
    const g0 = (await S.get('/api/v1/settings')).body;
    const r = await patch(X2.id, { schedule: { schedule_mode: 'hours', schedule_every: 6, theme: 'light', webhook_url: 'https://example.test/hook', min_session_minutes: 99 } });
    assert.ok([200, 400].includes(r.status));
    const g1 = (await S.get('/api/v1/settings')).body;
    assert.deepEqual(strip(g1), strip(g0));
    assert.equal((await account(X2.id)).next_sync_at, L + 6 * HOUR);
  });

  test('GET /settings reports when the global schedule runs next', async () => {
    await S.put('/api/v1/settings', { schedule_mode: 'off' });
    assert.equal((await S.get('/api/v1/settings')).body.next_global_run, null);
    await S.put('/api/v1/settings', { schedule_mode: 'daily', schedule_time: '04:00' });
    let t0 = Date.now();
    let s = (await S.get('/api/v1/settings')).body;
    let t1 = Date.now();
    assert.ok([nextLocalTime(t0, 4, 0), nextLocalTime(t1, 4, 0)].includes(s.next_global_run), `daily: ${fmt(s.next_global_run)}`);
    await S.put('/api/v1/settings', { schedule_mode: 'hourly' });
    t0 = Date.now(); s = (await S.get('/api/v1/settings')).body; t1 = Date.now();
    assert.ok(s.next_global_run >= t0 + HOUR && s.next_global_run <= t1 + HOUR, 'hourly: an hour from now');
    await S.put('/api/v1/settings', { schedule_mode: 'daily', schedule_time: '04:00' });
  });
});

// =====================================================================================
// Provider failures: error log, sync history, System page, webhooks, presence, secrets
// =====================================================================================
describe('observability: provider failures, presence and secrets', () => {
  let S;
  const KEYS = {
    revoked: 'STEAMREVOKEDKEY0123456789ABCDEF01',
    gone: 'STEAMGONEKEY0123456789ABCDEFAB02',
    flaky: 'STEAMFLAKYKEY0123456789ABCDEFAB03',
    live: 'STEAMLIVEKEY0123456789ABCDEFABC04',
    xbox: 'XBOXRATELIMITEDKEY0123456789XYZ05',
    npsso: 'NPSSOSECRETTOKEN0123456789ABCDEF06',
    psnAccess: 'PSNACCESSTOKENSECRET0123456789AB07',
    psnRefresh: 'PSNREFRESHTOKENSECRET0123456789A08',
  };
  const PLAYER = { steamid: '76561197960287930', communityvisibilitystate: 3, personaname: 'Tester', timecreated: 1262304000 };
  const steamKeys = {
    [KEYS.revoked]: { status: 403, body: '<html><head><title>Forbidden</title></head><body>Verify your key= parameter</body></html>' },
    [KEYS.gone]: { status: 404, body: 'Not Found' },
    [KEYS.flaky]: { networkOn: 'GetOwnedGames', player: PLAYER },
    [KEYS.live]: { player: { ...PLAYER }, games: [{ appid: 620, name: 'Portal 2', playtime_forever: 0 }, { appid: 400, name: 'Portal', playtime_forever: 0 }] },
  };
  const hooks = { mode: 200, received: [] };
  const steam = steamHandler(steamKeys);
  const xbox = xboxHandler({ [KEYS.xbox]: 'ratelimit' });
  const ids = {};
  const sys = async () => (await S.get('/api/v1/system')).body;
  const sysAcc = async (id) => (await sys()).accounts.find((a) => a.id === id);
  const callsFor = (key) => fetchMock.state.calls.filter((c) => c.url.includes(key)).length;
  const steamAccount = async (name, key) => (await S.post('/api/v1/accounts', { platform: 'steam', name, config: { api_key: key, steam_id: PLAYER.steamid, presence: 'off' }, sync: false })).body.id;

  before(async () => {
    fetchMock.state.handler = async (u, call) => {
      if (u.hostname === 'hooks.example.test') {
        hooks.received.push({ url: call.url, body: JSON.parse(call.body) });
        return new Response('', { status: hooks.mode });
      }
      return (await steam(u, call)) || (await xbox(u, call));
    };
    S = await startApp({ log: quietLogger() });
    ids.revoked = await steamAccount('Revoked', KEYS.revoked);
    ids.gone = await steamAccount('Gone', KEYS.gone);
    ids.flaky = await steamAccount('Flaky', KEYS.flaky);
  });
  after(() => { S?.close(); fetchMock.state.handler = null; });

  test('a Steam auth failure fails the sync cleanly, blames the credentials and is logged as an error', async () => {
    const t0 = Date.now();
    const s0 = await sys();
    const r = await S.post(`/api/v1/accounts/${ids.revoked}/sync?wait=true`);
    assert.equal(r.status, 502, 'upstream failure is a bad gateway, not a crash');
    assert.match(r.body.error, /403|forbidden|credential/i);
    const sync = (await S.get(`/api/v1/syncs?account_id=${ids.revoked}`)).body[0];
    assert.equal(sync.status, 'error');
    assert.ok(sync.finished_at >= sync.started_at);
    assert.ok(sync.details.api.calls >= 1);
    const a = (await S.get('/api/v1/accounts')).body.find((x) => x.id === ids.revoked);
    assert.equal(a.last_status, 'error');
    assert.match(a.last_error, /credential/i);
    const logs = (await S.get('/api/v1/logs?level=error')).body.items;
    const entry = logs.find((l) => /Revoked/.test(l.message));
    assert.ok(entry, 'the failure is in the error log');
    assert.match(entry.source, /^sync/);
    assert.ok(entry.time >= t0);
    const s1 = await sys();
    assert.equal(s1.errors_24h, s0.errors_24h + 1);
    assert.equal(s1.http.errors, s0.http.errors + 1, 'counted as a failed request');
    const acc = s1.accounts.find((x) => x.id === ids.revoked);
    assert.equal(acc.failed_syncs_7d, 1);
    assert.equal(acc.last_sync.status, 'error');
    assert.equal(acc.last_sync.trigger, 'manual');
    assert.equal(acc.api_usage_24h.calls, callsFor(KEYS.revoked), 'every API call is counted');
    assert.equal(acc.api_usage_24h.errors, callsFor(KEYS.revoked));
    assert.equal((await S.get('/api/v1/summary')).body.errors_24h, s1.errors_24h, 'dashboard warning matches the System page');
    const metrics = await (await fetch(`${S.root}/metrics`)).text();
    assert.match(metrics, new RegExp(`playtracker_account_last_sync_seconds\\{id="${ids.revoked}",platform="steam",status="error"\\} \\d+`));
    assert.equal(s1.counts.entries, 0, 'nothing was imported');
    assert.deepEqual(brokenTotals(S.db), []);
  });

  test('a non-auth upstream error is recorded without blaming the credentials', async () => {
    const r = await S.post(`/api/v1/accounts/${ids.gone}/sync?wait=true`);
    assert.equal(r.status, 502);
    const a = await sysAcc(ids.gone);
    assert.equal(a.last_status, 'error');
    assert.match(a.last_error, /404/);
    assert.doesNotMatch(a.last_error, /credential/i);
    assert.ok((await S.get('/api/v1/logs?level=error&q=Gone')).body.items.length >= 1);
  });

  test('a network failure is retried, then recorded and logged', async () => {
    const before_ = fetchMock.state.calls.filter((c) => c.url.includes('GetOwnedGames') && c.url.includes(KEYS.flaky)).length;
    const r = await S.post(`/api/v1/accounts/${ids.flaky}/sync?wait=true`);
    assert.equal(r.status, 502);
    assert.match(r.body.error, /network|api\.steampowered\.com/i);
    const attempts = fetchMock.state.calls.filter((c) => c.url.includes('GetOwnedGames') && c.url.includes(KEYS.flaky)).length - before_;
    assert.ok(attempts >= 2, `retried (${attempts} attempts)`);
    const a = await sysAcc(ids.flaky);
    assert.equal(a.last_status, 'error');
    assert.ok(a.api_usage_24h.errors >= attempts);
    assert.ok((await S.get('/api/v1/logs?level=error&q=Flaky')).body.items.length >= 1);
  });

  test('a rate limit pauses the account until the quota resets instead of failing it', async () => {
    const t0 = Date.now();
    const s0 = await sys();
    ids.xbox = (await S.post('/api/v1/accounts', { platform: 'xbox', name: 'Limited', config: { api_key: KEYS.xbox, presence: 'off' }, sync: false })).body.id;
    const r = await S.post(`/api/v1/accounts/${ids.xbox}/sync?wait=true`);
    assert.equal(r.status, 429);
    const sync = (await S.get(`/api/v1/syncs?account_id=${ids.xbox}`)).body[0];
    assert.equal(sync.status, 'warning', 'a paused quota is not a failed sync');
    const a = await sysAcc(ids.xbox);
    assert.equal(a.last_status, 'warning');
    assert.equal(a.failed_syncs_7d, 0);
    assert.equal(a.hourly_limit, 150, 'docs: 150 requests an hour on the free plan');
    assert.equal(a.api_quota.limit, 150);
    assert.equal(a.api_quota.remaining, 0);
    assert.ok(a.api_quota.blockedUntil > t0 + 25 * MIN && a.api_quota.blockedUntil <= Date.now() + 70 * MIN, 'paused until the reported reset');
    assert.ok(a.next_sync_at >= a.api_quota.blockedUntil, 'never scheduled before the quota resets');
    assert.ok(a.api_usage_24h.rate_limited >= 1);
    const s1 = await sys();
    assert.equal(s1.errors_24h, s0.errors_24h, 'not an error');
    assert.ok(s1.warnings_24h > s0.warnings_24h);
    assert.ok((await S.get('/api/v1/logs?level=warn&q=Rate%20limited')).body.items.length >= 1);
  });

  test('webhooks: errors-only, sessions and always modes; credentials never in the payload; delivery failures are logged', async () => {
    const push = (await S.post('/api/v1/accounts', { platform: 'custom', name: 'Hook Pusher' })).body.id;
    const report = (min) => S.post(`/api/v1/accounts/${push}/report`, { games: [{ id: 'hk', title: 'Hook Game', playtime_minutes: min }] });
    assert.equal((await report(100)).status, 200);
    assert.equal((await S.put('/api/v1/settings', { webhook_url: 'https://hooks.example.test/pt', webhook_on: 'errors' })).status, 200);
    let n = hooks.received.length;
    await S.post(`/api/v1/accounts/${ids.revoked}/sync?wait=true`);
    await waitFor(() => hooks.received.length > n, { timeout: 3000, what: 'error webhook' });
    const sent = hooks.received.at(-1).body;
    assert.equal(sent.event, 'sync.failed');
    assert.match(sent.error, /403|forbidden/i);
    assert.ok(!JSON.stringify(sent).includes(KEYS.revoked), 'no API key in the webhook');
    n = hooks.received.length;
    const r = await report(110);
    assert.equal(r.body.sessions_created, 1);
    await sleep(100);
    assert.equal(hooks.received.length, n, 'errors-only: a successful sync sends nothing');
    await S.put('/api/v1/settings', { webhook_on: 'sessions' });
    await report(110); await sleep(100);
    assert.equal(hooks.received.length, n, 'sessions mode: a sync without new sessions sends nothing');
    await report(120);
    await waitFor(() => hooks.received.length === n + 1, { timeout: 3000, what: 'sessions webhook' });
    assert.equal(hooks.received.at(-1).body.event, 'sync.completed');
    await S.put('/api/v1/settings', { webhook_on: 'always' });
    await report(120);
    await waitFor(() => hooks.received.length === n + 2, { timeout: 3000, what: 'always webhook' });
    hooks.mode = 500;
    await report(120);
    await waitFor(async () => (await S.get('/api/v1/logs?level=warn&q=Webhook')).body.items.length > 0, { timeout: 3000, what: 'webhook failure warning' });
    hooks.mode = 200;
    await S.put('/api/v1/settings', { webhook_url: '', webhook_on: 'sessions' });
    assert.deepEqual(brokenTotals(S.db), []);
  });

  test('presence checks show on the System page; failures are counted, logged once, and cleared', async () => {
    const t0 = Date.now();
    const firstCall = fetchMock.state.calls.length;
    ids.live = (await S.post('/api/v1/accounts', { platform: 'steam', name: 'Live', config: { api_key: KEYS.live, steam_id: PLAYER.steamid }, sync: false })).body.id;
    assert.equal((await S.post(`/api/v1/accounts/${ids.live}/sync?wait=true`)).status, 200);
    const spec = steamKeys[KEYS.live];
    spec.player = { ...PLAYER, gameid: '620', gameextrainfo: 'Portal 2' };
    const poll = () => S.app.sync.pollPresence(S.app.sync.account(ids.live));
    await poll();
    let p = (await sysAcc(ids.live)).presence;
    assert.equal(p.enabled, true);
    assert.equal(p.interval_sec, 120);
    assert.ok(p.last_poll >= t0);
    assert.equal(p.failures, 0);
    assert.equal(p.error, null);
    const playing = (await S.get('/api/v1/now-playing')).body;
    assert.ok(playing.some((x) => x.account_id === ids.live && /Portal 2/.test(x.title)), 'playing now');
    spec.status = 403;
    await poll(); await poll(); await poll();
    p = (await sysAcc(ids.live)).presence;
    assert.equal(p.failures, 3);
    assert.match(p.error, /403/);
    const warns = (await S.get('/api/v1/logs?source=presence')).body.items.filter((l) => /Live/.test(l.message));
    assert.equal(warns.length, 1, 'repeated failures do not flood the log');
    delete spec.status;
    spec.player = { ...PLAYER, communityvisibilitystate: 1 };
    await poll();
    p = (await sysAcc(ids.live)).presence;
    assert.equal(p.failures, 0, 'recovered');
    assert.match(p.error, /private/i, 'a private profile is explained');
    const acc = await sysAcc(ids.live);
    // this account is the only one talking to Steam during this test (library, cover art, presence)
    const steamCalls = fetchMock.state.calls.slice(firstCall).filter((c) => /steampowered\.com$/.test(c.u.hostname)).length;
    assert.equal(acc.api_usage_24h.calls, steamCalls, 'every call, presence included, is counted');
    assert.deepEqual(brokenTotals(S.db), []);
  });

  test('diagnostics (System page bundle, logs, syncs, accounts, metrics) never contain credentials or tokens', async () => {
    const psn = (await S.post('/api/v1/accounts', { platform: 'psn', name: 'PS5', config: { npsso: KEYS.npsso }, sync: false })).body.id;
    S.db.prepare('UPDATE accounts SET state = ? WHERE id = ?').run(JSON.stringify({ access_token: KEYS.psnAccess, refresh_token: KEYS.psnRefresh, access_expires_at: Date.now() + HOUR, refresh_expires_at: Date.now() + 30 * DAY }), psn);
    const token = (await S.post('/api/v1/tokens', { name: 'diag' })).body.token;
    assert.match(token, /^pt_/);
    S.app.log.scoped('test').info('console line written after all accounts exist');
    const text = await diagnosticsText(S);
    const secrets = [...Object.values(KEYS), token];
    for (const s of secrets) {
      assert.ok(!text.includes(s), `secret ${s.slice(0, 6)}… leaked`);
      assert.ok(!text.includes(s.slice(0, 14)), `a large piece of ${s.slice(0, 6)}… leaked`);
    }
    for (const a of (await sys()).accounts) {
      for (const k of ['api_key', 'npsso']) if (a.config[k] !== undefined) assert.match(a.config[k], /^•+[^•]{0,4}$/, `${a.name} ${k} masked`);
    }
  });
});

// =====================================================================================
// Error log: /api/v1/logs
// =====================================================================================
describe('error log: /api/v1/logs', () => {
  let S; let log;
  before(async () => { S = await startApp({ log: quietLogger() }); log = S.app.log; });
  after(() => S?.close());
  const items = async (q = '') => (await S.get(`/api/v1/logs${q}`)).body.items;
  const msgs = async (q = '') => (await items(q)).map((x) => x.message);
  const clear = async () => assert.equal((await S.del('/api/v1/logs')).status, 200);

  test('only warnings and errors are stored; info and debug only reach the console', async () => {
    await clear();
    const t = log.scoped('test');
    t.debug('dbg-marker'); t.info('info-marker'); t.warn('warn-marker', { n: 1 }); t.error('err-marker', new Error('kaboom'));
    const list = await items();
    assert.deepEqual(list.map((x) => x.message), ['err-marker', 'warn-marker'], 'newest first, warn+error only');
    assert.deepEqual(list.map((x) => x.level), ['error', 'warn']);
    assert.equal(list[0].source, 'test');
    assert.match(list[0].stack, /kaboom/, 'stack trace kept');
    assert.deepEqual(list[1].context, { n: 1 });
    const consoleLines = (await S.get('/api/v1/system')).body.console.join('\n');
    assert.match(consoleLines, /info-marker/);
    assert.match(consoleLines, /err-marker/);
  });

  test('filters: level, source prefix, text in message or context, since, combinations and limits', async () => {
    await clear();
    const sync = log.scoped('sync');
    sync.warn('Alpha warning', { account_id: 7 });
    sync.error('Beta failed');
    await sleep(15);
    const mid = Date.now();
    await sleep(15);
    log.scoped('presence').warn('Gamma presence');
    log.scoped('api').error('Delta api', { path: '/x/needle' });
    sync.child('child').warn('Epsilon child');
    assert.deepEqual(await msgs('?level=error'), ['Delta api', 'Beta failed']);
    assert.deepEqual(await msgs('?level=warn'), ['Epsilon child', 'Gamma presence', 'Alpha warning']);
    assert.equal((await msgs('?level=warn,error')).length, 5);
    assert.deepEqual(await msgs('?source=sync'), ['Epsilon child', 'Beta failed', 'Alpha warning'], 'source prefix includes sub-sources');
    assert.deepEqual(await msgs('?source=presence'), ['Gamma presence']);
    assert.deepEqual(await msgs('?q=needle'), ['Delta api'], 'search looks into the context');
    assert.deepEqual(await msgs('?q=BETA'), ['Beta failed'], 'search is case-insensitive');
    assert.deepEqual(await msgs('?level=warn&source=sync'), ['Epsilon child', 'Alpha warning'], 'filters combine');
    assert.deepEqual(await msgs(`?since=${mid}`), ['Epsilon child', 'Delta api', 'Gamma presence']);
    assert.deepEqual(await msgs(`?since=${encodeURIComponent(new Date(mid).toISOString())}`), ['Epsilon child', 'Delta api', 'Gamma presence'], 'ISO since');
    assert.deepEqual(await msgs(`?q=${encodeURIComponent("' OR 1=1 --")}`), [], 'search input is data, not SQL');
    assert.deepEqual(await msgs('?level=nonsense'), []);
    const all = await items();
    for (const [q, ok] of [['?limit=0', (n) => n >= 1], ['?limit=-5', (n) => n >= 1], ['?limit=abc', (n) => n === 5], ['?limit=5000', (n) => n === 5], ['?limit=2', (n) => n === 2]]) {
      const r = await S.get(`/api/v1/logs${q}`);
      assert.equal(r.status, 200, q);
      assert.ok(ok(r.body.items.length), `${q}: ${r.body.items.length}`);
    }
    assert.deepEqual((await S.get('/api/v1/logs')).body.counts_24h, { warn: 3, error: 2 });
    // keyset paging walks everything exactly once
    const seen = [];
    let cursor = '';
    for (let i = 0; i < 10; i++) {
      const r = (await S.get(`/api/v1/logs?limit=2${cursor}`)).body;
      seen.push(...r.items.map((x) => x.id));
      if (!r.items.length) { assert.equal(r.next, null); break; }
      cursor = `&before=${r.next}`;
    }
    assert.deepEqual(seen, all.map((x) => x.id));
  });

  test('search treats % and _ literally', { todo: 'APP BUG settings-system-13: /logs?q= is passed into LIKE unescaped, so % and _ act as wildcards' }, async () => {
    await clear();
    const t = log.scoped('test');
    t.warn('progress 50 items done'); t.warn('quota at 50% now'); t.warn('file_name missing'); t.warn('filename missing');
    assert.deepEqual(await msgs(`?q=${encodeURIComponent('50%')}`), ['quota at 50% now']);
    assert.deepEqual(await msgs(`?q=${encodeURIComponent('file_name')}`), ['file_name missing']);
  });

  test('huge messages are stored truncated, never rejected', async () => {
    await clear();
    log.scoped('test').warn('x'.repeat(5000), { size: 'small' });
    const r = await S.get('/api/v1/logs');
    assert.equal(r.status, 200);
    const m = r.body.items[0].message;
    assert.ok(m.length >= 100 && m.length <= 5000 && /^x+$/.test(m), `stored (${m.length} chars)`);
  });

  test('a warning with a very large context does not break the error log', { todo: 'APP BUG settings-system-14: the logger cuts context JSON at 20000 chars, GET /logs then JSON.parses it and answers 500 for the whole log' }, async () => {
    await clear();
    log.scoped('test').warn('big context', { blob: 'y'.repeat(30000) });
    const r = await S.get('/api/v1/logs');
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(r.body.items.find((x) => x.message === 'big context')?.level, 'warn');
  });

  test('the 24-hour error counters only count the last 24 hours; the log keeps older entries', async () => {
    await clear();
    S.db.prepare('INSERT INTO logs(time, level, source, message) VALUES (?, ?, ?, ?)').run(Date.now() - 25 * HOUR, 'error', 'sync', 'yesterday-error');
    log.scoped('sync').error('fresh-error');
    log.scoped('sync').warn('fresh-warning');
    assert.deepEqual((await msgs()).sort(), ['fresh-error', 'fresh-warning', 'yesterday-error']);
    const s = (await S.get('/api/v1/system')).body;
    assert.equal(s.errors_24h, 1);
    assert.equal(s.warnings_24h, 1);
    assert.equal(s.counts.logs, 3);
    assert.deepEqual((await S.get('/api/v1/logs')).body.counts_24h, { error: 1, warn: 1 });
    assert.equal((await S.get('/api/v1/summary')).body.errors_24h, 1);
  });

  test('clearing the log empties it everywhere', async () => {
    log.scoped('test').error('to be cleared');
    assert.ok((await S.get('/api/v1/system')).body.errors_24h >= 1);
    await clear();
    const r = (await S.get('/api/v1/logs')).body;
    assert.deepEqual(r.items, []);
    assert.deepEqual(r.counts_24h, {});
    assert.equal(r.next, null);
    const s = (await S.get('/api/v1/system')).body;
    assert.equal(s.errors_24h, 0);
    assert.equal(s.warnings_24h, 0);
    assert.equal(s.counts.logs, 0);
    assert.equal((await S.get('/api/v1/summary')).body.errors_24h, 0);
  });

  test('recent console output is on the System page, newest last and bounded', async () => {
    for (let i = 0; i < 120; i++) log.scoped('test').info(`console-line-${i}`);
    const lines = (await S.get('/api/v1/system')).body.console;
    assert.ok(lines.length <= 120 && lines.length >= 20, `${lines.length} lines`);
    assert.match(lines.at(-1), /console-line-119/);
    assert.ok(!lines.some((l) => /console-line-0\b/.test(l)), 'old lines roll off');
  });

  test('LOG_FORMAT=json makes console lines structured JSON', async () => {
    process.env.LOG_FORMAT = 'json';
    let lg;
    try { lg = createLogger({ quiet: true }); } finally { delete process.env.LOG_FORMAT; }
    const T = await startApp({ log: lg });
    try {
      lg.scoped('sync').warn('json-marker', { account_id: 3 });
      const line = (await T.get('/api/v1/system')).body.console.at(-1);
      const e = JSON.parse(line);
      assert.equal(e.level, 'warn');
      assert.equal(e.source, 'sync');
      assert.equal(e.message, 'json-marker');
      assert.deepEqual(e.ctx, { account_id: 3 });
      assert.ok(!Number.isNaN(Date.parse(e.time)));
    } finally { T.close(); }
  });

  test('PLAYTRACKER_LOG_FILE writes plain text and rotates', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'logs', 'playtracker.log');
    process.env.PLAYTRACKER_LOG_FILE = file;
    let lg;
    try { lg = createLogger({ quiet: true, maxFileBytes: 4096 }); } finally { delete process.env.PLAYTRACKER_LOG_FILE; }
    try {
      for (let i = 0; i < 100; i++) lg.scoped('test').warn(`file-line-${i} ${'z'.repeat(60)}`);
      const cur = fs.readFileSync(file, 'utf8');
      assert.match(cur, /file-line-99/);
      assert.ok(!cur.includes('\x1b['), 'no colour codes in the file');
      assert.ok(fs.existsSync(`${file}.1`), 'rotated');
      assert.ok(fs.statSync(file).size <= 4096 + 200, 'bounded');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('entries older than 30 days are pruned on start; recent ones survive a restart', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'pt.db');
    try {
      const S1 = await startApp({ dbFile: file, log: quietLogger() });
      const ins = S1.db.prepare('INSERT INTO logs(time, level, source, message) VALUES (?, ?, ?, ?)');
      const now = Date.now();
      ins.run(now - 45 * DAY, 'error', 'sync', 'old-marker 45d');
      ins.run(now - 31 * DAY, 'warn', 'sync', 'old-marker 31d');
      S1.app.log.scoped('sync').error('recent-marker error');
      S1.app.log.scoped('sync').warn('recent-marker warn');
      S1.close();
      const S2 = await startApp({ dbFile: file, log: quietLogger() });
      try {
        const all = (await S2.get('/api/v1/logs?limit=1000')).body.items.map((x) => x.message);
        assert.ok(!all.some((m) => m.startsWith('old-marker')), 'older than 30 days: gone');
        assert.deepEqual(all.filter((m) => m.startsWith('recent-marker')).sort(), ['recent-marker error', 'recent-marker warn']);
      } finally { S2.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// =====================================================================================
// /system diagnostics
// =====================================================================================
describe('system: /api/v1/system', () => {
  let S;
  before(async () => { S = await startApp({ log: quietLogger() }); });
  after(() => S?.close());

  test('versions, runtime, time zone, storage and auth', async () => {
    const t0 = Date.now();
    const r = await S.get('/api/v1/system');
    assert.equal(r.status, 200);
    const s = r.body;
    assert.equal(s.version, PKG.version);
    assert.equal(s.node, process.version);
    assert.equal(s.tz, 'America/New_York');
    assert.equal(s.tz_env, 'America/New_York');
    assert.ok(Number.isInteger(s.uptime_s) && s.uptime_s >= 0);
    assert.ok(s.started_at <= t0);
    assert.equal(s.data_dir, null, 'in-memory database');
    assert.ok(s.memory_mb > 0 && s.heap_mb > 0);
    assert.equal(s.auth_enabled, false);
    for (const k of ['requests', 'errors', 'client_errors', 'slow']) assert.ok(Number.isInteger(s.http[k]), k);
    assert.ok(Array.isArray(s.accounts) && Array.isArray(s.console));
  });

  test('a file database reports its path and size', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'pt.db');
    try {
      const T = await startApp({ dbFile: file });
      try {
        const s = (await T.get('/api/v1/system')).body;
        assert.equal(s.data_dir, file);
        assert.ok(s.db_bytes > 0);
      } finally { T.close(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('counts reflect the library and agree with the stats', async () => {
    const g1 = (await S.post('/api/v1/games', { title: 'Counted One' })).body;
    const g2 = (await S.post('/api/v1/games', { title: 'Counted Two' })).body;
    for (const [g, m] of [[g1, 30], [g1, 45], [g2, 20]]) assert.equal((await S.post('/api/v1/sessions', { game_id: g.id, minutes: m, date: '2025-06-10' })).status, 200);
    const csv = 'title,platform,playtime_hours,first_played,last_played\nCounted History,switch,20,2025-01-05,2025-02-20\n';
    assert.equal((await S.call('POST', '/api/v1/import', csv, { type: 'text/csv' })).status, 200);
    const push = (await S.post('/api/v1/accounts', { platform: 'custom', name: 'Counter' })).body.id;
    await S.post(`/api/v1/accounts/${push}/report`, { games: [{ id: 'cnt', title: 'Counted Pushed', playtime_minutes: 300 }] });
    await S.post(`/api/v1/accounts/${push}/report`, { games: [{ id: 'cnt', title: 'Counted Pushed', playtime_minutes: 310 }] });
    await S.post(`/api/v1/accounts/${push}/presence`, { playing: [{ id: 'cnt', title: 'Counted Pushed' }] });
    const c = (await S.get('/api/v1/system')).body.counts;
    const l = (await S.get('/api/v1/stats/lifetime')).body;
    assert.equal(c.games, 4);
    assert.equal(c.entries, 4);
    assert.equal(c.sessions_tracked, 4, '3 manual + 1 from the second report');
    assert.equal(c.sessions_tracked, l.sessions);
    assert.ok(c.sessions_estimated >= 1, 'imported history is dated');
    assert.ok(c.snapshots >= 2, 'each report is a snapshot');
    assert.ok(c.presence_spans >= 1);
    assert.equal(c.rollup_queue, 0, 'nothing left unaggregated');
    assert.ok(c.rollup_rows >= 3);
    assert.equal(l.total_minutes, 95 + 1200 + 310);
    assert.deepEqual(brokenTotals(S.db), []);
  });

  test('per-account health: push accounts and Xbox hourly limits', async () => {
    const push = (await S.post('/api/v1/accounts', { platform: 'custom', name: 'Health Push' })).body.id;
    await S.post(`/api/v1/accounts/${push}/report`, { games: [{ id: 'h1', title: 'Health Game', playtime_minutes: 10 }] });
    const x1 = (await S.post('/api/v1/accounts', { platform: 'xbox', name: 'Free plan', config: { api_key: 'xbox-health-1', presence: 'off' }, sync: false })).body.id;
    const x2 = (await S.post('/api/v1/accounts', { platform: 'xbox', name: 'Paid plan', config: { api_key: 'xbox-health-2', hourly_limit: '300', presence: 'off' }, sync: false })).body.id;
    const accs = (await S.get('/api/v1/system')).body.accounts;
    const p = accs.find((a) => a.id === push);
    assert.equal(p.push, true);
    assert.equal(p.next_sync_at, null);
    assert.equal(p.last_sync.status, 'ok');
    assert.equal(p.last_sync.trigger, 'api');
    assert.equal(p.failed_syncs_7d, 0);
    assert.deepEqual(p.api_usage_hour, { calls: 0, errors: 0, rate_limited: 0 });
    assert.equal(p.api_usage_24h.calls, 0);
    assert.equal(p.hourly_limit, null);
    assert.equal(p.presence.enabled, true);
    assert.equal(accs.find((a) => a.id === x1).hourly_limit, 150);
    assert.equal(accs.find((a) => a.id === x2).hourly_limit, 300);
    assert.equal(accs.find((a) => a.id === x1).last_sync, null, 'never synced');
    for (const a of accs) assert.ok(a.capabilities && typeof a.capabilities.rate_limit === 'string', `${a.name} capabilities`);
  });

  test('request counters: client errors and requests are counted', async () => {
    const s0 = (await S.get('/api/v1/system')).body.http;
    assert.equal((await S.put('/api/v1/settings', { theme: 'neon' })).status, 400);
    const s1 = (await S.get('/api/v1/system')).body.http;
    assert.equal(s1.client_errors, s0.client_errors + 1);
    assert.equal(s1.errors, s0.errors);
    assert.ok(s1.requests >= s0.requests + 2);
  });
});

// =====================================================================================
// Access control of observability endpoints
// =====================================================================================
describe('access: health, status and diagnostics with a password', () => {
  const PW = 'correct-horse-battery-staple';
  let S; let cookie; let token; let tokenId;
  before(async () => {
    S = await startApp({ password: PW });
    const r = await fetch(`${S.root}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) });
    assert.equal(r.status, 200);
    cookie = r.headers.get('set-cookie').split(';')[0];
    const t = (await S.post('/api/v1/tokens', { name: 'homepage' }, { headers: { cookie } })).body;
    token = t.token; tokenId = t.id;
  });
  after(() => S?.close());

  test('health, auth status and the OpenAPI document are public; everything else needs credentials', async () => {
    assert.equal((await S.get('/api/v1/health')).status, 200);
    const st = (await S.get('/api/v1/auth/status')).body;
    assert.equal(st.auth_enabled, true);
    assert.equal(st.authenticated, false);
    assert.equal(st.password_source, 'env');
    assert.equal((await S.get('/api/openapi.json')).status, 200);
    for (const p of ['/api/v1/system', '/api/v1/logs', '/api/v1/settings', '/api/v1/widget', '/api/v1/syncs', '/api/v1/summary']) assert.equal((await S.get(p)).status, 401, p);
    assert.equal((await S.del('/api/v1/logs')).status, 401);
    assert.equal((await S.put('/api/v1/settings', { theme: 'light' })).status, 401);
    assert.notEqual((await S.get('/api/v1/settings', { headers: { cookie } })).body.theme, 'light', 'unauthenticated write had no effect');
    assert.equal((await fetch(`${S.root}/metrics`)).status, 401);
  });

  test('API tokens open /metrics, /widget and /system; wrong or revoked tokens do not', async () => {
    const T = await S.post('/api/v1/tokens', { name: 'temp' }, { headers: { cookie } });
    const temp = T.body.token;
    for (const headers of [{ authorization: `Bearer ${token}` }, { 'x-api-key': token }]) {
      assert.equal((await fetch(`${S.root}/metrics`, { headers })).status, 200);
      assert.equal((await S.get('/api/v1/widget', { headers })).status, 200);
      assert.equal((await S.get('/api/v1/system', { headers })).status, 200);
    }
    assert.equal((await fetch(`${S.root}/metrics?api_key=${encodeURIComponent(token)}`)).status, 200);
    assert.equal((await fetch(`${S.root}/metrics`, { headers: { cookie } })).status, 200, 'a logged-in browser can read metrics');
    const st = (await S.get('/api/v1/auth/status', { headers: { authorization: `Bearer ${token}` } })).body;
    assert.equal(st.authenticated, true);
    assert.equal(st.via, 'token');
    assert.equal((await fetch(`${S.root}/metrics`, { headers: { authorization: 'Bearer pt_not-a-real-token' } })).status, 401);
    assert.equal((await fetch(`${S.root}/metrics`, { headers: { authorization: `Bearer ${temp}` } })).status, 200);
    assert.equal((await S.del(`/api/v1/tokens/${T.body.id}`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${S.root}/metrics`, { headers: { authorization: `Bearer ${temp}` } })).status, 401, 'revoked');
    assert.equal((await S.get('/api/v1/widget', { headers: { authorization: `Bearer ${temp}` } })).status, 401, 'revoked');
  });

  test('neither the password nor full tokens appear in diagnostics', async () => {
    const text = await diagnosticsText(S, { headers: { authorization: `Bearer ${token}` } });
    assert.ok(!text.includes(PW), 'password leaked');
    assert.ok(!text.includes(token), 'token leaked');
    const listed = (await S.get('/api/v1/tokens', { headers: { cookie } })).body.find((t) => t.id === tokenId);
    assert.ok(listed && token.startsWith(listed.prefix) && listed.prefix.length < token.length / 2, 'only a short prefix is listed');
  });

  test('a password set in the UI is stored hashed and never served back', async () => {
    const T = await startApp();
    try {
      const secret = 'ui-password-123';
      const r = await fetch(`${T.root}/api/v1/auth/password`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: secret }) });
      assert.equal(r.status, 200);
      const c = r.headers.get('set-cookie').split(';')[0];
      assert.equal((await T.get('/api/v1/system')).status, 401, 'now locked');
      const s = await T.get('/api/v1/settings', { headers: { cookie: c } });
      assert.equal(s.status, 200);
      assert.ok(!('password_hash' in s.body));
      const text = await diagnosticsText(T, { headers: { cookie: c } });
      assert.ok(!text.includes(secret));
      assert.ok(!/scrypt/i.test(text), 'no password hash');
      assert.equal((await T.get('/api/v1/auth/status')).body.password_source, 'settings');
    } finally { T.close(); }
  });
});

// =====================================================================================
// /metrics (Prometheus)
// =====================================================================================
describe('metrics: /metrics', () => {
  let S;
  before(async () => { S = await startApp(); });
  after(() => S?.close());
  const scrape = async () => {
    const r = await fetch(`${S.root}/metrics`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    assert.match(r.headers.get('content-type'), /version=0\.0\.4/);
    return r.text();
  };
  const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\.)*"(?:,[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\.)*")*\})? (-?(?:\d+(?:\.\d+)?(?:e[+-]?\d+)?|NaN|\+Inf|-Inf))$/;
  function parse(text) {
    assert.ok(text.endsWith('\n'), 'ends with a newline');
    const samples = new Map(); const types = new Map();
    for (const line of text.split('\n').filter(Boolean)) {
      if (line.startsWith('#')) {
        const m = /^# (HELP|TYPE) ([a-zA-Z_:][a-zA-Z0-9_:]*) (.+)$/.exec(line);
        assert.ok(m, `bad comment line: ${line}`);
        if (m[1] === 'TYPE') { assert.ok(!types.has(m[2]), `duplicate TYPE ${m[2]}`); assert.ok(['gauge', 'counter', 'histogram', 'summary', 'untyped'].includes(m[3])); types.set(m[2], m[3]); }
        continue;
      }
      const m = SAMPLE.exec(line);
      assert.ok(m, `bad sample line: ${line}`);
      const key = m[1] + (m[2] || '');
      assert.ok(!samples.has(key), `duplicate series ${key}`);
      samples.set(key, Number(m[3]));
    }
    return { samples, types };
  }

  test('an empty install exposes well-formed zero metrics', async () => {
    const { samples, types } = parse(await scrape());
    for (const n of ['playtracker_playtime_minutes_total', 'playtracker_tracked_minutes_total', 'playtracker_sessions_total', 'playtracker_games_total']) {
      assert.equal(samples.get(n), 0, n);
      assert.equal(types.get(n), 'gauge');
    }
  });

  test('values match the lifetime totals, per platform and per account, and follow every change', async () => {
    const g = (await S.post('/api/v1/games', { title: 'Metric Game' })).body;
    await S.post('/api/v1/sessions', { game_id: g.id, minutes: 40, date: '2025-05-05' });
    await S.call('POST', '/api/v1/import', 'title,platform,playtime_hours\nMetric Import,switch,5\n', { type: 'text/csv' });
    const push = (await S.post('/api/v1/accounts', { platform: 'custom', name: 'Metric Push' })).body.id;
    await S.post(`/api/v1/accounts/${push}/report`, { games: [{ id: 'm1', title: 'Metric Pushed', playtime_minutes: 100 }] });
    const check = async () => {
      const { samples } = parse(await scrape());
      const l = (await S.get('/api/v1/stats/lifetime')).body;
      assert.equal(samples.get('playtracker_playtime_minutes_total'), l.total_minutes);
      assert.equal(samples.get('playtracker_tracked_minutes_total'), l.tracked_minutes);
      assert.equal(samples.get('playtracker_sessions_total'), l.sessions);
      assert.equal(samples.get('playtracker_games_total'), l.games);
      const perPlatform = [...samples].filter(([k]) => k.startsWith('playtracker_playtime_minutes{'));
      assert.equal(perPlatform.reduce((a, [, v]) => a + v, 0), l.total_minutes, 'platforms add up to the total');
      for (const p of l.platforms) assert.equal(samples.get(`playtracker_playtime_minutes{platform="${p.platform}"}`), p.minutes);
      const accounts = (await S.get('/api/v1/accounts')).body;
      for (const a of accounts) {
        const k = [...samples.keys()].find((x) => x.startsWith(`playtracker_account_last_sync_seconds{id="${a.id}",`));
        assert.ok(k, `account ${a.id} exported`);
        assert.equal(samples.get(k), Math.floor((a.last_sync_at || 0) / 1000));
      }
      return { samples, l };
    };
    const first = await check();
    assert.equal(first.l.total_minutes, 40 + 300 + 100);
    await S.post('/api/v1/sessions', { game_id: g.id, minutes: 45, date: '2025-05-06' });
    const second = await check();
    assert.equal(second.samples.get('playtracker_playtime_minutes_total'), first.samples.get('playtracker_playtime_minutes_total') + 45, 'no stale cache');
    assert.equal(second.samples.get('playtracker_sessions_total'), first.samples.get('playtracker_sessions_total') + 1);
    // an excluded duplicate entry leaves the totals
    const entry = (await S.get(`/api/v1/games/${g.id}`)).body.entries[0];
    assert.equal((await S.patch(`/api/v1/entries/${entry.id}`, { excluded: true })).status, 200);
    const third = await check();
    assert.equal(third.samples.get('playtracker_playtime_minutes_total'), second.samples.get('playtracker_playtime_minutes_total') - 85);
    assert.deepEqual(brokenTotals(S.db), []);
  });
});

// =====================================================================================
// /widget
// =====================================================================================
describe('widget: /api/v1/widget', () => {
  const FLAT = ['today_hours', 'week_hours', 'lifetime_hours', 'games', 'sessions', 'streak_days', 'top_game_week', 'last_played'];
  const assertFlat = (w) => {
    for (const k of FLAT) assert.ok(k in w, `${k} present`);
    for (const [k, v] of Object.entries(w)) {
      assert.ok(v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)), `${k} is a flat value (${JSON.stringify(v)})`);
    }
  };

  test('an empty install answers zeros and nulls', async () => {
    const S = await startApp();
    try {
      const w = (await S.get('/api/v1/widget')).body;
      assertFlat(w);
      assert.deepEqual(w, { today_hours: 0, week_hours: 0, lifetime_hours: 0, games: 0, sessions: 0, streak_days: 0, top_game_week: null, last_played: null });
    } finally { S.close(); }
  });

  test('tracked play: today, this week, lifetime, streak, top game and last played', async (t) => {
    const today = todaySession(90);
    if (!today) return t.skip('within two minutes of local midnight');
    const S = await startApp();
    try {
      const hero = (await S.post('/api/v1/games', { title: 'Widget Hero' })).body;
      const side = (await S.post('/api/v1/games', { title: 'Side Quest' })).body;
      assert.equal((await S.post('/api/v1/sessions', { game_id: side.id, minutes: 30, date: localDate(-1) })).status, 200);
      assert.equal((await S.post('/api/v1/sessions', { game_id: hero.id, ...today })).status, 200);
      await S.post('/api/v1/sessions', { game_id: side.id, minutes: 600, date: '2024-01-10' });
      const w = (await S.get('/api/v1/widget')).body;
      assertFlat(w);
      assert.equal(w.today_hours, +(today.minutes / 60).toFixed(1));
      const monday = new Date(); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      const yesterdayInWeek = new Date(`${localDate(-1)}T12:00:00`).getTime() >= monday.getTime();
      assert.equal(w.week_hours, +((today.minutes + (yesterdayInWeek ? 30 : 0)) / 60).toFixed(1));
      assert.equal(w.lifetime_hours, Math.round((today.minutes + 630) / 60));
      assert.equal(w.games, 2);
      assert.equal(w.sessions, 3);
      assert.equal(w.streak_days, 2, 'played yesterday and today');
      assert.equal(w.last_played, 'Widget Hero');
      if (!(yesterdayInWeek && today.minutes === 30)) assert.equal(w.top_game_week, yesterdayInWeek && today.minutes < 30 ? 'Side Quest' : 'Widget Hero');
    } finally { S.close(); }
  });

  test('today and this week count tracked play only, never estimated history', { todo: 'APP BUG settings-system-15: /widget computes today/week with estimates included, so imported history shows up as play today/this week and as top_game_week' }, async (t) => {
    const today = todaySession(90);
    if (!today) return t.skip('within two minutes of local midnight');
    const S = await startApp();
    try {
      const csv = `title,platform,playtime_hours,first_played,last_played\nImported Epic,switch,3,${localDate(0)},${localDate(0)}\n`;
      assert.equal((await S.call('POST', '/api/v1/import', csv, { type: 'text/csv' })).status, 200);
      assert.ok((await S.get('/api/v1/stats?range=week&estimates=only')).body.total_minutes > 0, 'precondition: history dated into this week');
      const g = (await S.post('/api/v1/games', { title: 'Really Played' })).body;
      await S.post('/api/v1/sessions', { game_id: g.id, ...today });
      const w = (await S.get('/api/v1/widget')).body;
      const summary = (await S.get('/api/v1/summary')).body;
      assert.equal(summary.today.total_minutes, today.minutes, 'dashboard KPI: tracked only');
      assert.equal(w.today_hours, +(today.minutes / 60).toFixed(1));
      assert.equal(w.week_hours, +(today.minutes / 60).toFixed(1));
      assert.equal(w.top_game_week, 'Really Played');
    } finally { S.close(); }
  });
});

// =====================================================================================
// Health, routing and the OpenAPI document
// =====================================================================================
describe('api: health, routing and /api/openapi.json', () => {
  let S;
  before(async () => { S = await startApp(); });
  after(() => S?.close());

  test('health check: version, time and time zone; HEAD works; other methods are refused', async () => {
    const t0 = Date.now();
    const r = await S.get('/api/v1/health');
    const t1 = Date.now();
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.version, PKG.version);
    assert.ok(r.body.time >= t0 && r.body.time <= t1);
    assert.equal(r.body.tz, 'America/New_York');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const h = await fetch(`${S.root}/api/v1/health`, { method: 'HEAD' });
    assert.equal(h.status, 200);
    assert.equal((await h.text()).length, 0);
    for (const m of ['POST', 'PUT', 'DELETE']) {
      const x = await S.call(m, '/api/v1/health', m === 'DELETE' ? undefined : {});
      assert.equal(x.status, 405, m);
      assert.ok(x.body.error);
    }
  });

  test('unknown API paths are a JSON 404; malformed paths a 400; nothing crashes', async () => {
    for (const p of ['/api/v1/nope', '/api/v1/system/extra', '/api/v2/health', '/api/']) {
      const r = await S.get(p);
      assert.equal(r.status, 404, p);
      assert.equal(r.body.error, 'Not found');
    }
    const bad = await S.get('/api/v1/games/%E0%A4%A');
    assert.ok([400, 404].includes(bad.status));
    assert.equal((await S.get('/api/v1/health')).status, 200, 'still serving');
  });

  test('the OpenAPI document lists every route with its methods and path parameters', async () => {
    const r = await S.get('/api/openapi.json');
    assert.equal(r.status, 200);
    const doc = r.body;
    assert.match(doc.openapi, /^3\./);
    assert.equal(doc.info.version, PKG.version);
    assert.ok(doc.components?.securitySchemes && Object.keys(doc.components.securitySchemes).length);
    const routes = S.app.router.routes.filter((x) => !x.doc.hidden);
    let ops = 0;
    for (const [p, methods] of Object.entries(doc.paths)) {
      for (const [m, op] of Object.entries(methods)) {
        ops++;
        assert.ok(op.summary, `${m} ${p} has a summary`);
        assert.ok(op.responses && op.responses[200], `${m} ${p} has responses`);
        for (const name of [...p.matchAll(/\{(\w+)\}/g)].map((x) => x[1])) {
          assert.ok(op.parameters.some((q) => q.name === name && q.in === 'path' && q.required), `${m} ${p} declares {${name}}`);
        }
      }
    }
    for (const rt of routes) {
      const p = rt.path.replace(/:(\w+)/g, '{$1}');
      assert.ok(doc.paths[p]?.[rt.method.toLowerCase()], `${rt.method} ${rt.path} missing from the OpenAPI document`);
    }
    assert.equal(ops, routes.length, 'no undocumented or phantom operations');
    // the endpoints the README advertises
    for (const p of ['games', 'games/{id}', 'games/{id}/merge', 'entries/{id}', 'sessions', 'sessions/bulk', 'stats', 'stats/heatmap', 'stats/year/{year}', 'duplicates', 'accounts', 'accounts/{id}/sync', 'accounts/{id}/report', 'syncs', 'settings', 'tokens', 'import', 'export', 'backup', 'logs', 'system', 'widget', 'health']) {
      assert.ok(doc.paths[`/api/v1/${p}`], `README endpoint ${p}`);
    }
  });

  test('every documented operation is actually served (no 404/405 from the router)', async () => {
    const T = await startApp();
    try {
      const doc = (await T.get('/api/openapi.json')).body;
      for (const [p, methods] of Object.entries(doc.paths)) {
        const url = p.replace('{year}', '2025').replace(/\{\w+\}/g, '999999');
        for (const m of Object.keys(methods)) {
          const r = await T.call(m.toUpperCase(), url, ['get', 'delete'].includes(m) ? undefined : {});
          assert.notEqual(r.status, 405, `${m} ${p}`);
          assert.ok(!(r.status === 404 && r.body?.error === 'Not found'), `${m} ${p} is documented but not routed`);
          assert.ok(r.status < 500, `${m} ${url} -> ${r.status} ${r.text.slice(0, 120)}`);
        }
      }
    } finally { T.close(); }
  });
});

// =====================================================================================
// The background scheduler (scheduler: true). Runs last: its first tick is after ~5 s.
// =====================================================================================
describe('scheduler: background sync timer', { concurrency: true }, () => {
  // SyncService arms a 20 s cover-lookup timer that close() does not cancel (bug 16 below);
  // point it at an empty stand-in database so it cannot crash this test process after close.
  const defuse = (inst) => { inst.app.sync.db = { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({}) }) }; };

  test('due accounts are synced on schedule; off, disabled, push, not-due and backing-off accounts are left alone', async () => {
    const xk = { 'xbox-sched-due': 'ok', 'xbox-sched-off': 'ok', 'xbox-sched-disabled': 'ok', 'xbox-sched-hourly': 'ok', 'xbox-sched-backoff': 'forbidden' };
    fetchMock.state.handler = xboxHandler(xk);
    const firstCall = fetchMock.state.calls.length;
    const S = await startApp({ scheduler: true, log: quietLogger() });
    try {
      const mk = async (name, key, extra = {}) => (await S.post('/api/v1/accounts', { platform: 'xbox', name, config: { api_key: key, presence: 'off' }, sync: false, ...extra })).body.id;
      const A = await mk('due', 'xbox-sched-due');
      const B = await mk('off', 'xbox-sched-off', { schedule: { schedule_mode: 'off' } });
      const C = await mk('disabled', 'xbox-sched-disabled', { enabled: false });
      const D = await mk('hourly', 'xbox-sched-hourly', { schedule: { schedule_mode: 'hourly' } });
      const E = await mk('backoff', 'xbox-sched-backoff');
      const F = (await S.post('/api/v1/accounts', { platform: 'custom', name: 'push' })).body.id;
      const now = Date.now();
      const setLast = S.db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?');
      setLast.run(now - 25 * HOUR, A); setLast.run(now - 30 * DAY, B); setLast.run(now - 30 * DAY, C); setLast.run(now - 10 * MIN, D); setLast.run(now - 25 * HOUR, E);
      S.db.prepare("INSERT INTO syncs(account_id, trigger, started_at, finished_at, status, error) VALUES (?, 'schedule', ?, ?, 'error', 'earlier failure')").run(E, now - 5 * MIN, now - 5 * MIN);
      const syncsOf = (id) => S.db.prepare('SELECT * FROM syncs WHERE account_id = ? ORDER BY id').all(id);
      await waitFor(() => syncsOf(A).some((s) => s.finished_at), { timeout: 12_000, what: 'the scheduled sync of the due account' });
      await sleep(300);
      const a = syncsOf(A);
      assert.equal(a.length, 1);
      assert.equal(a[0].trigger, 'schedule');
      assert.equal(a[0].status, 'ok');
      for (const [id, what] of [[B, 'off'], [C, 'disabled'], [D, 'not due'], [F, 'push']]) assert.equal(syncsOf(id).length, 0, `${what} account must not sync`);
      assert.equal(syncsOf(E).length, 1, 'a recently failed account backs off');
      const xboxCalls = fetchMock.state.calls.slice(firstCall).filter((c) => c.u.hostname === 'xbl.io').map((c) => c.headers.get('x-authorization'));
      assert.ok(xboxCalls.length >= 1 && xboxCalls.every((k) => k === 'xbox-sched-due'), `only the due account called Xbox: ${[...new Set(xboxCalls)]}`);
      const acc = (await S.get('/api/v1/accounts')).body;
      const accA = acc.find((x) => x.id === A);
      assert.equal(accA.last_status, 'ok');
      assert.ok(accA.last_sync_at >= now);
      assert.equal(accA.next_sync_at, nextLocalTime(accA.last_sync_at, 4, 0), 'next run: the following 04:00');
      assert.equal(acc.find((x) => x.id === D).next_sync_at, now - 10 * MIN + HOUR, 'not-due account is planned an hour after its last sync');
      assert.equal(acc.find((x) => x.id === B).next_sync_at, null);
      assert.equal((await S.get('/api/v1/system')).body.accounts.find((x) => x.id === A).last_sync.trigger, 'schedule');
    } finally {
      S.db.prepare('UPDATE accounts SET enabled = 0').run();
      S.close();
      defuse(S.inst);
    }
  });

  test('close() cancels the scheduler: nothing runs against the closed database', { todo: 'APP BUG settings-system-16: SyncService.stop() does not clear the 5 s first-tick and 20 s cover-lookup timers; after close() the tick logs "database is not open" and the cover lookup throws an uncaught exception' }, async () => {
    const errors = [];
    const inst = createApp({ dbFile: ':memory:', password: '', scheduler: true, log: { ...SILENT, error: (m) => errors.push(String(m)) } });
    inst.close();
    try {
      await sleep(6500);
      assert.deepEqual(errors, []);
    } finally { defuse(inst); }
  });
});
