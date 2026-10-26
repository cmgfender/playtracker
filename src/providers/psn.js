import { ProviderError, spacer } from './http.js';
import { text, percent, unlockTime } from '../services/achievements.js';

// Same public client used by the PlayStation App (and the psn-api project).
const AUTH_BASE = 'https://ca.account.sony.com/api/authz/v3/oauth';
const CLIENT_ID = '09515159-7237-4370-9b40-3806e67c0891';
const BASIC = 'MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A=';
const REDIRECT = 'com.scee.psxandroid.scecompcall://redirect';
const SCOPE = 'psn:mobile.v2.core psn:clientapp';
const M = 'https://m.np.playstation.com/api';
const DAY = 86_400_000;

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

/** Earned-trophy timestamps from a trophies payload. */
export function earnedTimes(payload) {
  const out = [];
  for (const t of payload?.trophies || []) {
    if (!t.earned || !t.earnedDateTime) continue;
    const ms = Date.parse(t.earnedDateTime);
    if (Number.isFinite(ms) && ms > Date.UTC(2013, 0, 1)) out.push(ms);
  }
  return out;
}

/**
 * Trophy rows of one trophy set, from the player's earned list (trophyId, earned, earnedDateTime,
 * trophyType, trophyEarnedRate = % of players, trophyHidden) and the set's own list (trophyName,
 * trophyDetail, trophyIconUrl, trophyGroupId); either may be missing. Ids are
 * '<npCommunicationId>:<trophyId>' - a title can have two sets. `order` offsets the second set.
 */
export function parsePsnTrophies(earned, list, setId, order = 0) {
  const trophies = (v) => (Array.isArray(v) ? v : v?.trophies || []).filter((t) => t && t.trophyId != null);
  const mine = new Map(trophies(earned).map((t) => [String(t.trophyId), t]));
  const defs = new Map(trophies(list).map((t) => [String(t.trophyId), t]));
  return [...new Set([...defs.keys(), ...mine.keys()])].map((id, i) => {
    const t = mine.get(id) || {};
    const d = defs.get(id) || {};
    const pick = (k) => d[k] ?? t[k];
    const unlocked = t.earned === true;
    return {
      id: `${setId}:${id}`, name: text(pick('trophyName')), description: text(pick('trophyDetail')),
      icon_url: text(pick('trophyIconUrl')), icon_locked_url: null,
      unlocked, unlocked_at: unlocked ? unlockTime(t.earnedDateTime) : null,
      rarity: percent(t.trophyEarnedRate ?? d.trophyEarnedRate), points: null, grade: text(pick('trophyType'))?.toLowerCase() ?? null,
      hidden: pick('trophyHidden') == null ? null : !!pick('trophyHidden'), group: text(pick('trophyGroupId')), sort: order + i,
    };
  });
}

