// PlayStation (NPSSO / gamelist v2 / presence / trophies) and custom push accounts, black-box
// through the HTTP API with Sony mocked in-process. Expectations come from README.md,
// docs/PLATFORMS.md and the route summaries - not from the implementation.
import './helpers/psn-custom-tz.js';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN, HOUR, DAY, local, startOfDay, dayKey, realSleep, clock, installFetch, restoreFetch, usePsn, useSink,
  FakePSN, psnTitle, isoDuration, trophy, NPSSO, ACCOUNT_ID, startSink, startApp,
  invariantViolations, rollupViolations, futureSessions,
} from './helpers/psn-custom-harness.js';

// Monday 2 March 2026, 20:00 in New York (EST). DST starts Sunday 8 March.
const T0 = local(2026, 3, 2, 20, 0);
const iso = (t) => new Date(t).toISOString();

before(() => { clock.install(); installFetch(); });
after(() => { restoreFetch(); clock.restore(); });

/** A fresh app on its own in-memory database, closed when the test ends. */
async function fresh(tc, opts = {}) {
  clock.set(opts.at ?? T0);
  const t = await startApp(opts);
  tc.after(() => t.close());
  return t;
}

function fakePsn(...titles) {
  const psn = usePsn(new FakePSN());
  psn.add(...titles);
  return psn;
}

async function linkPsn(t, { npsso = NPSSO, name = 'PS5', presence, schedule, enabled } = {}) {
  const r = await t.api('POST', '/accounts', { platform: 'psn', name, config: { npsso, ...(presence ? { presence } : {}) }, sync: false, ...(schedule ? { schedule } : {}), ...(enabled === false ? { enabled: false } : {}) });
  assert.equal(r.status, 200, r.text);
  return r.body;
}

async function linkCustom(t, { name = 'Switch', config = { platform_label: 'Switch' } } = {}) {
  const r = await t.api('POST', '/accounts', { platform: 'custom', name, config });
  assert.equal(r.status, 200, r.text);
  return r.body;
}

function assertHealthy(t, msg = '') {
  assert.deepEqual(invariantViolations(t.db), [], `entries whose sessions don't add up to their total ${msg}`);
  assert.deepEqual(rollupViolations(t.db), [], `rollups out of step with sessions ${msg}`);
  assert.deepEqual(futureSessions(t.db), [], `sessions in the future ${msg}`);
}

const lifetimeTotal = async (t) => (await t.api('GET', '/stats/lifetime')).body.total_minutes;
const playRows = (t, entryId) => t.sessions(entryId, 'play');
const accountRow = async (t, id) => (await t.api('GET', '/accounts')).body.find((a) => a.id === id);

// =====================================================================================
describe('PSN sign-in: NPSSO, tokens, refresh and fallbacks', () => {
  test('NPSSO is exchanged for an authorization code, then tokens; the gamelist is read with the access token', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA01411_00', name: 'Astro Run', minutes: 600, first: T0 - 100 * DAY, last: T0 - 2 * DAY, count: 12 }));
    const acc = await linkPsn(t);
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.initial, true);
    assert.equal(r.body.games_seen, 1);

    const [authz] = psn.of('authorize');
    assert.equal(psn.count('authorize'), 1);
    assert.match(authz.headers.cookie, new RegExp(`(^|;\\s*)npsso=${NPSSO}(;|$)`), 'the NPSSO travels as the npsso cookie');
    assert.equal(authz.redirect, 'manual', 'the code is read from the redirect, which must not be followed');
    assert.equal(authz.params.response_type, 'code');
    assert.equal(authz.params.access_type, 'offline', 'offline access is what yields a refresh token');
    assert.ok(authz.params.client_id && authz.params.redirect_uri && /psn:mobile\.v2\.core/.test(authz.params.scope));

    const [tok] = psn.of('token');
    assert.equal(psn.count('token'), 1);
    assert.equal(tok.form.grant_type, 'authorization_code');
    assert.match(tok.form.code, /^v3\.code\d+$/);
    assert.ok(tok.form.redirect_uri);
    assert.match(tok.headers.authorization, /^Basic /);
    assert.match(tok.headers['content-type'], /application\/x-www-form-urlencoded/);

    const lists = psn.of('gamelist');
    assert.equal(lists.length, 1);
    assert.match(lists[0].headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.ok(psn.access.has(lists[0].headers.authorization.slice(7)), 'the access token issued by the token endpoint is used');
    assert.deepEqual(lists[0].params.categories.split(',').sort(), ['ps4_game', 'ps5_native_game', 'pspc_game']);
    assert.ok(authz.at <= tok.at && tok.at <= lists[0].at);

    const e = t.entry(acc.id, 'PPSA01411_00');
    assert.equal(e.playtime_min, 600);
    assertHealthy(t);
  });

  test('an NPSSO pasted with surrounding whitespace still signs in', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA00001_00', name: 'Whitespace Game', minutes: 60, first: T0 - 9 * DAY, last: T0 - DAY, count: 2 }));
    const acc = await linkPsn(t, { npsso: `   ${NPSSO}\n` });
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    assert.match(psn.of('authorize')[0].headers.cookie, new RegExp(`npsso=${NPSSO}$`));
  });

  test('a rejected NPSSO fails the sync cleanly: clear message, account flagged, nothing imported', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA00002_00', name: 'Never Imported', minutes: 300, first: T0 - 9 * DAY, last: T0 - DAY, count: 2 }));
    const acc = await linkPsn(t, { npsso: 'expired-npsso-value-0000' });
    const r = await t.syncNow(acc.id);
    assert.ok(r.status >= 400 && r.status !== 401, `status ${r.status}`);
    assert.match(r.body.error, /NPSSO/i);
    const a = await accountRow(t, acc.id);
    assert.equal(a.last_status, 'error');
    assert.match(a.last_error, /NPSSO/);
    assert.match(a.last_error, /credential/i, 'the account tells the user to update the credentials');
    assert.equal(psn.count('token'), 0);
    assert.equal(psn.count('gamelist'), 0);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 0);
    const syncs = (await t.api('GET', `/syncs?account_id=${acc.id}`)).body;
    assert.equal(syncs.length, 1);
    assert.equal(syncs[0].status, 'error');
  });

  test('the access token is reused while it is valid: no new sign-in on the next sync', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA00003_00', name: 'Reuse', minutes: 100, first: T0 - 9 * DAY, last: T0 - DAY, count: 2 }));
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    clock.advance(20 * MIN);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    assert.equal(psn.count('authorize'), 1);
    assert.equal(psn.count('token'), 1);
    assert.equal(psn.count('gamelist'), 2);
  });

  test('an expired access token is refreshed with the refresh token, without an NPSSO round-trip', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA00004_00', name: 'Refresh Me', minutes: 100, first: T0 - 9 * DAY, last: T0 - DAY, count: 2 }));
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    const firstRefresh = [...psn.refresh.keys()][0];
    clock.advance(DAY);
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    const toks = psn.of('token');
    assert.equal(toks.length, 2);
    assert.equal(toks[1].form.grant_type, 'refresh_token');
    assert.equal(toks[1].form.refresh_token, firstRefresh);
    assert.equal(psn.count('authorize'), 1, 'the NPSSO is not needed while the refresh token works');
    // the refreshed access token is kept: a sync 10 minutes later needs no token call
    clock.advance(10 * MIN);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    assert.equal(psn.count('token'), 2);
  });

  test('a rejected refresh token falls back to the NPSSO and the sync still records play', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA00005_00', name: 'Fallback', minutes: 100, first: T0 - 9 * DAY, last: T0 - DAY, count: 2 }));
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    psn.refresh.clear(); // Sony no longer accepts the refresh token
    clock.advance(DAY);
    psn.play('PPSA00005_00', { minutes: 45, end: Date.now() - HOUR });
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    const grants = psn.of('token').map((x) => x.form.grant_type);
    assert.deepEqual(grants, ['authorization_code', 'refresh_token', 'authorization_code']);
    assert.equal(psn.count('authorize'), 2);
    const e = t.entry(acc.id, 'PPSA00005_00');
    assert.equal(e.playtime_min, 145);
    assert.equal(t.sum(playRows(t, e.id)), 45);
    assertHealthy(t);
  });

  test('a refresh token past its ~2 month lifetime is not tried; the NPSSO is used directly', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA00006_00', name: 'Two Months', minutes: 100, first: T0 - 9 * DAY, last: T0 - DAY, count: 2 }));
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    clock.advance(61 * DAY);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    assert.deepEqual(psn.of('token').map((x) => x.form.grant_type), ['authorization_code', 'authorization_code']);
    assert.equal(psn.count('authorize'), 2);
  });

  test('refresh rejected and NPSSO expired: auth error asking for new credentials, existing data untouched', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA00007_00', name: 'Locked Out', minutes: 900, first: T0 - 90 * DAY, last: T0 - DAY, count: 20 }));
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    const before = await lifetimeTotal(t);
    psn.revokeAll();
    psn.validNpsso.clear();
    clock.advance(DAY);
    psn.play('PPSA00007_00', { minutes: 60, end: Date.now() - HOUR });
    const r = await t.syncNow(acc.id);
    assert.ok(r.status >= 400 && r.status !== 401, `status ${r.status}`);
    const a = await accountRow(t, acc.id);
    assert.equal(a.last_status, 'error');
    assert.match(a.last_error, /credential/i);
    assert.equal(await lifetimeTotal(t), before, 'a failed sync changes nothing');
    assert.equal(t.entry(acc.id, 'PPSA00007_00').playtime_min, 900);
    assertHealthy(t);
  });

  test('a new NPSSO saved via PATCH drops the cached tokens; the masked value keeps the old secret', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA00008_00', name: 'New Creds', minutes: 100, first: T0 - 9 * DAY, last: T0 - DAY, count: 2 }));
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    const shown = (await accountRow(t, acc.id)).config.npsso;
    assert.notEqual(shown, NPSSO);
    assert.ok(shown.endsWith(NPSSO.slice(-4)) && shown.startsWith('••••••'), `masked: ${shown}`);

    // saving the form with the masked value unchanged keeps both the secret and the session
    let p = await t.api('PATCH', `/accounts/${acc.id}`, { name: 'My PS5', config: { npsso: shown } });
    assert.equal(p.status, 200, p.text);
    clock.advance(5 * MIN);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    assert.equal(psn.count('authorize'), 1, 'masked value: nothing changed, cached tokens kept');

    const second = `${'Z'.repeat(60)}0042`;
    psn.validNpsso.add(second);
    p = await t.api('PATCH', `/accounts/${acc.id}`, { config: { npsso: second } });
    assert.equal(p.status, 200, p.text);
    clock.advance(5 * MIN);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    assert.equal(psn.count('authorize'), 2, 'new credentials -> new sign-in even though the old access token is still valid');
    assert.match(psn.of('authorize')[1].headers.cookie, new RegExp(`npsso=${second}`));
  });

  test('the NPSSO and PSN tokens never appear in API responses, sync history or exports', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA00009_00', name: 'Secret Keeper', minutes: 100, first: T0 - 9 * DAY, last: T0 - DAY, count: 2 }));
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    const secrets = [NPSSO, ...psn.access.keys(), ...psn.refresh.keys()];
    for (const path of ['/accounts', '/system', `/syncs?account_id=${acc.id}`, '/summary', '/export', '/export?format=csv', '/logs', `/games?account_id=${acc.id}`]) {
      const r = await t.api('GET', path);
      assert.equal(r.status, 200, `${path}: ${r.text.slice(0, 200)}`);
      for (const s of secrets) assert.ok(!r.text.includes(s), `${path} leaks a credential`);
    }
  });

  test('linking an account starts its initial import in the background; "sync now" without wait returns at once', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA00010_00', name: 'Background Import', minutes: 240, first: T0 - 20 * DAY, last: T0 - DAY, count: 4 }));
    const r = await t.api('POST', '/accounts', { platform: 'psn', name: 'Auto', config: { npsso: NPSSO } });
    assert.equal(r.status, 200, r.text);
    await t.settle();
    const a = await accountRow(t, r.body.id);
    assert.equal(a.last_sync_at, T0);
    assert.equal(a.last_status, 'ok');
    assert.equal(t.entry(r.body.id, 'PPSA00010_00').playtime_min, 240);
    const syncs = (await t.api('GET', `/syncs?account_id=${r.body.id}`)).body;
    assert.equal(syncs[0].trigger, 'initial');
    clock.set(T0 + DAY);
    psn.play('PPSA00010_00', { minutes: 30, end: T0 + DAY - HOUR });
    const quick = await t.api('POST', `/accounts/${r.body.id}/sync`);
    assert.deepEqual(quick.body, { ok: true, started: true });
    await t.settle();
    assert.equal(t.entry(r.body.id, 'PPSA00010_00').playtime_min, 270);
    assertHealthy(t);
  });

  test('missing or blank NPSSO is rejected when linking; unknown platforms are rejected', async (tc) => {
    const t = await fresh(tc);
    let r = await t.api('POST', '/accounts', { platform: 'psn', config: {} });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /NPSSO/);
    r = await t.api('POST', '/accounts', { platform: 'psn', config: { npsso: '   ' } });
    assert.equal(r.status, 400);
    r = await t.api('POST', '/accounts', { platform: 'ps3', config: { npsso: NPSSO } });
    assert.equal(r.status, 400);
    assert.equal((await t.api('GET', '/accounts')).body.length, 0);
  });
});

