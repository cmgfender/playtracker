import { ProviderError } from './http.js';

// Same public client used by the PlayStation App (and the psn-api project).
const AUTH_BASE = 'https://ca.account.sony.com/api/authz/v3/oauth';
const CLIENT_ID = '09515159-7237-4370-9b40-3806e67c0891';
const BASIC = 'MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=';
const REDIRECT = 'com.scee.psxandroid.scecompcall://redirect';
const SCOPE = 'psn:mobile.v2.core psn:clientapp';
const M = 'https://m.np.playstation.com/api';

/** Parse ISO-8601 durations like "PT228H56M33S" / "P1DT2H" into whole minutes. */
export function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(String(iso || ''));
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  return Math.floor(Number(d) * 1440 + Number(h) * 60 + Number(min) + Number(s) / 60);
}

function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

async function tokenRequest(ctx, body) {
  const data = await ctx.http(`${AUTH_BASE}/token`, {
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

async function exchangeNpsso(ctx, npsso) {
  const params = new URLSearchParams({ access_type: 'offline', client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE });
  const res = await ctx.http(`${AUTH_BASE}/authorize?${params}`, { headers: { Cookie: `npsso=${npsso}` }, redirect: 'manual', raw: true }, { retries: 1 });
  const loc = res.headers.get('location') || '';
  const code = new URL(loc, 'https://x.invalid').searchParams.get('code');
  if (!code) throw new ProviderError('PSN rejected the NPSSO token. Sign in at playstation.com, then copy a fresh "npsso" from https://ca.account.sony.com/api/v1/ssocookie', { auth: true });
  return tokenRequest(ctx, { code, redirect_uri: REDIRECT, grant_type: 'authorization_code', token_format: 'jwt' });
}

async function getToken(account, ctx) {
  const s = account.state || {};
  const now = Date.now();
  if (s.access_token && s.access_expires_at > now) return s;
  if (s.refresh_token && s.refresh_expires_at > now) {
    try {
      return await tokenRequest(ctx, { refresh_token: s.refresh_token, grant_type: 'refresh_token', token_format: 'jwt', scope: SCOPE });
    } catch (err) { ctx.warn?.(`PSN token refresh failed, falling back to NPSSO: ${err.message}`); }
  }
  if (!account.config.npsso) throw new ProviderError('An NPSSO token is required', { auth: true });
  return exchangeNpsso(ctx, account.config.npsso.trim());
}

export const psn = {
  id: 'psn',
  label: 'PlayStation',
  fields: [
    { key: 'npsso', label: 'NPSSO token', type: 'password', required: true, help: 'Sign in at playstation.com, then open https://ca.account.sony.com/api/v1/ssocookie and copy the "npsso" value. It is exchanged for a refresh token (valid ~2 months).' },
    { key: 'presence', label: 'Live presence tracking', type: 'select', options: ['on', 'off'], required: false, help: 'Polls your online status every 3 minutes for exact session times.' },
  ],
  notes: 'The richest data of any platform: total play duration, first AND last played time and launch count per PS4/PS5 title - pre-tracking history is dated with high confidence. Live presence pins sessions to exact times.',
  profile: {
    history: {
      update: 'delayed',          // playDuration lands on Sony's backend after the session
      lag_min: 15,
      last_played: 'end',
      first_played: true,         // firstPlayedDateTime
      play_count: true,           // playCount = launches; deltas = sessions in a window
      complete_library: true,
      single_title: true,         // one game runs at a time per account
      grouping: 'concept',        // PS4 and PS5 versions of one game share a concept id
    },
    presence: { interval_sec: 180, sync_after_sec: 900 },
  },
  capabilities: {
    lifetime: 'gamelist v2 playDuration (ISO-8601 duration)',
    recent: null,
    last_played: 'lastPlayedDateTime',
    first_played: 'firstPlayedDateTime',
    play_count: 'playCount (number of launches) - deltas split syncs into individual sessions',
    per_device: 'category (ps4_game / ps5_native_game / pspc_game)',
    presence: 'basicPresences: gameTitleInfoList while online',
    history_anchors: 'first + last played + launch count (high confidence); trophy timestamps not needed',
    rate_limit: 'Undocumented; roughly 300 requests per 15 minutes. A sync costs ~1 request per 200 titles.',
    limitations: [
      'Only PS4 / PS5 (and PC titles using PSN) - no PS3, Vita or PSP.',
      'Uses the PlayStation App\'s private API; the NPSSO must be refreshed roughly every 2 months.',
      'playDuration can lag the end of a session by several minutes; streaming (PS Plus cloud) may not be counted.',
      'Titles you only own but never launched do not appear.',
    ],
  },

  async fetchLibrary(account, ctx) {
    const tok = await getToken(account, ctx);
    const claims = jwtClaims(tok.access_token);
    const state = { ...account.state, ...tok, account_id: account.state.account_id || claims.sub || claims.account_id || null };
    const items = [];
    let offset = 0;
    for (let page = 0; page < 1000; page++) {
      const data = await ctx.http(`${M}/gamelist/v2/users/me/titles?categories=ps4_game,ps5_native_game,pspc_game&limit=200&offset=${offset}`,
        { headers: { Authorization: `Bearer ${tok.access_token}`, 'Accept-Language': 'en-US' } });
      for (const t of data?.titles || []) {
        items.push({
          extId: t.titleId,
          title: t.name || t.concept?.name || t.titleId,
          playtimeMin: parseDuration(t.playDuration),
          lastPlayedAt: t.lastPlayedDateTime ? Date.parse(t.lastPlayedDateTime) : null,
          firstPlayedAt: t.firstPlayedDateTime ? Date.parse(t.firstPlayedDateTime) : null,
          playCount: Number.isFinite(t.playCount) ? t.playCount : null,
          iconUrl: t.imageUrl || null,
          coverUrl: t.concept?.media?.images?.find((i) => i.type === 'MASTER')?.url || t.imageUrl || null,
          groupKey: t.concept?.id ? `psn-concept:${t.concept.id}` : null,
          meta: { category: t.category, conceptId: t.concept?.id },
        });
      }
      if (data?.nextOffset == null || !(data.titles || []).length) break;
      offset = data.nextOffset;
    }
    return { items, state };
  },

  async presence(account, ctx) {
    const tok = await getToken(account, ctx);
    if (tok.access_token !== account.state.access_token) Object.assign(account.state, tok); // caller persists state
    const ids = [account.state.account_id, 'me'].filter(Boolean);
    let lastErr;
    for (const id of ids) {
      try {
        const data = await ctx.http(`${M}/userProfile/v1/internal/users/${id}/basicPresences?type=primary`, { headers: { Authorization: `Bearer ${tok.access_token}` } }, { retries: 0 });
        const p = data?.basicPresence || {};
        return { playing: (p.gameTitleInfoList || []).map((g) => ({ extId: g.npTitleId, title: g.titleName, device: g.launchPlatform || g.format || null })), state: tok };
      } catch (err) { lastErr = err; }
    }
    throw lastErr;
  },
};
