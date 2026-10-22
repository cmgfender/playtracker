import { ProviderError, spacer } from './http.js';

const API = 'https://xbl.io/api/v2';
const HOME_TITLE_IDS = new Set(['750323071', '1022622766', '714681658']); // Xbox Home / dashboard / app shells

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

/** Outline of a stats response for diagnostics: top-level keys, stat names, size. No values. */
export function outline(obj) {
  const names = new Set();
  const walk = (o, d = 0) => {
    if (!o || typeof o !== 'object' || d > 8) return;
    if (Array.isArray(o)) { for (const v of o) walk(v, d + 1); return; }
    if (typeof (o.name ?? o.Name) === 'string') names.add(o.name ?? o.Name);
    for (const v of Object.values(o)) walk(v, d + 1);
  };
  walk(obj);
  let bytes = 0;
  try { bytes = JSON.stringify(obj ?? null).length; } catch { /* ignore */ }
  return { keys: obj && typeof obj === 'object' ? Object.keys(obj).slice(0, 12) : [typeof obj], stat_names: [...names].slice(0, 20), bytes };
}

/** Collect achievement unlock timestamps from either the modern or the Xbox 360 payload shape. */
export function findUnlockTimes(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) { for (const v of obj) findUnlockTimes(v, out); return out; }
  const t = obj.timeUnlocked ?? obj.progression?.timeUnlocked;
  if (t) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms) && ms > Date.UTC(2005, 0, 1)) out.push(ms);
  }
  for (const [k, v] of Object.entries(obj)) if (k !== 'progression' && v && typeof v === 'object') findUnlockTimes(v, out);
  return out;
}

/** Capture (screenshot / game clip) times per title id, from either media API shape. */
export function captureTimes(obj, out = new Map()) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) { for (const v of obj) captureTimes(v, out); return out; }
  const when = obj.captureDate ?? obj.dateRecorded ?? obj.dateTaken ?? obj.datePublished;
  if (obj.titleId != null && when) {
    const ms = Date.parse(when);
    if (Number.isFinite(ms) && ms > Date.UTC(2005, 0, 1)) {
      const k = String(obj.titleId);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(ms);
    }
    return out;
  }
  for (const v of Object.values(obj)) if (v && typeof v === 'object') captureTimes(v, out);
  return out;
}

const DEFAULT_HOURLY = 150; // OpenXBL free tier

