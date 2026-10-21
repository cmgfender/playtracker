import { tx } from '../db.js';
import { providers } from '../providers/index.js';
import { httpJson } from '../providers/http.js';
import { findOrCreateGame } from './library.js';
import { nextRun } from './schedule.js';
import { sendWebhook } from './webhook.js';
import { flushRollups } from './rollup.js';
import { allocate } from './inference.js';
import { reinferMany, mergeEvidence, reinferPending } from './inference.js';
import { asLogger } from '../logger.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PIN_MAX = 360; // a single delta up to 6h is treated as one continuous session

export function parseAccount(row) {
  if (!row) return null;
  return {
    ...row,
    config: safeJson(row.config, {}),
    state: safeJson(row.state, {}),
    schedule: row.schedule ? safeJson(row.schedule, null) : null,
    enabled: !!row.enabled,
  };
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }

/** Which device's counter grew the most between two snapshots (Steam per-OS/Deck minutes). */
export function deviceDelta(prev, next) {
  if (!next || !prev) return { device: null, offline: false };
  let best = null; let bestInc = 0;
  for (const [k, v] of Object.entries(next)) {
    if (k === 'offline') continue;
    const inc = (v || 0) - (prev[k] || 0);
    if (inc > bestInc) { bestInc = inc; best = k; }
  }
  return { device: best, offline: (next.offline || 0) > (prev.offline || 0) };
}

/**
 * Core algorithm: compare reported lifetime playtime against the last snapshot and turn
 * the difference into play sessions, using every hint the platform gives:
 *   presence spans  -> exact start/end (split across multiple spans)
 *   play count delta -> number of sessions in the window (PSN)
 *   last played      -> pins the end of the (last) session
 *   per-device delta -> which device was used (Steam Deck vs Windows, offline play)
 *   recent counter   -> narrows long windows (Steam 2-week minutes)
 * Large deltas over multi-day windows are spread over days instead of one giant block.
 *
 * Pre-tracking playtime (first import, late-appearing titles) is never recorded as play:
 * it becomes the entry's history and is dated by the inference engine (inference.js).
 */