// =====================================================================================
describe('PSN credentials test (POST /accounts/test)', () => {
  test('samples the library and live presence, and saves nothing', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(
      psnTitle({ id: 'PPSA10001_00', name: 'Sample One', minutes: 120, first: T0 - 9 * DAY, last: T0 - DAY, count: 2 }),
      psnTitle({ id: 'CUSA10002_00', name: 'Sample Two', minutes: 30, category: 'ps4_game', last: T0 - 3 * DAY }),
      psnTitle({ id: 'PPSA10003_00', name: 'Sample Three', minutes: 0 }),
    );
    psn.playing = [{ id: 'PPSA10001_00', title: 'Sample One' }];
    const r = await t.api('POST', '/accounts/test', { platform: 'psn', config: { npsso: NPSSO } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.games, 3);
    assert.equal(r.body.played, 2);
    assert.equal(r.body.minutes, 150);
    assert.equal(r.body.with_dates, 2);
    assert.match(r.body.presence, /^ok \(playing Sample One\)$/);
    assert.deepEqual(r.body.sample, ['Sample One', 'Sample Two', 'Sample Three']);
    assert.equal((await t.api('GET', '/accounts')).body.length, 0);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 0);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM presence').get().n, 0);
  });

  test('a rejected NPSSO answers a clear client or upstream error, not an internal server error', { todo: 'APP BUG psn-custom-1: POST /accounts/test with a rejected NPSSO answers HTTP 500 (and logs a server error)' }, async (tc) => {
    const t = await fresh(tc);
    fakePsn(psnTitle({ id: 'PPSA10004_00', name: 'X', minutes: 10 }));
    const r = await t.api('POST', '/accounts/test', { platform: 'psn', config: { npsso: 'not-a-valid-npsso' } });
    assert.match(r.body?.error || '', /NPSSO/);
    assert.ok(r.status >= 400 && r.status !== 500, `status ${r.status}`);
    assert.deepEqual(t.logs.error, [], 'a user typing a wrong token is not a server error');
  });

  test('Sony answering 401 must not surface as HTTP 401 (which the web UI treats as "PlayTracker login required")', { todo: 'APP BUG psn-custom-2: POST /accounts/test passes the platform\'s 401 through as our own 401 - the SPA then shows its login screen' }, async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA10005_00', name: 'X', minutes: 10 }));
    psn.failNext('token', { status: 401, body: { error: 'invalid_client' } });
    const r = await t.api('POST', '/accounts/test', { platform: 'psn', config: { npsso: NPSSO } });
    assert.ok(r.status >= 400, `status ${r.status}`);
    assert.notEqual(r.status, 401);
  });

  test('a sync that hits a Sony 401 reports an upstream error (502), not our own 401', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA10006_00', name: 'X', minutes: 10, first: T0 - 9 * DAY, last: T0 - DAY, count: 1 }));
    const acc = await linkPsn(t);
    psn.failNext('gamelist', { status: 401, body: { error: { code: 2241025, message: 'Invalid token' } } });
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 502, r.text);
    const a = await accountRow(t, acc.id);
    assert.equal(a.last_status, 'error');
    assert.match(a.last_error, /credential/i);
  });
});

// =====================================================================================
describe('PSN gamelist v2: paging, durations, titles', () => {
  test('the gamelist is read 200 titles per page until the last page; every title is imported once', async (tc) => {
    const t = await fresh(tc);
    const titles = Array.from({ length: 450 }, (_, i) => psnTitle({ id: `PPSA${String(20000 + i).padStart(5, '0')}_00`, name: `Paged Game ${i}`, minutes: 10 + i, first: T0 - 300 * DAY + i * HOUR, last: T0 - 2 * DAY - i * MIN, count: 1 + (i % 7), concept: 900000 + i }));
    const psn = fakePsn(...titles);
    const acc = await linkPsn(t);
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    const pages = psn.of('gamelist');
    assert.deepEqual(pages.map((p) => p.params.offset), ['0', '200', '400']);
    assert.ok(pages.every((p) => p.params.limit === '200'));
    assert.equal(r.body.games_seen, 450);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM entries WHERE account_id = ?').get(acc.id).n, 450);
    const expected = titles.reduce((a, x) => a + x._min, 0);
    assert.equal(await lifetimeTotal(t), expected);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM sessions WHERE kind = 'play'").get().n, 0, 'first sync: history only');
    assertHealthy(t);
  });

  test('paging stops on an explicit null nextOffset, and on an empty page that still claims more', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA21000_00', name: 'Only Page', minutes: 50, first: T0 - 9 * DAY, last: T0 - DAY, count: 2 }));
    psn.endStyle = 'null';
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    assert.equal(psn.count('gamelist'), 1);
    // a misbehaving reply: an empty page that advertises another one
    psn.on.gamelist = (u) => (u.searchParams.get('offset') === '0'
      ? new Response(JSON.stringify({ titles: [], nextOffset: 200, totalItemCount: 999 }), { status: 200, headers: { 'content-type': 'application/json' } })
      : undefined);
    clock.advance(HOUR);
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(psn.count('gamelist'), 2, 'an empty page ends paging');
    assert.equal(t.entry(acc.id, 'PPSA21000_00').playtime_min, 50, 'nothing lost');
  });

  test('pages that overlap (the list shifted while paging) never double-count a title', async (tc) => {
    const t = await fresh(tc);
    const A = psnTitle({ id: 'PPSA22001_00', name: 'Overlap A', minutes: 100, first: T0 - 50 * DAY, last: T0 - DAY, count: 3 });
    const B = psnTitle({ id: 'PPSA22002_00', name: 'Overlap B', minutes: 200, first: T0 - 50 * DAY, last: T0 - 2 * DAY, count: 4 });
    const C = psnTitle({ id: 'PPSA22003_00', name: 'Overlap C', minutes: 300, first: T0 - 50 * DAY, last: T0 - 3 * DAY, count: 5 });
    const psn = fakePsn(A, B, C);
    const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k.startsWith('_') ? undefined : v)));
    psn.on.gamelist = (u) => {
      const off = u.searchParams.get('offset');
      const body = off === '0' ? { titles: [strip(A), strip(B)], nextOffset: 2, totalItemCount: 3 } : { titles: [strip(B), strip(C)], previousOffset: 0, totalItemCount: 3 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const acc = await linkPsn(t);
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM entries WHERE account_id = ?').get(acc.id).n, 3);
    assert.equal(t.entry(acc.id, 'PPSA22002_00').playtime_min, 200);
    assert.equal(await lifetimeTotal(t), 600);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM sessions WHERE kind = 'play'").get().n, 0);
    assertHealthy(t);
  });

  test('playDuration ISO-8601 durations become whole minutes; unreadable durations never break the sync', async (tc) => {
    const t = await fresh(tc);
    const cases = [
      ['PPSA23001_00', 'PT228H56M33S', [13736, 13737]],
      ['PPSA23002_00', 'P1DT2H', [1560]],
      ['PPSA23003_00', 'P2D', [2880]],
      ['PPSA23004_00', 'PT1H0M0S', [60]],
      ['PPSA23005_00', 'PT45S', [0, 1]],
      ['PPSA23006_00', 'PT0S', [0]],
      ['PPSA23007_00', 'PT59M59S', [59, 60]],
      ['PPSA23008_00', 'PT1000H', [60000]],
      ['PPSA23009_00', 'PT7M', [7]],
      ['PPSA23010_00', 'about three hours', [0]],
      ['PPSA23011_00', undefined, [0]],
    ];
    const psn = fakePsn(...cases.map(([id, d], i) => {
      const x = psnTitle({ id, name: `Duration ${i}`, first: T0 - 30 * DAY, last: T0 - DAY, count: 1, concept: 230000 + i });
      x.playDuration = d;
      return x;
    }));
    const acc = await linkPsn(t);
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    for (const [id, d, ok] of cases) {
      const e = t.entry(acc.id, id);
      assert.ok(e, `${id} imported`);
      assert.ok(ok.includes(e.playtime_min), `${d} -> ${e.playtime_min}, expected ${ok.join(' or ')}`);
    }
    // a later unreadable value for a known title is not a reset: nothing lost, nothing invented
    clock.advance(DAY);
    psn.title('PPSA23002_00').playDuration = 'garbage';
    const r2 = await t.syncNow(acc.id);
    assert.equal(r2.status, 200, r2.text);
    assert.equal(r2.body.sessions_created, 0);
    assert.equal(t.entry(acc.id, 'PPSA23002_00').playtime_min, 1560);
    assertHealthy(t);
  });

  test('a title without a name uses its concept name, then its title id; covers come from the concept MASTER image', async (tc) => {
    const t = await fresh(tc);
    const a = psnTitle({ id: 'PPSA24001_00', name: 'ignored', conceptName: 'Concept Named Game', noName: true, minutes: 30, last: T0 - DAY });
    const b = psnTitle({ id: 'PPSA24002_00', name: 'ignored', noName: true, concept: null, minutes: 40, last: T0 - DAY });
    const c = psnTitle({ id: 'PPSA24003_00', name: 'Named Game', minutes: 50, last: T0 - DAY });
    fakePsn(a, b, c);
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    const games = (await t.api('GET', '/games?sort=title')).body.items;
    const titles = games.map((g) => g.title).sort();
    assert.deepEqual(titles, ['Concept Named Game', 'Named Game', 'PPSA24002_00']);
    assert.equal(games.find((g) => g.title === 'Named Game').cover_url, c.concept.media.images[0].url);
    assert.equal(games.find((g) => g.title === 'Named Game').minutes, 50);
  });

  test('PS4 and PS5 versions of one game (same concept) are one game with two entries', async (tc) => {
    const t = await fresh(tc);
    fakePsn(
      psnTitle({ id: 'CUSA31001_00', name: 'Lantern Tale', category: 'ps4_game', concept: 777001, minutes: 1200, first: T0 - 400 * DAY, last: T0 - 200 * DAY, count: 30 }),
      psnTitle({ id: 'PPSA31002_00', name: 'Lantern Tale: Ember Remaster', category: 'ps5_native_game', concept: 777001, minutes: 300, first: T0 - 100 * DAY, last: T0 - 2 * DAY, count: 9 }),
      psnTitle({ id: 'PPSA31003_00', name: 'Unrelated Racer', concept: 777002, minutes: 50, first: T0 - 10 * DAY, last: T0 - 3 * DAY, count: 2 }),
    );
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    const list = (await t.api('GET', '/games')).body;
    assert.equal(list.total, 2);
    const lantern = list.items.find((g) => g.entry_count === 2);
    assert.ok(lantern, 'one game holds both versions');
    assert.equal(lantern.minutes, 1500);
    const detail = (await t.api('GET', `/games/${lantern.id}`)).body;
    assert.deepEqual(detail.entries.map((e) => e.ext_id).sort(), ['CUSA31001_00', 'PPSA31002_00']);
    assert.deepEqual(detail.entries.map((e) => e.meta.category).sort(), ['ps4_game', 'ps5_native_game']);
    assert.equal(detail.summary.total_minutes, 1500);
    assertHealthy(t);
  });

  test('a PS5 upgrade that shows up later joins the existing game, and its first play is tracked', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'CUSA32001_00', name: 'Harbor Nights', category: 'ps4_game', concept: 778001, minutes: 900, first: T0 - 300 * DAY, last: T0 - 30 * DAY, count: 25 }));
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    clock.advance(DAY);
    const end = Date.now() - 2 * HOUR;
    psn.add(psnTitle({ id: 'PPSA32002_00', name: 'Harbor Nights Remastered', category: 'ps5_native_game', concept: 778001, minutes: 80, first: end - 80 * MIN, last: end, count: 1 }));
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    const e4 = t.entry(acc.id, 'CUSA32001_00');
    const e5 = t.entry(acc.id, 'PPSA32002_00');
    assert.equal(e5.game_id, e4.game_id, 'grouped by concept, not by title');
    const plays = playRows(t, e5.id);
    assert.equal(t.sum(plays), 80, 'first played after the last sync -> tracked play');
    assert.equal(e5.baseline_min, 0);
    assert.equal(plays.at(-1).ended_at, end);
    assertHealthy(t);
  });
});

