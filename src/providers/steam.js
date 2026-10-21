import { ProviderError, spacer } from './http.js';

const API = 'https://api.steampowered.com';
const STORE = 'https://store.steampowered.com/api';

function parseReleaseDate(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(/(\d+)(st|nd|rd|th)/, '$1'));
  return Number.isFinite(t) ? t : null;
}

export const steam = {
  id: 'steam',
  label: 'Steam',
  fields: [
    { key: 'api_key', label: 'Steam Web API key', type: 'password', required: true, help: 'Get one at https://steamcommunity.com/dev/apikey' },
    { key: 'steam_id', label: 'SteamID64, vanity name or profile URL', type: 'text', required: true, help: 'Profile → Edit Profile → Privacy: "My profile" and "Game details" must be Public.' },
    { key: 'presence', label: 'Live presence tracking', type: 'select', options: ['on', 'off'], required: false, help: 'Polls "currently playing" every 2 minutes for exact session start/end times (720 calls/day of your 100k).' },
  ],
  notes: 'Lifetime + last-2-weeks minutes per game, last played time, per-device minutes (Windows/Mac/Linux/Steam Deck), live "currently playing" and achievement unlock times for dating your history.',
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
      throw new ProviderError('Steam returned no games. Make sure your profile and "Game details" privacy are set to Public.', { auth: true });
    }
    const items = games.map((g) => ({
      extId: String(g.appid),
      title: g.name || `App ${g.appid}`,
      playtimeMin: Number(g.playtime_forever) || 0,
      recentMin: Number(g.playtime_2weeks) || 0,
      recentWindowDays: 14,
      lastPlayedAt: g.rtime_last_played ? g.rtime_last_played * 1000 : null,
      iconUrl: g.img_icon_url ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg` : null,
      coverUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/library_600x900.jpg`,
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
    return { playing: p.gameid ? [{ extId: String(p.gameid), title: p.gameextrainfo || null }] : [] };
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
    for (const e of entries) {
      if (ctx.stopped?.()) break;
      const u = { entryId: e.id, anchors: [], release_at: undefined, done: true };
      const meta = JSON.parse(e.meta || '{}');
      if (meta.has_stats !== false && steamid && calls < 400) {
        await apiGap(); calls++;
        try {
          const r = await ctx.http(`${API}/ISteamUserStats/GetPlayerAchievements/v1/?key=${key}&steamid=${steamid}&appid=${e.ext_id}`, {}, { retries: 1 });
          for (const a of r?.playerstats?.achievements || []) if (a.achieved && a.unlocktime > 0) u.anchors.push(a.unlocktime * 1000);
        } catch (err) {
          // 400/403 = game has no stats or stats are private: nothing to learn, not an error
          if (!(err.status === 400 || err.status === 403)) { u.done = false; ctx.warn?.(`Achievements for ${e.title}: ${err.message}`); }
        }
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
};
