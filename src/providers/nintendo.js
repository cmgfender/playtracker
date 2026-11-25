import crypto from 'node:crypto';
import { ProviderError } from './http.js';

// Play history is what Nintendo's store app shows under "Play Activity" (the Nintendo Store app,
// called My Nintendo in Japan before 2025). You sign in to your Nintendo Account once as that app's
// public client, and the session token it gives (valid about two years) reads the list.
//  - It has to be that client and scope: a token signed in as the Nintendo Switch Online app
//    (71b963c1b7b6d119) is turned away by the play history service with a 403.
//  - The service moved with the app's 2025 relaunch: the addresses older tools use are gone
//    (news-api.entry.nintendo.co.jp answers 590, a maintenance page; mypage-api.entry.nintendo.co.jp
//    no longer resolves). The current one needs a `gentry-locale` header, which also decides the
//    language of the titles, and names a title's console `platform` (HAC Switch, BEE Switch 2) where
//    the old ones said `deviceType`.
//  - It answers a client that says who it is, so Vestigo does: no app's User-Agent is borrowed.
const CLIENT_ID = '5c38e31cd085304b';
const REDIRECT = `npf${CLIENT_ID}://auth`;
const SCOPE = 'openid user user.mii user.email user.links[].id';
const ACCOUNTS = 'https://accounts.nintendo.com/connect/1.0.0';
const PLAY_HISTORY = 'https://app-api.znej.nintendo.com/api/v2.0/users/me/play_histories';
const ME = 'https://api.accounts.nintendo.com/2.0.0/users/me';
const LOCALE = 'en-US';
const UA = 'Vestigo (self-hosted play tracker)';

// sign-in links handed out and not used yet: the code verifier stays here, never in the link
const pending = new Map();
const PENDING_MS = 60 * 60_000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** A Nintendo Account sign-in link (PKCE); its verifier is kept for an hour, by the link's state. */
export function signInUrl(now = Date.now()) {
  for (const [k, v] of pending) if (v.at < now - PENDING_MS || pending.size > 20) pending.delete(k);
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(32));
  pending.set(state, { verifier, at: now });
  const params = new URLSearchParams({
    state, redirect_uri: REDIRECT, client_id: CLIENT_ID, scope: SCOPE, response_type: 'session_token_code',
    session_token_code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    session_token_code_challenge_method: 'S256', theme: 'login_form',
  });
  return { url: `${ACCOUNTS}/authorize?${params}`, expires_at: now + PENDING_MS };
}

/** The session token code and state of a pasted "npf…://auth#session_token_code=…" link. */
export function parseLink(link) {
  const s = String(link || '').trim();
  const hash = s.includes('#') ? s.slice(s.indexOf('#') + 1) : s.split('?')[1] || '';
  const p = new URLSearchParams(hash);
  return { code: p.get('session_token_code'), state: p.get('state') };
}

