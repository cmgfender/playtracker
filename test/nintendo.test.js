// Nintendo: the play history the Nintendo Store app shows. A sign-in link (PKCE, its verifier kept on
// the server) becomes a session token; each sync turns it into an access token and reads total
// minutes, first/last played and the last 7 days per title. Imported Switch rows join these games.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { nintendo, parseLink, parsePlayHistory, signInUrl } from '../src/providers/nintendo.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const DAY = 86_400_000;

const history = (minutes = { zelda: 3000, kirby: 45 }) => ({
  playHistories: [
    { titleId: '01007EF00011E000', titleName: 'The Legend of Zelda: Breath of the Wild', deviceType: 'HAC', imageUrl: 'https://img/zelda.jpg', firstPlayedAt: '2023-01-10T12:00:00+09:00', lastPlayedAt: new Date(Date.now() - 2 * DAY).toISOString(), totalPlayedDays: 80, totalPlayedMinutes: minutes.zelda },
    { titleId: '01004D300C5AE000', titleName: 'Kirby and the Forgotten Land', deviceType: 'HAC', imageUrl: 'https://img/kirby.jpg', firstPlayedAt: new Date(Date.now() - 5 * DAY).toISOString(), lastPlayedAt: new Date(Date.now() - DAY).toISOString(), totalPlayedDays: 2, totalPlayedMinutes: minutes.kirby },
  ],
  recentPlayHistories: [
    { playedDate: '2026-11-20T00:00:00+09:00', dailyPlayHistories: [{ titleId: '01004D300C5AE000', titleName: 'Kirby', totalPlayedMinutes: 30 }] },
    { playedDate: '2026-11-21T00:00:00+09:00', dailyPlayHistories: [{ titleId: '01004D300C5AE000', titleName: 'Kirby', totalPlayedMinutes: 15 }, { titleId: '01007EF00011E000', titleName: 'Zelda', totalPlayedMinutes: 60 }] },
  ],
  hiddenTitleList: [],
  lastUpdatedAt: new Date().toISOString(),
});

/** A ctx whose http answers like Nintendo's accounts and play-history services. */
function fakeNintendo({ reply = () => history(), sessionCode = 'CODE', playStatus = 200, refuseId = false } = {}) {
  const calls = [];
  const http = async (url, opts = {}) => {
    calls.push({ url, opts });
    const fail = (status) => Object.assign(new Error(`responded ${status}`), { status });
    if (url.endsWith('/api/session_token')) {
      const b = new URLSearchParams(opts.body);
      if (b.get('session_token_code') !== sessionCode || !b.get('session_token_code_verifier')) throw fail(400);
      return { session_token: 'SESSION', code: 'x' };
    }
    if (url.endsWith('/api/token')) {
      if (JSON.parse(opts.body).session_token !== 'SESSION') throw fail(400);
      return { access_token: 'ACCESS', id_token: 'ID', expires_in: 900 };
    }
    if (url.includes('play_histories')) {
      if (playStatus !== 200 && (refuseId || opts.headers.Authorization === 'Bearer ACCESS')) throw fail(playStatus);
      return reply();
    }
    if (url.includes('/users/me')) return { id: 'n1', nickname: 'Link', mii: { imageUriTemplate: 'https://mii/{}' } };
    throw fail(404);
  };
  return { calls, ctx: { http, warn() {} } };
}

const linkFor = (url, code = 'CODE') => `npf5c38e31cd085304b://auth#session_token_code=${code}&state=${new URL(url).searchParams.get('state')}&session_state=x`;

test('the sign-in link carries a PKCE challenge, never the verifier; a pasted link gives back its code and state', () => {
  const { url } = signInUrl();
  const u = new URL(url);
  // as the Nintendo Store app (My Nintendo), whose play history it is: the Switch Online app's sign-in is refused there
  assert.equal(u.searchParams.get('client_id'), '5c38e31cd085304b');
  assert.equal(u.searchParams.get('redirect_uri'), 'npf5c38e31cd085304b://auth');
  assert.equal(u.searchParams.get('scope'), 'openid user user.mii user.email user.links[].id');
  assert.equal(u.searchParams.get('session_token_code_challenge_method'), 'S256');
  assert.match(u.searchParams.get('session_token_code_challenge'), /^[\w-]{43}$/);
  assert.ok(!u.searchParams.has('session_token_code_verifier'));
  assert.deepEqual(parseLink(linkFor(url, 'abc')), { code: 'abc', state: u.searchParams.get('state') });
  assert.deepEqual(parseLink('nonsense'), { code: null, state: null });
});