export const psn = {
  id: 'psn',
  label: 'PlayStation',
  fields: [
    { key: 'npsso', label: 'NPSSO token', type: 'password', required: true, help: 'Sign in at playstation.com, then open https://ca.account.sony.com/api/v1/ssocookie and copy the "npsso" value. It is exchanged for a refresh token (valid ~2 months).' },
    { key: 'presence', label: 'Live presence tracking', type: 'select', options: ['on', 'off'], required: false, help: 'Polls your online status every 3 minutes for exact session times.' },
  ],
  notes: 'The richest data of any platform: total play duration, first AND last played time and launch count per PS4/PS5 title - pre-tracking history is dated with high confidence. Live presence pins sessions to exact times. Your trophies (grade, rarity, earned times) are kept too.',
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
    history_anchors: 'first + last played + launch count (high confidence), plus trophy earned times (trophy API, ~1 request per game) for when play happened in between',
    achievements: 'Earned trophies (the enrichment request: earned time, grade, % of players) + the title\'s trophy list (names, details, icons; 1 request per trophy set, only while not stored yet)',
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

  /**
   * Trophy earned times: real moments of play between first and last played. Maps titles to
   * trophy sets 5 at a time, then reads each set's earned trophies (PS5 sets are "trophy2").
   * Kept well under Sony's ~300 requests / 15 min: spaced calls, at most 120 per run.
   */
  async enrich(account, entries, ctx, { maxCalls = 120, knownSets = false } = {}) {
    const tok = await getToken(account, ctx);
    if (tok.access_token !== account.state.access_token) Object.assign(account.state, tok);
    const headers = { Authorization: `Bearer ${tok.access_token}`, 'Accept-Language': 'en-US' };
    const gap = spacer(3200);
    const updates = [];
    let calls = 0;
    // trophy lists (names, icons) are read once per set, capped on their own per run
    const details = { calls: 0, max: maxCalls };
    for (let i = 0; i < entries.length && calls < maxCalls; i += 5) {
      if (ctx.stopped?.()) break;
      const batch = entries.slice(i, i + 5);
      let titles;
      // reading achievements again (knownSets): trophy sets mapped within the last day are reused
      const mapped = knownSets ? batch.map((e) => ctx.cache?.get(`psn:sets:${e.ext_id}`)) : [];
      if (knownSets && mapped.every(Boolean)) titles = new Map(batch.map((e, k) => [e.ext_id, mapped[k].value]));
      else {
        await gap(); calls++;
        try {
          const r = await ctx.http(`${M}/trophy/v1/users/me/titles/trophyTitles?npTitleIds=${batch.map((e) => encodeURIComponent(e.ext_id)).join(',')}`, { headers }, { retries: 1 });
          titles = new Map((r?.titles || []).map((t) => [t.npTitleId, t.trophyTitles || []]));
          for (const e of batch) ctx.cache?.set(`psn:sets:${e.ext_id}`, titles.get(e.ext_id) || [], DAY);
        } catch (err) {
          if (err.rateLimited || err.auth) break;
          const none = err.status === 404 || err.status === 400;
          for (const e of batch) updates.push({ entryId: e.id, anchors: [], done: none, ...(none ? { achievements: null } : {}) });
          continue;
        }
      }
      for (const e of batch) {
        const sets = titles.get(e.ext_id) || [];
        const u = { entryId: e.id, anchors: [], done: true };
        const items = [];
        for (const [k, set] of sets.slice(0, 2).entries()) {
          if (calls >= maxCalls || ctx.stopped?.()) { u.done = false; break; }
          await gap(); calls++;
          const svc = set.npServiceName || (JSON.parse(e.meta || '{}').category === 'ps5_native_game' ? 'trophy2' : 'trophy');
          let r = null;
          try {
            r = await ctx.http(`${M}/trophy/v1/users/me/npCommunicationIds/${encodeURIComponent(set.npCommunicationId)}/trophyGroups/all/trophies?npServiceName=${svc}`, { headers }, { retries: 1 });
            u.anchors.push(...earnedTimes(r));
          } catch (err) {
            if (err.rateLimited) { u.done = false; break; }
            if (!(err.status === 404 || err.status === 400 || err.status === 403)) u.done = false;
          }
          if (r) {
            const x = await this.trophyList(e, set.npCommunicationId, svc, r, ctx, { headers, gap, budget: details, order: k * 10_000 });
            items.push(...x.items);
            if (x.partial) u.partial = true;
          }
        }
        // read: the trophies, or none at all (no set, or every set refused)
        if (items.length || u.done) u.achievements = items.length ? items : null;
        updates.push(u);
      }
    }
    return { updates, state: tok };
  },

  /**
   * One trophy set's rows from its earned list, completed with the set's own list (names,
   * details, icons) unless every earned trophy is stored with its name already. partial = the
   * names were needed but could not be read now (read again later).
   */
  async trophyList(e, comm, svc, earned, ctx, { headers, gap, budget, order = 0 }) {
    const known = new Map((ctx.knownAchievements?.(e.id) || []).map((k) => [k.ach_id, k]));
    // (a set whose list Sony refused within the last day is not asked again)
    const need = (earned?.trophies || []).some((t) => t?.trophyId != null && !known.get(`${comm}:${t.trophyId}`)?.named) && !ctx.cache?.get(`psn:nolist:${comm}`);
    let list = null;
    let partial = false;
    if (need && (budget.calls >= budget.max || ctx.stopped?.())) partial = true;
    else if (need) {
      await gap(); budget.calls++;
      try {
        list = await ctx.http(`${M}/trophy/v1/npCommunicationIds/${encodeURIComponent(comm)}/trophyGroups/all/trophies?npServiceName=${svc}`, { headers }, { retries: 1 });
      } catch (err) {
        if (err.status === 404 || err.status === 400 || err.status === 403) ctx.cache?.set(`psn:nolist:${comm}`, true, DAY);
        else partial = true;
      }
    }
    return { items: parsePsnTrophies(earned, list, comm, order), partial };
  },

  /** Read titles' trophies again (played since, or never read): the requests of enrichment, sets mapped recently reused. */
  async achievements(account, entries, ctx, { maxCalls = 120 } = {}) {
    const { updates, state } = await this.enrich(account, entries, ctx, { maxCalls, knownSets: true });
    return { updates: updates.map(({ entryId, achievements, done, partial }) => ({ entryId, achievements, done, partial })), state };
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
        const playing = (p.gameTitleInfoList || []).map((g) => ({ extId: g.npTitleId, title: g.titleName, device: g.launchPlatform || g.format || null }));
        const status = p.primaryPlatformInfo?.onlineStatus || p.availability;
        const online = !status ? null : /^online$|^availabletoplay$/i.test(status) ? 'Online' : /offline|unavailable/i.test(status) ? 'Offline' : String(status);
        return { playing, online, seen: playing.map((g) => ({ id: g.extId, name: g.title, device: g.device })), state: tok };
      } catch (err) {
        if (err.rateLimited || err.auth) throw err; // the fallback id would only cost another call
        lastErr = err;
      }
    }
    throw lastErr;
  },
};
