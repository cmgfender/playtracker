import { httpJson, ProviderError } from './http.js';

// Same public client used by the PlayStation App (and the psn-api project).
const AUTH_BASE = 'https://ca.account.sony.com/api/authz/v3/oauth';
const CLIENT_ID = '09515159-7237-4370-9b40-3806e67c0891';
const BASIC = 'MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=';
const REDIRECT = 'com.scee.psxandroid.scecompcall://redirect';
const SCOPE = 'psn:mobile.v2.core psn:clientapp';

/** Parse ISO-8601 durations like "PT228H56M33S" / "P1DT2H" into whole minutes. */
export function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(String(iso || ''));
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  return Math.floor(Number(d) * 1440 + Number(h) * 60 + Number(min) + Number(s) / 60);
}

async function tokenRequest(body) {
  const data = await httpJson(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${BASIC}` },
    body: new URLSearchParams(body).toString(),
  }, { retries: 1 });
  const now = Date.now();
  return {
    access_token: data.access_token,
    access_expires_at: now + (data.expires_in - 60) * 1000,
    refresh_token: data.refresh_token,
    refresh_expires_at: now + ((data.refresh_token_expires_in || 5_184_000) - 60) * 1000,
  };
}

async function exchangeNpsso(npsso) {
  const params = new URLSearchParams({
    access_type: 'offline', client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE,
  });
  const res = await httpJson(`${AUTH_BASE}/authorize?${params}`, {
    headers: { Cookie: `npsso=${npsso}` }, redirect: 'manual', raw: true,
  }, { retries: 1 });
  const loc = res.headers.get('location') || '';
  const code = new URL(loc, 'https://x.invalid').searchParams.get('code');
  if (!code) throw new ProviderError('PSN rejected the NPSSO token. Grab a fresh one from https://ca.account.sony.com/api/v1/ssocookie while signed in.', { auth: true });
  return tokenRequest({ code, redirect_uri: REDIRECT, grant_type: 'authorization_code', token_format: 'jwt' });
}

async function getToken(account) {
  const s = account.state || {};
  const now = Date.now();
  if (s.access_token && s.access_expires_at > now) return s;
  if (s.refresh_token && s.refresh_expires_at > now) {
    try {
      return await tokenRequest({ refresh_token: s.refresh_token, grant_type: 'refresh_token', token_format: 'jwt', scope: SCOPE });
    } catch { /* fall through to npsso */ }
  }
  if (!account.config.npsso) throw new ProviderError('An NPSSO token is required', { auth: true });
  return exchangeNpsso(account.config.npsso.trim());
}

export const psn = {
  id: 'psn',
  label: 'PlayStation',
  fields: [
    { key: 'npsso', label: 'NPSSO token', type: 'password', required: true, help: 'Sign in at playstation.com, then open https://ca.account.sony.com/api/v1/ssocookie and copy the "npsso" value. It is exchanged for a refresh token (valid ~2 months).' },
  ],
  notes: 'PlayStation reports total play duration per PS4/PS5 title along with first/last played timestamps, which are used to pin sessions to the correct day.',

  async fetchLibrary(account) {
    const tok = await getToken(account);
    const state = { ...account.state, ...tok };
    const items = [];
    let offset = 0;
    for (let page = 0; page < 1000; page++) {
      const url = `https://m.np.playstation.com/api/gamelist/v2/users/me/titles?categories=ps4_game,ps5_native_game,pspc_game&limit=200&offset=${offset}`;
      const data = await httpJson(url, { headers: { Authorization: `Bearer ${tok.access_token}`, 'Accept-Language': 'en-US' } });
      for (const t of data?.titles || []) {
        items.push({
          extId: t.titleId,
          title: t.name || t.concept?.name || t.titleId,
          playtimeMin: parseDuration(t.playDuration),
          lastPlayedAt: t.lastPlayedDateTime ? Date.parse(t.lastPlayedDateTime) : null,
          firstPlayedAt: t.firstPlayedDateTime ? Date.parse(t.firstPlayedDateTime) : null,
          iconUrl: t.imageUrl || null,
          coverUrl: t.concept?.media?.images?.find((i) => i.type === 'MASTER')?.url || t.imageUrl || null,
          meta: { category: t.category, playCount: t.playCount, conceptId: t.concept?.id },
        });
      }
      if (data?.nextOffset == null || !(data.titles || []).length) break;
      offset = data.nextOffset;
    }
    return { items, state };
  },
};