// =====================================================================================
describe('PSN first import: existing hours become dated history', () => {
  test('nothing is recorded as play; totals are exact; history is dated between first and last played with high confidence', async (tc) => {
    const t = await fresh(tc);
    const specs = [
      { id: 'PPSA40001_00', name: 'History One', minutes: 2400, first: T0 - 200 * DAY, last: T0 - 20 * DAY, count: 40 },
      { id: 'PPSA40002_00', name: 'History Two', minutes: 600, first: T0 - 60 * DAY, last: T0 - 2 * DAY, count: 8 },
      { id: 'CUSA40003_00', name: 'History Three', minutes: 90, first: T0 - 400 * DAY, last: T0 - 399 * DAY, count: 1, category: 'ps4_game' },
    ];
    fakePsn(...specs.map((s, i) => psnTitle({ ...s, concept: 400000 + i })));
    const acc = await linkPsn(t);
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.sessions_created, 0);
    assert.equal(await lifetimeTotal(t), 3090);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM sessions WHERE kind = 'play'").get().n, 0);
    const today = (await t.api('GET', '/stats?range=1d&estimates=exclude')).body;
    assert.equal(today.total_minutes, 0, 'no fake 50-hour session on import day');
    const summary = (await t.api('GET', '/summary')).body;
    assert.equal(summary.today.total_minutes, 0);
    assert.equal(summary.week.total_minutes, 0);
    for (const s of specs) {
      const e = t.entry(acc.id, s.id);
      assert.equal(e.playtime_min, s.minutes);
      assert.equal(e.baseline_min, s.minutes, 'all of it is history');
      assert.equal(e.first_played_at, s.first);
      assert.equal(e.last_played_at, s.last);
      assert.equal(e.play_count, s.count);
      for (const x of t.sessions(e.id, 'estimate')) {
        assert.ok(x.window_start >= startOfDay(s.first), `${s.name}: estimate starts ${iso(x.window_start)} before first played ${iso(s.first)}`);
        assert.ok(x.window_end <= startOfDay(s.last) + DAY, `${s.name}: estimate ends ${iso(x.window_end)} after last played ${iso(s.last)}`);
      }
      const g = (await t.api('GET', `/games/${e.game_id}`)).body;
      const h = g.entries[0].history;
      assert.equal(h.minutes, s.minutes);
      assert.equal(h.confidence, 'high', `${s.name}: first + last played + launch count = high confidence`);
      assert.equal(h.evidence.first_played_at, s.first);
      assert.equal(h.evidence.last_played_at, s.last);
      assert.equal(h.evidence.play_count, s.count);
    }
    assertHealthy(t);
  });

  // three 100-hour games all first played 20 days ago: 300 h cannot fit into 20 days at 12 h a day
  async function heavyLibrary(tc) {
    const t = await fresh(tc);
    const first = T0 - 20 * DAY;
    fakePsn(...[0, 1, 2].map((i) => psnTitle({ id: `PPSA4110${i}_00`, name: `Marathon ${i}`, minutes: 6000, first, last: T0 - DAY, count: 60, concept: 411000 + i })));
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    return { t, acc, first };
  }

  test('a heavy library: totals stay exact and no game gets more than 10 h of history on one day', async (tc) => {
    const { t } = await heavyLibrary(tc);
    assert.equal(await lifetimeTotal(t), 18000);
    const lt = (await t.api('GET', '/stats/lifetime')).body;
    assert.equal(lt.estimated_minutes + lt.baseline_minutes, 18000);
    assert.equal(lt.tracked_minutes, 0);
    const perGameDay = t.db.prepare('SELECT entry_id, day, SUM(minutes) m FROM play_days WHERE estimated = 1 GROUP BY entry_id, day ORDER BY m DESC LIMIT 1').get();
    assert.ok(perGameDay.m <= 600 + 1, `one game got ${perGameDay.m} min on ${perGameDay.day}`);
    assertHealthy(t);
  });

  test('a heavy library: history is never dated before the PSN first-played date; what cannot fit stays undated', { todo: 'APP BUG psn-custom-5: when the shared 12 h/day budget is full, history is moved to before the first-played date (still labelled high confidence) instead of being left undated' }, async (tc) => {
    const { t, acc, first } = await heavyLibrary(tc);
    for (const i of [0, 1, 2]) {
      const e = t.entry(acc.id, `PPSA4110${i}_00`);
      for (const x of t.sessions(e.id, 'estimate')) assert.ok(x.window_start >= startOfDay(first), `Marathon ${i}: ${x.minutes} min dated from ${iso(x.window_start)}, first played ${iso(first)}`);
    }
    const undated = t.db.prepare("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE kind = 'baseline'").get().m;
    assert.ok(undated > 0, 'the overflow is kept as undated history');
  });

  test('a heavy library: all games together get at most 12 h of history on any day', { todo: 'APP BUG psn-custom-6: the library-wide 12 h/day history cap is exceeded (740 min on a day) when history chunks end mid-day' }, async (tc) => {
    const { t } = await heavyLibrary(tc);
    const perDay = t.db.prepare('SELECT day, SUM(minutes) m FROM play_days WHERE estimated = 1 GROUP BY day ORDER BY m DESC LIMIT 1').get();
    assert.ok(perDay.m <= 720 + 1, `the library got ${perDay.m.toFixed(1)} min on ${perDay.day}`);
    const heat = (await t.api('GET', '/stats/heatmap?year=2026&estimates=only')).body;
    assert.ok(Object.values(heat.days).every((m) => m <= 721), `heatmap: ${JSON.stringify(heat.days)}`);
  });
});

// =====================================================================================
describe('PSN deltas become sessions', () => {
  async function imported(tc, title) {
    const t = await fresh(tc);
    const psn = fakePsn(title);
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    return { t, psn, acc };
  }
  const base = (over = {}) => psnTitle({ id: 'PPSA50001_00', name: 'Delta Quest', minutes: 600, first: T0 - 90 * DAY, last: T0 - 3 * DAY, count: 10, concept: 500001, ...over });

  test('one launch, 90 minutes: one session ending at last played', async (tc) => {
    const { t, psn, acc } = await imported(tc, base());
    clock.set(T0 + DAY);
    const end = T0 + DAY - HOUR;
    psn.play('PPSA50001_00', { minutes: 90, end });
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.sessions_created, 1);
    assert.equal(r.body.minutes_added, 90);
    const e = t.entry(acc.id, 'PPSA50001_00');
    assert.equal(e.playtime_min, 690);
    assert.equal(e.play_count, 11);
    assert.equal(e.last_played_at, end);
    const [s] = playRows(t, e.id);
    assert.equal(s.minutes, 90);
    assert.equal(s.ended_at, end);
    assert.equal(s.started_at, end - 90 * MIN);
    assert.equal(s.source, 'sync');
    const today = (await t.api('GET', '/stats?range=1d&estimates=exclude')).body;
    assert.equal(today.total_minutes, 90);
    assert.equal(today.sessions, 1);
    assertHealthy(t);
  });

  test('three launches in one window: three sessions that add up to the delta; the last ends at last played', async (tc) => {
    const { t, psn, acc } = await imported(tc, base());
    clock.set(T0 + DAY);
    const end = T0 + DAY - 2 * HOUR;
    psn.play('PPSA50001_00', { minutes: 150, launches: 3, end });
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    const plays = playRows(t, t.entry(acc.id, 'PPSA50001_00').id);
    assert.equal(plays.length, 3);
    assert.equal(t.sum(plays), 150);
    const last = plays.find((s) => s.ended_at === end);
    assert.ok(last, 'one session ends at last played');
    for (const s of plays) {
      const from = s.started_at ?? s.window_start;
      const to = s.ended_at ?? s.window_end;
      assert.ok(from >= T0 - 20 * MIN, `session starts ${iso(from)} before the window`);
      assert.ok(to <= T0 + DAY, `session ends ${iso(to)} after the sync`);
      if (s !== last) assert.ok(to <= last.started_at, 'earlier launches come before the last one');
    }
    assertHealthy(t);
  });

  test('a brand-new title first played since the last sync: its launch count becomes that many sessions', { todo: 'APP BUG psn-custom-3: a new PSN title first seen after the import ignores its launch count (3 launches -> 1 session)' }, async (tc) => {
    const { t, psn, acc } = await imported(tc, base());
    clock.set(T0 + DAY);
    const end = T0 + DAY - HOUR;
    psn.add(psnTitle({ id: 'PPSA50002_00', name: 'Bought Today', concept: 500002, minutes: 150, first: end - 6 * HOUR, last: end, count: 3 }));
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    const e = t.entry(acc.id, 'PPSA50002_00');
    assert.equal(e.baseline_min, 0, 'first played after the last sync: all of it is tracked play');
    const plays = playRows(t, e.id);
    assert.equal(t.sum(plays), 150);
    assert.equal(plays.length, 3, 'three launches -> three sessions');
    assert.ok(plays.some((s) => s.ended_at === end));
  });

  test('a new title whose first play predates the last sync, or that was last played before it, is history - not play', async (tc) => {
    const { t, psn, acc } = await imported(tc, base());
    clock.set(T0 + DAY);
    psn.add(
      psnTitle({ id: 'PPSA50003_00', name: 'Old But Played Today', concept: 500003, minutes: 900, first: T0 - 30 * DAY, last: T0 + DAY - HOUR, count: 10 }),
      psnTitle({ id: 'CUSA50004_00', name: 'Old And Idle', category: 'ps4_game', concept: 500004, minutes: 400, first: T0 - 60 * DAY, last: T0 - 10 * DAY, count: 5 }),
    );
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    for (const [id, m] of [['PPSA50003_00', 900], ['CUSA50004_00', 400]]) {
      const e = t.entry(acc.id, id);
      assert.equal(e.playtime_min, m);
      assert.equal(t.sum(playRows(t, e.id)), 0, `${id}: no burst of play on the day it appeared`);
      assert.equal(e.baseline_min, m);
    }
    assert.equal((await t.api('GET', '/stats?range=1d&estimates=exclude')).body.total_minutes, 0);
    assertHealthy(t);
  });

  test('deltas below the minimum session length are held back and counted once they add up', async (tc) => {
    const { t, psn, acc } = await imported(tc, base());
    clock.set(T0 + DAY);
    psn.play('PPSA50001_00', { minutes: 1, end: T0 + DAY - HOUR });
    let r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.sessions_created, 0);
    const e = t.entry(acc.id, 'PPSA50001_00');
    assert.equal(playRows(t, e.id).length, 0);
    clock.set(T0 + 2 * DAY);
    psn.play('PPSA50001_00', { minutes: 4, end: T0 + 2 * DAY - HOUR });
    r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(t.sum(playRows(t, e.id)), 5, 'the held-back minute is not lost');
    assert.equal(t.entry(acc.id, 'PPSA50001_00').playtime_min, 605);
    assertHealthy(t);
  });

  test('a launch without credited playtime creates no session', async (tc) => {
    const { t, psn, acc } = await imported(tc, base());
    clock.set(T0 + DAY);
    const x = psn.title('PPSA50001_00');
    x.playCount += 2;
    x.lastPlayedDateTime = iso(T0 + DAY - HOUR);
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.sessions_created, 0);
    assert.equal(playRows(t, t.entry(acc.id, 'PPSA50001_00').id).length, 0);
    assertHealthy(t);
  });

  test('playtime that dips (a glitch) and recovers is never counted twice', async (tc) => {
    const { t, psn, acc } = await imported(tc, base());
    const e = t.entry(acc.id, 'PPSA50001_00');
    clock.set(T0 + DAY);
    psn.title('PPSA50001_00').playDuration = 'PT9H'; // 540, below the 600 already recorded
    let r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.sessions_created, 0);
    clock.set(T0 + 2 * DAY);
    psn.title('PPSA50001_00').playDuration = 'PT10H'; // back to 600: nothing new was played
    r = await t.syncNow(acc.id);
    assert.equal(r.body.sessions_created, 0, 'recovering from a dip is not new play');
    clock.set(T0 + 3 * DAY);
    psn.play('PPSA50001_00', { minutes: 60, end: T0 + 3 * DAY - HOUR }); // 660
    r = await t.syncNow(acc.id);
    assert.equal(t.sum(playRows(t, e.id)), 60);
    assert.equal(t.entry(acc.id, 'PPSA50001_00').playtime_min, 660);
    assert.equal(await lifetimeTotal(t), 660);
    assertHealthy(t);
  });

  test('one launch of five hours stays one session (the launch counter says one sitting)', { todo: 'APP BUG psn-custom-4: a single PSN launch longer than 4 h is split into two sessions (120 min pinned + 180 min "earlier session")' }, async (tc) => {
    const { t, psn, acc } = await imported(tc, base());
    clock.set(T0 + DAY);
    const end = T0 + DAY - HOUR;
    psn.play('PPSA50001_00', { minutes: 300, launches: 1, end });
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    const plays = playRows(t, t.entry(acc.id, 'PPSA50001_00').id);
    assert.equal(t.sum(plays), 300);
    assert.equal(plays.length, 1, 'n new launches -> n sessions');
    assert.equal(plays[0].ended_at, end);
  });

  test('without a launch count, a long sitting is split: a typical session ends at last played, the rest before it', async (tc) => {
    const { t, psn, acc } = await imported(tc, base({ count: null }));
    clock.set(T0 + DAY);
    const end = T0 + DAY - HOUR;
    const x = psn.title('PPSA50001_00');
    x._min += 300; x.playDuration = isoDuration(x._min); x.lastPlayedDateTime = iso(end);
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    const plays = playRows(t, t.entry(acc.id, 'PPSA50001_00').id);
    assert.equal(t.sum(plays), 300);
    const last = plays.find((s) => s.ended_at === end);
    assert.ok(last, 'pinned to last played (end)');
    assert.ok(last.minutes <= 240, `the pinned part is a typical session, got ${last.minutes}`);
    for (const s of plays) if (s !== last) assert.ok((s.ended_at ?? s.window_end) <= last.started_at, 'the rest lies before it');
    assertHealthy(t);
  });

  test('more playtime than the sync window can hold: tracked play is capped, the excess becomes undated history', async (tc) => {
    const { t, psn, acc } = await imported(tc, base());
    clock.set(T0 + HOUR);
    psn.play('PPSA50001_00', { minutes: 1000, end: T0 + HOUR - 20 * MIN });
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    const e = t.entry(acc.id, 'PPSA50001_00');
    const tracked = t.sum(playRows(t, e.id));
    const late = t.db.prepare("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE entry_id = ? AND kind = 'baseline' AND source = 'sync'").get(e.id).m;
    assert.ok(tracked > 0 && tracked < 1000, `tracked ${tracked}`);
    // one sitting may have started before the window (PSN reports a session when it ends): at most
    // the elapsed hour plus one maximum-length session
    assert.ok(tracked <= 60 + 720 + 15, `tracked ${tracked}`);
    assert.equal(tracked + late, 1000, 'nothing lost: the excess is undated history');
    assert.equal(e.playtime_min, 1600);
    assertHealthy(t);
  });

  test('a week between syncs: a large delta is spread over the days, weighted to the last activity, at most 10 h a day', async (tc) => {
    const { t, psn, acc } = await imported(tc, base({ count: null }));
    clock.set(T0 + 7 * DAY);
    const end = T0 + 6 * DAY + HOUR; // Monday 21:00
    const x = psn.title('PPSA50001_00');
    x._min += 1500; x.playDuration = isoDuration(x._min); x.lastPlayedDateTime = iso(end);
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    const e = t.entry(acc.id, 'PPSA50001_00');
    const plays = playRows(t, e.id);
    assert.equal(t.sum(plays), 1500);
    assert.ok(plays.length >= 3, `spread over several days, got ${plays.length} sessions`);
    const days = t.db.prepare('SELECT day, SUM(minutes) m FROM play_days WHERE entry_id = ? AND estimated = 0 GROUP BY day').all(e.id);
    assert.ok(days.every((d) => d.m <= 600 + 1), JSON.stringify(days));
    const lastDay = days.find((d) => d.day === dayKey(end));
    assert.ok(lastDay, 'the last-played day has play');
    assert.ok(days.every((d) => d.m <= lastDay.m + 0.5), `weighted toward the last activity: ${JSON.stringify(days)}`);
    assert.ok(plays.every((s) => (s.started_at ?? s.window_start) >= T0 - 20 * MIN));
    assertHealthy(t);
  });

  test('a session across the spring-forward night keeps its real length and lands on the right day', async (tc) => {
    const t = await fresh(tc, { at: local(2026, 3, 7, 20, 0) });
    const psn = fakePsn(base({ first: T0 - 90 * DAY, last: T0 - 3 * DAY }));
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    clock.set(local(2026, 3, 8, 20, 0));
    const end = local(2026, 3, 8, 3, 30); // 03:30 EDT; 120 real minutes earlier is 00:30 EST
    psn.play('PPSA50001_00', { minutes: 120, end });
    assert.equal((await t.syncNow(acc.id)).status, 200);
    const [s] = playRows(t, t.entry(acc.id, 'PPSA50001_00').id);
    assert.equal(s.minutes, 120);
    assert.equal(s.ended_at - s.started_at, 120 * MIN);
    assert.equal(new Date(s.started_at).getHours(), 0);
    const heat = (await t.api('GET', '/stats/heatmap?year=2026&estimates=exclude')).body;
    assert.equal(heat.days['2026-03-08'], 120);
    assert.equal(heat.days['2026-03-07'] ?? 0, 0);
    assertHealthy(t);
  });

  test('titles missing from the library are flagged, keep their minutes, and return cleanly', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(base(), psnTitle({ id: 'CUSA50009_00', name: 'Refunded Maybe', category: 'ps4_game', concept: 500009, minutes: 120, first: T0 - 40 * DAY, last: T0 - 5 * DAY, count: 3 }));
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    const hidden = psn.title('CUSA50009_00');
    psn.remove('CUSA50009_00');
    clock.set(T0 + DAY);
    let r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.removed, 1);
    let e = t.entry(acc.id, 'CUSA50009_00');
    assert.ok(e.missing_since, 'flagged as no longer in the library');
    assert.equal(e.playtime_min, 120, 'its playtime is kept');
    const g = (await t.api('GET', `/games/${e.game_id}`)).body;
    assert.ok(g.entries[0].missing_since);
    assert.equal(await lifetimeTotal(t), 720);
    psn.add(hidden);
    clock.set(T0 + 2 * DAY);
    r = await t.syncNow(acc.id);
    assert.equal(r.body.sessions_created, 0);
    e = t.entry(acc.id, 'CUSA50009_00');
    assert.equal(e.missing_since, null);
    assertHealthy(t);
  });

  test('an empty library reply (a Sony glitch) does not flag the whole library as removed', async (tc) => {
    const { t, psn, acc } = await imported(tc, base());
    const saved = psn.titles;
    psn.titles = [];
    clock.set(T0 + DAY);
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(t.entry(acc.id, 'PPSA50001_00').missing_since, null);
    assert.equal(await lifetimeTotal(t), 600);
    psn.titles = saved;
  });
});