async function sessionToken(account, ctx) {
  if (account.config.session_token) return { token: String(account.config.session_token).trim(), fresh: false };
  if (account.state?.session_token) return { token: account.state.session_token, fresh: false };
  const { code, state } = parseLink(account.config.sign_in_link);
  if (!code) throw new ProviderError(`Paste the link of "Select this person" from the Nintendo sign-in page (it starts with ${REDIRECT})`, { auth: true });
  const p = pending.get(state);
  // (exchanged already, by a Test of the form before it was saved: a link works only once)
  if (p?.token) return { token: p.token, fresh: true };
  if (!p) throw new ProviderError('This sign-in link is from an earlier sign-in page (or Vestigo restarted since). Open the Nintendo sign-in again and paste the new link.', { auth: true });
  const r = await ctx.http(`${ACCOUNTS}/api/session_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA },
    body: new URLSearchParams({ client_id: CLIENT_ID, session_token_code: code, session_token_code_verifier: p.verifier }).toString(),
  }, { retries: 1 }).catch((err) => {
    if (err.status === 400) throw new ProviderError('Nintendo rejected this sign-in link (each one works once, for a few minutes). Open the Nintendo sign-in again and paste the new link.', { auth: true, status: 400 });
    throw err;
  });
  if (!r?.session_token) throw new ProviderError('Nintendo returned no session token for this sign-in link', { auth: true });
  p.token = r.session_token;
  return { token: r.session_token, fresh: true };
}

async function accessToken(account, ctx) {
  const { token, fresh } = await sessionToken(account, ctx);
  const r = await ctx.http(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ client_id: CLIENT_ID, session_token: token, grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer-session-token' }),
  }, { retries: 1 }).catch((err) => {
    if (err.status === 400 || err.status === 401) throw new ProviderError('Nintendo no longer accepts this sign-in (it lasts about two years, and ends if you sign out of all devices). Sign in again from the account\'s settings.', { auth: true, status: err.status });
    throw err;
  });
  if (!r?.access_token) throw new ProviderError('Nintendo returned no access token', { auth: true });
  return { access: r.access_token, id: r.id_token || null, session: fresh ? token : null };
}

const time = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) && t > 0 ? t : null; };

// What the play history service's refusals mean. A sign-in it does not take for its own app gets a
// bare "403 Forbidden" page, which reads like a network block that passes with time: it is not one.
// 590 is its maintenance page (and what a retired address answers for good).
const refused = (err) => {
  if (err?.status === 403) return new ProviderError('Nintendo\'s play history service refused this sign-in (403). Sign in again from the account\'s settings. If it is refused again, Nintendo has changed what its store app sends and Vestigo needs an update: export diagnostics from System', { auth: true, status: 403 });
  if (err?.status === 590) return new ProviderError('Nintendo\'s play history service is down for maintenance (590). It is tried again on the next sync. If it stays this way for days, Nintendo has moved the service and Vestigo needs an update: export diagnostics from System', { status: 590 });
  return err;
};

/**
 * Library items from a play_histories reply: lifetime minutes, first/last played, the last 7 days.
 * A title played on two consoles has an entry for each (Switch and Switch 2): they are one game here,
 * their minutes added. Titles you hid in the app (hiddenTitleList) stay out.
 */
export function parsePlayHistory(data) {
  const key = (t) => String(t?.titleId || '').toUpperCase();
  const hidden = new Set((data?.hiddenTitleList || []).map((h) => key(typeof h === 'string' ? { titleId: h } : h)).filter(Boolean));
  const recent = new Map();
  for (const day of data?.recentPlayHistories || []) {
    for (const t of day?.dailyPlayHistories || []) {
      const id = key(t);
      if (id) recent.set(id, (recent.get(id) || 0) + (Number(t.totalPlayedMinutes) || 0));
    }
  }
  const out = new Map();
  for (const t of data?.playHistories || []) {
    const id = key(t);
    if (!id || hidden.has(id)) continue;
    const minutes = Math.max(0, Math.floor(Number(t.totalPlayedMinutes) || 0));
    const first = time(t.firstPlayedAt); const last = time(t.lastPlayedAt);
    const device = t.platform || t.deviceType || null;
    const days = Number.isFinite(t.totalPlayedDays) ? t.totalPlayedDays : null;
    const it = out.get(id);
    if (!it) {
      out.set(id, { extId: id, title: t.titleName || id, playtimeMin: minutes, recentMin: recent.get(id) || 0, firstPlayedAt: first, lastPlayedAt: last,
        iconUrl: t.imageUrl || null, coverUrl: t.imageUrl || null, meta: { device, played_days: days } });
      continue;
    }
    it.playtimeMin += minutes;
    if (first && (!it.firstPlayedAt || first < it.firstPlayedAt)) it.firstPlayedAt = first;
    if (last && (!it.lastPlayedAt || last > it.lastPlayedAt)) it.lastPlayedAt = last;
    if (device && !String(it.meta.device || '').split('+').includes(device)) it.meta.device = it.meta.device ? `${it.meta.device}+${device}` : device;
    if (days != null) it.meta.played_days = (it.meta.played_days || 0) + days;
  }
  return [...out.values()];
}

export const nintendo = {
  id: 'nintendo',
  label: 'Nintendo',
  fields: [
    { key: 'sign_in_link', label: 'Sign-in link', type: 'password', required: false, sign_in: true, placeholder: `${REDIRECT}#session_token_code=…`,
      // (the button's link opens Nintendo's phone app: followed in a browser it goes nowhere, so it is copied)
      steps: [
        'Open the Nintendo sign-in and sign in to your Nintendo Account.',
        'On the page that follows, do not click "Select this person". Right-click it (on a phone, press and hold) and choose Copy Link Address.',
        'Paste the link below within an hour, then Connect.',
      ],
      help: `Clicking "Select this person" does nothing in Chrome, and Safari says the address is invalid: the link opens Nintendo's phone app, which a browser cannot do. That is expected. The link you copy starts with ${REDIRECT} and works once.` },
    { key: 'session_token', label: 'Session token', type: 'password', required: false, help: 'Instead of a sign-in link: a Nintendo Account session token for the Nintendo Store app (My Nintendo), from another tool. One for the Nintendo Switch Online app does not work here.' },
  ],
  notes: 'Your Nintendo Switch play history, as the Nintendo Store app shows it under Play Activity: total play time, first and last played per title, and the last 7 days day by day. One sign-in, kept for about two years.',
  profile: {
    history: {
      update: 'delayed',          // the console uploads play history now and then; hours can pass
      lag_min: 60,
      last_played: 'end',
      first_played: true,         // firstPlayedAt
      recent: { days: 7, strict: false },
      complete_library: true,
      single_title: true,
    },
  },
  capabilities: {
    lifetime: 'play_histories totalPlayedMinutes',
    recent: 'recentPlayHistories - minutes per title per day, last 7 days',
    last_played: 'lastPlayedAt',
    first_played: 'firstPlayedAt',
    play_count: null,
    per_device: null,
    presence: null,
    history_anchors: 'first + last played, days played',
    rate_limit: 'Undocumented; a sync costs 3 requests.',
    limitations: [
      'Uses the private API of the Nintendo Store app (My Nintendo), as its public client; no Nintendo Switch Online membership is needed.',
      'Play history reaches Nintendo when the console is online and uploads it, which can be hours after you play.',
      'No live "playing now", achievements or per-device minutes.',
      'Titles hidden from play history in the app are not listed.',
    ],
  },

  /** For the account form: a fresh sign-in link (PKCE; the verifier stays on this server). */
  signInUrl,

  /** What a new or edited account is missing, if anything. */
  checkConfig: (config) => (String(config.sign_in_link || '').trim() || String(config.session_token || '').trim() ? null : 'Missing: Sign-in link (or a session token)'),

  async fetchLibrary(account, ctx) {
    const tok = await accessToken(account, ctx);
    const get = (url, bearer, more = {}) => ctx.http(url, { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json', 'User-Agent': UA, ...more } }, { retries: 1 });
    const history = (bearer) => get(PLAY_HISTORY, bearer, { 'gentry-locale': LOCALE });
    let data;
    try {
      data = await history(tok.access);
    } catch (err) {
      // the play history service takes the ID token as well as the access token
      if ((err.status === 401 || err.status === 403) && tok.id) data = await history(tok.id).catch((again) => { throw refused(again); });
      else throw refused(err);
    }
    if (!Array.isArray(data?.playHistories)) throw new ProviderError(`Nintendo's play history came back in an unexpected shape (keys: ${Object.keys(data || {}).join(', ') || 'none'})`);
    const state = { ...(tok.session ? { session_token: tok.session } : {}) };
    try {
      const me = await get(ME, tok.access);
      if (me?.nickname) Object.assign(state, { persona: me.nickname, avatar: me.mii?.imageUriTemplate ? String(me.mii.imageUriTemplate).replace('{}', 'png?type=face&width=140') : null });
    } catch (err) { ctx.warn?.(`Nintendo profile: ${err.message}`); }
    return { items: parsePlayHistory(data), state };
  },
};