test('a sync signs in once, then reads totals, first/last played and the last 7 days', async () => {
  const { url } = signInUrl();
  const { ctx, calls } = fakeNintendo();
  const account = { config: { sign_in_link: linkFor(url) }, state: {} };
  const r = await nintendo.fetchLibrary(account, ctx);
  assert.equal(r.state.session_token, 'SESSION');
  assert.equal(r.state.persona, 'Link');
  for (const c of calls) assert.match(c.opts.headers['User-Agent'], /^com\.nintendo\.znej\//, `${c.url} is asked as the store app`);
  assert.equal(JSON.parse(calls.find((c) => c.url.endsWith('/api/token')).opts.body).client_id, '5c38e31cd085304b');
  const kirby = r.items.find((i) => i.extId === '01004D300C5AE000');
  assert.equal(kirby.playtimeMin, 45);
  assert.equal(kirby.recentMin, 45, 'the days add up');
  assert.equal(r.items.find((i) => i.extId === '01007EF00011E000').firstPlayedAt, Date.parse('2023-01-10T03:00:00Z'));
  assert.equal(calls.filter((c) => c.url.endsWith('/api/session_token')).length, 1);
  // the next sync uses the session token it kept
  const again = fakeNintendo();
  await nintendo.fetchLibrary({ config: account.config, state: r.state }, again.ctx);
  assert.equal(again.calls.filter((c) => c.url.endsWith('/api/session_token')).length, 0);
});

test('sign-in problems say what to do', async () => {
  const stale = fakeNintendo();
  await assert.rejects(nintendo.fetchLibrary({ config: { sign_in_link: 'npf5c38e31cd085304b://auth#session_token_code=CODE&state=unknown' }, state: {} }, stale.ctx), (e) => e.auth && /earlier sign-in page/.test(e.message));
  await assert.rejects(nintendo.fetchLibrary({ config: { sign_in_link: 'https://example.com' }, state: {} }, stale.ctx), (e) => e.auth && /Select this person/.test(e.message));
  const used = fakeNintendo({ sessionCode: 'OTHER' });
  await assert.rejects(nintendo.fetchLibrary({ config: { sign_in_link: linkFor(signInUrl().url) }, state: {} }, used.ctx), (e) => e.auth && /works once/.test(e.message));
  const revoked = fakeNintendo();
  await assert.rejects(nintendo.fetchLibrary({ config: { session_token: 'REVOKED' }, state: {} }, revoked.ctx), (e) => e.auth && /Sign in again/.test(e.message));
  // refused as the wrong app (a bare 403 page, for the access token and the ID token alike): not "a temporary block"
  const wrongApp = fakeNintendo({ playStatus: 403, refuseId: true });
  await assert.rejects(nintendo.fetchLibrary({ config: { session_token: 'SESSION' }, state: {} }, wrongApp.ctx), (e) => e.auth && e.status === 403 && /refused this sign-in \(403\)\. Sign in again/.test(e.message));
  assert.deepEqual(wrongApp.calls.filter((c) => c.url.includes('play_histories')).map((c) => `${new URL(c.url).hostname} ${c.opts.headers.Authorization}`),
    ['news-api.entry.nintendo.co.jp Bearer ACCESS', 'news-api.entry.nintendo.co.jp Bearer ID', 'mypage-api.entry.nintendo.co.jp Bearer ACCESS'], 'the access token, the ID token, then the older address');
  // something else than "no" (the service is down) is the error at once, not three tries
  const down = fakeNintendo({ playStatus: 503, refuseId: true });
  await assert.rejects(nintendo.fetchLibrary({ config: { session_token: 'SESSION' }, state: {} }, down.ctx), (e) => e.status === 503);
  assert.equal(down.calls.filter((c) => c.url.includes('play_histories')).length, 1);
  const odd = fakeNintendo({ reply: () => ({ error: 'x' }) });
  await assert.rejects(nintendo.fetchLibrary({ config: { session_token: 'SESSION' }, state: {} }, odd.ctx), /unexpected shape \(keys: error\)/);
});

test('a link tested before the account is saved still works for the save (each link works once)', async () => {
  const link = linkFor(signInUrl().url);
  const first = fakeNintendo();
  await nintendo.fetchLibrary({ config: { sign_in_link: link }, state: {} }, first.ctx);
  const second = fakeNintendo({ sessionCode: 'USED' });
  const r = await nintendo.fetchLibrary({ config: { sign_in_link: link }, state: {} }, second.ctx);
  assert.equal(r.state.session_token, 'SESSION');
  assert.equal(second.calls.filter((c) => c.url.endsWith('/api/session_token')).length, 0);
});

test('play history refusing the access token is asked again with the ID token', async () => {
  const { ctx, calls } = fakeNintendo({ playStatus: 401 });
  const r = await nintendo.fetchLibrary({ config: { session_token: 'SESSION' }, state: {} }, ctx);
  assert.equal(r.items.length, 2);
  assert.deepEqual(calls.filter((c) => c.url.includes('play_histories')).map((c) => c.opts.headers.Authorization), ['Bearer ACCESS', 'Bearer ID']);
});

test('parsePlayHistory skips rows without a title id and odd numbers', () => {
  const items = parsePlayHistory({ playHistories: [{ titleName: 'x' }, { titleId: 'A', totalPlayedMinutes: 'lots', firstPlayedAt: 'never' }] });
  assert.deepEqual(items.map((i) => [i.extId, i.playtimeMin, i.firstPlayedAt, i.recentMin]), [['A', 0, null, 0]]);
});

test('through the app: link an account, sync, new play becomes a session, an imported Switch row joins the game', async () => {
  const { server, close, app } = createApp({ dbFile: ':memory:', password: '', scheduler: false, log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (p, opts = {}) => (await fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body && JSON.stringify(opts.body) })).json();
  let minutes = { zelda: 3000, kirby: 45 };
  const fake = fakeNintendo({ reply: () => history(minutes) });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts);
    try { return new Response(JSON.stringify(await fake.ctx.http(String(url), opts)), { status: 200, headers: { 'content-type': 'application/json' } }); } catch (e) { return new Response('{}', { status: e.status || 500 }); }
  };
  try {
    const platforms = await call('/platforms');
    const n = platforms.find((p) => p.id === 'nintendo');
    assert.equal(n.sign_in, true);
    const { url } = await call('/platforms/nintendo/sign-in');
    assert.match(url, /^https:\/\/accounts\.nintendo\.com\/connect\/1\.0\.0\/authorize\?/);
    const none = await fetch(`${base}/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'nintendo', config: {} }) });
    assert.equal(none.status, 400);
    assert.match((await none.json()).error, /Sign-in link/);
    const acc = await call('/accounts', { method: 'POST', body: { platform: 'nintendo', config: { sign_in_link: linkFor(url) }, sync: false } });
    assert.match(acc.config.sign_in_link, /^••••••/, 'the link is kept like a password');
    await app.sync.sync(acc.id, 'initial');
    const after = (await call('/accounts')).find((a) => a.id === acc.id);
    assert.equal(after.last_status, 'ok', after.last_error);
    assert.equal(after.profile.name, 'Link');
    const db = app.db;
    const total = () => db.prepare("SELECT SUM(playtime_min) m FROM entries WHERE platform = 'nintendo'").get().m;
    assert.equal(total(), 3045);
    // two hours of Zelda since
    minutes = { zelda: 3120, kirby: 45 };
    await app.sync.sync(acc.id, 'manual');
    const play = db.prepare("SELECT s.minutes FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.platform = 'nintendo' AND s.kind = 'play' AND s.sync_id IS NOT NULL ORDER BY s.id DESC LIMIT 1").get();
    assert.equal(play?.minutes, 120);
    assert.deepEqual(db.prepare('SELECT e.id FROM entries e LEFT JOIN sessions s ON s.entry_id = e.id GROUP BY e.id HAVING COALESCE(SUM(s.minutes), 0) != e.playtime_min').all(), []);
    // a spreadsheet's Switch row of the same game is the synced one, not a second copy
    await call('/import', { method: 'POST', body: { games: [{ title: 'The Legend of Zelda: Breath of the Wild', platform: 'switch', playtime_minutes: 3000 }] } });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM entries WHERE platform = 'switch'").get().n, 0);
  } finally {
    globalThis.fetch = realFetch;
    close();
  }
});