// =====================================================================================
describe('PSN live presence (basicPresences)', () => {
  const A = () => psnTitle({ id: 'PPSA60001_00', name: 'Presence Quest', minutes: 600, first: T0 - 90 * DAY, last: T0 - 3 * DAY, count: 10, concept: 600001 });
  const poll = (t, id) => t.sync.pollPresence(t.sync.account(id));

  test('polls open a span while playing and close it after; the next sync gets exact times and is scheduled 15 min after the session', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(A());
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    // same evening as the import, so the next scheduled (04:00) sync is still ahead
    const P0 = T0 + 30 * MIN;
    clock.set(P0);
    await poll(t, acc.id); // not playing
    psn.playing = [{ id: 'PPSA60001_00', title: 'Presence Quest' }];
    for (let k = 1; k <= 31; k++) {
      clock.set(P0 + 3 * k * MIN);
      await poll(t, acc.id);
      if (k === 10) {
        const np = (await t.api('GET', '/now-playing')).body;
        assert.equal(np.length, 1);
        assert.equal(np[0].title, 'Presence Quest');
        assert.equal(np[0].game_id, t.entry(acc.id, 'PPSA60001_00').game_id);
        assert.equal(np[0].platform, 'psn');
      }
    }
    const reqs = psn.of('presence');
    assert.ok(reqs.every((r) => r.path === `/api/userProfile/v1/internal/users/${ACCOUNT_ID}/basicPresences` && r.params.type === 'primary'), 'looked up by the account id read from the token');
    psn.playing = [];
    const stop = P0 + 96 * MIN;
    clock.set(stop);
    await poll(t, acc.id);
    assert.equal((await t.api('GET', '/now-playing')).body.length, 0);
    const a = await accountRow(t, acc.id);
    assert.equal(a.next_sync_at, stop + 15 * MIN, 'a sync runs 15 minutes after the session ends (Sony lags)');
    assert.equal(a.presence.enabled, true);
    assert.equal(a.presence.failures, 0);

    psn.play('PPSA60001_00', { minutes: 93, end: P0 + 94 * MIN });
    clock.set(stop + 20 * MIN);
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    const plays = playRows(t, t.entry(acc.id, 'PPSA60001_00').id);
    assert.equal(plays.length, 1);
    assert.equal(plays[0].minutes, 93);
    assert.equal(plays[0].confidence, 'exact');
    assert.ok(Math.abs(plays[0].started_at - (P0 + 1.5 * MIN)) <= 3 * MIN, `start ${iso(plays[0].started_at)}`);
    assert.ok(Math.abs(plays[0].ended_at - (P0 + 94.5 * MIN)) <= 3 * MIN, `end ${iso(plays[0].ended_at)}`);
    assertHealthy(t);
  });

  test('presence falls back to users/me when the account-id lookup is not found; auth failures are counted, not thrown', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(A());
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    psn.presenceById = false;
    psn.playing = [{ id: 'PPSA60001_00', title: 'Presence Quest' }];
    clock.advance(5 * MIN);
    await poll(t, acc.id);
    assert.deepEqual(psn.of('presence').map((r) => r.path.split('/')[6]), [ACCOUNT_ID, 'me']);
    assert.equal((await t.api('GET', '/now-playing')).body.length, 1);
    // Sony revokes everything: the poll fails, the failure is visible on the account, and nothing crashes
    psn.revokeAll();
    clock.advance(3 * MIN);
    await poll(t, acc.id);
    const a = await accountRow(t, acc.id);
    assert.equal(a.presence.failures, 1);
    assert.match(a.presence.error, /401/);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM presence WHERE ended_at IS NULL').get().n, 1, 'a failed poll does not end the running span');
  });

  test('a presence poll refreshes an expired access token once and keeps the new one', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(A());
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    clock.advance(2 * HOUR);
    await poll(t, acc.id);
    clock.advance(3 * MIN);
    await poll(t, acc.id);
    assert.deepEqual(psn.of('token').map((x) => x.form.grant_type), ['authorization_code', 'refresh_token']);
    assert.equal(psn.of('presence').length, 2);
    assert.equal((await accountRow(t, acc.id)).presence.failures, 0);
  });

  test('live presence can be switched off per account', async (tc) => {
    const t = await fresh(tc);
    fakePsn(A());
    const on = await linkPsn(t, { name: 'On' });
    const off = await linkPsn(t, { name: 'Off', presence: 'off' });
    assert.equal((await accountRow(t, on.id)).presence.enabled, true);
    assert.equal((await accountRow(t, off.id)).presence.enabled, false);
    const p = await t.api('PATCH', `/accounts/${on.id}`, { config: { presence: 'off' } });
    assert.equal(p.status, 200);
    assert.equal(p.body.presence.enabled, false);
  });
});

// =====================================================================================
describe('PSN trophy enrichment dates history', () => {
  const titleSpecs = [1, 2, 3, 4, 5, 6, 7].map((i) => ({
    id: i <= 5 ? `PPSA7000${i}_00` : `CUSA7000${i}_00`,
    name: `Trophy Game ${i}`,
    category: i <= 5 ? 'ps5_native_game' : 'ps4_game',
    comm: `NPWR7000${i}_00`,
    service: i <= 5 ? 'trophy2' : 'trophy',
  }));
  const A1 = local(2026, 1, 21, 21, 15);
  const A2 = local(2026, 1, 22, 22, 40);

  function trophyWorld() {
    const psn = fakePsn(...titleSpecs.map((s, i) => psnTitle({ id: s.id, name: s.name, category: s.category, minutes: 600, first: T0 - 100 * DAY, last: T0 - 5 * DAY, count: 10, concept: 700000 + i })));
    for (const s of titleSpecs) {
      // one PS5 set arrives without npServiceName: the PS5 category decides (trophy2)
      psn.trophyTitles.set(s.id, [{ npCommunicationId: s.comm, ...(s.id === 'PPSA70005_00' ? {} : { npServiceName: s.service }) }]);
      psn.trophySets.set(s.comm, { service: s.service, trophies: [trophy(1, A1), trophy(2, A2), trophy(3, null)] });
    }
    return psn;
  }

  test('titles are mapped to trophy sets 5 at a time, PS5 sets read as trophy2 and PS4 as trophy; earned times anchor the history', async (tc) => {
    const t = await fresh(tc);
    const psn = trophyWorld();
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    const maps = psn.of('trophyTitles');
    assert.equal(maps.length, 2, '7 titles -> 2 lookups');
    assert.ok(maps.every((m) => m.ids.length <= 5));
    assert.deepEqual(maps.flatMap((m) => m.ids).sort(), titleSpecs.map((s) => s.id).sort());
    const reads = psn.of('trophies');
    assert.equal(reads.length, 7);
    for (const s of titleSpecs) {
      const read = reads.find((r) => r.path.includes(s.comm));
      assert.equal(read.params.npServiceName, s.service, `${s.id} read with ${s.service}`);
    }
    for (const s of titleSpecs) {
      const e = t.entry(acc.id, s.id);
      const g = (await t.api('GET', `/games/${e.game_id}`)).body;
      const h = g.entries[0].history;
      assert.equal(h.evidence.anchors, 2, `${s.id}: two earned trophies (the unearned one is ignored)`);
      assert.equal(h.enriched, true);
      // history is re-dated around real moments of play
      const near = t.db.prepare('SELECT COALESCE(SUM(minutes), 0) m FROM play_days WHERE entry_id = ? AND estimated = 1 AND day BETWEEN ? AND ?')
        .get(e.id, dayKey(A1 - DAY), dayKey(A2 + DAY)).m;
      assert.ok(near > 0, `${s.id}: history placed around the trophy days`);
    }
    const sys = (await t.api('GET', '/system')).body;
    assert.equal(sys.accounts.find((a) => a.id === acc.id).enrichment_pending, 0);
    // re-running enrichment from scratch does not duplicate anchors or minutes
    const total = await lifetimeTotal(t);
    const re = await t.api('POST', `/accounts/${acc.id}/enrich?wait=true`, { reset: true });
    assert.equal(re.status, 200, re.text);
    assert.equal(re.body.updated, 7);
    const g1 = (await t.api('GET', `/games/${t.entry(acc.id, 'PPSA70001_00').game_id}`)).body;
    assert.equal(g1.entries[0].history.evidence.anchors, 2);
    assert.equal(await lifetimeTotal(t), total);
    assertHealthy(t);
  });

  test('trophy failures: a missing set completes the title without anchors; a server error leaves it pending for a retry', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(
      psnTitle({ id: 'PPSA71001_00', name: 'No Trophies Here', minutes: 300, first: T0 - 50 * DAY, last: T0 - 5 * DAY, count: 5, concept: 710001 }),
      psnTitle({ id: 'PPSA71002_00', name: 'Server Error Set', minutes: 300, first: T0 - 50 * DAY, last: T0 - 5 * DAY, count: 5, concept: 710002 }),
      psnTitle({ id: 'PPSA71003_00', name: 'Healthy Set', minutes: 300, first: T0 - 50 * DAY, last: T0 - 5 * DAY, count: 5, concept: 710003 }),
    );
    psn.trophyTitles.set('PPSA71001_00', [{ npCommunicationId: 'NPWR71001_00', npServiceName: 'trophy2' }]); // set itself 404s
    psn.trophyTitles.set('PPSA71002_00', [{ npCommunicationId: 'NPWR71002_00', npServiceName: 'trophy2' }]);
    psn.trophyTitles.set('PPSA71003_00', [{ npCommunicationId: 'NPWR71003_00', npServiceName: 'trophy2' }]);
    psn.trophySets.set('NPWR71002_00', { status: 500, headers: { 'retry-after': '1' } });
    psn.trophySets.set('NPWR71003_00', { service: 'trophy2', trophies: [trophy(1, T0 - 20 * DAY), trophy(2, T0 - 19 * DAY)] });
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    const hist = async (id) => (await t.api('GET', `/games/${t.entry(acc.id, id).game_id}`)).body.entries[0].history;
    assert.equal((await hist('PPSA71001_00')).enriched, true);
    assert.equal((await hist('PPSA71001_00')).evidence.anchors, 0);
    assert.equal((await hist('PPSA71002_00')).enriched, false, 'a server error is retried later');
    assert.equal((await hist('PPSA71003_00')).evidence.anchors, 2);
    const sys = (await t.api('GET', '/system')).body;
    assert.equal(sys.accounts.find((a) => a.id === acc.id).enrichment_pending, 1);
    assert.equal(await lifetimeTotal(t), 900);
    assertHealthy(t);
  });

  test('a trophy rate limit stops the run and keeps every title pending', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(...[1, 2, 3].map((i) => psnTitle({ id: `PPSA7200${i}_00`, name: `Limited ${i}`, minutes: 200, first: T0 - 50 * DAY, last: T0 - 5 * DAY, count: 3, concept: 720000 + i })));
    psn.failNext('trophyTitles', { status: 429, body: { error: { code: 2241027, message: 'Too Many Requests' } } });
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    assert.equal(psn.count('trophyTitles'), 1, 'no hammering after a 429');
    assert.equal(psn.count('trophies'), 0);
    const sys = (await t.api('GET', '/system')).body;
    assert.equal(sys.accounts.find((a) => a.id === acc.id).enrichment_pending, 3);
    assert.equal(await lifetimeTotal(t), 600);
  });

  test('trophy calls are spaced at least 3.2 seconds apart', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA73001_00', name: 'Spaced', minutes: 200, first: T0 - 50 * DAY, last: T0 - 5 * DAY, count: 3, concept: 730001 }));
    psn.autoAdvanceTrophyMs = 0; // real time this once
    psn.trophyTitles.set('PPSA73001_00', [{ npCommunicationId: 'NPWR73001_00', npServiceName: 'trophy2' }]);
    psn.trophySets.set('NPWR73001_00', { service: 'trophy2', trophies: [trophy(1, T0 - 20 * DAY)] });
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    const calls = [...psn.of('trophyTitles'), ...psn.of('trophies')].sort((a, b) => a.real - b.real);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].real - calls[0].real >= 3150, `gap ${Math.round(calls[1].real - calls[0].real)} ms`);
  });
});

