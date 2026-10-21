import { tx } from '../db.js';
import { providers } from '../providers/index.js';
import { findOrCreateGame } from './library.js';
import { nextRun } from './schedule.js';
import { sendWebhook } from './webhook.js';
import { flushRollups } from './rollup.js';

const MIN = 60_000;
const DAY = 1440 * MIN;

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

/**
 * Turn a play delta into session rows. `lastPlayedAt` (if the platform reports it and it
 * falls inside the window) pins the end of the session; otherwise only the window is known.
 */
function insertSession(db, { entryId, syncId, source, kind, minutes, windowStart, windowEnd, lastPlayedAt, note, now }) {
  if (minutes <= 0) return null;
  let started = null;
  let ended = null;
  if (kind === 'play' && lastPlayedAt && lastPlayedAt > windowStart && lastPlayedAt <= windowEnd + MIN) {
    ended = Math.min(lastPlayedAt, windowEnd);
    started = Math.max(windowStart, ended - minutes * MIN);
  }
  // A window barely longer than the session means we know exactly when it happened.
  if (kind === 'play' && !ended && windowEnd - windowStart <= (minutes + 10) * MIN) {
    ended = windowEnd;
    started = windowStart;
  }
  const r = db.prepare(`INSERT INTO sessions(entry_id, sync_id, source, kind, minutes, window_start, window_end, started_at, ended_at, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(entryId, syncId, source, kind, Math.round(minutes), windowStart, windowEnd, started, ended, note || null, now);
  return Number(r.lastInsertRowid);
}

/**
 * Core algorithm: compare reported lifetime playtime against the last snapshot and
 * record the difference as play sessions. Pure DB logic so it is shared by provider
 * syncs, API pushes and tests.
 *
 * Mass-import handling: the first time an entry is seen during an account's initial
 * sync (or when the platform says it was last played before our previous sync) its
 * existing playtime is stored as a 'baseline' that counts toward lifetime totals but
 * never shows up as a burst of play in daily/weekly stats.
 */
export function applyItems(db, account, items, { settings, now = Date.now(), syncId, initial, source = 'sync' }) {
  const minSession = Math.max(0, Number(settings.min_session_minutes) || 0);
  const overage = Math.max(0, Number(settings.max_overage_minutes) || 0);
  const useRecent = settings.use_recent_on_import !== false;
  const autoMerge = settings.auto_merge_titles !== false;
  const prevSync = account.last_sync_at;
  const stats = { games_seen: 0, games_changed: 0, games_new: 0, sessions_created: 0, minutes_added: 0, baseline_minutes: 0, new_sessions: [] };

  const getEntry = db.prepare('SELECT * FROM entries WHERE account_id = ? AND ext_id = ?');
  const insEntry = db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, icon_url, cover_url, playtime_min, last_played_at, first_seen_at, last_synced_at, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updEntry = db.prepare(`UPDATE entries SET title = ?, icon_url = COALESCE(?, icon_url), cover_url = COALESCE(?, cover_url),
    playtime_min = ?, last_played_at = COALESCE(?, last_played_at), last_synced_at = ?, meta = ? WHERE id = ?`);
  const touchEntry = db.prepare('UPDATE entries SET title = ?, icon_url = COALESCE(?, icon_url), cover_url = COALESCE(?, cover_url), last_played_at = COALESCE(?, last_played_at), meta = ? WHERE id = ?');
  const insSnap = db.prepare('INSERT INTO snapshots(entry_id, sync_id, taken_at, playtime_min) VALUES (?, ?, ?, ?)');
  const fillCover = db.prepare('UPDATE games SET cover_url = ? WHERE id = ? AND cover_url IS NULL');

  const record = (entry, title, kind, minutes, windowStart, windowEnd, lastPlayedAt, note) => {
    const id = insertSession(db, { entryId: entry.id, syncId, source, kind, minutes, windowStart, windowEnd, lastPlayedAt, note, now });
    if (!id) return;
    if (kind === 'play') {
      stats.sessions_created++;
      stats.minutes_added += Math.round(minutes);
      stats.new_sessions.push({ id, entry_id: entry.id, game_id: entry.game_id, title, minutes: Math.round(minutes), platform: account.platform });
    } else {
      stats.baseline_minutes += Math.round(minutes);
    }
  };

  for (const it of items) {
    if (!it || it.extId == null) continue;
    stats.games_seen++;
    const extId = String(it.extId);
    const playtime = Math.max(0, Math.floor(Number(it.playtimeMin) || 0));
    const lastPlayedAt = it.lastPlayedAt || null;
    const metaJson = JSON.stringify(it.meta || {});
    const recent = Math.max(0, Math.floor(Number(it.recentMin) || 0));
    const recentWindow = (it.recentWindowDays || 14) * DAY;
    let entry = getEntry.get(account.id, extId);

    if (!entry) {
      stats.games_new++;
      const gameId = findOrCreateGame(db, { title: it.title, coverUrl: it.coverUrl }, { autoMerge, now });
      const r = insEntry.run(account.id, gameId, account.platform, extId, String(it.title || extId), it.iconUrl || null, it.coverUrl || null,
        playtime, lastPlayedAt, now, now, metaJson);
      entry = { id: Number(r.lastInsertRowid), game_id: gameId };
      fillCover.run(it.coverUrl || null, gameId);
      insSnap.run(entry.id, syncId, now, playtime);
      if (playtime <= 0) continue;

      const playedBeforeLastSync = prevSync && lastPlayedAt && lastPlayedAt < prevSync;
      const isImport = initial || !prevSync || it.backfill || playedBeforeLastSync;
      const elapsed = prevSync ? (now - prevSync) / MIN : 0;
      let play = 0;
      let windowStart = prevSync || now;
      if (isImport) {
        if (useRecent && recent > 0) { play = Math.min(recent, playtime); windowStart = now - recentWindow; }
      } else if (playtime <= elapsed + overage) {
        play = playtime; // brand new game, all of it played since the last sync
      } else if (recent > 0) {
        play = Math.min(recent, playtime, elapsed);
        windowStart = Math.max(prevSync, now - recentWindow);
      }
      if (play > 0 && play >= minSession) record(entry, it.title, 'play', play, windowStart, now, lastPlayedAt);
      else play = 0;
      record(entry, it.title, 'baseline', playtime - play, null, now, null, isImport ? 'Imported history' : 'Playtime before tracking started');
      if (play > 0) stats.games_changed++;
      continue;
    }

    const delta = playtime - entry.playtime_min;
    if (delta === 0 || (delta > 0 && delta < minSession)) {
      // Nothing (or too little) changed. Keep the old snapshot time when a small delta is
      // pending so it accumulates into the next real session.
      if (delta === 0) updEntry.run(String(it.title || entry.title), it.iconUrl || null, it.coverUrl || null, entry.playtime_min, lastPlayedAt, now, metaJson, entry.id);
      else touchEntry.run(String(it.title || entry.title), it.iconUrl || null, it.coverUrl || null, lastPlayedAt, metaJson, entry.id);
      continue;
    }

    updEntry.run(String(it.title || entry.title), it.iconUrl || null, it.coverUrl || null, playtime, lastPlayedAt, now, metaJson, entry.id);
    insSnap.run(entry.id, syncId, now, playtime);
    if (delta < 0) continue; // playtime went down (refund/reset); totals follow the platform

    stats.games_changed++;
    let windowStart = entry.last_synced_at || prevSync || entry.first_seen_at;
    // Steam's two-week counter narrows long (weekly/monthly) windows.
    if (recent >= delta && now - windowStart > recentWindow) windowStart = now - recentWindow;
    const elapsed = (now - windowStart) / MIN;
    if (delta > elapsed + overage) {
      const play = Math.max(0, Math.floor(elapsed));
      record(entry, it.title, 'play', play, windowStart, now, lastPlayedAt);
      record(entry, it.title, 'baseline', delta - play, null, now, null, 'Reported playtime exceeded wall-clock time since the last sync');
    } else {
      record(entry, it.title, 'play', delta, windowStart, now, lastPlayedAt);
    }
  }
  flushRollups(db);
  return stats;
}

export class SyncService {
  constructor({ db, settings, log = console }) {
    this.db = db;
    this.settings = settings;
    this.log = log;
    this.running = new Map();
    this.timer = null;
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
    return nextRun(this.scheduleFor(account), account.last_sync_at, Date.now());
  }

  refreshNext(accountId) {
    const a = this.account(accountId);
    if (a) this.db.prepare('UPDATE accounts SET next_sync_at = ? WHERE id = ?').run(this.computeNext(a), a.id);
  }

  isRunning(id) {
    return this.running.has(id);
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
    const syncId = Number(db.prepare('INSERT INTO syncs(account_id, trigger, started_at, initial) VALUES (?, ?, ?, ?)').run(account.id, trigger, startedAt, initial ? 1 : 0).lastInsertRowid);
    try {
      let items = pushedItems;
      let state = account.state;
      let warning = null;
      if (!items) {
        const getEntry = db.prepare('SELECT * FROM entries WHERE account_id = ? AND ext_id = ?');
        const res = await provider.fetchLibrary(account, { getEntry: (ext) => getEntry.get(account.id, String(ext)) });
        items = res.items;
        state = res.state ?? state;
        warning = res.warning || null;
        if (!items) throw new Error('This account receives data through the API (POST /api/v1/accounts/:id/report)');
      }
      const now = Date.now();
      const stats = tx(db, () => {
        const s = applyItems(db, account, items, { settings: this.settings.all(), now, syncId, initial, source: 'sync' });
        db.prepare(`UPDATE syncs SET finished_at = ?, status = ?, games_seen = ?, games_changed = ?, games_new = ?, sessions_created = ?, minutes_added = ?, baseline_minutes = ?, error = ? WHERE id = ?`)
          .run(now, warning ? 'warning' : 'ok', s.games_seen, s.games_changed, s.games_new, s.sessions_created, s.minutes_added, s.baseline_minutes, warning, syncId);
        db.prepare('UPDATE accounts SET state = ?, last_sync_at = ?, last_status = ?, last_error = ? WHERE id = ?')
          .run(JSON.stringify(state || {}), now, warning ? 'warning' : 'ok', warning, account.id);
        return s;
      });
      this.refreshNext(account.id);
      const result = { sync_id: syncId, account_id: account.id, initial, ...stats };
      this.log.info?.(`[sync] ${account.platform}/${account.name}: ${stats.games_seen} games, ${stats.sessions_created} sessions, +${stats.minutes_added}m${initial ? ' (initial import)' : ''}`);
      this.notify(account, result, null);
      return result;
    } catch (err) {
      const msg = String(err?.message || err);
      db.prepare("UPDATE syncs SET finished_at = ?, status = 'error', error = ? WHERE id = ?").run(Date.now(), msg, syncId);
      db.prepare("UPDATE accounts SET last_status = 'error', last_error = ? WHERE id = ?").run(msg, account.id);
      this.log.error?.(`[sync] ${account.platform}/${account.name} failed: ${msg}`);
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

  notify(account, result, error) {
    const s = this.settings.all();
    if (!s.webhook_url) return;
    if (s.webhook_on === 'errors' && !error) return;
    if (s.webhook_on === 'sessions' && !error && !(result?.sessions_created > 0)) return;
    sendWebhook(s.webhook_url, { account, result, error }).catch((e) => this.log.warn?.(`[webhook] ${e.message}`));
  }

  start() {
    const tick = async () => {
      const rows = this.db.prepare('SELECT * FROM accounts WHERE enabled = 1').all().map(parseAccount);
      const now = Date.now();
      for (const a of rows) {
        const next = this.computeNext(a);
        if (a.next_sync_at !== next) this.db.prepare('UPDATE accounts SET next_sync_at = ? WHERE id = ?').run(next, a.id);
        if (next == null || next > now || this.running.has(a.id)) continue;
        // back off 30 minutes after a failed attempt
        const last = this.db.prepare('SELECT started_at, status FROM syncs WHERE account_id = ? ORDER BY id DESC LIMIT 1').get(a.id);
        if (last?.status === 'error' && now - last.started_at < 30 * MIN) continue;
        this.sync(a.id, 'schedule').catch(() => {});
      }
    };
    this.timer = setInterval(() => tick().catch((e) => this.log.error?.(e)), 60_000);
    this.timer.unref?.();
    setTimeout(() => tick().catch((e) => this.log.error?.(e)), 5_000).unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}
