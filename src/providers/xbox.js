import { httpJson, ProviderError } from './http.js';

const API = 'https://xbl.io/api/v2';

/** Walk an arbitrary stats payload and return the MinutesPlayed value, if any. */
export function findMinutesPlayed(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const v of obj) { const r = findMinutesPlayed(v); if (r != null) return r; }
    return null;
  }
  if (String(obj.name || obj.Name || '').toLowerCase() === 'minutesplayed' && (obj.value ?? obj.Value) != null) {
    const n = Number(obj.value ?? obj.Value);
    return Number.isFinite(n) ? Math.floor(n) : null;
  }
  for (const v of Object.values(obj)) { const r = findMinutesPlayed(v); if (r != null) return r; }
  return null;
}

export const xbox = {
  id: 'xbox',
  label: 'Xbox',
  fields: [
    { key: 'api_key', label: 'OpenXBL API key', type: 'password', required: true, help: 'Sign in with your Microsoft account at https://xbl.io and create an API key.' },
    { key: 'max_stat_calls', label: 'Max stat lookups per sync', type: 'number', required: false, placeholder: '120', help: 'OpenXBL rate-limits free keys. Titles not looked up yet are picked up on the next sync and imported as history.' },
  ],
  notes: 'Xbox exposes a per-title "MinutesPlayed" stat. Only titles whose last-played time changed are re-queried, keeping you well within OpenXBL rate limits.',

  async fetchLibrary(account, ctx) {
    const key = account.config.api_key;
    if (!key) throw new ProviderError('OpenXBL API key is required', { auth: true });
    const headers = { 'X-Authorization': key, Accept: 'application/json', 'Accept-Language': 'en-US' };
    const hist = await httpJson(`${API}/player/titleHistory`, { headers });
    const titles = hist?.titles || hist?.content?.titles || [];
    const budget = Number(account.config.max_stat_calls) || 120;
    let calls = 0;
    const items = [];
    let skipped = 0;
    for (const t of titles) {
      const extId = String(t.titleId);
      const lastPlayedAt = t.titleHistory?.lastTimePlayed ? Date.parse(t.titleHistory.lastTimePlayed) : null;
      const existing = ctx.getEntry(extId);
      const base = {
        extId,
        title: t.name,
        lastPlayedAt,
        iconUrl: t.displayImage || null,
        coverUrl: t.displayImage || null,
        meta: { devices: t.devices, achievement: t.achievement, pfn: t.pfn },
      };
      // Unchanged since last time -> reuse known playtime, no API call.
      if (existing && existing.last_played_at && lastPlayedAt && lastPlayedAt <= existing.last_played_at) {
        items.push({ ...base, playtimeMin: existing.playtime_min });
        continue;
      }
      if (calls >= budget) { skipped++; continue; }
      calls++;
      let minutes = null;
      try {
        const stats = await httpJson(`${API}/achievements/stats/${encodeURIComponent(extId)}`, { headers }, { retries: 1 });
        minutes = findMinutesPlayed(stats);
      } catch (err) {
        if (err.auth) throw err;
        if (err.status === 429) { skipped++; break; }
      }
      // Titles without a MinutesPlayed stat (some apps / legacy 360 titles) are tracked at their last known value.
      items.push({ ...base, playtimeMin: minutes ?? existing?.playtime_min ?? 0, unknownPlaytime: minutes == null && !existing });
    }
    return { items, state: { ...account.state, xuid: hist?.xuid }, warning: skipped ? `${skipped} titles deferred to the next sync (rate limit budget)` : null };
  },
};