// =====================================================================================
describe('PSN failures and concurrency', () => {
  const X = () => psnTitle({ id: 'PPSA80001_00', name: 'Flaky Network', minutes: 600, first: T0 - 90 * DAY, last: T0 - 3 * DAY, count: 10, concept: 800001 });

  test('a transient 5xx is retried; a persistent one fails the sync without touching data', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(X());
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    clock.set(T0 + DAY);
    psn.play('PPSA80001_00', { minutes: 60, end: T0 + DAY - HOUR });
    psn.failNext('gamelist', { status: 503, headers: { 'retry-after': '1' } });
    let r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.minutes_added, 60);
    clock.set(T0 + 2 * DAY);
    psn.play('PPSA80001_00', { minutes: 30, end: T0 + 2 * DAY - HOUR });
    psn.failNext('gamelist', ...Array(5).fill({ status: 503, headers: { 'retry-after': '1' } }));
    r = await t.syncNow(acc.id);
    assert.equal(r.status, 502, r.text);
    const a = await accountRow(t, acc.id);
    assert.equal(a.last_status, 'error');
    assert.match(a.last_error, /503/);
    assert.equal(t.entry(acc.id, 'PPSA80001_00').playtime_min, 660, 'the failed sync changed nothing');
    psn.queued.gamelist = [];
    clock.set(T0 + 2 * DAY + HOUR);
    r = await t.syncNow(acc.id);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.minutes_added, 30, 'the next good sync picks the play up');
    assertHealthy(t);
  });

  test('a rate limit (429) pauses the account instead of failing it', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(X());
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    clock.set(T0 + DAY);
    psn.failNext('gamelist', { status: 429, body: { error: { code: 2241027, message: 'Too Many Requests' } } });
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 429, r.text);
    assert.equal(psn.count('gamelist'), 2, 'an exhausted quota is not hammered with retries');
    const a = await accountRow(t, acc.id);
    assert.equal(a.last_status, 'warning', 'a quota pause is not an account failure');
    assert.ok(a.next_sync_at >= Date.now() + MIN, 'next sync waits for the quota');
    assert.equal(t.entry(acc.id, 'PPSA80001_00').playtime_min, 600);
  });

  test('a reply that is not JSON fails the sync cleanly', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(X());
    const acc = await linkPsn(t);
    psn.failNext('gamelist', { status: 200, raw: '<html><body>Service Unavailable</body></html>', headers: { 'content-type': 'text/html' } });
    const r = await t.syncNow(acc.id);
    assert.equal(r.status, 502, r.text);
    assert.match(r.body.error, /invalid JSON/i);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 0);
    assert.equal((await accountRow(t, acc.id)).last_status, 'error');
  });

  test('two syncs of one account at the same time share one run: play is counted once', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(X());
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    clock.set(T0 + DAY);
    psn.play('PPSA80001_00', { minutes: 90, end: T0 + DAY - HOUR });
    let release;
    psn.gate = { gamelist: new Promise((r) => { release = r; }) };
    const p1 = t.api('POST', `/accounts/${acc.id}/sync?wait=true`);
    while (psn.count('gamelist') < 2) await realSleep(5);
    const p2 = t.api('POST', `/accounts/${acc.id}/sync?wait=true`);
    await realSleep(30);
    release();
    psn.gate = null;
    const [r1, r2] = await Promise.all([p1, p2]);
    await t.settle();
    assert.equal(r1.status, 200, r1.text);
    assert.equal(r2.status, 200, r2.text);
    assert.equal(psn.count('gamelist'), 2, 'one import + one shared run');
    assert.equal(t.sum(playRows(t, t.entry(acc.id, 'PPSA80001_00').id)), 90);
    assert.equal(t.entry(acc.id, 'PPSA80001_00').playtime_min, 690);
    assertHealthy(t);
  });

  test('a report pushed while a sync of that account is running is refused (409), and the sync completes', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(X());
    const acc = await linkPsn(t);
    let release;
    psn.gate = { gamelist: new Promise((r) => { release = r; }) };
    const p = t.api('POST', `/accounts/${acc.id}/sync?wait=true`);
    while (psn.count('gamelist') < 1) await realSleep(5);
    const rep = await t.api('POST', `/accounts/${acc.id}/report`, { games: [{ id: 'PPSA80001_00', title: 'Flaky Network', playtime_minutes: 999 }] });
    assert.equal(rep.status, 409, rep.text);
    release();
    psn.gate = null;
    const r = await p;
    await t.settle();
    assert.equal(r.status, 200, r.text);
    assert.equal(t.entry(acc.id, 'PPSA80001_00').playtime_min, 600);
  });
});

