import { httpJson, ProviderError } from './http.js';

const API = 'https://api.steampowered.com';

export const steam = {
  id: 'steam',
  label: 'Steam',
  fields: [
    { key: 'api_key', label: 'Steam Web API key', type: 'password', required: true, help: 'Get one at https://steamcommunity.com/dev/apikey' },
    { key: 'steam_id', label: 'SteamID64, vanity name or profile URL', type: 'text', required: true, help: 'Your profile and "Game details" must be public.' },
  ],
  notes: 'Steam reports lifetime minutes plus minutes played in the last two weeks. On the first import the two-week figure becomes a real session so your stats are not empty.',

  async resolveId(cfg) {
    let id = String(cfg.steam_id || '').trim();
    const m = id.match(/steamcommunity\.com\/(id|profiles)\/([^/?#]+)/i);
    if (m) id = m[2];
    if (/^\d{17}$/.test(id)) return id;
    const data = await httpJson(`${API}/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(cfg.api_key)}&vanityurl=${encodeURIComponent(id)}`);
    if (data?.response?.success !== 1) throw new ProviderError(`Could not resolve Steam vanity name "${id}"`);
    return data.response.steamid;
  },

  async fetchLibrary(account) {
    const cfg = account.config;
    if (!cfg.api_key || !cfg.steam_id) throw new ProviderError('Steam API key and Steam ID are required');
    const state = { ...account.state };
    if (!state.steamid64 || state.steam_id_input !== cfg.steam_id) {
      state.steamid64 = await this.resolveId(cfg);
      state.steam_id_input = cfg.steam_id;
    }
    const url = `${API}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(cfg.api_key)}&steamid=${state.steamid64}&include_appinfo=1&include_played_free_games=1&skip_unvetted_apps=0&format=json`;
    const data = await httpJson(url);
    const games = data?.response?.games;
    if (!Array.isArray(games)) {
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
      coverUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/library_600x900.jpg`,
      meta: {
        windows: g.playtime_windows_forever, mac: g.playtime_mac_forever, linux: g.playtime_linux_forever,
        deck: g.playtime_deck_forever, disconnected: g.playtime_disconnected,
        header: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`,
        store: `https://store.steampowered.com/app/${g.appid}`,
      },
    }));
    return { items, state };
  },
};
