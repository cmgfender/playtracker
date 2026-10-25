import { ProviderError, spacer } from './http.js';
import { text, percent, cached } from '../services/achievements.js';

// GetPlayerSummaries personastate
const PERSONA = ['Offline', 'Online', 'Busy', 'Away', 'Snooze', 'Looking to trade', 'Looking to play'];

const API = 'https://api.steampowered.com';
const STORE = 'https://store.steampowered.com/api';

function parseReleaseDate(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(/(\d+)(st|nd|rd|th)/, '$1'));
  return Number.isFinite(t) ? t : null;
}

const DAY = 86_400_000;

/**
 * Achievement rows from the player's list (GetPlayerAchievements with l=english: unlock state and
 * time, names), the game's schema (GetSchemaForGame: full list, icons, hidden flag) and global
 * unlock percentages (GetGlobalAchievementPercentagesForApp). Each part may be missing; a whole
 * response or just its inner list is accepted.
 */
export function parseSteamAchievements(player, schema = null, percentages = null) {
  const list = (v, inner) => (Array.isArray(v) ? v : inner(v) || []);
  const mine = list(player, (v) => v?.playerstats?.achievements).filter((a) => a && a.apiname != null);
  const defs = list(schema, (v) => v?.game?.availableGameStats?.achievements).filter((d) => d && d.name != null);
  const pct = new Map(list(percentages, (v) => v?.achievementpercentages?.achievements).filter((x) => x && x.name != null).map((x) => [String(x.name), x.percent]));
  const byId = new Map(mine.map((a) => [String(a.apiname), a]));
  const def = new Map(defs.map((d) => [String(d.name), d]));
  // the schema's order (it lists every achievement), then any it doesn't know
  const ids = [...new Set([...def.keys(), ...byId.keys()])];
  return ids.map((id, i) => {
    const a = byId.get(id) || {};
    const d = def.get(id) || {};
    const unlocked = Number(a.achieved) === 1;
    // the player's English texts first: every read has them (the schema only the first)
    return {
      id,
      name: text(a.name) ?? text(d.displayName) ?? id,
      description: text(a.description) ?? text(d.description),
      icon_url: text(d.icon), icon_locked_url: text(d.icongray),
      unlocked, unlocked_at: unlocked && Number(a.unlocktime) > 0 ? Number(a.unlocktime) * 1000 : null,
      rarity: percent(pct.get(id)), points: null, grade: null,
      hidden: d.hidden == null ? null : Number(d.hidden) === 1, group: null, sort: i,
    };
  });
}

/** The parts of a schema reply achievements need (kept small: it is cached per app). */
function schemaAchievements(r) {
  const list = r?.game?.availableGameStats?.achievements;
  return Array.isArray(list) ? list.map((d) => ({ name: d.name, displayName: d.displayName, description: d.description, hidden: d.hidden, icon: d.icon, icongray: d.icongray })) : [];
}