export function applyItems(db, account, items, { settings, now = Date.now(), syncId, initial, source = 'sync' }) {
  const minSession = Math.max(0, Number(settings.min_session_minutes) || 0);
  const overage = Math.max(0, Number(settings.max_overage_minutes) || 0);
  const useRecent = settings.use_recent_on_import !== false;
  const autoMerge = settings.auto_merge_titles !== false;
  const prevSync = account.last_sync_at;
  const stats = { games_seen: 0, games_changed: 0, games_new: 0, sessions_created: 0, minutes_added: 0, baseline_minutes: 0, history_minutes: 0, estimated_minutes: 0, exact_sessions: 0, new_sessions: [] };

  const getEntry = db.prepare('SELECT * FROM entries WHERE account_id = ? AND ext_id = ?');
  const insEntry = db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, icon_url, cover_url, playtime_min, last_played_at, first_played_at, play_count, first_seen_at, last_synced_at, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updEntry = db.prepare(`UPDATE entries SET title = ?, icon_url = COALESCE(?, icon_url), cover_url = COALESCE(?, cover_url),
    playtime_min = ?, last_played_at = COALESCE(?, last_played_at), first_played_at = COALESCE(first_played_at, ?), play_count = COALESCE(?, play_count),
    last_synced_at = ?, meta = ? WHERE id = ?`);
  const touchEntry = db.prepare(`UPDATE entries SET title = ?, icon_url = COALESCE(?, icon_url), cover_url = COALESCE(?, cover_url),
    last_played_at = COALESCE(?, last_played_at), first_played_at = COALESCE(first_played_at, ?) WHERE id = ?`);
  const insSnap = db.prepare('INSERT INTO snapshots(entry_id, sync_id, taken_at, playtime_min) VALUES (?, ?, ?, ?)');
  const fillCover = db.prepare('UPDATE games SET cover_url = ? WHERE id = ? AND cover_url IS NULL');
  const addHistory = db.prepare('UPDATE entries SET baseline_min = baseline_min + ? WHERE id = ?');
  const insSession = db.prepare(`INSERT INTO sessions(entry_id, sync_id, source, kind, minutes, window_start, window_end, started_at, ended_at, confidence, device, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const spansFor = db.prepare('SELECT * FROM presence WHERE account_id = ? AND ext_id = ? AND started_at < ? AND COALESCE(ended_at, last_seen_at) > ? ORDER BY started_at');
  const toInfer = new Set();

  const play = (entry, title, { minutes, windowStart, windowEnd, started = null, ended = null, confidence, device = null, note = null }) => {
    minutes = Math.round(minutes);
    if (minutes <= 0) return;
    // window barely longer than the session: we know exactly when it happened
    if (!ended && windowEnd - windowStart <= (minutes + 10) * MIN) { started = windowStart; ended = windowEnd; confidence = confidence === 'exact' ? 'exact' : 'pinned'; }
    const r = insSession.run(entry.id, syncId, source, 'play', minutes, windowStart, windowEnd, started, ended, confidence, device, note, now);
    stats.sessions_created++;
    stats.minutes_added += minutes;
    if (confidence === 'exact') stats.exact_sessions++;
    stats.new_sessions.push({ id: Number(r.lastInsertRowid), entry_id: entry.id, game_id: entry.game_id, title, minutes, platform: account.platform, confidence });
  };

  // Split a delta into sessions using presence spans, play counts and last-played.
  const recordDelta = (entry, it, delta, windowStart, windowEnd, prevMeta) => {
    const title = it.title || entry.title;
    const { device, offline } = deviceDelta(prevMeta?.devices, it.devices);
    const dev = device || null;
    const baseNote = offline ? 'Includes offline play reported on reconnect' : null;
    let remaining = delta;

    // 1) presence spans observed in this window -> exact sessions
    const spans = spansFor.all(account.id, String(it.extId), windowEnd + MIN, windowStart);
    if (spans.length) {
      const spanMin = spans.map((s) => Math.max(1, ((s.ended_at || s.last_seen_at) - s.started_at) / MIN));
      const total = spanMin.reduce((a, x) => a + x, 0);
      const covered = Math.min(remaining, total * 1.25 + 5);
      let used = 0;
      spans.forEach((s, i) => {
        const m = i === spans.length - 1 ? Math.round(covered - used) : Math.round((covered * spanMin[i]) / total);
        used += m;
        const end = Math.min(s.ended_at || s.last_seen_at, windowEnd);
        play(entry, title, { minutes: m, windowStart: Math.max(windowStart, s.started_at), windowEnd: end, started: Math.max(s.started_at, end - m * MIN), ended: end, confidence: 'exact', device: s.device || dev, note: baseNote });
      });
      remaining -= covered;
      if (remaining < Math.max(1, minSession)) return;
    }

    const lp = it.lastPlayedAt && it.lastPlayedAt > windowStart && it.lastPlayedAt <= windowEnd + MIN ? Math.min(it.lastPlayedAt, windowEnd) : null;
    const pcDelta = it.playCount != null && entry.play_count != null ? it.playCount - entry.play_count : 0;
    const k = Math.max(1, Math.min(30, pcDelta));
    const spanDays = (windowEnd - windowStart) / DAY;

    // 2) several launches (PSN play count): k sessions, the last one pinned to last played
    if (k > 1) {
      const each = remaining / k;
      for (let i = 0; i < k; i++) {
        const last = i === k - 1;
        if (last && lp && each <= PIN_MAX) play(entry, title, { minutes: each, windowStart, windowEnd, started: Math.max(windowStart, lp - each * MIN), ended: lp, confidence: 'pinned', device: dev, note: baseNote });
        else play(entry, title, { minutes: each, windowStart, windowEnd: lp || windowEnd, confidence: 'window', device: dev, note: baseNote ?? `${k} launches in this window` });
      }
      return;
    }

    // 3) one continuous session ending at last played
    if (remaining <= PIN_MAX && lp) {
      play(entry, title, { minutes: remaining, windowStart, windowEnd, started: Math.max(windowStart, lp - remaining * MIN), ended: lp, confidence: 'pinned', device: dev, note: baseNote });
      return;
    }

    // 4) big delta over a multi-day window: spread over days (bump on the last played day)
    if (remaining > PIN_MAX && spanDays > 1.2) {
      const end = lp || windowEnd;
      const d0 = startOfDay(windowStart);
      const n = Math.max(1, Math.round((startOfDay(end) - d0) / DAY) + 1);
      const weights = Array.from({ length: n }, (_, i) => 1 + (lp ? 3 * Math.exp(-((n - 1 - i) ** 2) / 2) : 0));
      const alloc = allocate(remaining, weights, { cap: 600, minDay: 15 });
      alloc.forEach((m, i) => {
        if (m <= 0) return;
        const ds = Math.max(windowStart, addDays(d0, i));
        const de = Math.min(end, addDays(d0, i + 1) - 1);
        if (de <= ds) return;
        play(entry, title, { minutes: m, windowStart: ds, windowEnd: de, confidence: 'window', device: dev, note: baseNote ?? 'Spread over the sync window' });
      });
      return;
    }
    play(entry, title, { minutes: remaining, windowStart, windowEnd, confidence: 'window', device: dev, note: baseNote });
  };

  const history = (entry, minutes, it, extra = {}) => {
    if (minutes <= 0) return;
    addHistory.run(minutes, entry.id);
    mergeEvidence(db, entry.id, {
      tracking_start: now,
      last_played_at: it.lastPlayedAt ?? undefined,
      first_played_at: it.firstPlayedAt ?? undefined,
      play_count: it.playCount ?? undefined,
      date_added: it.dateAdded ?? undefined,
      recent_min: useRecent && it.recentMin ? Math.min(it.recentMin, minutes) : undefined,
      recent_days: it.recentWindowDays ?? undefined,
      ...extra,
    });
    stats.history_minutes += minutes;
    toInfer.add(entry.id);
  };

  for (const it of items) {
    if (!it || it.extId == null) continue;
    stats.games_seen++;
    const extId = String(it.extId);
    const playtime = Math.max(0, Math.floor(Number(it.playtimeMin) || 0));
    const lastPlayedAt = it.lastPlayedAt || null;
    const meta = { ...(it.meta || {}), ...(it.devices ? { devices: it.devices } : {}) };
    const metaJson = JSON.stringify(meta);
    const recent = Math.max(0, Math.floor(Number(it.recentMin) || 0));
    const recentWindow = (it.recentWindowDays || 14) * DAY;
    let entry = getEntry.get(account.id, extId);

    if (!entry) {
      stats.games_new++;
      const gameId = findOrCreateGame(db, { title: it.title, coverUrl: it.coverUrl }, { autoMerge, now });
      const r = insEntry.run(account.id, gameId, account.platform, extId, String(it.title || extId), it.iconUrl || null, it.coverUrl || null,
        playtime, lastPlayedAt, it.firstPlayedAt || null, it.playCount ?? null, now, now, metaJson);
      entry = { id: Number(r.lastInsertRowid), game_id: gameId, title: it.title, play_count: null };
      fillCover.run(it.coverUrl || null, gameId);
      insSnap.run(entry.id, syncId, now, playtime);
      if (playtime <= 0) continue;

      const playedBeforeLastSync = prevSync && lastPlayedAt && lastPlayedAt < prevSync;
      const startedBeforeLastSync = prevSync && it.firstPlayedAt && it.firstPlayedAt < prevSync;
      const isImport = initial || !prevSync || it.backfill || playedBeforeLastSync;
      if (isImport) {
        // first sight of existing playtime -> history (dated by inference, never a burst today)
        history(entry, playtime, it);
        continue;
      }
      const elapsed = (now - prevSync) / MIN;
      if (!startedBeforeLastSync && playtime <= elapsed + overage) {
        // brand-new game, all of it played since the last sync
        recordDelta(entry, it, playtime, it.firstPlayedAt && it.firstPlayedAt > prevSync ? it.firstPlayedAt : prevSync, now, null);
        stats.games_changed++;
        continue;
      }
      // partly older: the recent counter (Steam) tells us how much is new, the rest is history
      const fresh = recent > 0 ? Math.min(recent, playtime, elapsed) : 0;
      if (fresh >= minSession && fresh > 0) { recordDelta(entry, it, fresh, Math.max(prevSync, now - recentWindow), now, null); stats.games_changed++; }
      history(entry, playtime - fresh, it, { recent_min: undefined });
      continue;
    }

    const delta = playtime - entry.playtime_min;
    if (delta === 0 || (delta > 0 && delta < minSession)) {
      // Nothing (or too little) changed. Keep the old snapshot time when a small delta is
      // pending so it accumulates into the next real session.
      if (delta === 0) updEntry.run(String(it.title || entry.title), it.iconUrl || null, it.coverUrl || null, entry.playtime_min, lastPlayedAt, it.firstPlayedAt || null, it.playCount ?? null, now, metaJson, entry.id);
      else touchEntry.run(String(it.title || entry.title), it.iconUrl || null, it.coverUrl || null, lastPlayedAt, it.firstPlayedAt || null, entry.id);
      continue;
    }

    const prevMeta = safeJson(entry.meta, {});
    updEntry.run(String(it.title || entry.title), it.iconUrl || null, it.coverUrl || null, playtime, lastPlayedAt, it.firstPlayedAt || null, it.playCount ?? null, now, metaJson, entry.id);
    insSnap.run(entry.id, syncId, now, playtime);
    if (delta < 0) continue; // playtime went down (refund/reset); totals follow the platform

    stats.games_changed++;
    let windowStart = entry.last_synced_at || prevSync || entry.first_seen_at;
    // Steam's two-week counter narrows long (weekly/monthly) windows.
    if (recent >= delta && now - windowStart > recentWindow) windowStart = now - recentWindow;
    const elapsed = (now - windowStart) / MIN;
    if (delta > elapsed + overage) {
      // more playtime than wall-clock time: platform back-filled (offline play, late stat writes)
      const p = Math.max(0, Math.floor(elapsed));
      if (p > 0) recordDelta(entry, it, p, windowStart, now, prevMeta);
      insSession.run(entry.id, syncId, source, 'baseline', delta - p, null, now, null, null, null, null, 'Reported late by the platform (offline play / back-fill) - undated', now);
      stats.baseline_minutes += delta - p;
    } else {
      recordDelta(entry, it, delta, windowStart, now, prevMeta);
    }
  }

  if (toInfer.size) {
    flushRollups(db); // day-load accounting reads the rollups
    for (const r of reinferMany(db, toInfer, { account, settings })) {
      if (r) { stats.estimated_minutes += r.chunks.reduce((a, c) => a + c.minutes, 0); stats.baseline_minutes += r.undated; }
    }
  }
  flushRollups(db);
  return stats;
}

export class SyncService {
  constructor({ db, settings, log }) {
    this.db = db;
    this.settings = settings;
    this.log = asLogger(log).scoped('sync');
    this.plog = asLogger(log).scoped('presence');
    this.running = new Map();
    this.enriching = new Map(); // accountId -> in-flight promise
    this.soon = new Map();
    this.presenceState = new Map(); // accountId -> { lastPoll, failures, error }
    this.timer = null;
    this.stopping = false;
  }

  account(id) {
    return parseAccount(this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  }

  scheduleFor(account) {
    const s = this.settings.all();
    return account.schedule ? { ...s, ...account.schedule } : s;
  }

  computeNext(account) {
    if (!account.enabled || providers[account.platform]?.push) return null;
    const scheduled = nextRun(this.scheduleFor(account), account.last_sync_at, Date.now());
    const soon = this.soon.get(account.id);
    return soon && (scheduled == null || soon < scheduled) ? soon : scheduled;
  }

  refreshNext(accountId) {
    const a = this.account(accountId);
    if (a) this.db.prepare('UPDATE accounts SET next_sync_at = ? WHERE id = ?').run(this.computeNext(a), a.id);
  }

  isRunning(id) {
    return this.running.has(id);
  }

  // ---------- API usage accounting ----------
  usage(accountId) {
    const hour = Math.floor(Date.now() / HOUR);
    return this.db.prepare('SELECT calls, errors, rate_limited FROM api_usage WHERE account_id = ? AND hour = ?').get(accountId, hour) || { calls: 0, errors: 0, rate_limited: 0 };
  }

  recordCall(accountId, r, counters) {
    const hour = Math.floor(Date.now() / HOUR);
    try {
      this.db.prepare(`INSERT INTO api_usage(account_id, hour, calls, errors, rate_limited) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(account_id, hour) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors, rate_limited = rate_limited + excluded.rate_limited`)
        .run(accountId, hour, r.ok ? 0 : 1, r.rateLimited ? 1 : 0);
    } catch { /* never fail a request on accounting */ }
    if (counters) {
      counters.calls++;
      if (!r.ok) counters.errors++;
      if (r.rateLimited) counters.rate_limited++;
      counters.ms += r.ms;
      counters.hosts[r.host] = (counters.hosts[r.host] || 0) + 1;
    }
    if (r.rateLimited) this.log.warn(`Rate limited by ${r.host}`, { account_id: accountId, status: r.status });
  }

  ctxFor(account, { counters, warnings } = {}) {
    const getEntry = this.db.prepare('SELECT * FROM entries WHERE account_id = ? AND ext_id = ?');
    return {
      http: (url, opts, cfg = {}) => httpJson(url, opts, { ...cfg, onResult: (r) => this.recordCall(account.id, r, counters) }),
      getEntry: (ext) => getEntry.get(account.id, String(ext)),
      remainingBudget: (limit) => limit - this.usage(account.id).calls,
      warn: (m) => { warnings?.push(m); this.log.warn(m, { account: `${account.platform}/${account.name}` }); },
      stopped: () => this.stopping,
    };
  }

  /** Fetch from the provider and apply. Concurrent calls for the same account share one run. */
  sync(accountId, trigger = 'manual') {
    if (this.running.has(accountId)) return this.running.get(accountId);
    const p = this._sync(accountId, trigger).finally(() => this.running.delete(accountId));
    this.running.set(accountId, p);
    return p;
  }

  async _sync(accountId, trigger, pushedItems = null) {
    const account = this.account(accountId);
    if (!account) throw Object.assign(new Error('Account not found'), { status: 404 });
    const provider = providers[account.platform];
    if (!provider) throw new Error(`Unknown platform ${account.platform}`);
    const db = this.db;
    const startedAt = Date.now();
    const initial = !account.last_sync_at;
    this.soon.delete(account.id);
    const counters = { calls: 0, errors: 0, rate_limited: 0, ms: 0, hosts: {} };
    const warnings = [];
    const syncId = Number(db.prepare('INSERT INTO syncs(account_id, trigger, started_at, initial) VALUES (?, ?, ?, ?)').run(account.id, trigger, startedAt, initial ? 1 : 0).lastInsertRowid);
    const label = `${account.platform}/${account.name}`;
    try {
      let items = pushedItems;
      let state = account.state;
      let info = null;
      if (!items) {
        const res = await provider.fetchLibrary(account, this.ctxFor(account, { counters, warnings }));
        items = res.items;
        state = res.state ?? state;
        info = res.info || null;
        if (res.warning) warnings.push(res.warning);
        if (!items) throw new Error('This account receives data through the API (POST /api/v1/accounts/:id/report)');
      }
      const now = Date.now();
      const warning = warnings.length ? warnings.join('; ').slice(0, 1000) : null;
      const stats = tx(db, () => {
        const s = applyItems(db, account, items, { settings: this.settings.all(), now, syncId, initial, source: 'sync' });
        const details = { api: counters, warnings, info, history_minutes: s.history_minutes, estimated_minutes: s.estimated_minutes, exact_sessions: s.exact_sessions };
        db.prepare(`UPDATE syncs SET finished_at = ?, status = ?, games_seen = ?, games_changed = ?, games_new = ?, sessions_created = ?, minutes_added = ?, baseline_minutes = ?, error = ?, duration_ms = ?, details = ? WHERE id = ?`)
          .run(now, warning ? 'warning' : 'ok', s.games_seen, s.games_changed, s.games_new, s.sessions_created, s.minutes_added, s.history_minutes + s.baseline_minutes, warning, Date.now() - startedAt, JSON.stringify(details), syncId);
        db.prepare('UPDATE accounts SET state = ?, last_sync_at = ?, last_status = ?, last_error = ? WHERE id = ?')
          .run(JSON.stringify(state || {}), now, warning ? 'warning' : 'ok', warning, account.id);
        return s;
      });
      this.refreshNext(account.id);
      const result = { sync_id: syncId, account_id: account.id, initial, ...stats, api_calls: counters.calls, duration_ms: Date.now() - startedAt };
      this.log.info(`${label}: ${stats.games_seen} games, ${stats.sessions_created} sessions (+${stats.minutes_added}m)${stats.history_minutes ? `, ${Math.round(stats.history_minutes / 60)}h history dated (${Math.round(stats.estimated_minutes / 60)}h charted)` : ''}${initial ? ' [initial import]' : ''} in ${result.duration_ms}ms, ${counters.calls} API calls`);
      this.notify(account, result, null);
      if (provider.enrich) this.enrich(account.id).catch((e) => this.log.error(`Enrichment failed for ${label}`, e));
      return result;
    } catch (err) {
      const msg = String(err?.message || err);
      const status = err?.auth ? 'auth' : 'error';
      db.prepare("UPDATE syncs SET finished_at = ?, status = 'error', error = ?, duration_ms = ?, details = ? WHERE id = ?")
        .run(Date.now(), msg, Date.now() - startedAt, JSON.stringify({ api: counters, warnings, auth: !!err?.auth, stack: err?.stack?.split('\n').slice(0, 6).join('\n') }), syncId);
      db.prepare('UPDATE accounts SET last_status = ?, last_error = ? WHERE id = ?').run(status === 'auth' ? 'error' : 'error', err?.auth ? `${msg} - update the credentials for this account` : msg, account.id);
      this.log.error(`${label} failed: ${msg}`, { account_id: account.id, trigger, auth: !!err?.auth, api_calls: counters.calls, ...(err?.auth || err?.name === 'ProviderError' ? {} : { error: err }) });
      this.notify(account, null, msg);
      throw Object.assign(err instanceof Error ? err : new Error(msg), { syncId, status: 502 });
    }
  }

  /** Data pushed by an external reporter (custom accounts or any account). */
  report(accountId, items) {
    if (this.running.has(accountId)) throw Object.assign(new Error('A sync is already running for this account'), { status: 409 });
    const p = this._sync(accountId, 'api', items).finally(() => this.running.delete(accountId));
    this.running.set(accountId, p);
    return p;
  }

  // ---------- enrichment (background): date history with achievement times, release dates ----------
  enrich(accountId, opts) {
    if (this.enriching.has(accountId)) return this.enriching.get(accountId);
    const p = this._enrich(accountId, opts).finally(() => this.enriching.delete(accountId));
    this.enriching.set(accountId, p);
    return p;
  }

  async _enrich(accountId, { limit = 300 } = {}) {
    const account = this.account(accountId);
    const provider = providers[account?.platform];
    if (!account || !provider?.enrich) return null;
    const entries = this.db.prepare('SELECT * FROM entries WHERE account_id = ? AND baseline_min > 0 AND enriched_at IS NULL ORDER BY baseline_min DESC LIMIT ?').all(accountId, limit);
    if (!entries.length) return { updated: 0, anchored: 0, remaining: 0 };
    const counters = { calls: 0, errors: 0, rate_limited: 0, ms: 0, hosts: {} };
    const t0 = Date.now();
    try {
      const { updates } = await provider.enrich(account, entries, this.ctxFor(account, { counters }));
      let anchored = 0;
      tx(this.db, () => {
        for (const u of updates) {
          mergeEvidence(this.db, u.entryId, { anchors: u.anchors?.length ? u.anchors : undefined, release_at: u.release_at });
          if (u.anchors?.length) anchored++;
          if (u.done) this.db.prepare('UPDATE entries SET enriched_at = ? WHERE id = ?').run(Date.now(), u.entryId);
        }
        flushRollups(this.db);
        reinferMany(this.db, updates.map((u) => u.entryId), { account, settings: this.settings.all() });
        flushRollups(this.db);
      });
      this.log.info(`Enriched ${updates.length} ${account.platform} titles (${anchored} with activity timestamps) in ${Math.round((Date.now() - t0) / 1000)}s, ${counters.calls} API calls`);
      // more to do? continue later within rate limits
      const left = this.db.prepare('SELECT COUNT(*) n FROM entries WHERE account_id = ? AND baseline_min > 0 AND enriched_at IS NULL').get(accountId).n;
      if (left && updates.length && !this.stopping) setTimeout(() => this.enrich(accountId).catch((e) => this.log.error('Enrichment failed', e)), account.platform === 'xbox' ? HOUR / 2 : 5000).unref?.();
      return { updated: updates.length, anchored, remaining: left };
    } catch (err) {
      this.log.error(`Enrichment of ${account.platform}/${account.name} failed: ${err.message}`, err);
      throw err;
    }
  }

  // ---------- presence ("currently playing") ----------
  presenceEnabled(account) {
    const p = providers[account.platform];
    return account.enabled && (p?.presence || p?.push) && account.config.presence !== 'off';
  }

  /** Update presence spans from a list of currently-playing titles. Closing a span schedules a sync. */
  applyPresence(account, playing, { intervalSec = 120, now = Date.now() } = {}) {
    const db = this.db;
    const prev = this.presenceState.get(account.id) || {};
    const open = db.prepare('SELECT * FROM presence WHERE account_id = ? AND ended_at IS NULL').all(account.id);
    const ids = new Set(playing.map((p) => String(p.extId)));
    const half = (intervalSec * 1000) / 2;
    let closed = 0;
    tx(db, () => {
      for (const s of open) {
        if (ids.has(s.ext_id)) db.prepare('UPDATE presence SET last_seen_at = ? WHERE id = ?').run(now, s.id);
        else {
          db.prepare('UPDATE presence SET ended_at = ? WHERE id = ?').run(Math.min(now, s.last_seen_at + half), s.id);
          closed++;
        }
      }
      for (const p of playing) {
        if (open.some((s) => s.ext_id === String(p.extId))) continue;
        const start = prev.lastPoll && now - prev.lastPoll < intervalSec * 3000 ? Math.round((prev.lastPoll + now) / 2) : now;
        db.prepare('INSERT INTO presence(account_id, ext_id, title, started_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(account.id, String(p.extId), p.title || null, start, now);
        this.plog.info(`${account.platform}/${account.name} started playing ${p.title || p.extId}`);
      }
      // keep presence history bounded
      db.prepare('DELETE FROM presence WHERE account_id = ? AND ended_at IS NOT NULL AND ended_at < ?').run(account.id, now - 90 * DAY);
    });
    if (closed && !providers[account.platform]?.push) {
      const delay = (providers[account.platform]?.syncAfterSessionSec || 300) * 1000;
      this.soon.set(account.id, now + delay);
      this.refreshNext(account.id);
      this.plog.info(`${account.platform}/${account.name}: session ended, syncing in ${Math.round(delay / 60000)} min`);
    }
    return { open: ids.size, closed };
  }

  async pollPresence(account) {
    const provider = providers[account.platform];
    const st = this.presenceState.get(account.id) || { failures: 0 };
    const now = Date.now();
    const ctx = this.ctxFor(account);
    try {
      const res = await provider.presence(account, ctx);
      if (res === null) return; // provider declined (no budget / not configured yet)
      if (res.state) this.db.prepare('UPDATE accounts SET state = ? WHERE id = ?').run(JSON.stringify({ ...account.state, ...res.state }), account.id);
      st.error = res.unavailable || null;
      this.applyPresence(account, res.playing || [], { intervalSec: provider.presenceIntervalSec, now });
      if (st.failures >= 3) this.plog.info(`${account.platform}/${account.name}: presence recovered`);
      st.failures = 0;
    } catch (err) {
      st.failures++;
      st.error = err.message;
      // log the first failure and then only every 10th to avoid flooding
      if (st.failures === 1 || st.failures % 10 === 0) this.plog.warn(`${account.platform}/${account.name}: presence check failed (${st.failures}x): ${err.message}`, { account_id: account.id });
    } finally {
      st.lastPoll = now;
      this.presenceState.set(account.id, st);
    }
  }

  nowPlaying() {
    return this.db.prepare(`SELECT p.account_id, p.ext_id, p.title presence_title, p.started_at, p.last_seen_at, a.platform, a.name account_name,
        e.game_id, g.title, g.cover_url
      FROM presence p JOIN accounts a ON a.id = p.account_id
      LEFT JOIN entries e ON e.account_id = p.account_id AND e.ext_id = p.ext_id LEFT JOIN games g ON g.id = e.game_id
      WHERE p.ended_at IS NULL AND p.last_seen_at > ?`).all(Date.now() - 20 * MIN)
      .map((r) => ({ ...r, title: r.title || r.presence_title || r.ext_id, minutes: Math.round((r.last_seen_at - r.started_at) / MIN) }));
  }

  presenceInfo(accountId) {
    const st = this.presenceState.get(accountId);
    return st ? { last_poll: st.lastPoll || null, failures: st.failures, error: st.error || null } : null;
  }

  notify(account, result, error) {
    const s = this.settings.all();
    if (!s.webhook_url) return;
    if (s.webhook_on === 'errors' && !error) return;
    if (s.webhook_on === 'sessions' && !error && !(result?.sessions_created > 0)) return;
    sendWebhook(s.webhook_url, { account, result, error }).catch((e) => this.log.warn(`Webhook delivery failed: ${e.message}`));
  }

  start() {
    // History inferred by an older algorithm version (or migrated installs) is redone once.
    try { flushRollups(this.db); reinferPending(this.db, { log: this.log, settings: this.settings.all() }); flushRollups(this.db); } catch (e) { this.log.error('History inference failed', e); }
    const tick = async () => {
      const rows = this.db.prepare('SELECT * FROM accounts WHERE enabled = 1').all().map(parseAccount);
      const now = Date.now();
      for (const a of rows) {
        const provider = providers[a.platform];
        const next = this.computeNext(a);
        if (a.next_sync_at !== next) this.db.prepare('UPDATE accounts SET next_sync_at = ? WHERE id = ?').run(next, a.id);
        if (next != null && next <= now && !this.running.has(a.id)) {
          // back off 30 minutes after a failed attempt
          const last = this.db.prepare('SELECT started_at, status FROM syncs WHERE account_id = ? ORDER BY id DESC LIMIT 1').get(a.id);
          if (!(last?.status === 'error' && now - last.started_at < 30 * MIN)) {
            const trigger = this.soon.has(a.id) && this.soon.get(a.id) <= now ? 'session-end' : 'schedule';
            this.sync(a.id, trigger).catch(() => {});
          }
        }
        if (provider?.presence && this.presenceEnabled(a) && a.last_sync_at) {
          const st = this.presenceState.get(a.id) || {};
          const backoff = Math.min(10, 2 ** Math.max(0, (st.failures || 0) - 1));
          if (!st.lastPoll || now - st.lastPoll >= provider.presenceIntervalSec * 1000 * backoff) await this.pollPresence(a);
        }
      }
    };
    const run = () => tick().catch((e) => this.log.error('Scheduler tick failed', e));
    this.timer = setInterval(run, 30_000);
    this.timer.unref?.();
    setTimeout(run, 5_000).unref?.();
  }

  stop() {
    this.stopping = true;
    clearInterval(this.timer);
  }
}