// =====================================================================================
describe('Custom accounts: pushed reports', () => {
  test('a custom account is push-only: no background sync, nothing scheduled, presence push available', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    assert.equal(acc.platform, 'custom');
    assert.equal(acc.push, true);
    assert.equal(acc.enabled, true);
    assert.equal(acc.last_sync_at, null);
    assert.equal(acc.next_sync_at, null);
    assert.equal(acc.config.platform_label, 'Switch');
    assert.equal(acc.presence.enabled, true);
    await realSleep(20);
    assert.deepEqual((await t.api('GET', `/syncs?account_id=${acc.id}`)).body, []);
    const test = await t.api('POST', '/accounts/test', { platform: 'custom', config: {} });
    assert.equal(test.status, 200);
    assert.equal(test.body.ok, true);
    const fromAll = await t.api('POST', '/sync');
    assert.equal(fromAll.body.started, 0, '"sync all" has nothing to fetch for push accounts');
  });

  test('the first report files totals as dated history, never as play, and keeps the dates as evidence', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    const r = await t.report(acc.id, [
      { id: 'totk', title: 'Zelda: TotK', playtime_minutes: 5230, last_played_at: iso(T0 - 3 * DAY), first_played_at: iso(T0 - 200 * DAY), play_count: 80, date_added: iso(T0 - 210 * DAY) },
      { id: 'mk8', title: 'Mario Kart 8 Deluxe', playtime_hours: 12.5 },
    ]);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.initial, true);
    assert.equal(r.body.games_new, 2);
    assert.equal(r.body.sessions_created, 0);
    const totk = t.entry(acc.id, 'totk');
    const mk8 = t.entry(acc.id, 'mk8');
    assert.equal(totk.playtime_min, 5230);
    assert.equal(mk8.playtime_min, 750);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM sessions WHERE kind = 'play'").get().n, 0);
    assert.equal(await lifetimeTotal(t), 5980);
    const h = (await t.api('GET', `/games/${totk.game_id}`)).body.entries[0].history;
    assert.equal(h.minutes, 5230);
    assert.equal(h.evidence.first_played_at, T0 - 200 * DAY);
    assert.equal(h.evidence.last_played_at, T0 - 3 * DAY);
    assert.equal(h.evidence.play_count, 80);
    assert.equal(h.evidence.date_added, T0 - 210 * DAY);
    for (const x of t.sessions(totk.id, 'estimate')) {
      assert.ok(x.window_start >= startOfDay(T0 - 200 * DAY) && x.window_end <= startOfDay(T0 - 3 * DAY) + DAY, `estimate ${iso(x.window_start)}..${iso(x.window_end)}`);
    }
    const syncs = (await t.api('GET', `/syncs?account_id=${acc.id}`)).body;
    assert.equal(syncs.length, 1);
    assert.equal(syncs[0].trigger, 'api');
    assert.equal(syncs[0].initial, 1);
    assert.equal((await t.api('GET', '/stats?range=7d&estimates=exclude')).body.total_minutes, 0);
    assertHealthy(t);
  });

  test('a later report turns the delta into a session pinned to last_played_at (its end by default, its start when configured)', async (tc) => {
    const t = await fresh(tc);
    const end = await linkCustom(t, { name: 'Ends' });
    const start = await linkCustom(t, { name: 'Starts', config: { last_played_meaning: 'start' } });
    for (const a of [end, start]) assert.equal((await t.report(a.id, [{ id: 'g', title: `Pin ${a.name}`, playtime_minutes: 100 }])).status, 200);
    clock.set(T0 + DAY);
    const lpEnd = T0 + DAY - HOUR;
    const lpStart = T0 + DAY - 3 * HOUR;
    let r = await t.report(end.id, [{ id: 'g', title: 'Pin Ends', playtime_minutes: 190, last_played_at: iso(lpEnd) }]);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.sessions_created, 1);
    r = await t.report(start.id, [{ id: 'g', title: 'Pin Starts', playtime_minutes: 190, last_played_at: lpStart }]);
    assert.equal(r.status, 200, r.text);
    const [se] = playRows(t, t.entry(end.id, 'g').id);
    assert.equal(se.minutes, 90);
    assert.equal(se.ended_at, lpEnd);
    assert.equal(se.started_at, lpEnd - 90 * MIN);
    const [ss] = playRows(t, t.entry(start.id, 'g').id);
    assert.equal(ss.minutes, 90);
    assert.equal(ss.started_at, lpStart, 'epoch-millisecond last_played_at marks the start');
    assert.equal(ss.ended_at, lpStart + 90 * MIN);
    assertHealthy(t);
  });

  test('device and cover art in a report: sessions are tagged with the device, the game gets the cover', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    const cover = 'https://images.example/zelda.jpg';
    await t.report(acc.id, [{ id: 'z', title: 'Device Game', playtime_minutes: 100, device: 'switch-oled', cover_url: cover }]);
    clock.set(T0 + DAY);
    await t.report(acc.id, [{ id: 'z', title: 'Device Game', playtime_minutes: 160, device: 'switch-oled', last_played_at: iso(T0 + DAY - HOUR) }]);
    const e = t.entry(acc.id, 'z');
    const s = (await t.api('GET', `/sessions?game_id=${e.game_id}`)).body.items;
    assert.equal(s.length, 1);
    assert.equal(s[0].device, 'switch-oled');
    assert.equal(s[0].minutes, 60);
    assert.equal(s[0].account_id, acc.id);
    assert.equal((await t.api('GET', `/games/${e.game_id}`)).body.cover_url, cover);
  });

  test('pushing a new lifetime total for one entry (POST /entries/:id/playtime) records the delta like a report', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    await t.report(acc.id, [{ id: 'p', title: 'Single Push', playtime_minutes: 100 }]);
    clock.set(T0 + DAY);
    const e = t.entry(acc.id, 'p');
    const r = await t.api('POST', `/entries/${e.id}/playtime`, { playtime_minutes: 145, last_played_at: iso(T0 + DAY - HOUR) });
    assert.equal(r.status, 200, r.text);
    await t.settle();
    const [s] = playRows(t, e.id);
    assert.equal(s.minutes, 45);
    assert.equal(s.ended_at, T0 + DAY - HOUR);
    assert.equal((await t.api('POST', `/entries/${e.id}/playtime`, {})).status, 400);
    assert.equal((await t.api('POST', `/entries/${e.id}/playtime`, { playtime_minutes: -5 })).status, 400);
    assert.equal(t.entry(acc.id, 'p').playtime_min, 145);
    assertHealthy(t);
  });

  test('a last_played_at in the future (clock skew) or before the previous report never creates sessions outside the window', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    await t.report(acc.id, [{ id: 'f', title: 'Future Clock', playtime_minutes: 100 }, { id: 's', title: 'Stale Clock', playtime_minutes: 100 }]);
    clock.set(T0 + DAY);
    const r = await t.report(acc.id, [
      { id: 'f', title: 'Future Clock', playtime_minutes: 160, last_played_at: iso(T0 + DAY + 3 * HOUR) },
      { id: 's', title: 'Stale Clock', playtime_minutes: 150, last_played_at: iso(T0 - 5 * DAY) },
    ]);
    assert.equal(r.status, 200, r.text);
    for (const [id, m] of [['f', 60], ['s', 50]]) {
      const plays = playRows(t, t.entry(acc.id, id).id);
      assert.equal(t.sum(plays), m);
      for (const x of plays) {
        assert.ok((x.started_at ?? x.window_start) >= T0 - MIN, `${id}: starts ${iso(x.started_at ?? x.window_start)} before the previous report`);
        assert.ok((x.ended_at ?? x.window_end) <= T0 + DAY, `${id}: ends ${iso(x.ended_at ?? x.window_end)} after the report`);
      }
    }
    assertHealthy(t);
  });

  test('unchanged totals create nothing; small deltas are held back until they add up', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    await t.report(acc.id, [{ id: 'a', title: 'Small Steps', playtime_minutes: 100 }]);
    clock.set(T0 + HOUR);
    let r = await t.report(acc.id, [{ id: 'a', title: 'Small Steps', playtime_minutes: 100 }]);
    assert.equal(r.body.sessions_created, 0);
    clock.set(T0 + 2 * HOUR);
    r = await t.report(acc.id, [{ id: 'a', title: 'Small Steps', playtime_minutes: 101 }]);
    assert.equal(r.body.sessions_created, 0, '1 minute is below the 2-minute minimum session');
    clock.set(T0 + 3 * HOUR);
    r = await t.report(acc.id, [{ id: 'a', title: 'Small Steps', playtime_minutes: 103 }]);
    const e = t.entry(acc.id, 'a');
    assert.equal(t.sum(playRows(t, e.id)), 3, 'the held-back minute is included once the delta is big enough');
    assert.equal(e.playtime_min, 103);
    assertHealthy(t);
  });

  test('a delta larger than the time since the last report: within tolerance it all counts; beyond it is capped and the rest is undated', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    await t.report(acc.id, [{ id: 'a', title: 'Too Much', playtime_minutes: 100 }]);
    clock.set(T0 + HOUR);
    let r = await t.report(acc.id, [{ id: 'a', title: 'Too Much', playtime_minutes: 170 }]); // 70 min in 60: within the 15-minute tolerance
    assert.equal(r.status, 200, r.text);
    const e = t.entry(acc.id, 'a');
    assert.equal(t.sum(playRows(t, e.id)), 70);
    clock.set(T0 + 2 * HOUR);
    r = await t.report(acc.id, [{ id: 'a', title: 'Too Much', playtime_minutes: 370 }]); // 200 min in 60
    assert.equal(r.status, 200, r.text);
    const tracked = t.sum(playRows(t, e.id)) - 70;
    const late = t.db.prepare("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE entry_id = ? AND kind = 'baseline' AND source = 'sync'").get(e.id).m;
    assert.equal(tracked, 60, 'capped at the elapsed time');
    assert.equal(late, 140, 'the excess is undated history');
    assert.equal(t.entry(acc.id, 'a').playtime_min, 370);
    assertHealthy(t);
  });

  async function recentImport(tc) {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    const r = await t.report(acc.id, [{ id: 'a', title: 'Recently Busy', playtime_minutes: 1000, recent_minutes: 120, last_played_at: iso(T0 - DAY), first_played_at: iso(T0 - 120 * DAY) }]);
    assert.equal(r.status, 200, r.text);
    const e = t.entry(acc.id, 'a');
    return { t, e, est: t.sessions(e.id, 'estimate') };
  }

  test('recent_minutes on the first report: dated history inside the last 14 days, the rest before it, nothing as play', async (tc) => {
    const { t, e, est } = await recentImport(tc);
    const firstDay = startOfDay(T0 - 14 * DAY); // history is dated in whole days
    assert.deepEqual(est.filter((x) => x.window_start < firstDay && x.window_end > T0 - 14 * DAY + 1), [], 'no chunk straddles the 14-day boundary');
    const recentChunks = est.filter((x) => x.note === 'Recent play before tracking');
    assert.ok(recentChunks.length > 0);
    assert.ok(recentChunks.every((x) => x.window_start >= firstDay && x.window_end <= T0), 'recent play lies inside the recent window');
    assert.equal(playRows(t, e.id).length, 0);
    assert.equal(t.sum(est) + t.sum(t.sessions(e.id, 'baseline')), 1000);
    assertHealthy(t);
  });

  test('recent_minutes on the first report: exactly that many minutes are dated inside the last 14 days', { todo: 'APP BUG psn-custom-10: of recent_minutes: 120 only 119 are dated inside the recent window (one minute lost to rounding)' }, async (tc) => {
    const { est } = await recentImport(tc);
    const inRecent = est.filter((x) => x.window_start >= startOfDay(T0 - 14 * DAY)).reduce((a, x) => a + x.minutes, 0);
    assert.equal(inRecent, 120);
  });

  test('recent_days sets the length of the recent window', { todo: 'APP BUG psn-custom-7: recent_days is accepted but ignored - recent_minutes are always dated over 14 days' }, async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    const r = await t.report(acc.id, [{ id: 'a', title: 'Last Three Days', playtime_minutes: 1000, recent_minutes: 120, recent_days: 3, last_played_at: iso(T0 - DAY), first_played_at: iso(T0 - 120 * DAY) }]);
    assert.equal(r.status, 200, r.text);
    const est = t.sessions(t.entry(acc.id, 'a').id, 'estimate');
    const inRecent = est.filter((x) => x.window_start >= startOfDay(T0 - 3 * DAY)).reduce((a, x) => a + x.minutes, 0);
    assert.equal(inRecent, 120, '120 minutes in the last 3 days');
  });

  test('recent_minutes: 0 means nothing was played recently; absent means unknown', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    let r = await t.report(acc.id, [
      { id: 'unknown', title: 'Recent Unknown', playtime_minutes: 2000, first_played_at: iso(T0 - 300 * DAY) },
      { id: 'zero', title: 'Recent Zero', playtime_minutes: 2000, first_played_at: iso(T0 - 300 * DAY), recent_minutes: 0 },
    ]);
    assert.equal(r.status, 200, r.text);
    const zero = t.sessions(t.entry(acc.id, 'zero').id, 'estimate');
    const recentZero = zero.filter((x) => x.window_end > T0 - 14 * DAY).reduce((a, x) => a + x.minutes, 0);
    assert.equal(recentZero, 0, 'recent_minutes: 0 -> no history dated in the last 14 days');
    // later report: brand-new titles with more playtime than the elapsed day
    clock.set(T0 + DAY);
    r = await t.report(acc.id, [
      { id: 'n-absent', title: 'New Absent', playtime_minutes: 5000 },
      { id: 'n-zero', title: 'New Zero', playtime_minutes: 5000, recent_minutes: 0 },
      { id: 'n-120', title: 'New Recent', playtime_minutes: 5000, recent_minutes: 120 },
    ]);
    assert.equal(r.status, 200, r.text);
    const playOf = (id) => t.sum(playRows(t, t.entry(acc.id, id).id));
    assert.equal(playOf('n-absent'), 0, 'unknown recency: all of it is history');
    assert.equal(playOf('n-zero'), 0, 'nothing recent: all of it is history');
    assert.equal(playOf('n-120'), 120, 'the recent minutes are new play');
    for (const id of ['n-absent', 'n-zero', 'n-120']) assert.equal(t.entry(acc.id, id).playtime_min, 5000);
    assertHealthy(t);
  });

  test('backfill: a total that only now became available is history, never new play', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    await t.report(acc.id, [{ id: 'a', title: 'Late Total', playtime_minutes: 100 }, { id: 'b', title: 'Normal', playtime_minutes: 50 }]);
    clock.set(T0 + DAY);
    const r = await t.report(acc.id, [
      { id: 'a', title: 'Late Total', playtime_minutes: 400, backfill: true },
      { id: 'c', title: 'New Backfilled', playtime_minutes: 300, backfill: true },
      { id: 'b', title: 'Normal', playtime_minutes: 110, last_played_at: iso(T0 + DAY - HOUR) },
    ]);
    assert.equal(r.status, 200, r.text);
    const a = t.entry(acc.id, 'a');
    const c = t.entry(acc.id, 'c');
    assert.equal(a.playtime_min, 400);
    assert.equal(t.sum(playRows(t, a.id)), 0);
    assert.equal(a.baseline_min, 400);
    assert.equal(c.playtime_min, 300);
    assert.equal(t.sum(playRows(t, c.id)), 0);
    assert.equal(t.sum(playRows(t, t.entry(acc.id, 'b').id)), 60, 'the non-backfilled delta in the same report is play');
    assert.equal((await t.api('GET', '/stats?range=1d&estimates=exclude')).body.total_minutes, 60);
    assertHealthy(t);
  });

  test('partial reports never mark titles as removed', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    await t.report(acc.id, [{ id: 'a', title: 'Reported Daily', playtime_minutes: 100 }, { id: 'b', title: 'Not In This Report', playtime_minutes: 500 }]);
    clock.set(T0 + DAY);
    const r = await t.report(acc.id, [{ id: 'a', title: 'Reported Daily', playtime_minutes: 160, last_played_at: iso(T0 + DAY - HOUR) }]);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.removed, 0);
    const b = t.entry(acc.id, 'b');
    assert.equal(b.missing_since, null);
    assert.equal(b.playtime_min, 500);
    assert.equal(await lifetimeTotal(t), 660);
    assertHealthy(t);
  });

  test('bad report bodies are rejected; junk entries in the list are skipped; unknown accounts are 404', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    assert.equal((await t.api('POST', '/accounts/999/report', { games: [] })).status, 404);
    for (const body of [{}, { games: 'zelda' }, { games: { id: 'x' } }]) {
      const r = await t.api('POST', `/accounts/${acc.id}/report`, body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    const bad = await t.api('POST', `/accounts/${acc.id}/report`, '{"games": [', { 'content-type': 'application/json' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /JSON/);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 0);
    const r = await t.report(acc.id, [null, 5, 'x', true, { id: 'ok', title: 'Valid One', playtime_minutes: 10 }]);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.games_seen, 1);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 1);
  });

  test('a report entry with neither id nor title is skipped instead of creating a game called "undefined"', { todo: 'APP BUG psn-custom-11: entries without id/title (or an empty array) in games[] create a game titled "undefined"' }, async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    const r = await t.api('POST', `/accounts/${acc.id}/report`, { games: [[], { playtime_minutes: 10 }, { id: 'ok', title: 'Valid One', playtime_minutes: 10 }] });
    assert.ok(r.status === 200 || r.status === 400, `status ${r.status}`);
    await t.settle();
    const titles = t.db.prepare('SELECT title FROM games').all().map((g) => g.title);
    assert.ok(!titles.includes('undefined'), `games: ${titles.join(', ')}`);
    assert.ok(t.db.prepare("SELECT COUNT(*) n FROM entries WHERE ext_id = 'undefined'").get().n === 0);
  });

  test('negative or non-numeric playtime is rejected with 400', { todo: 'APP BUG psn-custom-8: POST /accounts/:id/report accepts negative / non-numeric playtime with 200 and silently stores 0' }, async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    for (const g of [{ id: 'neg', title: 'Negative', playtime_minutes: -50 }, { id: 'nan', title: 'Words', playtime_minutes: 'lots' }, { id: 'nanh', title: 'Hours', playtime_hours: 'a few' }]) {
      const r = await t.api('POST', `/accounts/${acc.id}/report`, { games: [g] });
      assert.equal(r.status, 400, `${JSON.stringify(g)} -> ${r.status}`);
    }
  });

  test('invalid playtime values never damage stored totals', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    await t.report(acc.id, [{ id: 'a', title: 'Robust', playtime_minutes: 300 }]);
    clock.set(T0 + DAY);
    for (const v of [-50, 'lots', null]) await t.api('POST', `/accounts/${acc.id}/report`, { games: [{ id: 'a', title: 'Robust', playtime_minutes: v }] });
    await t.settle();
    const e = t.entry(acc.id, 'a');
    assert.equal(e.playtime_min, 300);
    assert.equal(playRows(t, e.id).length, 0);
    assert.ok(t.db.prepare('SELECT MIN(playtime_min) m FROM entries').get().m >= 0);
    assertHealthy(t);
  });

  test('the same game twice in one first report is not counted twice and is never play', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    const r = await t.report(acc.id, [{ id: 'a', title: 'Listed Twice', playtime_minutes: 100 }, { id: 'a', title: 'Listed Twice', playtime_minutes: 200 }]);
    assert.equal(r.status, 200, r.text);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM entries WHERE account_id = ?').get(acc.id).n, 1);
    const e = t.entry(acc.id, 'a');
    assert.ok([100, 200].includes(e.playtime_min), `total ${e.playtime_min}`);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM sessions WHERE kind = 'play'").get().n, 0, 'the first report never records play');
    assert.equal(await lifetimeTotal(t), e.playtime_min);
    assertHealthy(t);
  });

  test('games without an id are matched by title across reports; numeric and string ids are the same game', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    await t.report(acc.id, [{ title: 'Hollow Knight', playtime_minutes: 100 }, { id: 42, title: 'Celeste', playtime_minutes: 50 }]);
    clock.set(T0 + DAY);
    const r = await t.report(acc.id, [{ title: 'Hollow Knight', playtime_minutes: 160 }, { id: '42', title: 'Celeste', playtime_minutes: 80 }]);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.games_new, 0);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM entries WHERE account_id = ?').get(acc.id).n, 2);
    assert.equal(t.sum(playRows(t, t.entry(acc.id, 'Hollow Knight').id)), 60);
    assert.equal(t.sum(playRows(t, t.entry(acc.id, '42').id)), 30);
    assertHealthy(t);
  });

  test('a huge lifetime total is stored exactly; what cannot be dated stays undated', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    const t0 = performance.now();
    const r = await t.report(acc.id, [{ id: 'mmo', title: 'Forever MMO', playtime_minutes: 10_000_000, first_played_at: iso(T0 - 6000 * DAY), last_played_at: iso(T0 - DAY) }]);
    assert.equal(r.status, 200, r.text);
    assert.ok(performance.now() - t0 < 20_000, 'answered in reasonable time');
    assert.equal(t.entry(acc.id, 'mmo').playtime_min, 10_000_000);
    assert.equal(await lifetimeTotal(t), 10_000_000);
    const undated = t.db.prepare("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE kind = 'baseline'").get().m;
    assert.ok(undated > 0, '10 million minutes do not fit at 10 h a day: the rest is undated');
    assertHealthy(t);
  });

  test('a huge lifetime total: no day gets more than 10 h of that game\'s history, including 25-hour DST days', { todo: 'APP BUG psn-custom-6: daily history caps are exceeded on 25-hour DST fall-back days (621 min) and on the partial last day (654 min)' }, async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    await t.report(acc.id, [{ id: 'mmo', title: 'Forever MMO', playtime_minutes: 10_000_000, first_played_at: iso(T0 - 6000 * DAY), last_played_at: iso(T0 - DAY) }]);
    const days = t.db.prepare('SELECT day, SUM(minutes) m FROM play_days GROUP BY day HAVING m > 601 ORDER BY m DESC').all();
    assert.deepEqual(days.map((d) => `${d.day}: ${d.m.toFixed(0)}`), []);
  });

  test('a custom account cannot be pulled: syncing it fails cleanly and points to the report endpoint', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    await t.report(acc.id, [{ id: 'a', title: 'Pushed Only', playtime_minutes: 100 }]);
    const r = await t.syncNow(acc.id);
    assert.ok(r.status >= 400, `status ${r.status}`);
    assert.match(r.body.error, /report/);
    assert.equal(t.entry(acc.id, 'a').playtime_min, 100);
  });
});

