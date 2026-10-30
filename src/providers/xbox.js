import { ProviderError, spacer } from './http.js';
import { text, percent, unlockTime } from '../services/achievements.js';

const API = 'https://xbl.io/api/v2';
// Xbox Home / dashboard / app shells; 704208617 is the Xbox app on Windows (reported as "Online")
const TITLE_HISTORY_CAP = 1000;
const HOME_TITLE_IDS = new Set(['750323071', '1022622766', '714681658', '704208617']);
// presence words some shells report as their title; never a game unless the library has it
const SHELL_NAMES = /^(home|online|away|busy|offline|xbox( app)?)$/i;
// a presence device that is a Windows PC (Xbox app, Game Bar, Game Pass titles)
export const PC_DEVICE = /windows|win32|pc/i;

/** Walk an arbitrary stats payload and return the MinutesPlayed value, if any. */
export function findMinutesPlayed(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    for (const v of obj) { const r = findMinutesPlayed(v); if (r != null) return r; }
    return null;
  }
  if (String(obj.name || obj.Name || '').toLowerCase() === 'minutesplayed' && (obj.value ?? obj.Value) != null && String(obj.value ?? obj.Value).trim() !== '') {
    const n = Number(obj.value ?? obj.Value);
    return Number.isFinite(n) ? Math.floor(n) : null;
  }
  for (const v of Object.values(obj)) { const r = findMinutesPlayed(v); if (r != null) return r; }
  return null;
}