export const steam = {
  id: 'steam',
  label: 'Steam',
  fields: [
    { key: 'api_key', label: 'Steam Web API key', type: 'password', required: true, help: 'Get one at https://steamcommunity.com/dev/apikey' },
    { key: 'steam_id', label: 'SteamID64, vanity name or profile URL', type: 'text', required: true, help: 'Profile → Edit Profile → Privacy: "My profile" and "Game details" must be Public.' },
    { key: 'presence', label: 'Live presence tracking', type: 'select', options: ['on', 'off'], required: false, help: 'Polls "currently playing" every 2 minutes for exact session start/end times (720 calls/day of your 100k).' },
  ],
  notes: 'Lifetime + last-2-weeks minutes per game, last played time, per-device minutes (Windows/Mac/Linux/Steam Deck), live "currently playing", and your achievements (names, icons, rarity and unlock times, which also date your history).',
  profile: {
    history: {
      update: 'on-exit',          // playtime_forever is written when the game exits
      lag_min: 1,
      last_played: 'start',       // rtime_last_played is stamped at launch (auto-calibrated via presence)
      recent: { days: 14, strict: true }, // playtime_2weeks bounds how much of a delta is recent
      devices: ['windows', 'mac', 'linux', 'deck', 'offline'],
      offline_counter: 'offline', // playtime_disconnected grows when offline play is uploaded
      single_title: true,         // one game runs at a time per account
      complete_library: true,
    },
    presence: { interval_sec: 120, sync_after_sec: 90 },
  },
  capabilities: {
    lifetime: 'GetOwnedGames.playtime_forever (minutes)',
    recent: 'playtime_2weeks - minutes in the last 14 days',
    last_played: 'rtime_last_played (unix time)',
    first_played: null,
    play_count: null,
    per_device: 'playtime_windows/mac/linux/deck_forever + playtime_disconnected (offline)',
    presence: 'GetPlayerSummaries.gameid while in-game',
    history_anchors: 'GetPlayerAchievements unlock times; store release date; account creation date',
    achievements: 'GetPlayerAchievements (unlocks, English names) + GetSchemaForGame (icons, hidden flag; cached per app) + GetGlobalAchievementPercentagesForApp (rarity)',
    rate_limit: '100,000 Web API calls per day per key; store API ~200 requests / 5 minutes',
    limitations: [
      'No session history, purchase date or "date added" - only lifetime totals.',
      'Playtime is written when a game exits; a game left running shows up on the sync after it closes.',
      'Offline play is reported when the client reconnects (tracked as playtime_disconnected).',
      'Private profiles / private "Game details" return no games; presence needs a public profile.',
      'Family Sharing borrowed games and non-Steam shortcuts are not included.',
      'Minute granularity.',
    ],
  },

  async resolveId(cfg, ctx) {
    let id = String(cfg.steam_id || '').trim();
    const m = id.match(/steamcommunity\.com\/(id|profiles)\/([^/?#]+)/i);
    if (m) id = m[2];
    if (/^\d{17}$/.test(id)) return id;
    const data = await ctx.http(`${API}/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(cfg.api_key)}&vanityurl=${encodeURIComponent(id)}`);
    if (data?.response?.success !== 1) throw new ProviderError(`Could not resolve Steam vanity name "${id}"`);
    return data.response.steamid;
  },

  async summary(account, ctx, steamid) {
    const data = await ctx.http(`${API}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(account.config.api_key)}&steamids=${steamid}`);
    return data?.response?.players?.[0] || null;
  },

  async fetchLibrary(account, ctx) {
    const cfg = account.config;
    if (!cfg.api_key || !cfg.steam_id) throw new ProviderError('Steam API key and Steam ID are required', { auth: true });
    const state = { ...account.state };
    if (!state.steamid64 || state.steam_id_input !== cfg.steam_id) {
      state.steamid64 = await this.resolveId(cfg, ctx);
      state.steam_id_input = cfg.steam_id;
    }
    // Account creation date bounds all inferred history; refresh profile weekly.
    if (!state.profile_at || Date.now() - state.profile_at > 7 * 86_400_000) {
      try {
        const p = await this.summary(account, ctx, state.steamid64);
        if (p) {
          if (p.timecreated) state.account_created_at = p.timecreated * 1000;
          state.persona = p.personaname;
          state.avatar = p.avatarfull;
          state.public = p.communityvisibilitystate === 3;
        }
        state.profile_at = Date.now();
      } catch (err) { ctx.warn?.(`Profile lookup failed: ${err.message}`); }
    }
    const url = `${API}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(cfg.api_key)}&steamid=${state.steamid64}&include_appinfo=1&include_played_free_games=1&skip_unvetted_apps=0&format=json`;
    const data = await ctx.http(url);
    const games = data?.response?.games;
    if (!Array.isArray(games)) {
      // a privacy setting, not a credentials problem (the key and id were accepted)
      throw new ProviderError('Steam returned no games. Make sure your profile and "Game details" privacy are set to Public.');
    }
    const items = games.map((g) => ({
      extId: String(g.appid),
      title: g.name || `App ${g.appid}`,
      playtimeMin: Number(g.playtime_forever) || 0,
      recentMin: Number(g.playtime_2weeks) || 0,
      recentWindowDays: 14,
      lastPlayedAt: g.rtime_last_played ? g.rtime_last_played * 1000 : null,
      iconUrl: g.img_icon_url ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg` : null,
      // newer apps keep their art under hashed paths (resolved once via resolveCovers)
      coverUrl: account.state.covers?.[g.appid] || `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/library_600x900.jpg`,
      devices: {
        windows: g.playtime_windows_forever || 0, mac: g.playtime_mac_forever || 0, linux: g.playtime_linux_forever || 0,
        deck: g.playtime_deck_forever || 0, offline: g.playtime_disconnected || 0,
      },
      meta: {
        header: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`,
        store: `https://store.steampowered.com/app/${g.appid}`,
        has_stats: !!g.has_community_visible_stats,
      },
    }));
    return { items, state };
  },

  async presence(account, ctx) {
    const id = account.state.steamid64;
    if (!id) return null;
    const p = await this.summary(account, ctx, id);
    if (!p) return null;
    if (p.communityvisibilitystate !== 3) return { playing: [], unavailable: 'Profile is private - presence unavailable' };
    const playing = p.gameid ? [{ extId: String(p.gameid), title: p.gameextrainfo || null }] : [];
    return { playing, online: PERSONA[p.personastate] ?? null, seen: playing.map((g) => ({ id: g.extId, name: g.title })) };
  },

  /**
   * Real cover art paths from the store (IStoreBrowseService/GetItems, 100 apps per request).
   * Older apps live at the classic library_600x900.jpg path; newer ones only under a hashed
   * path, and some have no portrait capsule at all (then the header image is used).
   * Returns { appid: url } for apps whose art is NOT at the classic path.
   */
  async resolveCovers(account, appids, ctx, { maxCalls = 10 } = {}) {
    const out = {};
    const checked = [];
    for (let i = 0; i < appids.length && i / 100 < maxCalls; i += 100) {
      const ids = appids.slice(i, i + 100);
      const input = { ids: ids.map((appid) => ({ appid: Number(appid) })), context: { language: 'english', country_code: 'US' }, data_request: { include_assets: true } };
      let r;
      try {
        r = await ctx.http(`${API}/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`, {}, { retries: 1 });
      } catch (err) {
        ctx.warn?.(`Steam cover lookup: ${err.message}`);
        break;
      }
      for (const it of r?.response?.store_items || []) {
        const a = it.assets;
        if (!a?.asset_url_format) continue;
        const file = a.library_capsule || a.header;
        if (!file) continue;
        const url = `https://shared.cloudflare.steamstatic.com/store_item_assets/${a.asset_url_format.replace('${FILENAME}', file)}`;
        // classic = the classic file in the classic directory (a hashed directory is not, whatever the file is called)
        const appid = it.appid ?? it.id;
        const classicPath = a.asset_url_format.replace(/\?.*$/, '') === `steam/apps/${appid}/\${FILENAME}`;
        if (!(classicPath && file === 'library_600x900.jpg')) out[appid] = url;
      }
      checked.push(...ids);
    }
    return { covers: out, checked };
  },

  /**
   * Date pre-tracking history: achievement unlock times (when play actually happened) and
   * store release dates (lower bound). Largest histories first; spaced to respect limits.
   */
  async enrich(account, entries, ctx) {
    const key = encodeURIComponent(account.config.api_key);
    const steamid = account.state.steamid64;
    const apiGap = spacer(250);
    const storeGap = spacer(1600);
    const updates = [];
    let calls = 0;
    // schema / rarity lookups (at most 2 per title) are capped on their own: the dating calls keep
    // their pace, and every title of a run (at most 400 asked) gets its details
    const details = { calls: 0, max: 800 };
    for (const e of entries) {
      if (ctx.stopped?.()) break;
      const u = { entryId: e.id, anchors: [], release_at: undefined, done: true };
      const meta = JSON.parse(e.meta || '{}');
      if (meta.has_stats === false) u.achievements = null; // no stats, no achievements
      if (meta.has_stats !== false && steamid && calls < 400) {
        await apiGap(); calls++;
        let r = null;
        try {
          r = await ctx.http(`${API}/ISteamUserStats/GetPlayerAchievements/v1/?key=${key}&steamid=${steamid}&appid=${e.ext_id}&l=english`, {}, { retries: 1 });
          for (const a of r?.playerstats?.achievements || []) if (a.achieved && a.unlocktime > 0) u.anchors.push(a.unlocktime * 1000);
        } catch (err) {
          // 400/403 = game has no stats or stats are private: nothing to learn, not an error
          if (!(err.status === 400 || err.status === 403)) { u.done = false; ctx.warn?.(`Achievements for ${e.title}: ${err.message}`); } else u.achievements = null;
        }
        if (r) u.achievements = await this.achievementDetails(account, e, r, ctx, apiGap, details);
      }
      if (calls < 400) {
        await storeGap();
        try {
          const r = await ctx.http(`${STORE}/appdetails?appids=${e.ext_id}&filters=release_date`, {}, { retries: 1 });
          const rd = r?.[e.ext_id]?.data?.release_date;
          if (rd && !rd.coming_soon) u.release_at = parseReleaseDate(rd.date) ?? undefined;
        } catch (err) {
          if (err.rateLimited) { u.done = false; updates.push(u); break; }
        }
      }
      updates.push(u);
    }
    return { updates };
  },

  /**
   * Complete one title's achievements from its GetPlayerAchievements reply: the schema (icons,
   * hidden flag, the full list) only while stored rows lack it, and global rarity - both cached
   * per app for a day (a failed lookup for an hour). Lookups that fail are skipped quietly (games
   * without stats answer errors or empty lists); `budget` caps them per run.
   */
  async achievementDetails(account, e, player, ctx, gap, budget = { calls: 0, max: Infinity }) {
    const list = player?.playerstats?.achievements;
    if (!Array.isArray(list) || !list.length) return []; // read: this game has none
    const appid = encodeURIComponent(e.ext_id);
    const lookup = async (url) => {
      if (budget.calls >= budget.max || ctx.stopped?.()) throw Object.assign(new Error('no budget left in this run'), { skipped: true });
      await gap(); budget.calls++;
      return ctx.http(url, {}, { retries: 0 });
    };
    const known = new Map((ctx.knownAchievements?.(e.id) || []).map((k) => [k.ach_id, k]));
    const schema = list.some((a) => !known.get(String(a.apiname))?.iconed)
      ? await cached(ctx.cache, `steam:schema:${e.ext_id}`, DAY, async () => schemaAchievements(await lookup(`${API}/ISteamUserStats/GetSchemaForGame/v2/?key=${encodeURIComponent(account.config.api_key)}&appid=${appid}&l=english`)))
      : null;
    const rarity = await cached(ctx.cache, `steam:rarity:${e.ext_id}`, DAY, async () => {
      const r = await lookup(`${API}/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`);
      return (r?.achievementpercentages?.achievements || []).map((x) => ({ name: x.name, percent: x.percent }));
    });
    return parseSteamAchievements(list, schema, rarity);
  },

  /**
   * Read titles' achievements again (played since they were read, or never read): one
   * GetPlayerAchievements call per title plus the cached schema / rarity lookups, spaced like
   * enrichment, at most `maxCalls` requests.
   */
  async achievements(account, entries, ctx, { maxCalls = 400 } = {}) {
    const key = encodeURIComponent(account.config.api_key);
    const steamid = account.state.steamid64;
    if (!steamid) return { updates: [] };
    const gap = spacer(250);
    const updates = [];
    const details = { calls: 0, max: maxCalls };
    let calls = 0;
    for (const e of entries) {
      // a title takes up to 3 requests: never start one the budget can't finish
      if (ctx.stopped?.() || calls + details.calls + 3 > maxCalls) break;
      if (JSON.parse(e.meta || '{}').has_stats === false) { updates.push({ entryId: e.id, achievements: null, done: true }); continue; }
      await gap(); calls++;
      let r;
      try {
        r = await ctx.http(`${API}/ISteamUserStats/GetPlayerAchievements/v1/?key=${key}&steamid=${steamid}&appid=${e.ext_id}&l=english`, {}, { retries: 1 });
      } catch (err) {
        if (err.status === 400 || err.status === 403) { updates.push({ entryId: e.id, achievements: null, done: true }); continue; }
        if (err.rateLimited || err.status === 401) break;
        updates.push({ entryId: e.id, done: false });
        continue;
      }
      details.max = maxCalls - calls;
      updates.push({ entryId: e.id, achievements: await this.achievementDetails(account, e, r, ctx, gap, details), done: true });
    }
    return { updates };
  },
};