// =====================================================================================
describe('Custom accounts: presence pushes', () => {
  async function setup(tc) {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    assert.equal((await t.report(acc.id, [{ id: 'a', title: 'Presence Push', playtime_minutes: 100 }])).status, 200);
    const push = async (at, playing) => { clock.set(at); const r = await t.api('POST', `/accounts/${acc.id}/presence`, { playing }); assert.equal(r.status, 200, r.text); return r.body; };
    return { t, acc, push };
  }
  const P0 = T0 + DAY - 3 * HOUR;
  const A = [{ id: 'a', title: 'Presence Push' }];

  test('presence pushes pin the next reported delta to the exact start and end', async (tc) => {
    const { t, acc, push } = await setup(tc);
    assert.deepEqual(await push(P0, A), { open: 1, closed: 0 });
    const np = (await t.api('GET', '/now-playing')).body;
    assert.equal(np.length, 1);
    assert.equal(np[0].title, 'Presence Push');
    assert.equal(np[0].platform, 'custom');
    assert.deepEqual(await push(P0 + 60 * MIN, A), { open: 1, closed: 0 });
    await push(P0 + 89 * MIN, A);
    assert.deepEqual(await push(P0 + 90 * MIN, []), { open: 0, closed: 1 });
    assert.equal((await t.api('GET', '/now-playing')).body.length, 0);
    clock.set(P0 + 100 * MIN);
    const r = await t.report(acc.id, [{ id: 'a', title: 'Presence Push', playtime_minutes: 190, last_played_at: iso(P0 + 90 * MIN) }]);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.exact_sessions, 1);
    const [s] = playRows(t, t.entry(acc.id, 'a').id);
    assert.equal(s.minutes, 90);
    assert.equal(s.confidence, 'exact');
    assert.equal(s.started_at, P0);
    assert.equal(s.ended_at, P0 + 90 * MIN);
    assertHealthy(t);
  });

  test('two presence spans in one report window become two exact sessions', async (tc) => {
    const { t, acc, push } = await setup(tc);
    await push(P0, A); await push(P0 + 59 * MIN, A); await push(P0 + 60 * MIN, []);
    await push(P0 + 120 * MIN, A); await push(P0 + 149 * MIN, A); await push(P0 + 150 * MIN, []);
    clock.set(P0 + 160 * MIN);
    const r = await t.report(acc.id, [{ id: 'a', title: 'Presence Push', playtime_minutes: 190, last_played_at: iso(P0 + 150 * MIN) }]);
    assert.equal(r.status, 200, r.text);
    const plays = playRows(t, t.entry(acc.id, 'a').id);
    assert.deepEqual(plays.map((s) => [s.minutes, s.confidence, s.started_at, s.ended_at]), [
      [60, 'exact', P0, P0 + 60 * MIN],
      [30, 'exact', P0 + 120 * MIN, P0 + 150 * MIN],
    ]);
    assertHealthy(t);
  });

  test('a presence span that was already fully credited is not used again by the next report', { todo: 'APP BUG psn-custom-9: a report right after a presence session lets the next day\'s report pull 6 minutes back into the old session (span reused)' }, async (tc) => {
    const { t, acc, push } = await setup(tc);
    await push(P0, A); await push(P0 + 89 * MIN, A); await push(P0 + 90 * MIN, []);
    clock.set(P0 + 91 * MIN); // e.g. a Home Assistant automation reports as soon as the game closes
    await t.report(acc.id, [{ id: 'a', title: 'Presence Push', playtime_minutes: 190, last_played_at: iso(P0 + 90 * MIN) }]);
    clock.set(P0 + DAY);
    const lp = P0 + DAY - HOUR;
    await t.report(acc.id, [{ id: 'a', title: 'Presence Push', playtime_minutes: 250, last_played_at: iso(lp) }]);
    const plays = playRows(t, t.entry(acc.id, 'a').id);
    assert.deepEqual(plays.map((s) => s.minutes), [90, 60], 'yesterday stays 90 minutes, today is 60');
    assert.equal(plays[1].ended_at, lp);
  });

  test('presence push validation: playing must be an array, junk items are skipped, unknown accounts are 404', async (tc) => {
    const { t, acc } = await setup(tc);
    assert.equal((await t.api('POST', '/accounts/999/presence', { playing: [] })).status, 404);
    assert.equal((await t.api('POST', `/accounts/${acc.id}/presence`, { playing: 'zelda' })).status, 400);
    assert.equal((await t.api('POST', `/accounts/${acc.id}/presence`, { playing: { id: 'a' } })).status, 400);
    const r = await t.api('POST', `/accounts/${acc.id}/presence`, { playing: [null, 7, { id: 'a' }] });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.open, 1);
    const none = await t.api('POST', `/accounts/${acc.id}/presence`, {});
    assert.equal(none.status, 200, 'no "playing" = nothing is being played');
    assert.equal(none.body.closed, 1);
  });
});