/** Outline of a stats response for diagnostics: top-level keys, stat names, size. No values. */
export function outline(obj) {
  const names = new Set();
  let minutesStat = null;
  const walk = (o, d = 0) => {
    if (!o || typeof o !== 'object' || d > 8) return;
    if (Array.isArray(o)) { for (const v of o) walk(v, d + 1); return; }
    if (typeof (o.name ?? o.Name) === 'string') names.add(o.name ?? o.Name);
    // how the playtime stat itself looks (its fields, and the value - just a minute count)
    if (String(o.name ?? o.Name).toLowerCase() === 'minutesplayed' && !minutesStat) minutesStat = { keys: Object.keys(o).slice(0, 12), value: o.value ?? o.Value ?? null };
    for (const v of Object.values(o)) walk(v, d + 1);
  };
  walk(obj);
  let bytes = 0;
  try { bytes = JSON.stringify(obj ?? null).length; } catch { /* ignore */ }
  const inner = unwrap(obj);
  return {
    keys: obj && typeof obj === 'object' ? Object.keys(obj).slice(0, 12) : [typeof obj],
    ...(inner !== obj && inner && typeof inner === 'object' ? { content_keys: Object.keys(inner).slice(0, 12) } : {}),
    ...(obj && typeof obj === 'object' && 'code' in obj ? { code: obj.code } : {}),
    stat_names: [...names].slice(0, 20), ...(minutesStat ? { minutes_stat: minutesStat } : {}), bytes,
  };
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

/**
 * Achievement rows from an achievements/player reply, in a { content, code } envelope or not:
 * the modern shape (progressState, progression.timeUnlocked, mediaAssets, rarity, Gamerscore
 * rewards) and the Xbox 360 one (unlocked, timeUnlocked, gamerscore, imageId - its icon is the
 * classic image.xboxlive.com path, built from the title and image ids).
 */
export function parseXboxAchievements(payload, titleId = null) {
  const body = unwrap(payload);
  const list = Array.isArray(body?.achievements) ? body.achievements : Array.isArray(body) ? body : [];
  const hex = (n) => (n != null && n !== '' && Number.isInteger(Number(n)) && Number(n) >= 0 ? Number(n).toString(16) : null);
  return list.filter((a) => a && typeof a === 'object' && a.id != null && a.id !== '').map((a, i) => {
    const modern = 'progressState' in a || (a.progression && typeof a.progression === 'object');
    const when = unlockTime(modern ? a.progression?.timeUnlocked ?? a.timeUnlocked : a.timeUnlocked);
    const unlocked = modern ? (a.progressState ? a.progressState === 'Achieved' : when != null) : !!(a.unlocked ?? a.unlockedOnline ?? when);
    let icon = null;
    if (modern) {
      const media = Array.isArray(a.mediaAssets) ? a.mediaAssets.filter((m) => m?.url) : [];
      icon = (media.find((m) => /icon/i.test(`${m.type || ''} ${m.name || ''}`)) || media[0])?.url ?? null;
    } else if (hex(a.imageId) && hex(a.titleId ?? titleId)) {
      icon = `https://image.xboxlive.com/global/t.${hex(a.titleId ?? titleId)}/ach/0/${hex(a.imageId)}`;
    }
    const score = modern ? (Array.isArray(a.rewards) ? a.rewards.find((r) => /gamerscore/i.test(String(r?.type || ''))) : null)?.value : a.gamerscore;
    return {
      id: String(a.id), name: text(a.name), description: text(a.description) ?? text(a.lockedDescription),
      icon_url: text(icon), icon_locked_url: null,
      unlocked, unlocked_at: unlocked ? when : null,
      rarity: percent(a.rarity?.currentPercentage), points: score != null && score !== '' && Number.isFinite(Number(score)) ? Number(score) : null, grade: null,
      hidden: a.isSecret == null ? null : !!a.isSecret, group: null, sort: i,
    };
  });
}

/**
 * pagingInfo of an achievements/player reply (modern and Xbox 360 alike, in the envelope or
 * not): { token, total }. token = the continuationToken of the next page (null on the last),
 * total = totalRecords (null when not said).
 */
export function pagingOf(payload) {
  const body = unwrap(payload);
  const p = (body && typeof body === 'object' && !Array.isArray(body) ? body.pagingInfo : null) ?? payload?.pagingInfo;
  const n = p?.totalRecords == null || p.totalRecords === '' ? NaN : Number(p.totalRecords);
  return { token: text(p?.continuationToken, 4000), total: Number.isInteger(n) && n >= 0 ? n : null };
}

// pages of one title's achievements read at most (a read stopped by the budget goes on from
// where it stopped; past this the list is taken as read - its total still shows it is not all)
export const ACH_PAGES = 10;

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

/** OpenXBL wraps many replies as { content, code }; return what is inside. */
export function unwrap(d) {
  return d && typeof d === 'object' && !Array.isArray(d) && 'content' in d && ('code' in d || Object.keys(d).length <= 2) ? d.content : d;
}

/** Find the signed-in player's xuid in a titleHistory / presence reply. */
function xuidOf(d) {
  const b = unwrap(d);
  const x = b?.xuid ?? (Array.isArray(b) ? b[0]?.xuid : b?.people?.[0]?.xuid);
  return x != null ? String(x) : null;
}

const DEFAULT_HOURLY = 150; // OpenXBL free tier

export const xbox = {
  id: 'xbox',
  label: 'Xbox',
  fields: [
    { key: 'api_key', label: 'OpenXBL API key', type: 'password', required: true, help: 'Sign in with your Microsoft account at https://xbl.io and create an API key.' },
    { key: 'hourly_limit', label: 'OpenXBL requests per hour', type: 'number', required: false, placeholder: '150', help: 'Your plan\'s hourly limit (free = 150). Vestigo budgets syncs, presence and enrichment to stay under it.' },
    { key: 'presence', label: 'Live presence tracking', type: 'select', options: ['on', 'off'], required: false, help: 'Polls presence every 5 minutes (12 requests/hour).' },
    { key: 'include_apps', label: 'Track apps', type: 'select', options: ['off', 'on'], required: false, help: 'Title history also lists apps (Netflix, YouTube, …). Off = games only.' },
  ],
  notes: 'Per-title MinutesPlayed and last played time (console + PC/Game Pass), live presence, and your achievements (gamerscore, rarity and unlock times, which also date your history). Budgeted to the OpenXBL hourly limit.',
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
    achievements: 'achievements/player (the enrichment request): names, icons, gamerscore, rarity, unlock times; read again after new play (1 request per page of a title - most have one - above the 30% reserve; long lists go on from where the budget stopped them)',
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
    const titles = unwrap(hist)?.titles || hist?.titles || [];
    // Xbox lists only the most recently played titles (1000 at most): at the cap, a title missing
    // from the list may just have dropped off its end, so the report can't show what was removed
    const capped = titles.length >= TITLE_HISTORY_CAP;
    // keep ~15% of the hour for presence & retries
    let budget = Math.max(0, (ctx.remainingBudget?.(this.hourlyLimit(account)) ?? this.hourlyLimit(account)) - Math.ceil(this.hourlyLimit(account) * 0.15));
    const items = [];
    const deferredIds = [];
    let missing = 0;
    const zeroChecked = { ...(account.state.zero_checked || {}) };
    const statFailures = { ...(account.state.stat_failures || {}) };
    // titles whose MinutesPlayed was read within an hour of their last play: the stat can still
    // lag then, so it is read once more on a later sync (otherwise the late minutes would only
    // arrive with the next play, on that day)
    const readSoon = Object.fromEntries(Object.entries(account.state.read_soon || {}).filter(([, t]) => t > Date.now() - 7 * 86_400_000));
    // when each deferred title was first deferred: null = during the first import (its playtime
    // is history), else the sync before the deferral (its new play is counted from there)
    const deferredSince = Object.fromEntries((account.state.deferred_titles || []).map((id) => [id, account.state.deferred_since?.[id] ?? null]));
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
      // unchanged since last time: reuse the stored minutes (titles stuck at 0 are rechecked
      // weekly, or on the next sync when the 0 was read right after a session: the stat lags it)
      const zeroLag = zeroChecked[extId] && lastPlayedAt && zeroChecked[extId] - lastPlayedAt < 3_600_000;
      const lagged = readSoon[extId] && lastPlayedAt && readSoon[extId] - lastPlayedAt < 3_600_000;
      if (existing && !changed && !lagged && !(!existing.playtime_min && (recheckDue || zeroLag))) {
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
        // a server or network error says nothing about the title: ask again next sync - three
        // times; a title that keeps failing then keeps its stored minutes, so it neither holds
        // the account in back-fill syncs nor stops removed titles from being noticed
        if (!err.status || err.status >= 500) {
          statFailures[extId] = (statFailures[extId] || 0) + 1;
          if (statFailures[extId] < 3) { deferredIds.push(extId); continue; }
          if (existing) items.push({ ...base, playtimeMin: existing.playtime_min });
          continue;
        }
        failure = err.message;
      }
      if (!failure) delete statFailures[extId];
      if (minutes == null) {
        missing++;
        zeroChecked[extId] = Date.now();
        // answered, but without a MinutesPlayed stat (many PC / Game Pass titles): sessions for
        // this title come from live presence instead
        if (!failure) unmetered[extId] = 1;
        // keep a few response outlines (shape and stat names, no values) for diagnostics
        if (samples.length < 6) samples.push({ title_id: extId, title: t.name, at: new Date().toISOString(), ...(failure ? { error: failure.slice(0, 200) } : outline(stats)) });
      } else {
        if (minutes === 0) zeroChecked[extId] = Date.now(); else delete zeroChecked[extId];
        delete unmetered[extId];
        if (lastPlayedAt && Date.now() - lastPlayedAt < 3_600_000) readSoon[extId] = Date.now(); else delete readSoon[extId];
      }
      // a title first seen after being deferred during the first import is history, not new play;
      // one deferred on a later sync is judged from the sync before the deferral
      const since = !existing && extId in deferredSince ? deferredSince[extId] : undefined;
      items.push({
        ...base,
        playtimeMin: minutes ?? existing?.playtime_min ?? 0,
        // the first real total of a title so far tracked by presence includes what presence
        // already recorded; the rest is history, never new play
        backfill: since === null || (minutes != null && wasUnmetered),
        ...(since != null ? { windowFrom: since } : {}),
        ...(minutes == null && !failure ? fallback : {}),
      });
    }
    const state = { ...account.state, xuid: xuidOf(hist) || account.state.xuid };
    // only titles actually waiting for budget (not skipped apps) - they are fetched by hourly back-fill syncs
    state.deferred_titles = deferredIds.slice(0, 5000);
    state.deferred_since = Object.fromEntries(state.deferred_titles.map((id) => [id, id in deferredSince ? deferredSince[id] : (account.last_sync_at ?? null)]));
    state.zero_checked = zeroChecked;
    state.read_soon = readSoon;
    state.stat_failures = statFailures;
    state.unmetered = unmetered;
    if (samples.length) state.missing_minutes_samples = samples;
    const deferred = deferredIds.length;
    const warning = deferred ? `${deferred} titles deferred to stay within the OpenXBL hourly limit - fetched by hourly back-fill syncs` : null;
    return { items, state, warning, complete: deferred === 0 && !capped, capped, info: { titles: titles.length, missing_minutes: missing, deferred, ...(capped ? { capped: true } : {}) } };
  },

  async presence(account, ctx) {
    if ((ctx.remainingBudget?.(this.hourlyLimit(account)) ?? 1) < 3) return null; // leave room for syncs
    const raw = await ctx.http(`${API}/presence`, { headers: this.headers(account) }, { retries: 0 });
    const data = unwrap(raw);
    const people = Array.isArray(data) ? data : data?.people || [data];
    const me = people.find((p) => !account.state.xuid || String(p?.xuid) === String(account.state.xuid)) || people[0];
    const playing = [];
    const seen = []; // everything reported, for diagnostics (which titles were skipped and why)
    for (const d of me?.devices || []) {
      // on a PC a running game is often not reported as the full-screen foreground title
      const pc = PC_DEVICE.test(String(d.type || ''));
      for (const t of d.titles || []) {
        const id = String(t.id ?? t.titleId ?? '');
        const row = { id, name: t.name || null, device: d.type || null, placement: t.placement || null, state: t.state || null, ...(t.lastModified ? { modified: t.lastModified } : {}) };
        seen.push(row);
        if (!id || HOME_TITLE_IDS.has(id) || (SHELL_NAMES.test(String(t.name || '').trim()) && !ctx.getEntry?.(id))) { row.skipped = 'home'; continue; }
        if (t.state && t.state !== 'Active') { row.skipped = 'inactive'; continue; }
        if (t.placement && !['Full', 'Fill', 'Snapped'].includes(t.placement) && !(pc && ctx.getEntry?.(id))) { row.skipped = 'background'; continue; }
        playing.push({ extId: id, title: t.name || null, device: d.type || null });
      }
    }
    // no devices at all: keep the reply's outline so diagnostics show what came back
    return { playing, seen, online: me?.state || null, ...(me?.devices ? {} : { shape: outline(raw) }), ...(xuidOf(raw) && !account.state.xuid ? { state: { xuid: xuidOf(raw) } } : {}) };
  },

  async enrich(account, entries, ctx) {
    const xuid = account.state.xuid;
    if (!xuid) return { updates: [] };
    const headers = this.headers(account);
    const gap = spacer(1000);
    const updates = [];
    // screenshots + game clips: two requests for the whole library, moments of real play
    const captures = new Map();
    const reserve = Math.ceil(this.hourlyLimit(account) * 0.3);
    for (const kind of ['screenshots', 'gameclips']) {
      if ((ctx.remainingBudget?.(this.hourlyLimit(account)) ?? 0) <= reserve) return { updates };
      try {
        await gap();
        captureTimes(await ctx.http(`${API}/dvr/${kind}`, { headers }, { retries: 0 }), captures);
      } catch (err) {
        if (err.rateLimited) return { updates };
        ctx.warn?.(`Xbox ${kind}: ${err.message}`);
      }
    }
    const pages = { ...(account.state.ach_pages || {}) };
    for (const e of entries) {
      if (ctx.stopped?.()) break;
      if ((ctx.remainingBudget?.(this.hourlyLimit(account)) ?? 0) <= reserve) break;
      try {
        const r = await this.readTitle(account, e, ctx, { headers, gap, reserve, pages });
        // the same replies carry the achievements themselves: no extra request. A list the budget
        // cut short is enriched again later, from where it stopped (its history waits for it)
        const anchors = [...r.replies.flatMap((x) => findUnlockTimes(x)), ...(captures.get(String(e.ext_id)) || [])];
        updates.push({ entryId: e.id, anchors, done: !r.resume, achievements: r.items, total: r.total, whole: r.whole, calls: r.calls, ...(r.resume ? { partial: true, resume: true } : {}) });
      } catch (err) {
        if (err.rateLimited || err.auth || err.blocked) break;
        const none = err.status === 404 || err.status === 400; // the title has no achievements
        updates.push({ entryId: e.id, anchors: captures.get(String(e.ext_id)) || [], done: none, ...(none ? { achievements: null, total: null } : {}) });
      }
    }
    return { updates, ...(JSON.stringify(pages) !== JSON.stringify(account.state.ach_pages || {}) ? { state: { ach_pages: pages } } : {}) };
  },

  /**
   * One title's achievements: achievements/player, then each further page its
   * pagingInfo.continuationToken names (?continuationToken=, as Xbox Live's own achievements
   * API takes it - OpenXBL passes it on). Modern and Xbox 360 lists page alike. A page is one
   * request: a further page is asked only while more than the reserve of the hour is left and
   * `budget` (shared by the run: { calls, max }) allows; the read stops on the last page, a
   * token seen before, an empty page or after ACH_PAGES pages. A read stopped early keeps what
   * it read and leaves where it stopped in `pages` (account.state.ach_pages: ext id -> { token,
   * pages, read, at, total }), so the next read goes on from there - unless the title was
   * played since its first page was read, or the token is refused (then from the first page).
   * Returns { items, replies, total (totalRecords), calls, resume (stopped early), whole (items
   * are the full list: read in one go) }; throws the error of a first page, or when no page could be read.
   */
  async readTitle(account, e, ctx, { headers, gap, reserve, pages, budget = { calls: 0, max: Infinity } }) {
    const url = `${API}/achievements/player/${encodeURIComponent(account.state.xuid)}/${encodeURIComponent(e.ext_id)}`;
    const key = String(e.ext_id);
    const room = () => !ctx.stopped?.() && budget.calls < budget.max && (ctx.remainingBudget?.(this.hourlyLimit(account)) ?? 0) > reserve;
    let from = pages[key];
    if (from && !(from.token && (e.last_session_at ?? 0) <= (from.at ?? 0))) from = null;
    const start = () => ({ token: from?.token ?? null, count: from?.pages ?? 0, total: from?.total ?? null, offset: from?.read ?? 0, at: from?.at ?? Date.now() });
    let { token, count, total, offset, at } = start();
    const seen = new Set(token ? [token] : []);
    const items = [];
    const replies = [];
    const calls0 = budget.calls;
    for (;;) {
      await gap(); budget.calls++;
      let r;
      try {
        r = await ctx.http(token ? `${url}?continuationToken=${encodeURIComponent(token)}` : url, { headers }, { retries: 0 });
      } catch (err) {
        if (err.auth || (!from && !replies.length)) throw err;
        // a token from an earlier read that is refused (expired): from the first page again
        if (from && !replies.length && !err.rateLimited && err.status >= 400 && err.status < 500) {
          from = null;
          ({ token, count, total, offset, at } = start());
          seen.clear();
          if (room()) continue;
        }
        break; // keep what was read; go on from this page next time
      }
      replies.push(r);
      count++;
      const page = parseXboxAchievements(r, e.ext_id);
      for (const it of page) items.push({ ...it, sort: offset + items.length });
      const next = pagingOf(r);
      if (next.total != null) total = next.total;
      if (!next.token || seen.has(next.token) || !page.length || count >= ACH_PAGES) { token = null; break; }
      seen.add(next.token);
      token = next.token;
      if (!room()) break;
    }
    if (token) pages[key] = { token, pages: count, read: offset + items.length, at, total };
    else delete pages[key];
    // nothing read at all (the page to go on from failed): a failed attempt, not progress
    if (!replies.length) throw new Error('no page of the achievement list could be read');
    return { items, replies, total, calls: budget.calls - calls0, resume: !!token, whole: !token && !from };
  },

  /**
   * Read titles' achievements again (played since they were read, or never read): one
   * achievements/player request per page of a title (most have one), only while more than 30%
   * of the hour's budget is left (like enrichment), at most `maxCalls` requests. A title the
   * budget cut short is marked to be read on later (partial, resume), not as read.
   */
  async achievements(account, entries, ctx, { maxCalls = 10 } = {}) {
    const xuid = account.state.xuid;
    if (!xuid) return { updates: [] };
    const headers = this.headers(account);
    const gap = spacer(1000);
    const reserve = Math.ceil(this.hourlyLimit(account) * 0.3);
    const updates = [];
    const budget = { calls: 0, max: maxCalls };
    const pages = { ...(account.state.ach_pages || {}) };
    for (const e of entries) {
      if (ctx.stopped?.() || budget.calls >= maxCalls) break;
      if ((ctx.remainingBudget?.(this.hourlyLimit(account)) ?? 0) <= reserve) break;
      const calls0 = budget.calls;
      try {
        const r = await this.readTitle(account, e, ctx, { headers, gap, reserve, pages, budget });
        updates.push({ entryId: e.id, achievements: r.items, total: r.total, done: true, whole: r.whole, calls: r.calls, ...(r.resume ? { partial: true, resume: true } : {}) });
      } catch (err) {
        if (err.rateLimited || err.auth || err.blocked) break;
        const none = err.status === 404 || err.status === 400;
        updates.push({ entryId: e.id, done: none, calls: budget.calls - calls0, ...(none ? { achievements: null, total: null } : {}) });
      }
    }
    return { updates, ...(JSON.stringify(pages) !== JSON.stringify(account.state.ach_pages || {}) ? { state: { ach_pages: pages } } : {}) };
  },
};
