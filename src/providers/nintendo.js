import crypto from 'node:crypto';
import { ProviderError } from './http.js';

// The Nintendo Switch Online app's public client: you sign in to your Nintendo Account once, and the
// session token it gives (valid about two years) reads the app's play history - the same list the
// app shows under "Play history" (Switch and Switch 2 titles).
const CLIENT_ID = '71b963c1b7b6d119';
const REDIRECT = `npf${CLIENT_ID}://auth`;
const SCOPE = 'openid user user.birthday user.mii user.screenName';
const ACCOUNTS = 'https://accounts.nintendo.com/connect/1.0.0';
const PLAY_HISTORY = 'https://news-api.entry.nintendo.co.jp/api/v1.1/users/me/play_histories';
const ME = 'https://api.accounts.nintendo.com/2.0.0/users/me';
const UA = 'com.nintendo.znca/2.10.0 (Android/14)';

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
  if (!code) throw new ProviderError('Paste the link of "Select this person" from the Nintendo sign-in page (it starts with npf71b963c1b7b6d119://auth)', { auth: true });
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

/** Library items from a play_histories reply: lifetime minutes, first/last played, the last 7 days. */
export function parsePlayHistory(data) {
  const recent = new Map();
  for (const day of data?.recentPlayHistories || []) {
    for (const t of day?.dailyPlayHistories || []) {
      const id = String(t?.titleId || '');
      if (id) recent.set(id, (recent.get(id) || 0) + (Number(t.totalPlayedMinutes) || 0));
    }
  }
  return (data?.playHistories || []).filter((t) => t?.titleId).map((t) => ({
    extId: String(t.titleId),
    title: t.titleName || String(t.titleId),
    playtimeMin: Math.max(0, Math.floor(Number(t.totalPlayedMinutes) || 0)),
    recentMin: recent.get(String(t.titleId)) || 0,
    firstPlayedAt: time(t.firstPlayedAt),
    lastPlayedAt: time(t.lastPlayedAt),
    iconUrl: t.imageUrl || null,
    coverUrl: t.imageUrl || null,
    meta: { device: t.deviceType || null, played_days: Number.isFinite(t.totalPlayedDays) ? t.totalPlayedDays : null },
  }));
}

export const nintendo = {
  id: 'nintendo',
  label: 'Nintendo',
  fields: [
    { key: 'sign_in_link', label: 'Sign-in link', type: 'password', required: false, sign_in: true, placeholder: 'npf71b963c1b7b6d119://auth#session_token_code=…', help: 'Open the Nintendo sign-in and sign in. Then right-click (on a phone, long-press) "Select this person", copy the link and paste it here, within an hour.' },
    { key: 'session_token', label: 'Session token', type: 'password', required: false, help: 'Instead of a sign-in link: a Nintendo Account session token for the Nintendo Switch Online app, from another tool (nxapi).' },
  ],
  notes: 'Your Nintendo Switch play history, as the Nintendo Switch Online app shows it: total play time, first and last played per title, and the last 7 days day by day. One sign-in, kept for about two years.',
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
      'Uses the Nintendo Switch Online app\'s private API; no Nintendo Switch Online membership is needed.',
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
    const get = (url, bearer) => ctx.http(url, { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json', 'User-Agent': UA } }, { retries: 1 });
    let data;
    try {
      data = await get(PLAY_HISTORY, tok.access);
    } catch (err) {
      // the play history service has taken the ID token instead of the access token
      if ((err.status === 401 || err.status === 403) && tok.id) data = await get(PLAY_HISTORY, tok.id);
      else throw err;
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