// =====================================================================================
describe('Account management: CRUD, schedules, enable/disable, delete', () => {
  test('create, rename, list with totals; unknown ids are 404', async (tc) => {
    const t = await fresh(tc);
    let r = await t.api('POST', '/accounts', { platform: 'custom', config: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.name, 'Custom / API push', 'named after the platform by default');
    const id = r.body.id;
    r = await t.api('PATCH', `/accounts/${id}`, { name: 'Living Room Switch' });
    assert.equal(r.body.name, 'Living Room Switch');
    r = await t.api('PATCH', `/accounts/${id}`, { name: 'N'.repeat(200) });
    assert.equal(r.status, 200);
    assert.ok(r.body.name.length <= 80, 'names are bounded');
    const off = await t.api('POST', '/accounts', { platform: 'custom', name: 'Spare', config: {}, enabled: false });
    assert.equal(off.body.enabled, false);
    await t.report(id, [{ id: 'a', title: 'Counted Game', playtime_minutes: 120 }, { id: 'b', title: 'Second Game', playtime_minutes: 30 }]);
    const list = (await t.api('GET', '/accounts')).body;
    assert.equal(list.length, 2);
    const me = list.find((a) => a.id === id);
    assert.equal(me.games, 2);
    assert.equal(me.minutes, 150);
    assert.ok(me.last_sync_at);
    assert.equal((await t.api('PATCH', '/accounts/999', { name: 'x' })).status, 404);
    assert.equal((await t.api('DELETE', '/accounts/999')).status, 404);
    assert.equal((await t.api('POST', '/accounts/999/sync?wait=true')).status, 404);
  });

  test('per-account schedule overrides are validated, described and drive the next sync; null falls back to the global schedule', async (tc) => {
    const t = await fresh(tc);
    fakePsn(psnTitle({ id: 'PPSA91001_00', name: 'Scheduled', minutes: 100, first: T0 - 9 * DAY, last: T0 - DAY, count: 2 }));
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    let a = await accountRow(t, acc.id);
    assert.equal(a.schedule, null);
    assert.equal(a.schedule_label, 'Daily at 04:00');
    assert.equal(a.next_sync_at, local(2026, 3, 3, 4, 0));
    const patch = async (schedule) => t.api('PATCH', `/accounts/${acc.id}`, { schedule });

    let r = await patch({ schedule_mode: 'hourly' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.schedule_label, 'Every hour');
    assert.equal(r.body.next_sync_at, T0 + HOUR);

    r = await patch({ schedule_mode: 'days', schedule_every: 3, schedule_time: '06:30' });
    assert.equal(r.body.schedule_label, 'Every 3 days at 06:30');
    const nd = new Date(r.body.next_sync_at);
    assert.deepEqual([nd.getHours(), nd.getMinutes()], [6, 30]);
    assert.ok(r.body.next_sync_at > T0 + 2 * DAY && r.body.next_sync_at <= T0 + 3.5 * DAY, iso(r.body.next_sync_at));

    r = await patch({ schedule_mode: 'weekly', schedule_weekday: 6, schedule_time: '10:00' });
    assert.equal(r.body.schedule_label, 'Weekly on Saturday at 10:00');
    assert.equal(r.body.next_sync_at, local(2026, 3, 7, 10, 0));

    for (const bad of [{ schedule_mode: 'sometimes' }, { schedule_time: '25:00' }, { schedule_mode: 'days', schedule_every: 0 }, { schedule_weekday: 9 }]) {
      const b = await patch(bad);
      assert.equal(b.status, 400, JSON.stringify(bad));
    }
    a = await accountRow(t, acc.id);
    assert.equal(a.schedule_label, 'Weekly on Saturday at 10:00', 'a rejected change leaves the override as it was');

    r = await patch({ schedule_mode: 'off' });
    assert.equal(r.body.schedule_label, 'Manual only');
    assert.equal(r.body.next_sync_at, null);

    r = await patch(null);
    assert.equal(r.body.schedule, null);
    assert.equal(r.body.schedule_label, 'Daily at 04:00');
    assert.equal(r.body.next_sync_at, local(2026, 3, 3, 4, 0));

    const create = await t.api('POST', '/accounts', { platform: 'psn', config: { npsso: NPSSO }, sync: false, schedule: { schedule_mode: 'every-now-and-then' } });
    assert.equal(create.status, 400);
    assert.equal((await t.api('GET', '/accounts')).body.length, 1, 'nothing created on a bad schedule');
  });

  test('changing the global schedule re-plans accounts without an override and leaves overrides alone', async (tc) => {
    const t = await fresh(tc);
    fakePsn(psnTitle({ id: 'PPSA91002_00', name: 'Global', minutes: 100, first: T0 - 9 * DAY, last: T0 - DAY, count: 2 }));
    const plain = await linkPsn(t, { name: 'Plain' });
    const own = await linkPsn(t, { name: 'Own', schedule: { schedule_mode: 'weekly', schedule_weekday: 6, schedule_time: '10:00' } });
    assert.equal((await t.syncNow(plain.id)).status, 200);
    assert.equal((await t.syncNow(own.id)).status, 200);
    assert.equal((await accountRow(t, own.id)).next_sync_at, local(2026, 3, 7, 10, 0));
    const s = await t.api('PUT', '/settings', { schedule_mode: 'hourly' });
    assert.equal(s.status, 200, s.text);
    const p = await accountRow(t, plain.id);
    assert.equal(p.schedule_label, 'Every hour');
    assert.equal(p.next_sync_at, p.last_sync_at + HOUR);
    const o = await accountRow(t, own.id);
    assert.equal(o.schedule_label, 'Weekly on Saturday at 10:00');
    assert.equal(o.next_sync_at, local(2026, 3, 7, 10, 0));
  });

  test('disabled accounts are not scheduled, not polled and skipped by "sync all"; push accounts are never scheduled', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA91003_00', name: 'Toggle', minutes: 100, first: T0 - 9 * DAY, last: T0 - DAY, count: 2 }));
    const acc = await linkPsn(t);
    const custom = await linkCustom(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    await t.report(custom.id, [{ id: 'a', title: 'Pushed', playtime_minutes: 10 }]);
    assert.equal((await accountRow(t, custom.id)).next_sync_at, null);
    let r = await t.api('PATCH', `/accounts/${acc.id}`, { enabled: false });
    assert.equal(r.body.enabled, false);
    assert.equal(r.body.next_sync_at, null);
    assert.equal(r.body.presence.enabled, false);
    const before = psn.count('gamelist');
    r = await t.api('POST', '/sync');
    assert.equal(r.body.started, 0);
    await t.settle();
    assert.equal(psn.count('gamelist'), before);
    r = await t.api('PATCH', `/accounts/${acc.id}`, { enabled: true });
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.next_sync_at, local(2026, 3, 3, 4, 0));
    r = await t.api('POST', '/sync');
    assert.equal(r.body.started, 1);
    await t.settle();
    assert.equal(psn.count('gamelist'), before + 1);
  });

  test('deleting an account removes exactly its data; games that other sources also track survive', async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(
      psnTitle({ id: 'PPSA92001_00', name: 'Shared Quest', minutes: 300, first: T0 - 30 * DAY, last: T0 - DAY, count: 5, concept: 920001 }),
      psnTitle({ id: 'PPSA92002_00', name: 'Only On PSN', minutes: 200, first: T0 - 30 * DAY, last: T0 - DAY, count: 5, concept: 920002 }),
    );
    const acc = await linkPsn(t);
    const custom = await linkCustom(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    await t.report(custom.id, [{ id: 'sq', title: 'Shared Quest', playtime_minutes: 120 }, { id: 'oc', title: 'Only Custom', playtime_minutes: 80 }]);
    const onlyPsnGame = t.entry(acc.id, 'PPSA92002_00').game_id;
    const sharedGame = t.entry(acc.id, 'PPSA92001_00').game_id;
    assert.equal(t.entry(custom.id, 'sq').game_id, sharedGame, 'same title on two accounts is one game');
    const manual = await t.api('POST', '/sessions', { game_id: onlyPsnGame, minutes: 45, started_at: T0 - 2 * HOUR });
    assert.equal(manual.status, 200, manual.text);
    psn.playing = [{ id: 'PPSA92001_00', title: 'Shared Quest' }];
    await t.sync.pollPresence(t.sync.account(acc.id));
    assert.equal((await t.api('GET', '/now-playing')).body.length, 1);
    const del = await t.api('DELETE', `/accounts/${acc.id}`);
    assert.equal(del.status, 200, del.text);
    const n = (sql, ...a) => t.db.prepare(sql).get(...a).n;
    assert.equal(n('SELECT COUNT(*) n FROM entries WHERE account_id = ?', acc.id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM syncs WHERE account_id = ?', acc.id), 0);
    assert.equal(n('SELECT COUNT(*) n FROM presence WHERE account_id = ?', acc.id), 0);
    assert.equal((await t.api('GET', '/now-playing')).body.length, 0, 'no ghost "playing now" card');
    assert.equal(n('SELECT COUNT(*) n FROM sessions WHERE entry_id NOT IN (SELECT id FROM entries)'), 0);
    assert.equal(n('SELECT COUNT(*) n FROM snapshots WHERE entry_id NOT IN (SELECT id FROM entries)'), 0);
    assert.equal(n('SELECT COUNT(*) n FROM play_days WHERE session_id NOT IN (SELECT id FROM sessions)'), 0);
    const shared = (await t.api('GET', `/games/${sharedGame}`)).body;
    assert.deepEqual(shared.entries.map((e) => e.account_id), [custom.id]);
    assert.equal(shared.minutes, 120);
    const onlyPsn = (await t.api('GET', `/games/${onlyPsnGame}`)).body;
    assert.deepEqual(onlyPsn.entries.map((e) => e.platform), ['manual'], 'the hand-logged session keeps the game');
    assert.equal(onlyPsn.minutes, 45);
    const lt = (await t.api('GET', '/stats/lifetime')).body;
    assert.equal(lt.total_minutes, 120 + 80 + 45);
    assert.deepEqual(lt.platforms.map((p) => p.platform).sort(), ['custom', 'manual']);
    // charts hold tracked + dated history only (undated history counts toward lifetime totals)
    assert.equal((await t.api('GET', '/stats?range=all&estimates=include')).body.total_minutes, lt.tracked_minutes + lt.estimated_minutes);
    assert.deepEqual((await t.api('GET', '/accounts')).body.map((a) => a.id), [custom.id]);
    assertHealthy(t);
  });

  test('a re-linked account starts with clean API usage and no inherited rate-limit pause', { todo: 'APP BUG psn-custom-12: account ids are reused after a delete, and the new account inherits the old one\'s API usage counters and rate-limit pause' }, async (tc) => {
    const t = await fresh(tc);
    const psn = fakePsn(psnTitle({ id: 'PPSA93001_00', name: 'Relinked', minutes: 100, first: T0 - 9 * DAY, last: T0 - DAY, count: 2 }));
    const old = await linkPsn(t);
    assert.equal((await t.syncNow(old.id)).status, 200);
    clock.advance(10 * MIN);
    psn.failNext('gamelist', { status: 429, body: { error: { message: 'Too Many Requests' } } });
    assert.equal((await t.syncNow(old.id)).status, 429);
    const o = await accountRow(t, old.id);
    assert.ok(o.api_usage_hour.calls >= 4 && o.api_quota?.blockedUntil > Date.now(), 'the old account used its quota');
    assert.equal((await t.api('DELETE', `/accounts/${old.id}`)).status, 200);
    const fresh2 = await linkPsn(t, { name: 'Relinked PS5' });
    const a = await accountRow(t, fresh2.id);
    assert.equal(a.api_usage_hour.calls, 0, `account ${fresh2.id} (old id ${old.id}) shows calls it never made`);
    assert.equal(a.api_quota, null, 'and a rate-limit pause it never hit');
  });
});

// =====================================================================================
describe('Webhooks', () => {
  async function hooked(tc, url, on) {
    const t = await fresh(tc);
    const sink = useSink(await startSink());
    tc.after(() => sink.close());
    const s = await t.api('PUT', '/settings', { webhook_url: url ?? `${sink.base}/hook`, webhook_on: on });
    assert.equal(s.status, 200, s.text);
    return { t, sink };
  }
  const quiet = () => realSleep(300); // give a (wrong) delivery time to arrive

  test('generic URL, webhook_on=sessions: a sync with new sessions posts a JSON summary; one without posts nothing', async (tc) => {
    const { t, sink } = await hooked(tc, null, 'sessions');
    const acc = await linkCustom(t);
    await t.report(acc.id, [{ id: 'w', title: 'Webhook Game', playtime_minutes: 100 }]);
    await quiet();
    assert.equal(sink.hits.length, 0, 'the import created no sessions');
    clock.set(T0 + DAY);
    await t.report(acc.id, [{ id: 'w', title: 'Webhook Game', playtime_minutes: 190, last_played_at: iso(T0 + DAY - HOUR) }]);
    const [hit] = await sink.waitFor(1);
    assert.equal(hit.method, 'POST');
    assert.equal(hit.path, '/hook');
    assert.match(hit.headers['content-type'], /application\/json/);
    assert.equal(hit.body.event, 'sync.completed');
    assert.deepEqual(hit.body.account, { id: acc.id, platform: 'custom', name: 'Switch' });
    assert.equal(hit.body.result.sessions_created, 1);
    assert.equal(hit.body.result.minutes_added, 90);
    assert.equal(hit.body.error ?? null, null);
    assert.match(hit.body.text, /Webhook Game/);
    assert.match(hit.body.text, /1h 30m/);
    await quiet();
    assert.equal(sink.hits.length, 1, 'exactly one delivery per sync');
  });

  test('webhook_on=always posts even when nothing changed', async (tc) => {
    const { t, sink } = await hooked(tc, null, 'always');
    const acc = await linkCustom(t);
    await t.report(acc.id, [{ id: 'w', title: 'Quiet Game', playtime_minutes: 100 }]);
    const [hit] = await sink.waitFor(1);
    assert.equal(hit.body.event, 'sync.completed');
    assert.equal(hit.body.result.sessions_created, 0);
  });

  test('webhook_on=errors posts failures only, with the error and without credentials', async (tc) => {
    const { t, sink } = await hooked(tc, null, 'errors');
    fakePsn(psnTitle({ id: 'PPSA94001_00', name: 'X', minutes: 10 }));
    const custom = await linkCustom(t);
    await t.report(custom.id, [{ id: 'w', title: 'Fine Game', playtime_minutes: 100 }]);
    clock.set(T0 + DAY);
    await t.report(custom.id, [{ id: 'w', title: 'Fine Game', playtime_minutes: 160, last_played_at: iso(T0 + DAY - HOUR) }]);
    await quiet();
    assert.equal(sink.hits.length, 0, 'successful syncs are not reported');
    const bad = 'bad-npsso-that-must-stay-secret-1234';
    const psnAcc = await linkPsn(t, { npsso: bad, name: 'Broken PS5' });
    assert.ok((await t.syncNow(psnAcc.id)).status >= 400);
    const [hit] = await sink.waitFor(1);
    assert.equal(hit.body.event, 'sync.failed');
    assert.match(hit.body.error, /NPSSO/);
    assert.deepEqual(hit.body.account, { id: psnAcc.id, platform: 'psn', name: 'Broken PS5' });
    assert.ok(!hit.text.includes(bad), 'the NPSSO is never sent to the webhook');
  });

  test('Discord and Slack webhook URLs get chat-formatted messages within their size limits', async (tc) => {
    const discord = 'https://discord.com/api/webhooks/123456/tokenABC';
    const { t, sink } = await hooked(tc, discord, 'sessions');
    const acc = await linkCustom(t);
    const games = Array.from({ length: 40 }, (_, i) => ({ id: `g${i}`, title: `A Rather Long Game Title Number ${i} - Definitive Remaster Collection`, playtime_minutes: 100 }));
    await t.report(acc.id, games);
    clock.set(T0 + DAY);
    await t.report(acc.id, games.map((g) => ({ ...g, playtime_minutes: 130, last_played_at: iso(T0 + DAY - HOUR) })));
    const [d] = await sink.waitFor(1);
    assert.equal(d.host, 'discord.com');
    assert.equal(d.path, '/api/webhooks/123456/tokenABC');
    assert.deepEqual(Object.keys(d.body).sort(), ['content', 'username']);
    assert.equal(d.body.username, 'PlayTracker');
    assert.ok(d.body.content.length <= 2000, `Discord rejects content over 2000 chars (got ${d.body.content.length})`);
    assert.match(d.body.content, /40 session/);

    sink.clear();
    assert.equal((await t.api('PUT', '/settings', { webhook_url: 'https://hooks.slack.com/services/T000/B000/XXXX' })).status, 200);
    clock.set(T0 + 2 * DAY);
    await t.report(acc.id, [{ id: 'g1', title: games[1].title, playtime_minutes: 175, last_played_at: iso(T0 + 2 * DAY - HOUR) }]);
    const [s] = await sink.waitFor(1);
    assert.equal(s.host, 'hooks.slack.com');
    assert.deepEqual(Object.keys(s.body), ['text']);
    assert.match(s.body.text, /Number 1 /);
    assert.match(s.body.text, /45m/);
  });

  test('a failing webhook endpoint never fails the sync; the failure is logged', async (tc) => {
    const { t, sink } = await hooked(tc, null, 'always');
    sink.setStatus(500);
    const acc = await linkCustom(t);
    const r = await t.report(acc.id, [{ id: 'w', title: 'Unlucky Hook', playtime_minutes: 100 }]);
    assert.equal(r.status, 200, r.text);
    await sink.waitFor(1);
    for (let i = 0; i < 40 && !t.logs.warn.some((m) => /Webhook delivery failed/.test(m)); i++) await realSleep(25);
    assert.ok(t.logs.warn.some((m) => /Webhook delivery failed.*500/.test(m)), t.logs.warn.join('\n'));
    assert.equal(t.entry(acc.id, 'w').playtime_min, 100);
  });

  test('webhook URLs must be http(s)', async (tc) => {
    const t = await fresh(tc);
    for (const url of ['ftp://example.com/hook', 'javascript:alert(1)', 'file:///etc/passwd']) {
      const r = await t.api('PUT', '/settings', { webhook_url: url });
      assert.equal(r.status, 400, url);
    }
    assert.equal((await t.api('GET', '/settings')).body.webhook_url, '');
  });

  test('webhook_on only accepts sessions, always or errors', { todo: 'APP BUG psn-custom-13: PUT /settings accepts any webhook_on value (e.g. "sometimes"), which then posts on every sync' }, async (tc) => {
    const t = await fresh(tc);
    const r = await t.api('PUT', '/settings', { webhook_on: 'sometimes' });
    assert.equal(r.status, 400);
  });
});

// =====================================================================================
describe('Security boundaries for pushes', () => {
  test('with a password set, report and presence pushes need a valid token (Bearer, X-API-Key or api_key)', async (tc) => {
    const t = await fresh(tc, { password: 'correct horse battery staple' });
    const { token } = t.app.auth.createToken('home-assistant');
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await t.api('POST', '/accounts', { platform: 'custom', name: 'Switch', config: {} })).status, 401);
    const acc = (await t.api('POST', '/accounts', { platform: 'custom', name: 'Switch', config: {} }, auth)).body;
    const body = { games: [{ id: 'a', title: 'Guarded', playtime_minutes: 100 }] };
    assert.equal((await t.api('POST', `/accounts/${acc.id}/report`, body)).status, 401);
    assert.equal((await t.api('POST', `/accounts/${acc.id}/report`, body, { authorization: 'Bearer pt_wrongwrongwrong' })).status, 401);
    assert.equal((await t.api('POST', `/accounts/${acc.id}/presence`, { playing: [{ id: 'a' }] })).status, 401);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 0);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM presence').get().n, 0);
    assert.equal((await t.api('POST', `/accounts/${acc.id}/report`, body, auth)).status, 200);
    clock.advance(DAY);
    assert.equal((await t.api('POST', `/accounts/${acc.id}/report`, { games: [{ id: 'a', title: 'Guarded', playtime_minutes: 130 }] }, { 'x-api-key': token })).status, 200);
    clock.advance(DAY);
    assert.equal((await t.api('POST', `/accounts/${acc.id}/report?api_key=${encodeURIComponent(token)}`, { games: [{ id: 'a', title: 'Guarded', playtime_minutes: 160 }] })).status, 200);
    assert.equal((await t.api('POST', `/accounts/${acc.id}/presence`, { playing: [{ id: 'a' }] }, auth)).status, 200);
    await t.settle();
    assert.equal(t.entry(acc.id, 'a').playtime_min, 160);
  });

  test('a browser on another origin cannot push a report to an open (password-less) instance', async (tc) => {
    const t = await fresh(tc);
    const acc = await linkCustom(t);
    const r = await t.api('POST', `/accounts/${acc.id}/report`, { games: [{ id: 'a', title: 'CSRF', playtime_minutes: 999 }] }, { origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 0);
  });
});

// =====================================================================================
describe('Catalogue, API description and joining imported PSN data', () => {
  test('the platform catalogue and OpenAPI describe PSN credentials and the custom push endpoints', async (tc) => {
    const t = await fresh(tc);
    const platforms = (await t.api('GET', '/platforms')).body;
    const psn = platforms.find((p) => p.id === 'psn');
    const npsso = psn.fields.find((f) => f.key === 'npsso');
    assert.equal(npsso.type, 'password');
    assert.equal(npsso.required, true);
    assert.equal(psn.push, false);
    assert.equal(psn.can_enrich, true);
    const custom = platforms.find((p) => p.id === 'custom');
    assert.equal(custom.push, true);
    const spec = (await t.api('GET', '/api/openapi.json')).body;
    assert.ok(spec.paths['/api/v1/accounts/{id}/report']?.post, 'report endpoint documented');
    assert.ok(spec.paths['/api/v1/accounts/{id}/presence']?.post, 'presence endpoint documented');
    assert.match(spec.paths['/api/v1/accounts/{id}/report'].post.requestBody.content['application/json'].schema.description, /recent_minutes/);
  });

  test('linking PSN after importing a PSN spreadsheet joins the data: one entry, the platform total, imported sessions kept', async (tc) => {
    const t = await fresh(tc);
    const imp = await t.api('POST', '/import', { games: [{ title: 'Astro Run', platform: 'psn', playtime_minutes: 500, sessions: [{ date: '2026-02-20', minutes: 120 }] }] });
    assert.equal(imp.status, 200, imp.text);
    assert.equal(await lifetimeTotal(t), 500);
    fakePsn(psnTitle({ id: 'PPSA95001_00', name: 'Astro Run', minutes: 600, first: T0 - 100 * DAY, last: T0 - 2 * DAY, count: 12 }));
    const acc = await linkPsn(t);
    assert.equal((await t.syncNow(acc.id)).status, 200);
    const entries = t.db.prepare("SELECT * FROM entries WHERE platform = 'psn'").all();
    assert.equal(entries.length, 1, 'the synced entry takes over the imported copy');
    assert.equal(entries[0].account_id, acc.id);
    assert.equal(entries[0].playtime_min, 600, "the platform's total stands");
    assert.equal(await lifetimeTotal(t), 600, 'not 1100');
    const plays = playRows(t, entries[0].id);
    assert.equal(t.sum(plays), 120, 'the imported real session is kept as play');
    assert.equal(dayKey(plays[0].started_at ?? plays[0].window_start), '2026-02-20');
    const dups = (await t.api('GET', '/duplicates')).body;
    assert.equal(dups.counts?.double_counted ?? (dups.double_counted || []).length, 0);
    assertHealthy(t);
  });
});