export const xbox = {
  id: 'xbox',
  label: 'Xbox',
  fields: [
    { key: 'api_key', label: 'OpenXBL API key', type: 'password', required: true, help: 'Sign in with your Microsoft account at https://xbl.io and create an API key.' },
    { key: 'hourly_limit', label: 'OpenXBL requests per hour', type: 'number', required: false, placeholder: '150', help: 'Your plan\'s hourly limit (free = 150). PlayTracker budgets syncs, presence and enrichment to stay under it.' },
    { key: 'presence', label: 'Live presence tracking', type: 'select', options: ['on', 'off'], required: false, help: 'Polls presence every 5 minutes (12 requests/hour).' },
    { key: 'include_apps', label: 'Track apps', type: 'select', options: ['off', 'on'], required: false, help: 'Title history also lists apps (Netflix, YouTube, …). Off = games only.' },
  ],
  notes: 'Per-title MinutesPlayed and last played time (console + PC/Game Pass), live presence and achievement unlock times for dating your history. Budgeted to the OpenXBL hourly limit.',
  profile: {
    history: {
      update: 'periodic',         // MinutesPlayed is flushed during play: a long session spans reports
      lag_min: 10,
      last_played: 'end',         // lastTimePlayed = latest activity
      single_title: true,         // one game runs at a time per account
      complete_library: true,     // except titles deferred by the hourly budget (reported per sync)
    },
    presence: { interval_sec: 300, sync_after_sec: 600 },
  },
  capabilities: {
    lifetime: 'Per-title "MinutesPlayed" user stat (one request per title)',
    recent: null,
    last_played: 'titleHistory.lastTimePlayed',
    first_played: null,
    play_count: null,
    per_device: 'devices the title is available on (not per-device minutes)',
    presence: 'presence: current title + placement (Full/Snapped)',
    history_anchors: 'Achievement unlock times (modern + Xbox 360 titles) and screenshot / game clip capture dates (2 requests per enrichment run)',
    rate_limit: 'OpenXBL: 150 requests/hour on the free plan (configurable for paid plans)',
    limitations: [
      'Requires the third-party OpenXBL service (Microsoft offers no public consumer API).',
      'Minutes need one request per title; only titles whose last-played time changed are re-queried, the rest reuse the stored value.',
      'A large first import is spread over several hourly budgets; deferred titles are imported as history once fetched.',
      'Some titles (apps, some backward-compatible 360 games) have no MinutesPlayed stat - tracked from last played only.',
      'The MinutesPlayed stat can lag a session by several minutes.',
      'Exact endpoint shapes are not officially documented; responses are parsed defensively.',
    ],
  },

  headers(account) {
    const key = account.config.api_key;
    if (!key) throw new ProviderError('OpenXBL API key is required', { auth: true });
    return { 'X-Authorization': key, Accept: 'application/json', 'Accept-Language': 'en-US' };
  },

  hourlyLimit(account) {
    return Number(account.config.hourly_limit) || DEFAULT_HOURLY;
  },

  async fetchLibrary(account, ctx) {
    const headers = this.headers(account);
    const hist = await ctx.http(`${API}/player/titleHistory`, { headers });
    const titles = hist?.titles || hist?.content?.titles || [];
    // keep ~15% of the hour for presence & retries
    let budget = Math.max(0, (ctx.remainingBudget?.(this.hourlyLimit(account)) ?? this.hourlyLimit(account)) - Math.ceil(this.hourlyLimit(account) * 0.15));
    const items = [];
    const deferredIds = [];
    let missing = 0;
    const zeroChecked = { ...(account.state.zero_checked || {}) };
    const unmetered = { ...(account.state.unmetered || {}) };
    const samples = [];
    // most recently played first so active games are always fresh
    titles.sort((a, b) => Date.parse(b.titleHistory?.lastTimePlayed || 0) - Date.parse(a.titleHistory?.lastTimePlayed || 0));
    for (const t of titles) {
      const extId = String(t.titleId);
      if (HOME_TITLE_IDS.has(extId)) continue;
      if (account.config.include_apps !== 'on' && String(t.type || '').toLowerCase() === 'app') continue;
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
      const changed = !(existing && existing.last_played_at && lastPlayedAt && lastPlayedAt <= existing.last_played_at);
      // titles without a playtime stat are asked again once a week (the stat may appear, and a
      // failed or odd response must not stick forever)
      const recheckDue = !(zeroChecked[extId] > Date.now() - 7 * 86_400_000);
      const wasUnmetered = !!unmetered[extId];
      // played since last time, but the platform reports no playtime: tracked by presence, with
      // a fallback session ending at the new last-played time when presence missed it
      const fallback = existing && changed && lastPlayedAt ? { unmeteredPlayAt: lastPlayedAt, prevPlayedAt: existing.last_played_at || null } : {};
      if (existing && wasUnmetered && !recheckDue) {
        items.push({ ...base, playtimeMin: existing.playtime_min, ...fallback });
        continue;
      }
      // unchanged since last time: reuse the stored minutes (titles stuck at 0 are rechecked)
      if (existing && !changed && !(!existing.playtime_min && recheckDue)) {
        items.push({ ...base, playtimeMin: existing.playtime_min });
        continue;
      }
      if (budget <= 0) { deferredIds.push(extId); continue; }
      budget--;
      let minutes = null;
      let failure = null;
      let stats = null;
      try {
        stats = await ctx.http(`${API}/achievements/stats/${encodeURIComponent(extId)}`, { headers }, { retries: 1 });
        minutes = findMinutesPlayed(stats);
      } catch (err) {
        if (err.auth) throw err;
        if (err.rateLimited) { deferredIds.push(extId); budget = 0; continue; }
        failure = err.message;
      }
      if (minutes == null) {
        missing++;
        zeroChecked[extId] = Date.now();
        // answered, but without a MinutesPlayed stat (many PC / Game Pass titles): sessions for
        // this title come from live presence instead
        if (!failure) unmetered[extId] = 1;
        // keep a few response outlines (shape and stat names, no values) for diagnostics
        if (samples.length < 6) samples.push({ title_id: extId, title: t.name, at: new Date().toISOString(), ...(failure ? { error: failure.slice(0, 200) } : outline(stats)) });
      } else { delete zeroChecked[extId]; delete unmetered[extId]; }
      // a title seen for the first time on a later sync while being deferred earlier is history, not new play
      items.push({
        ...base,
        playtimeMin: minutes ?? existing?.playtime_min ?? 0,
        // the first real total of a title so far tracked by presence includes what presence
        // already recorded; the rest is history, never new play
        backfill: (!existing && account.state.deferred_titles?.includes(extId)) || (minutes != null && wasUnmetered),
        ...(minutes == null && !failure ? fallback : {}),
      });
    }
    const state = { ...account.state, xuid: hist?.xuid || account.state.xuid };
    // only titles actually waiting for budget (not skipped apps) - they are fetched by hourly back-fill syncs
    state.deferred_titles = deferredIds.slice(0, 5000);
    state.zero_checked = zeroChecked;
    state.unmetered = unmetered;
    if (samples.length) state.missing_minutes_samples = samples;
    const deferred = deferredIds.length;
    const warning = deferred ? `${deferred} titles deferred to stay within the OpenXBL hourly limit - fetched by hourly back-fill syncs` : null;
    return { items, state, warning, complete: deferred === 0, info: { titles: titles.length, missing_minutes: missing, deferred } };
  },

  async presence(account, ctx) {
    if ((ctx.remainingBudget?.(this.hourlyLimit(account)) ?? 1) < 3) return null; // leave room for syncs
    const data = await ctx.http(`${API}/presence`, { headers: this.headers(account) }, { retries: 0 });
    const people = Array.isArray(data) ? data : data?.people || [data];
    const me = people.find((p) => !account.state.xuid || String(p?.xuid) === String(account.state.xuid)) || people[0];
    const playing = [];
    for (const d of me?.devices || []) {
      for (const t of d.titles || []) {
        const id = String(t.id ?? t.titleId ?? '');
        if (!id || HOME_TITLE_IDS.has(id)) continue;
        if (t.placement && !['Full', 'Fill', 'Snapped'].includes(t.placement)) continue;
        if (t.state && t.state !== 'Active') continue;
        playing.push({ extId: id, title: t.name || null, device: d.type || null });
      }
    }
    return { playing };
  },

  async enrich(account, entries, ctx) {
    const xuid = account.state.xuid;
    if (!xuid) return { updates: [] };
    const headers = this.headers(account);
    const gap = spacer(1000);
    const updates = [];
    // screenshots + game clips: two requests for the whole library, moments of real play
    const captures = new Map();
    for (const kind of ['screenshots', 'gameclips']) {
      try {
        await gap();
        captureTimes(await ctx.http(`${API}/dvr/${kind}`, { headers }, { retries: 0 }), captures);
      } catch (err) {
        if (err.rateLimited) return { updates };
        ctx.warn?.(`Xbox ${kind}: ${err.message}`);
      }
    }
    for (const e of entries) {
      if (ctx.stopped?.()) break;
      if ((ctx.remainingBudget?.(this.hourlyLimit(account)) ?? 0) <= Math.ceil(this.hourlyLimit(account) * 0.3)) break;
      await gap();
      try {
        const r = await ctx.http(`${API}/achievements/player/${encodeURIComponent(xuid)}/${encodeURIComponent(e.ext_id)}`, { headers }, { retries: 0 });
        updates.push({ entryId: e.id, anchors: [...findUnlockTimes(r), ...(captures.get(String(e.ext_id)) || [])], done: true });
      } catch (err) {
        if (err.rateLimited) break;
        updates.push({ entryId: e.id, anchors: captures.get(String(e.ext_id)) || [], done: err.status === 404 || err.status === 400 });
      }
    }
    return { updates };
  },
};
