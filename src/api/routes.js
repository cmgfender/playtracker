import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tx } from '../db.js';
import { providers, providerInfo } from '../providers/index.js';
import { parseAccount } from '../services/sync.js';
import { validateSettings } from '../services/settings.js';
import { describeSchedule, nextRun } from '../services/schedule.js';
import { computeStats, heatmap, lifetime, yearInReview, memo } from '../services/stats.js';
import { findDuplicates } from '../services/duplicates.js';
import { importRows, exportChunks, parseCsv } from '../services/importer.js';
import { manualEntry, mergeGames, pruneEmptyGames, splitEntry, findOrCreateGame, cleanTitle } from '../services/library.js';
import { normalizeTitle } from '../services/titles.js';
import { reinferMany, reinferPending, relearnStyle, styleOf, INFER_VERSION } from '../services/inference.js';
import { flushRollups } from '../services/rollup.js';
import { applyLicenses } from '../services/licenses.js';
import { readZip, isZip } from '../services/zip.js';
import { gameTrackTables, importGameTrack } from '../services/gametrack.js';
import { modelFor } from '../services/model.js';
import { entrySummaries, combineSummaries, gameAchievements, withSessionAchievements, achievementStats, achievementProgress } from '../services/achievements.js';
import { punchcard, sessionLengths, platformSeries, timeline, gameCurve, libraryOverview, yearOverYear, records } from '../services/insights.js';
import fsp from 'node:fs';
import { httpJson, ProviderError } from '../providers/http.js';
import { HttpError, toInt, toTime } from '../util.js';

const MIN = 60_000;
const STATUSES = ['unset', 'backlog', 'playing', 'paused', 'completed', 'beaten', 'dropped', 'wishlist'];

function mask(v) {
  const s = String(v ?? '');
  if (!s) return '';
  return s.length <= 6 ? '••••••' : `••••••${s.slice(-4)}`;
}

function publicAccount(a, sync) {
  const p = providers[a.platform];
  const config = {};
  for (const [k, v] of Object.entries(a.config)) {
    const f = p?.fields.find((x) => x.key === k);
    config[k] = f?.type === 'password' ? mask(v) : v;
  }
  return {
    id: a.id, platform: a.platform, name: a.name, enabled: a.enabled, config,
    schedule: a.schedule, schedule_label: describeSchedule(sync.scheduleFor(a)),
    last_sync_at: a.last_sync_at, next_sync_at: a.next_sync_at, last_status: a.last_status, last_error: a.last_error,
    syncing: sync.isRunning(a.id), push: !!p?.push, created_at: a.created_at,
    games: a.games ?? undefined, minutes: a.minutes ?? undefined,
    presence: p?.presence || p?.push ? { enabled: sync.presenceEnabled(a), interval_sec: p.profile?.presence?.interval_sec || null, ...(sync.presenceInfo(a.id) || {}) } : null,
    api_usage_hour: sync.usage(a.id),
    // what the API itself last reported about the quota (shared with anything else using the key)
    api_quota: sync.quota?.get(a.id) ? { ...sync.quota.get(a.id) } : null,
    hourly_limit: p?.hourlyLimit ? p.hourlyLimit(a) : null,
    // outlines of platform responses that had no playtime (diagnostics)
    missing_minutes_samples: a.state?.missing_minutes_samples || undefined,
    history_model: p ? modelFor(p, a).describe() : null,
    profile: a.state?.persona ? { name: a.state.persona, avatar: a.state.avatar, account_created_at: a.state.account_created_at || null } : null,
  };
}

// response shapes documented in the OpenAPI document (`returns`), shared by the routes carrying them
const ACH_SUMMARY_DOC = '{ total, unlocked, percent (0-100, floored to 0.1), points, points_total (Xbox gamerscore; null elsewhere), '
  + 'grades ({ platinum, gold, silver, bronze } unlocked; PlayStation, null elsewhere), last_unlocked_at, completed (everything unlocked, or the PlayStation platinum), '
  + 'completed_at, fetched_at (when the platform was last read) } | null (never read, or not a platform title)';
const ACH_ITEM_DOC = '{ id (platform id: Steam apiname, Xbox achievement id, PlayStation "<npCommunicationId>:<trophyId>"; unique per entry), entry_id, platform, name, description, '
  + 'icon_url, icon_locked_url, unlocked, unlocked_at (null: locked, or the platform has no time), rarity (% of players), points (Xbox gamerscore), '
  + 'grade (PlayStation bronze|silver|gold|platinum), hidden, group (PlayStation trophy group) }';
const SESSION_ACH_DOC = 'achievements: { count, items: [{ id, entry_id, name, icon_url, rarity, points, grade, unlocked_at }] } - the unlocks that belong to the session (by time; see GET /games/{id}/achievements)';
const SESSION_DOC = '{ id, game_id, entry_id, title, cover_url, platform, account_id, account_name, source, kind, minutes, window_start, window_end, started_at, ended_at, precise, confidence, device, note, sync_id, created_at, '
  + `${SESSION_ACH_DOC} }`;

const ESTIMATES = new Set(['include', 'exclude', 'only']);
const estimatesParam = (q, settings) => (ESTIMATES.has(q.estimates) ? q.estimates : settings.get('stats_estimates') || 'include');

function requireFields(platform, config) {
  const p = providers[platform];
  if (!p) throw new HttpError(400, `Unknown platform "${platform}". Use one of: ${Object.keys(providers).join(', ')}`);
  const missing = p.fields.filter((f) => f.required && !String(config[f.key] ?? '').trim()).map((f) => f.label);
  if (missing.length) throw new HttpError(400, `Missing: ${missing.join(', ')}`);
}

function gameRow(g) {
  return {
    id: g.id, title: g.title, cover_url: g.cover_url, status: g.status, rating: g.rating, notes: g.notes,
    favorite: !!g.favorite, hidden: !!g.hidden, merge_locked: !!g.merge_locked,
    minutes: g.minutes ?? 0, recent_minutes: g.recent_minutes ?? 0,
    platforms: g.platforms ? String(g.platforms).split(',').filter(Boolean) : [],
    entry_count: g.entry_count ?? 0,
    last_played_at: Math.max(g.last_played_entry || 0, g.last_session || 0) || null,
    created_at: g.created_at, updated_at: g.updated_at,
  };
}

// Library listing: per-game aggregates come from the (indexed) entries table and the
// per-day rollup, never from scanning sessions, so it stays fast for huge libraries.
const RECENT_DAYS = 14;
function recentFromDay() {
  const d = new Date(Date.now() - (RECENT_DAYS - 1) * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const GAME_LIST = `WITH agg AS (
    SELECT game_id,
      COALESCE(SUM(CASE WHEN excluded = 0 THEN playtime_min END), 0) minutes,
      GROUP_CONCAT(DISTINCT platform) platforms,
      COUNT(*) entry_count,
      MAX(COALESCE(last_played_at, 0)) last_played_entry,
      MAX(CASE WHEN excluded = 0 THEN COALESCE(last_session_at, 0) ELSE 0 END) last_session
    FROM entries GROUP BY game_id),
  rec AS (
    SELECT game_id, SUM(minutes) recent_minutes FROM play_days WHERE excluded = 0 AND day >= ? GROUP BY game_id)
  SELECT g.*, agg.minutes, agg.platforms, agg.entry_count, agg.last_played_entry, agg.last_session, COALESCE(rec.recent_minutes, 0) recent_minutes
  FROM games g JOIN agg ON agg.game_id = g.id LEFT JOIN rec ON rec.game_id = g.id`;

const GAME_SORTS = {
  recent: 'MAX(agg.last_session, agg.last_played_entry) DESC, agg.minutes DESC, g.id',
  playtime: 'agg.minutes DESC, g.id', title: 'g.title COLLATE NOCASE ASC, g.id', added: 'g.created_at DESC, g.id',
  rating: 'COALESCE(g.rating, -1) DESC, agg.minutes DESC, g.id', trending: 'recent_minutes DESC, agg.minutes DESC, g.id',
};

function sessionRow(s) {
  return {
    id: s.id, game_id: s.game_id, entry_id: s.entry_id, title: s.title, cover_url: s.cover_url, platform: s.platform,
    account_id: s.account_id, account_name: s.account_name, source: s.source, kind: s.kind, minutes: s.minutes,
    window_start: s.window_start, window_end: s.window_end, started_at: s.started_at, ended_at: s.ended_at,
    precise: !!(s.started_at && s.ended_at), confidence: s.confidence || (s.started_at && s.ended_at ? 'pinned' : s.kind === 'play' ? 'window' : null),
    device: s.device || null, note: s.note, sync_id: s.sync_id, created_at: s.created_at,
  };
}

const SESSION_SELECT = `SELECT s.*, e.game_id, e.platform, e.account_id, a.name account_name, g.title, g.cover_url
  FROM sessions s JOIN entries e ON e.id = s.entry_id JOIN games g ON g.id = e.game_id LEFT JOIN accounts a ON a.id = e.account_id`;

// strict booleans (as in settings and imports): "false" or "0" must never read as true
const flag = (v) => (v === true || v === 'true' || v === 1 || v === '1' ? 1 : 0);
// search text for `LIKE ? ESCAPE '\'`: % and _ are literal characters, not wildcards
const likeText = (s) => `%${String(s).replace(/[\\%_]/g, '\\$&')}%`;
/** toTime() of a body field; a value that is given but is not a time is a 400, never "no time". */
function timeField(b, k) {
  const t = toTime(b[k]);
  if (t == null && b[k] != null && b[k] !== '') throw new HttpError(400, `${k} is not a valid time`);
  return t;
}
/** A from/to query bound: a date (YYYY-MM-DD) covers that whole local day. */
function dayBound(v, end) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (end ? 1 : 0)).getTime() - (end ? 1 : 0) : toTime(v);
}

export function registerRoutes(r, app) {
  // query numbers within sane bounds (SQLite treats LIMIT -1 as "no limit")
  const clamp = (v, def, min, max) => Math.min(max, Math.max(min, toInt(v, def)));
  // ?dry_run=true: run an import for real inside a transaction, report, then roll it all back
  const preview = (c, fn) => {
    if (c.query.dry_run !== 'true' && c.query.dry_run !== '1') return fn();
    db.exec('BEGIN IMMEDIATE');
    try { return { ...fn(), dry_run: true }; } finally { db.exec('ROLLBACK'); }
  };
  const arr = (v, name) => {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new HttpError(400, `${name} must be an array`);
    return v;
  };
  const { db, settings, sync, auth, version, revision = null } = app;

  // ---------- meta ----------
  r.get('/api/v1/health', () => ({ ok: true, version, revision, time: Date.now(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }), { summary: 'Health check', public: true });
  r.get('/api/v1/platforms', () => providerInfo(), { summary: 'Supported platforms and their credential fields' });

  // ---------- auth ----------
  // password_env (the variable that sets the password) is configuration detail: signed-in callers only
  r.get('/api/v1/auth/status', (c) => ({
    auth_enabled: auth.enabled(), authenticated: c.auth.ok, via: c.auth.via, password_source: auth.passwordSource(),
    ...(c.auth.ok ? { password_env: auth.passwordEnv() } : {}),
  }), { summary: 'Auth status', public: true });
  // failed logins per client address: after 5 within 15 minutes, wait (grows up to 15 minutes)
  const failures = new Map();
  r.post('/api/v1/auth/login', (c) => {
    if (!auth.enabled()) return { ok: true };
    const ip = c.req.socket.remoteAddress || '?';
    const now = Date.now();
    const f = failures.get(ip);
    if (f && f.blockedUntil > now) throw new HttpError(429, `Too many attempts - try again in ${Math.ceil((f.blockedUntil - now) / 1000)}s`);
    const pw = typeof c.body.password === 'string' ? c.body.password : '';
    if (pw.length > 1024 || !auth.checkPassword(pw)) {
      const rec = f && now - f.first < 15 * 60_000 ? f : { first: now, count: 0, blockedUntil: 0 };
      rec.count++;
      if (rec.count >= 5) rec.blockedUntil = now + Math.min(15 * 60_000, 30_000 * 2 ** (rec.count - 5));
      failures.set(ip, rec);
      if (failures.size > 10_000) failures.clear();
      throw new HttpError(401, 'Wrong password');
    }
    failures.delete(ip);
    const s = auth.createLoginSession();
    c.setCookie('pt_session', s.token, s.maxAge);
    return { ok: true };
  }, { summary: 'Log in (sets a cookie)', body: '{ password }', public: true });
  r.post('/api/v1/auth/logout', (c) => {
    auth.destroyLoginSession(c.cookies.pt_session);
    c.setCookie('pt_session', '', 0);
    return { ok: true };
  }, { summary: 'Log out', public: true });
  r.put('/api/v1/auth/password', (c) => {
    for (const k of ['current', 'password']) if (c.body[k] != null && typeof c.body[k] !== 'string') throw new HttpError(400, `${k} must be a string`);
    if (auth.enabled() && !auth.checkPassword(String(c.body.current || ''))) throw new HttpError(401, 'Current password is wrong');
    auth.setPassword(c.body.password ? String(c.body.password) : '');
    if (c.body.password) {
      const s = auth.createLoginSession();
      c.setCookie('pt_session', s.token, s.maxAge);
    }
    return { ok: true, auth_enabled: auth.enabled() };
  }, { summary: 'Set, change or remove (empty) the UI password', body: '{ current?, password }' });

  // ---------- dashboard ----------
  r.get('/api/v1/summary', () => {
    const weekStartsOn = settings.get('week_starts_on');
    // KPIs use tracked play only (never inflated by an import); the 30-day chart also
    // shows inferred history, flagged as estimated.
    const week = computeStats(db, { range: 'week', group: 'day', weekStartsOn, estimates: 'exclude' });
    const month = computeStats(db, { range: '30d', group: 'day', weekStartsOn, estimates: estimatesParam({}, settings) });
    const today = computeStats(db, { range: '1d', group: 'day', weekStartsOn, estimates: 'exclude' });
    const recent = db.prepare(`${SESSION_SELECT} WHERE s.kind = 'play' AND e.excluded = 0 ORDER BY s.sort_time DESC LIMIT 12`).all().map(sessionRow);
    const nowPlaying = db.prepare(`${GAME_LIST} WHERE rec.recent_minutes > 0 AND g.hidden = 0 ORDER BY agg.last_session DESC LIMIT 12`).all(recentFromDay()).map(gameRow);
    const accounts = db.prepare('SELECT * FROM accounts ORDER BY id').all().map(parseAccount).map((a) => publicAccount(a, sync));
    const pending = db.prepare("SELECT COUNT(*) n FROM sessions WHERE kind = 'play' AND sort_time > ? AND created_at > ?").get(Date.now() - 30 * 86_400_000, Date.now() - 86_400_000).n;
    const errors24h = db.prepare("SELECT COUNT(*) n FROM logs WHERE level = 'error' AND time > ?").get(Date.now() - 86_400_000).n;
    return { lifetime: lifetime(db), today, week, month, recent_sessions: recent, now_playing: nowPlaying, playing_now: sync.nowPlaying(), accounts, new_sessions_24h: pending, errors_24h: errors24h };
  }, { summary: 'Everything the dashboard needs in one call' });

  // ---------- games ----------
  r.get('/api/v1/games', (c) => {
    const q = c.query;
    const where = [];
    const args = [recentFromDay()];
    if (q.q) { where.push("(g.title LIKE ? ESCAPE '\\' OR g.norm_title LIKE ? ESCAPE '\\')"); args.push(likeText(q.q), likeText(normalizeTitle(q.q))); }
    if (q.status) { where.push(`g.status IN (${q.status.split(',').map(() => '?').join(',')})`); args.push(...q.status.split(',')); }
    if (q.favorite === 'true' || q.favorite === '1') where.push('g.favorite = 1');
    if (q.hidden === 'only') where.push('g.hidden = 1');
    else if (q.hidden !== 'true' && q.hidden !== 'all') where.push('g.hidden = 0');
    if (q.platform) { where.push(`g.id IN (SELECT game_id FROM entries WHERE platform IN (${q.platform.split(',').map(() => '?').join(',')}))`); args.push(...q.platform.split(',')); }
    if (q.account_id) { where.push('g.id IN (SELECT game_id FROM entries WHERE account_id = ?)'); args.push(toInt(q.account_id)); }
    if (q.played === 'true') where.push('agg.minutes > 0');
    if (q.played === 'false') where.push('agg.minutes = 0');
    if (q.multi === 'true') where.push('agg.entry_count > 1');
    if (q.recent === 'true') where.push('rec.recent_minutes > 0');
    const order = GAME_SORTS[q.sort] || GAME_SORTS[settings.get('default_library_sort')] || GAME_SORTS.recent;
    const limit = Math.min(5000, Math.max(1, toInt(q.limit, 100)));
    const offset = Math.max(0, toInt(q.offset, 0));
    const base = `${GAME_LIST} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const totals = memo(db, `games-count:${JSON.stringify(args)}:${where.join('|')}`, () => db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(minutes), 0) m, COALESCE(MAX(minutes), 0) mx FROM (${base})`).get(...args));
    const items = db.prepare(`${base} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset).map(gameRow);
    return { total: totals.n, total_minutes: totals.m, max_minutes: totals.mx, limit, offset, items };
  }, { summary: 'List / search the library (paginated)', query: { q: 'search', platform: 'steam,xbox,psn,…', status: 'comma list', sort: 'recent|playtime|title|added|rating|trending', played: 'true|false', favorite: 'true', hidden: 'true|only', multi: 'true = only games with several entries', recent: 'true = played in the last 14 days', limit: 'max 5000 (default 100)', offset: '' } });

  r.post('/api/v1/games', (c) => {
    const title = typeof c.body.title === 'string' ? c.body.title.trim() : '';
    if (!title) throw new HttpError(400, 'title is required');
    const now = Date.now();
    const id = tx(db, () => {
      const gid = c.body.merge === false
        ? Number(db.prepare('INSERT INTO games(title, norm_title, cover_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(cleanTitle(title), normalizeTitle(title), c.body.cover_url || null, now, now).lastInsertRowid)
        : findOrCreateGame(db, { title, coverUrl: c.body.cover_url }, { autoMerge: true, now });
      manualEntry(db, gid, now);
      if (c.body.status && STATUSES.includes(c.body.status)) db.prepare('UPDATE games SET status = ? WHERE id = ?').run(c.body.status, gid);
      return gid;
    });
    return getGame(id);
  }, { summary: 'Add a game manually (Switch, retro, …)', body: '{ title, cover_url?, status?, merge? }' });

  function getGame(id) {
    const base = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    const ea = db.prepare(`SELECT COALESCE(SUM(CASE WHEN excluded = 0 THEN playtime_min END), 0) minutes, GROUP_CONCAT(DISTINCT platform) platforms, COUNT(*) entry_count,
      MAX(COALESCE(last_played_at, 0)) last_played_entry, MAX(CASE WHEN excluded = 0 THEN COALESCE(last_session_at, 0) ELSE 0 END) last_session FROM entries WHERE game_id = ?`).get(id);
    const rec = db.prepare('SELECT COALESCE(SUM(minutes), 0) m FROM play_days WHERE game_id = ? AND excluded = 0 AND day >= ?').get(id, recentFromDay()).m;
    const g = base && ea.entry_count ? { ...base, ...ea, recent_minutes: rec } : null;
    if (!g) {
      const bare = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
      if (!bare) throw new HttpError(404, 'Game not found');
      return { ...gameRow(bare), entries: [], achievements: null };
    }
    const rows = db.prepare(`SELECT e.*, a.name account_name FROM entries e LEFT JOIN accounts a ON a.id = e.account_id WHERE e.game_id = ? ORDER BY e.playtime_min DESC`).all(id);
    const ach = entrySummaries(db, rows);
    const entries = rows
      .map((e) => {
        const h = JSON.parse(e.hist || '{}');
        return {
          id: e.id, account_id: e.account_id, account_name: e.account_name, platform: e.platform, ext_id: e.ext_id, title: e.title, icon_url: e.icon_url, cover_url: e.cover_url,
          playtime_min: e.playtime_min, last_played_at: e.last_played_at, first_played_at: e.first_played_at, play_count: e.play_count,
          first_seen_at: e.first_seen_at, last_synced_at: e.last_synced_at, excluded: !!e.excluded, meta: JSON.parse(e.meta || '{}'),
          missing_since: e.missing_since || null, group_key: e.group_key || null,
          history: e.baseline_min > 0 ? {
            minutes: e.baseline_min,
            tracking_start: h.tracking_start || e.first_seen_at,
            evidence: { first_played_at: h.first_played_at || null, last_played_at: h.last_played_at || null, play_count: h.play_count || null, recent_min: h.recent_min || null, date_added: h.date_added || null, release_at: h.release_at || null, anchors: (h.anchors || []).length },
            manual: h.manual || null, mode: h.mode || 'auto', enriched: !!e.enriched_at,
            ...(h.inference || {}),
          } : null,
          achievements: ach.get(e.id) ?? null,
        };
      });
    const agg = db.prepare(`SELECT s.kind, COUNT(*) n, COALESCE(SUM(s.minutes),0) m, MIN(COALESCE(s.started_at, s.window_start, s.window_end)) first, MAX(s.minutes) longest
      FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.game_id = ? AND e.excluded = 0 GROUP BY s.kind`).all(id);
    const k = Object.fromEntries(agg.map((x) => [x.kind, x]));
    const firstSeen = Math.min(...entries.map((e) => e.first_seen_at));
    return {
      ...gameRow(g),
      entries,
      // the game's achievements: its counted entries together (completed when any of them is)
      achievements: combineSummaries(entries.filter((e) => !e.excluded).map((e) => e.achievements)),
      summary: {
        total_minutes: g.minutes,
        tracked_minutes: k.play?.m || 0,
        estimated_minutes: k.estimate?.m || 0,
        baseline_minutes: k.baseline?.m || 0,
        sessions: k.play?.n || 0,
        avg_session_minutes: k.play?.n ? Math.round(k.play.m / k.play.n) : 0,
        longest_session_minutes: k.play?.longest || 0,
        first_tracked_at: k.play?.first || null,
        tracking_since: Number.isFinite(firstSeen) ? firstSeen : null,
      },
    };
  }

  r.get('/api/v1/games/:id', (c) => {
    const game = getGame(toInt(c.params.id));
    const sessions = db.prepare(`${SESSION_SELECT} WHERE s.entry_id IN (SELECT id FROM entries WHERE game_id = ?) AND s.kind IN ('play', 'baseline') ORDER BY s.sort_time DESC, s.id DESC LIMIT 300`).all(game.id).map(sessionRow);
    const stats = computeStats(db, { range: 'all', gameId: game.id, group: 'month', weekStartsOn: settings.get('week_starts_on'), topLimit: 1 });
    return { ...game, sessions, sessions_truncated: game.summary && game.summary.sessions > 300, series: stats.series, weekday: stats.weekday };
  }, {
    summary: 'Game detail with entries, latest 300 sessions, monthly history, achievement summaries',
    returns: `The game (as in GET /games) plus entries[] (each with history and achievements), achievements (the game's counted entries together: counts add up, completed when any entry is), summary, sessions, series, weekday. achievements: ${ACH_SUMMARY_DOC}. The full list: GET /games/{id}/achievements.`,
  });

  r.get('/api/v1/games/:id/achievements', (c) => {
    const id = toInt(c.params.id);
    if (!db.prepare('SELECT id FROM games WHERE id = ?').get(id)) throw new HttpError(404, 'Game not found');
    const state = c.query.state || 'all';
    if (!['all', 'unlocked', 'locked'].includes(state)) throw new HttpError(400, 'state must be all, unlocked or locked');
    const entryId = c.query.entry_id ? toInt(c.query.entry_id) : null;
    if (c.query.entry_id && !db.prepare('SELECT 1 FROM entries WHERE id = ? AND game_id = ?').get(entryId, id)) throw new HttpError(404, 'Entry not found in this game');
    return gameAchievements(db, id, { entryId, state });
  }, {
    summary: 'A game\'s achievements / trophies: unlocked first (newest first), then locked in the platform\'s order, each with the session it was unlocked in',
    query: { entry_id: 'only this entry (platform copy) of the game', state: 'all (default) | unlocked | locked' },
    returns: `{ game_id, summary: ${ACH_SUMMARY_DOC} (the counted entries together), entries: [{ entry_id, platform, account_id, account_name, title, excluded, achievements: summary }], total, `
      + `items: [${ACH_ITEM_DOC.slice(0, -2)}, session: { id, started_at, ended_at, precise } | null, session_kind: 'tracked' | 'history' | null }] }. `
      + 'The session is found by time: the tracked play session whose span holds the unlock (exact times first, else its sync window; 10 minutes of slack after the end), else the dated history estimate whose window holds it (session_kind history), else null. precise = false: started_at / ended_at are the window.',
  });

  r.get('/api/v1/entries/:id/snapshots', (c) => {
    const limit = clamp(c.query.limit, 1000, 1, 10000);
    return db.prepare('SELECT taken_at, playtime_min, sync_id FROM snapshots WHERE entry_id = ? ORDER BY taken_at DESC LIMIT ?').all(toInt(c.params.id), limit);
  }, { summary: 'Raw playtime snapshots for an entry (newest first)', query: { limit: 'max 10000' } });

  r.patch('/api/v1/games/:id', (c) => {
    const id = toInt(c.params.id);
    if (!db.prepare('SELECT id FROM games WHERE id = ?').get(id)) throw new HttpError(404, 'Game not found');
    const b = c.body;
    const sets = []; const args = [];
    if ('title' in b) {
      const t = typeof b.title === 'string' && b.title.trim() ? cleanTitle(b.title) : '';
      if (!t) throw new HttpError(400, 'title must be a non-empty string');
      sets.push('title = ?', 'norm_title = ?'); args.push(t, normalizeTitle(t));
    }
    if ('cover_url' in b) { sets.push('cover_url = ?'); args.push(b.cover_url || null); }
    if ('status' in b) { if (!STATUSES.includes(b.status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`); sets.push('status = ?'); args.push(b.status); }
    if ('rating' in b) {
      const n = b.rating == null || b.rating === '' ? null : Number(b.rating);
      if (n !== null && !Number.isFinite(n)) throw new HttpError(400, 'rating must be a number from 0 to 10');
      sets.push('rating = ?'); args.push(n === null ? null : Math.max(0, Math.min(10, n)));
    }
    if ('notes' in b) {
      if (b.notes != null && typeof b.notes !== 'string') throw new HttpError(400, 'notes must be a string');
      sets.push('notes = ?'); args.push(b.notes ? b.notes.slice(0, 10000) : null);
    }
    for (const f of ['favorite', 'hidden', 'merge_locked']) if (f in b) { sets.push(`${f} = ?`); args.push(flag(b[f])); }
    if (sets.length) db.prepare(`UPDATE games SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, Date.now(), id);
    return getGame(id);
  }, { summary: 'Update status, rating, notes, favorite, hidden, title, cover', body: '{ status?, rating?, notes?, favorite?, hidden?, title?, cover_url?, merge_locked? }' });

  r.delete('/api/v1/games/:id', (c) => {
    const id = toInt(c.params.id);
    const synced = db.prepare('SELECT COUNT(*) n FROM entries WHERE game_id = ? AND account_id IS NOT NULL').get(id).n;
    if (synced && c.query.force !== 'true') throw new HttpError(409, 'This game comes from a synced account and would re-appear on the next sync. Hide it instead, or pass ?force=true.');
    tx(db, () => {
      db.prepare('DELETE FROM entries WHERE game_id = ?').run(id);
      db.prepare('DELETE FROM games WHERE id = ?').run(id);
    });
    return { ok: true };
  }, { summary: 'Delete a game (manual/imported games; synced ones need ?force=true)' });

  r.post('/api/v1/games/:id/merge', (c) => {
    const target = toInt(c.params.id);
    const ids = arr(c.body.source_ids || c.body.ids, 'source_ids').map(Number).filter(Boolean);
    if (!ids.length) throw new HttpError(400, 'source_ids is required');
    tx(db, () => mergeGames(db, target, ids));
    return getGame(target);
  }, { summary: 'Merge other games into this one (duplicate tracking)', body: '{ source_ids: number[] }' });

  // ---------- entries ----------
  r.patch('/api/v1/entries/:id', (c) => {
    const id = toInt(c.params.id);
    const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
    if (!e) throw new HttpError(404, 'Entry not found');
    if ('excluded' in c.body) db.prepare('UPDATE entries SET excluded = ? WHERE id = ?').run(flag(c.body.excluded), id);
    return getGame(e.game_id);
  }, { summary: 'Exclude/include an entry from totals (mirrored duplicates)', body: '{ excluded: boolean }' });

  r.post('/api/v1/entries/:id/split', (c) => {
    const gid = tx(db, () => splitEntry(db, toInt(c.params.id)));
    return getGame(gid);
  }, { summary: 'Detach an entry into its own game (undo a wrong merge)' });

  r.post('/api/v1/entries/:id/move', (c) => {
    const id = toInt(c.params.id);
    const target = toInt(c.body.game_id);
    const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
    if (!e) throw new HttpError(404, 'Entry not found');
    if (!db.prepare('SELECT id FROM games WHERE id = ?').get(target)) throw new HttpError(404, 'Target game not found');
    tx(db, () => { db.prepare('UPDATE entries SET game_id = ? WHERE id = ?').run(target, id); pruneEmptyGames(db); });
    return getGame(target);
  }, { summary: 'Move an entry to another game', body: '{ game_id }' });

  r.post('/api/v1/entries/:id/playtime', async (c) => {
    const id = toInt(c.params.id);
    const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
    if (!e) throw new HttpError(404, 'Entry not found');
    const total = toInt(c.body.playtime_minutes);
    if (total == null || total < 0) throw new HttpError(400, 'playtime_minutes (lifetime total) is required');
    if (e.account_id) {
      const res = await sync.report(e.account_id, [{ extId: e.ext_id, title: e.title, playtimeMin: total, lastPlayedAt: toTime(c.body.last_played_at) }]);
      return res;
    }
    // local entry: record the delta directly
    const now = Date.now();
    const delta = total - e.playtime_min;
    if (delta < 0) {
      // like a synced total (sync.report): a lower total keeps the high-water mark, so the
      // total and the entry's sessions keep adding up and nothing is counted twice later
      db.prepare('UPDATE entries SET last_played_at = COALESCE(?, last_played_at) WHERE id = ?').run(toTime(c.body.last_played_at), id);
      return { ok: true, delta: 0, ignored: 'lower than the current total' };
    }
    tx(db, () => {
      if (delta > 0) {
        db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, note, created_at) VALUES (?, 'api', 'play', ?, ?, ?, ?, ?)")
          .run(id, delta, e.last_synced_at || e.first_seen_at, now, c.body.note || null, now);
      }
      db.prepare('UPDATE entries SET playtime_min = ?, last_synced_at = ?, last_played_at = COALESCE(?, last_played_at) WHERE id = ?').run(total, now, toTime(c.body.last_played_at), id);
      db.prepare('INSERT INTO snapshots(entry_id, taken_at, playtime_min) VALUES (?, ?, ?)').run(id, now, total);
    });
    return { ok: true, delta };
  }, { summary: 'Report a new lifetime total for one entry; the delta becomes a session', body: '{ playtime_minutes, last_played_at? }' });

  // ---------- sessions ----------
  r.get('/api/v1/sessions', (c) => {
    const q = c.query;
    const where = []; const args = [];
    const kind = q.kind || 'play';
    if (kind !== 'all') { where.push('s.kind = ?'); args.push(kind); }
    if (q.include_excluded !== 'true') where.push('s.entry_id NOT IN (SELECT id FROM entries WHERE excluded = 1)');
    if (q.game_id) { where.push('s.entry_id IN (SELECT id FROM entries WHERE game_id = ?)'); args.push(toInt(q.game_id)); }
    if (q.platform) { where.push('s.entry_id IN (SELECT id FROM entries WHERE platform = ?)'); args.push(q.platform); }
    if (q.account_id) { where.push('s.entry_id IN (SELECT id FROM entries WHERE account_id = ?)'); args.push(toInt(q.account_id)); }
    if (q.source) { where.push('s.source = ?'); args.push(q.source); }
    if (q.sync_id) { where.push('s.sync_id = ?'); args.push(toInt(q.sync_id)); }
    if (q.from) { where.push('s.sort_time >= ?'); args.push(dayBound(q.from, false)); }
    if (q.to) { where.push('COALESCE(s.started_at, s.window_start, s.window_end) <= ?'); args.push(dayBound(q.to, true)); }
    if (q.q) { where.push("s.entry_id IN (SELECT e2.id FROM entries e2 JOIN games g2 ON g2.id = e2.game_id WHERE g2.title LIKE ? ESCAPE '\\')"); args.push(likeText(q.q)); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(1000, Math.max(1, toInt(q.limit, 100)));
    const offset = Math.max(0, toInt(q.offset, 0));
    const total = memo(db, `sess-count:${w}:${JSON.stringify(args)}`, () => db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(s.minutes),0) m FROM sessions s ${w}`).get(...args));
    // Keyset pagination: pass back `next` as ?before= to page deep into huge histories cheaply.
    const pw = [...where]; const pargs = [...args];
    const cur = /^(\d+):(\d+)$/.exec(q.before || '');
    if (cur) { pw.push('(s.sort_time < ? OR (s.sort_time = ? AND s.id < ?))'); pargs.push(Number(cur[1]), Number(cur[1]), Number(cur[2])); }
    // the achievements unlocked during each session of the page (two queries for the page)
    const items = withSessionAchievements(db, db.prepare(`${SESSION_SELECT} ${pw.length ? `WHERE ${pw.join(' AND ')}` : ''} ORDER BY s.sort_time DESC, s.id DESC LIMIT ? OFFSET ?`)
      .all(...pargs, limit, cur ? 0 : offset).map(sessionRow));
    const last = items.at(-1);
    const sortTime = (x) => x.ended_at || x.window_end || x.created_at;
    return { total: total.n, total_minutes: total.m, limit, offset, items, next: items.length === limit && last ? `${sortTime(last)}:${last.id}` : null };
  }, {
    summary: 'List sessions (newest first). Use `before` = previous `next` for fast deep paging.',
    query: { from: 'date/ISO/epoch', to: '', game_id: '', platform: '', account_id: '', source: 'sync|manual|import|api', kind: 'play|baseline|estimate|all', sync_id: '', q: 'title search', limit: 'max 1000', offset: '', before: 'cursor from `next`' },
    returns: `{ total, total_minutes, limit, offset, next, items: [session] }. session: ${SESSION_DOC}; items holds the first 5 unlocks in unlock order.`,
  });

  /** One session as the API shows it (with all its unlocks), or a 404. */
  const sessionOut = (id) => {
    const s = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id);
    if (!s) throw new HttpError(404, 'Session not found');
    return withSessionAchievements(db, [sessionRow(s)], { limit: null })[0];
  };

  r.get('/api/v1/sessions/:id', (c) => sessionOut(toInt(c.params.id)),
    { summary: 'Get one session', returns: `session: ${SESSION_DOC}; items holds every unlock of the session in unlock order.` });

  r.post('/api/v1/sessions', (c) => {
    const b = c.body;
    const gameId = toInt(b.game_id);
    const minutes = toInt(b.minutes) ?? (b.hours ? Math.round(Number(b.hours) * 60) : null);
    if (!gameId || !db.prepare('SELECT id FROM games WHERE id = ?').get(gameId)) throw new HttpError(400, 'Valid game_id is required');
    if (!minutes || minutes <= 0 || minutes > 7 * 1440) throw new HttpError(400, 'minutes must be between 1 and 10080');
    const now = Date.now();
    let started = timeField(b, 'started_at');
    let ended = timeField(b, 'ended_at');
    const date = timeField(b, 'date');
    if (!started && !ended && date) {
      started = date;
      // a date-only session belongs to that local day: around noon, but it never spills into
      // the next day (or past now) while it fits
      if (/^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
        const dayEnd = dayBound(b.date, true) + 1;
        started = Math.max(dayBound(b.date, false), Math.min(started, dayEnd - minutes * MIN, now - minutes * MIN));
      }
      ended = started + minutes * MIN;
    }
    if (started && !ended) ended = started + minutes * MIN;
    if (!started && ended) started = ended - minutes * MIN;
    if (!started) { ended = now; started = now - minutes * MIN; }
    if (ended <= started) throw new HttpError(400, 'ended_at must be after started_at');
    if (ended > now + 5 * MIN) throw new HttpError(400, 'A session cannot end in the future');
    const id = tx(db, () => {
      const e = manualEntry(db, gameId, now);
      const r2 = db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, note, created_at, confidence) VALUES (?, 'manual', 'play', ?, ?, ?, ?, ?, ?, ?, 'exact')")
        .run(e.id, minutes, started, ended, started, ended, b.note || null, now);
      db.prepare('UPDATE entries SET playtime_min = playtime_min + ?, last_played_at = MAX(COALESCE(last_played_at, 0), ?), last_synced_at = ? WHERE id = ?').run(minutes, ended, now, e.id);
      if (b.status && STATUSES.includes(b.status)) db.prepare('UPDATE games SET status = ?, updated_at = ? WHERE id = ?').run(b.status, now, gameId);
      return Number(r2.lastInsertRowid);
    });
    return sessionOut(id);
  }, { summary: 'Log a manual session', body: '{ game_id, minutes|hours, started_at?|ended_at?|date?, note?, status? }', returns: 'the session, as GET /sessions/{id}' });

  function changeSession(id, patch) {
    const s = db.prepare('SELECT s.*, e.platform, e.account_id FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE s.id = ?').get(id);
    if (!s) throw new HttpError(404, 'Session not found');
    const local = s.source === 'manual' || s.source === 'import' || s.source === 'api';
    const sets = []; const args = [];
    if ('note' in patch) { sets.push('note = ?'); args.push(patch.note || null); }
    if ('kind' in patch) {
      if (!['play', 'baseline'].includes(patch.kind)) throw new HttpError(400, 'kind must be play or baseline');
      // history is never recorded as play: it can only leave the stats
      if (patch.kind === 'play' && s.source === 'inferred') throw new HttpError(400, 'pre-tracking history cannot be counted as tracked play');
      sets.push('kind = ?'); args.push(patch.kind);
    }
    let st = 'started_at' in patch ? timeField(patch, 'started_at') : s.started_at;
    const en = 'ended_at' in patch ? timeField(patch, 'ended_at') : s.ended_at;
    // times sent back as they are (a client echoing the session) are no change
    let times = st !== s.started_at || en !== s.ended_at;
    if (times && st && en && en <= st) throw new HttpError(400, 'ended_at must be after started_at');
    if ('minutes' in patch) {
      const m = toInt(patch.minutes);
      if (!m || m <= 0 || m > 7 * 1440) throw new HttpError(400, 'minutes must be between 1 and 10080');
      if (!local) throw new HttpError(400, 'Minutes of synced sessions come from the platform; change kind to "baseline" to drop it from stats instead');
      // an exact session spans its minutes: new minutes alone keep the end and move the start
      // (a wider span, e.g. from an import, is kept while they fit in it); times changed with
      // them must leave room for them
      if (st && en && !times && m !== s.minutes && (en - st === s.minutes * MIN || m * MIN > en - st)) { st = en - m * MIN; times = true; }
      else if (st && en && times && m * MIN > en - st) throw new HttpError(400, 'minutes do not fit between started_at and ended_at');
      sets.push('minutes = ?'); args.push(m);
      db.prepare('UPDATE entries SET playtime_min = MAX(0, playtime_min + ?) WHERE id = ?').run(m - s.minutes, s.entry_id);
    }
    if (times) {
      sets.push('started_at = ?', 'ended_at = ?'); args.push(st, en);
      if (local) { sets.push('window_start = ?', 'window_end = ?'); args.push(st, en); }
    }
    if (sets.length) db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  function removeSession(id) {
    const s = db.prepare('SELECT s.*, e.account_id FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE s.id = ?').get(id);
    if (!s) throw new HttpError(404, 'Session not found');
    if (s.source === 'sync' || (s.source === 'inferred' && s.account_id != null)) {
      // Lifetime playtime comes from the platform, so a synced session (or the dated history
      // of a synced game) can only be dropped from period stats (converted to baseline), not
      // truly deleted: a lower total would come back as new play on the next sync.
      db.prepare("UPDATE sessions SET kind = 'baseline', note = COALESCE(note, 'Removed from stats') WHERE id = ?").run(id);
      return 'baseline';
    }
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    db.prepare('UPDATE entries SET playtime_min = MAX(0, playtime_min - ?) WHERE id = ?').run(s.minutes, s.entry_id);
    return 'deleted';
  }

  r.patch('/api/v1/sessions/:id', (c) => {
    const id = toInt(c.params.id);
    tx(db, () => changeSession(id, c.body));
    return sessionOut(id);
  }, { summary: 'Edit a session (note, times, kind; minutes for manual sessions)', body: '{ note?, started_at?, ended_at?, kind?, minutes? }', returns: 'the session, as GET /sessions/{id} (its unlocks follow its new times)' });

  r.delete('/api/v1/sessions/:id', (c) => ({ ok: true, result: tx(db, () => removeSession(toInt(c.params.id))) }),
    { summary: 'Delete a manual session, or drop a synced one from stats (becomes baseline)' });

  r.post('/api/v1/sessions/bulk', (c) => {
    const ids = [...new Set(arr(c.body.ids, 'ids').map(Number).filter(Boolean))]; // a repeated id acts once
    const action = c.body.action;
    if (!['baseline', 'play', 'delete'].includes(action)) throw new HttpError(400, 'action must be baseline, play or delete');
    tx(db, () => { for (const id of ids) action === 'delete' ? removeSession(id) : changeSession(id, { kind: action }); });
    return { ok: true, count: ids.length };
  }, { summary: 'Bulk convert sessions to baseline/play or delete', body: '{ ids: number[], action: "baseline"|"play"|"delete" }' });

  // ---------- stats ----------
  r.get('/api/v1/stats', (c) => computeStats(db, {
    range: c.query.range, group: c.query.group, gameId: toInt(c.query.game_id), platform: c.query.platform, weekStartsOn: settings.get('week_starts_on'), estimates: estimatesParam(c.query, settings),
  }), { summary: 'Aggregated stats for a range. Inferred pre-tracking history is included (and reported separately) unless estimates=exclude', query: { range: '7d|30d|90d|365d|week|month|year|all|year:2026|month:2026-05', group: 'day|week|month|year', game_id: '', platform: '', estimates: 'include|exclude|only' } });
  r.get('/api/v1/stats/lifetime', () => lifetime(db), { summary: 'Lifetime totals (including imported history)' });
  r.get('/api/v1/stats/heatmap', (c) => heatmap(db, { year: c.query.year, gameId: toInt(c.query.game_id), estimates: estimatesParam(c.query, settings) }), { summary: 'Minutes per day for a year', query: { year: '', game_id: '', estimates: 'include|exclude|only' } });
  r.get('/api/v1/stats/year/:year', (c) => {
    if (!/^\d{4}$/.test(c.params.year)) throw new HttpError(400, 'year must be YYYY');
    return yearInReview(db, toInt(c.params.year), { weekStartsOn: settings.get('week_starts_on'), estimates: estimatesParam(c.query, settings) });
  }, { summary: 'Year in review', query: { estimates: 'include|exclude' } });
  r.get('/api/v1/stats/years', () => {
    const first = db.prepare('SELECT MIN(day) d FROM play_days').get().d;
    const ys = [];
    if (first) for (let y = new Date().getFullYear(); y >= Number(first.slice(0, 4)); y--) if (db.prepare('SELECT 1 FROM play_days WHERE day >= ? AND day <= ? LIMIT 1').get(`${y}-01-01`, `${y}-12-31`)) ys.push(y);
    const cur = new Date().getFullYear();
    if (!ys.includes(cur)) ys.unshift(cur);
    return ys;
  }, { summary: 'Years that have play data' });
  r.get('/api/v1/stats/achievements', (c) => {
    if (c.query.group && !['day', 'week', 'month', 'year'].includes(c.query.group)) throw new HttpError(400, 'group must be day, week, month or year');
    return achievementStats(db, { range: c.query.range, group: c.query.group, platform: c.query.platform || null, weekStartsOn: settings.get('week_starts_on'), limit: clamp(c.query.limit, 10, 1, 100) });
  }, {
    summary: 'Achievement / trophy stats for a range: unlocks per period, rarest unlocks, games completed, totals, completion of played games',
    query: { range: '7d|30d|90d|365d|week|month|year|all|year:2026|month:2026-05 (default 30d)', group: 'day|week|month|year (default: by the range\'s length, as /stats)', platform: 'steam|xbox|psn', limit: 'rarest / completed list length (default 10, max 100)' },
    returns: '{ range: { from, to, label, group }, unlocked, points (gamerscore), grades: { platinum, gold, silver, bronze } - all unlocked in the range; '
      + 'series: [{ key, unlocked, points }] per group; rarest: [achievement + { game_id, title, cover_url }] unlocked in the range, rarest first; '
      + 'completed: [{ entry_id, game_id, title, cover_url, platform, total, unlocked, platinum, completed_at }] completed in the range, newest first; completed_count; '
      + 'totals (all time): { unlocked, total, percent, points, points_total, grades, entries (titles with achievements), completed }; '
      + 'completion: { entries (played titles with achievements), average_percent, buckets: [{ label, min, max, count }] (0%, 1-24%, 25-49%, 50-74%, 75-99%, 100%) } }. '
      + 'Excluded entries are left out.',
  });

  // ---------- insights (charts: punchcard, lengths, stacks, timelines, library, records) ----------
  // Tracked play and estimated history are always reported apart; views that need a real time
  // of day (punchcard, session lengths, day / week / streak records) are tracked play only.
  const RANGE_Q = '7d|30d|90d|365d|week|month|year|all|year:2026|month:2026-05';
  const EST_Q = 'include|exclude|only (default: the stats_estimates setting)';
  const groupParam = (g, allowed = ['day', 'week', 'month', 'year']) => {
    if (g != null && g !== '' && !allowed.includes(g)) throw new HttpError(400, `group must be ${allowed.join(', ')}`);
    return g || undefined;
  };
  const insightOpts = (c) => ({ gameId: toInt(c.query.game_id), platform: c.query.platform || null, weekStartsOn: settings.get('week_starts_on') });
  const SESSION_REF_DOC = '{ session_id, minutes, game_id, title, cover_url, platform, started_at (null unless exact), ended_at, day (local, of the end), precise }';

  r.get('/api/v1/stats/punchcard', (c) => punchcard(db, { range: c.query.range, ...insightOpts(c) }), {
    summary: 'Minutes by weekday x hour of day for a range (tracked play with exact start/end times only)',
    query: { range: `${RANGE_Q} (default 30d)`, game_id: '', platform: '' },
    returns: '{ range: { from, to, label }, estimates: "exclude" (always: estimated history and sync-window sessions have no reliable time of day), week_starts_on, '
      + 'minutes: number[7][24] (index 0 = Sunday, as getDay(); local hours; a session is split across the hours and days it covers), weekday: number[7], hours: number[24], '
      + 'days: number[7] (how many of each weekday the range holds, for averages), total_minutes (in the grid), tracked_minutes (all tracked play in the range), '
      + 'untimed_minutes (tracked play without exact times, not in the grid), busiest: { weekday, hour, minutes } | null, busiest_weekday: { weekday, minutes } | null, busiest_hour: { hour, minutes } | null }',
  });
  r.get('/api/v1/stats/session-lengths', (c) => sessionLengths(db, { range: c.query.range, exact: c.query.exact === 'true' || c.query.exact === '1', ...insightOpts(c) }), {
    summary: 'Distribution of tracked session lengths for a range: histogram, median, p90, longest',
    query: { range: `${RANGE_Q} (default 30d)`, game_id: '', platform: '', exact: 'true = only sessions with exact start/end times (a sync window can hold several sittings)' },
    returns: '{ range: { from, to, label }, estimates: "exclude" (always: history is not sessions), exact_only, sessions (tracked play sessions ending in the range), exact_sessions, total_minutes, '
      + 'mean_minutes, median_minutes (the middle value; mean of the two middle ones for an even count), p90_minutes (nearest rank), '
      + 'buckets: [{ label, min, max (minutes; max exclusive, null = open), count, minutes }] (<15m, 15-30m, 30-60m, 1-2h, 2-3h, 3-5h, 5h+), '
      + `longest: ${SESSION_REF_DOC} | null (the first to reach that length) }`,
  });
  r.get('/api/v1/stats/platforms', (c) => {
    const by = c.query.by || 'platform';
    if (!['platform', 'device'].includes(by)) throw new HttpError(400, 'by must be platform or device');
    return platformSeries(db, { range: c.query.range, group: groupParam(c.query.group), by, estimates: estimatesParam(c.query, settings), ...insightOpts(c) });
  }, {
    summary: 'Minutes per platform (or device) per period, tracked and estimated apart - for stacked charts',
    query: { range: `${RANGE_Q} (default 30d)`, group: 'day|week|month|year (default: by the range\'s length, as /stats)', by: 'platform (default) | device', game_id: '', platform: '', estimates: EST_Q },
    returns: '{ range: { from, to, label, group }, by, estimates, keys: string[] (period keys, as /stats series), '
      + 'series: [{ name (the platform, or the device as the platform reported it; null = no device known - history has none), minutes, tracked_minutes, estimated_minutes, tracked: number[keys], estimated: number[keys] }] (most played first), '
      + 'totals: { tracked: number[keys], estimated: number[keys] } }',
  });
  r.get('/api/v1/stats/timeline', (c) => timeline(db, {
    range: c.query.range || '365d', group: groupParam(c.query.group), limit: clamp(c.query.limit, 10, 1, 50), estimates: estimatesParam(c.query, settings), ...insightOpts(c),
  }), {
    summary: '"When did I play what": the top games of a range with minutes per week / month (swimlanes), and the most played game of each month (eras)',
    query: { range: `${RANGE_Q} (default 365d)`, group: 'week|month (default: week up to 200 days, else month; day|year also accepted)', limit: 'games (default 10, max 50)', platform: '', estimates: EST_Q },
    returns: '{ range: { from, to, label, group }, estimates, keys: string[], games_played, '
      + 'games: [{ game_id, title, cover_url, minutes, estimated_minutes, first_day, last_day (in the range), tracked: number[keys], estimated: number[keys] }] (most played first), '
      + 'others: { tracked: number[keys], estimated: number[keys] } (every other game together), '
      + 'months: [{ month (YYYY-MM), game_id, title, cover_url, minutes, estimated_minutes, month_minutes, share (0-1 of the month) }] (months with play), '
      + 'eras: [{ game_id, title, cover_url, from, to (YYYY-MM), months, minutes, estimated_minutes }] (consecutive months led by the same game) }',
  });
  r.get('/api/v1/games/:id/stats', (c) => gameCurve(db, toInt(c.params.id), { group: groupParam(c.query.group) || 'month', estimates: estimatesParam(c.query, settings), weekStartsOn: settings.get('week_starts_on') }), {
    summary: 'A game over time: cumulative minutes (tracked and estimated apart), sessions and achievement unlocks per period, first / last played',
    tag: 'stats',
    query: { group: 'day|week|month|year (default month)', estimates: EST_Q },
    returns: '{ game_id, title, cover_url, status, group, estimates, totals: { minutes (tracked + estimated + baseline), tracked_minutes, estimated_minutes, baseline_minutes (undated history: in totals, never on the curve), sessions }, '
      + 'first_day, last_day (first / last day on the curve), first_session_at, last_session_at (tracked play), platform_first_played_at, platform_last_played_at (as the platforms report them), '
      + 'achievements: { total, unlocked, undated (unlocked at a time the platform does not know: not on the curve), percent }, '
      + 'series: [{ key, minutes, tracked, estimated, sessions (tracked, ending in the period), unlocked, cumulative_tracked, cumulative_estimated, cumulative_unlocked }] '
      + '(from the first play or unlock to now; [] when there is none). Excluded entries never count. 404 for an unknown game.',
  });
  r.get('/api/v1/stats/library', (c) => libraryOverview(db, {
    hidden: c.query.hidden === 'true', points: clamp(c.query.points, 500, 0, 2000), dustyLimit: clamp(c.query.dusty_limit, 20, 0, 100),
  }), {
    summary: 'Library overview: games and hours by status, platform, first-played year and year added; played vs never; dusty games; backlog age; hours distribution; completion vs hours',
    query: { hidden: 'true = include hidden games (default: left out, as GET /games)', points: 'completion scatter points (default 500, max 2000; most played first)', dusty_limit: 'dusty games listed (default 20, max 100)' },
    returns: '{ hidden_included, games, played, never_played, minutes (lifetime, as GET /games), tracked_minutes, history_minutes (estimated + undated baseline), '
      + 'by_status: [{ status, games, played, minutes, tracked_minutes, history_minutes }] (every status), by_platform: [{ platform, games, played, minutes, tracked_minutes, history_minutes }] (a game on two platforms counts on both), '
      + 'by_first_played_year: [{ year, games, minutes, from_history (games whose first play is known from history or the platform, not from tracking) }], first_played_unknown (played, no date), '
      + 'by_year_added: [{ year, games, minutes }] (date added / purchased, where a platform, import or licenses page gave it), added_unknown, '
      + 'hours: [{ label, min, max (lifetime minutes; max exclusive, null = open), games, minutes }] (Never, <1h, 1-5h, 5-10h, 10-25h, 25-50h, 50-100h, 100h+), '
      + 'dusty: { count, minutes, items: [{ game_id, title, cover_url, status, minutes, last_played_at, days_since }] } (played, not in over a year, not completed / beaten / dropped / wishlist; most hours first), '
      + 'backlog: { count, minutes, median_days, buckets: [{ label, min_days, max_days, games }], oldest: [{ game_id, title, cover_url, since, days, minutes }] } (status backlog; age from the date added, else from when it entered Vestigo), '
      + 'completion: { games (with achievements), points: [{ game_id, title, minutes, percent, unlocked, total, status }] (at most `points`, most played first), truncated } }. Excluded entries never count.',
  });
  r.get('/api/v1/stats/year-over-year', (c) => {
    let years;
    if (c.query.years) {
      years = String(c.query.years).split(',').map((y) => y.trim()).filter(Boolean);
      if (!years.length || years.length > 10 || years.some((y) => !/^\d{4}$/.test(y))) throw new HttpError(400, 'years must be a comma list of up to 10 years (YYYY)');
      years = years.map(Number);
    }
    return yearOverYear(db, { years, estimates: estimatesParam(c.query, settings), ...insightOpts(c) });
  }, {
    summary: 'Years side by side: minutes per month (tracked / estimated), totals, the same date in each year, top game, new games',
    query: { years: 'comma list, up to 10 (default: last year and this year)', game_id: '', platform: '', estimates: EST_Q },
    returns: '{ estimates, years: [{ year, partial (the current year), total_minutes, tracked_minutes, estimated_minutes, to_date: { through (MM-DD, today), minutes, tracked_minutes, estimated_minutes } (Jan 1 to the same date: compares years so far), '
      + 'sessions, games_played, days_played (tracked), new_games (first ever play in that year), top_game: { game_id, title, cover_url, minutes, estimated_minutes } | null, '
      + 'months: [{ month (1-12), key (YYYY-MM), minutes, tracked, estimated, sessions }] }] (oldest first) }',
  });
  r.get('/api/v1/stats/records', (c) => records(db, { range: c.query.range || 'all', group: groupParam(c.query.group, ['month', 'year']), estimates: estimatesParam(c.query, settings), ...insightOpts(c) }), {
    summary: 'Records and highlights: longest session, biggest day, best week / month, longest streak, most played game per period, first tracked session',
    query: { range: `${RANGE_Q} (default all)`, group: 'month|year for most_played_by (default: year for ranges over 400 days, else month)', game_id: '', platform: '', estimates: `${EST_Q} - most played only; the other records are tracked play` },
    returns: `{ range: { from, to, label }, estimates, tracked_minutes, estimated_minutes, sessions, days_played, games_played, longest_session: ${SESSION_REF_DOC} | null, first_session: (same) | null, `
      + 'biggest_day: { day, minutes } | null, best_week: { key, from, to (days; weeks start on week_starts_on), minutes } | null, best_month: { key, minutes } | null, '
      + 'longest_streak: { days, from, to } | null (in the range), current_streak (days, ending today or yesterday), '
      + 'most_played: { game_id, title, cover_url, minutes, estimated_minutes, share } | null, most_played_by: { group, items: [{ key, game_id, title, cover_url, minutes, estimated_minutes, share }] }, '
      + 'weekday: number[7] (tracked minutes, 0 = Sunday), hours: number[24] (exact sessions), '
      + 'highlights: [{ id (longest_session|biggest_day|best_week|longest_streak|most_played|favorite_weekday|time_of_day|first_session), text (an English one-liner from a fixed template), value, unit (minutes|days|percent), ...the ids / days it refers to }] }',
  });

  // ---------- duplicates ----------
  r.get('/api/v1/duplicates', (c) => {
    const d = findDuplicates(db, { threshold: Number(c.query.threshold) || 0.8, limit: clamp(c.query.limit, 300, 1, 5000) });
    return c.query.summary === 'true' ? { counts: d.counts } : d;
  }, { summary: 'Merge suggestions, double-counted entries, cross-platform games (each list capped; see counts)', query: { threshold: '0..1 (default 0.8)', limit: 'per list, default 300', summary: 'true = counts only' } });
  r.post('/api/v1/duplicates/dismiss', (c) => {
    if (!c.body.key) throw new HttpError(400, 'key is required');
    db.prepare('INSERT OR IGNORE INTO dismissed_duplicates(key, created_at) VALUES (?, ?)').run(String(c.body.key), Date.now());
    return { ok: true };
  }, { summary: 'Dismiss a duplicate suggestion', body: '{ key }' });
  r.delete('/api/v1/duplicates/dismissed', () => { db.prepare('DELETE FROM dismissed_duplicates').run(); return { ok: true }; }, { summary: 'Reset dismissed suggestions' });

  // ---------- accounts & syncs ----------
  r.get('/api/v1/accounts', () => db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM entries e WHERE e.account_id = a.id) games,
      (SELECT COALESCE(SUM(playtime_min),0) FROM entries e WHERE e.account_id = a.id AND e.excluded = 0) minutes FROM accounts a ORDER BY a.id`).all()
    .map(parseAccount).map((a) => publicAccount(a, sync)), { summary: 'List linked accounts' });

  r.post('/api/v1/accounts/test', async (c) => {
    const platform = String(c.body.platform || '');
    const config = c.body.config || {};
    requireFields(platform, config);
    const p = providers[platform];
    if (p.push) return { ok: true, games: 0 };
    const warnings = [];
    let calls = 0;
    const ctx = {
      http: (url, opts, cfg = {}) => httpJson(url, opts, { ...cfg, onResult: () => { calls++; } }),
      // a test only samples: never spend an hourly budget (Xbox) before the real import runs
      getEntry: () => null, warn: (m) => warnings.push(m), remainingBudget: (limit) => Math.ceil(limit * 0.15) + 3, stopped: () => false,
    };
    const fake = { id: 0, platform, config, state: {} };
    let res;
    try {
      res = await p.fetchLibrary(fake, ctx);
    } catch (err) {
      // the platform said no: never relay its status (its 401 is not a Vestigo login, a
      // missing one is not an internal error) - rejected credentials 422, anything else 502
      if (!(err instanceof ProviderError)) throw err;
      throw new HttpError(err.auth ? 422 : 502, err.message);
    }
    let presence = null;
    if (p.presence) {
      try { const pr = await p.presence({ ...fake, state: res.state || {} }, ctx); presence = pr ? (pr.unavailable || `ok (${pr.playing.length ? `playing ${pr.playing.map((x) => x.title || x.extId).join(', ')}` : 'not playing'})`) : 'skipped'; } catch (err) { presence = `unavailable: ${err.message}`; }
    }
    const withDates = res.items.filter((i) => i.lastPlayedAt || i.firstPlayedAt).length;
    return {
      ok: true, games: res.items.length, played: res.items.filter((i) => i.playtimeMin > 0).length, minutes: res.items.reduce((a, i) => a + (i.playtimeMin || 0), 0),
      with_dates: withDates, presence, api_calls: calls,
      warning: [res.info?.deferred ? `Sampled a few of ${res.info.titles} titles; the full import runs within the hourly API limit after saving` : res.warning, ...warnings].filter(Boolean).join('; ') || null,
      account_created_at: res.state?.account_created_at || null, sample: res.items.slice(0, 5).map((i) => i.title),
    };
  }, { summary: 'Test credentials without saving', body: '{ platform, config }' });

  r.post('/api/v1/accounts', (c) => {
    const platform = String(c.body.platform || '');
    const config = c.body.config || {};
    requireFields(platform, config);
    const name = String(c.body.name || providers[platform].label).slice(0, 80);
    let schedule = null;
    if (c.body.schedule) {
      const v = validateSettings(c.body.schedule);
      if (v.errors.length) throw new HttpError(400, v.errors.join('; '));
      schedule = JSON.stringify(v.values);
    }
    const id = Number(db.prepare('INSERT INTO accounts(platform, name, config, enabled, schedule, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(platform, name, JSON.stringify(config), c.body.enabled === false ? 0 : 1, schedule, Date.now()).lastInsertRowid);
    if (!providers[platform].push && c.body.sync !== false) sync.sync(id, 'initial').catch(() => {});
    return publicAccount(sync.account(id), sync);
  }, { summary: 'Link an account (starts the initial import)', body: '{ platform, name?, config, enabled?, schedule?, sync? }' });

  r.patch('/api/v1/accounts/:id', (c) => {
    const a = sync.account(toInt(c.params.id));
    if (!a) throw new HttpError(404, 'Account not found');
    const b = c.body;
    const config = { ...a.config };
    for (const [k, v] of Object.entries(b.config || {})) {
      if (typeof v === 'string' && v.startsWith('••••••')) continue; // masked, unchanged
      config[k] = v;
    }
    let state = a.state;
    // credentials changed -> drop cached tokens (other settings, e.g. presence, keep what the account learned)
    const creds = (cfg) => JSON.stringify((providers[a.platform]?.fields || []).filter((f) => f.required || f.type === 'password').map((f) => cfg[f.key] ?? null));
    if (b.config && creds(config) !== creds(a.config)) state = {};
    // a newly declared last-played meaning starts its calibration over (learned votes would override it)
    else if (b.config && (config.last_played_meaning || null) !== (a.config.last_played_meaning || null)) { const { calibration, ...rest } = state || {}; state = rest; }
    let schedule = a.schedule;
    if ('schedule' in b) {
      if (b.schedule) {
        const v = validateSettings(b.schedule);
        if (v.errors.length) throw new HttpError(400, v.errors.join('; '));
        schedule = v.values;
      } else schedule = null;
    }
    db.prepare('UPDATE accounts SET name = ?, config = ?, state = ?, enabled = ?, schedule = ? WHERE id = ?')
      .run(String(b.name ?? a.name).slice(0, 80), JSON.stringify(config), JSON.stringify(state), 'enabled' in b ? (b.enabled ? 1 : 0) : (a.enabled ? 1 : 0), schedule ? JSON.stringify(schedule) : null, a.id);
    sync.refreshNext(a.id);
    return publicAccount(sync.account(a.id), sync);
  }, { summary: 'Update an account (name, credentials, enabled, schedule override)', body: '{ name?, config?, enabled?, schedule?: { schedule_mode, schedule_every, schedule_time, … } | null }' });

  r.delete('/api/v1/accounts/:id', (c) => {
    const id = toInt(c.params.id);
    if (!sync.account(id)) throw new HttpError(404, 'Account not found');
    tx(db, () => {
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      // ids are reused: an account linked later must not inherit this one's API usage
      db.prepare('DELETE FROM api_usage WHERE account_id = ?').run(id);
      pruneEmptyGames(db);
    });
    sync.forget(id);
    return { ok: true };
  }, { summary: 'Unlink an account and delete its data' });

  r.post('/api/v1/accounts/:id/sync', async (c) => {
    const id = toInt(c.params.id);
    if (!sync.account(id)) throw new HttpError(404, 'Account not found');
    if (c.query.wait === 'true' || c.body.wait) return sync.sync(id, 'manual');
    sync.sync(id, 'manual').catch(() => {});
    return { ok: true, started: true };
  }, { summary: 'Sync now (?wait=true to wait for the result)', query: { wait: 'true' } });

  r.post('/api/v1/accounts/:id/report', async (c) => {
    const id = toInt(c.params.id);
    if (!sync.account(id)) throw new HttpError(404, 'Account not found');
    const games = c.body.games || c.body.items;
    if (!Array.isArray(games)) throw new HttpError(400, 'games must be an array');
    const items = [];
    games.forEach((g, i) => {
      // entries that are not objects or name no game are skipped (never a game called "undefined")
      if (!g || typeof g !== 'object' || Array.isArray(g)) return;
      const ext = g.id ?? g.ext_id ?? g.title ?? g.name;
      if (ext == null || ext === '') return;
      for (const k of ['playtime_minutes', 'playtime_hours']) {
        if (g[k] != null && !(Number.isFinite(Number(g[k])) && Number(g[k]) >= 0)) throw new HttpError(400, `games[${i}].${k} must be a non-negative number`);
      }
      const playtimeMin = g.playtime_minutes != null ? Number(g.playtime_minutes) : g.playtime_hours != null ? Math.round(Number(g.playtime_hours) * 60) : 0;
      items.push({
        extId: String(ext),
        title: g.title || g.name || String(ext),
        playtimeMin,
        lastPlayedAt: toTime(g.last_played_at),
        firstPlayedAt: toTime(g.first_played_at),
        dateAdded: toTime(g.date_added),
        playCount: g.play_count != null ? toInt(g.play_count) : null,
        recentMin: g.recent_minutes != null ? toInt(g.recent_minutes) : null, // absent = unknown, not zero
        recentWindowDays: clamp(g.recent_days, 14, 1, 365),
        devices: g.device ? { [String(g.device)]: playtimeMin } : undefined,
        coverUrl: g.cover_url || null,
        iconUrl: g.icon_url || null,
        backfill: !!g.backfill,
      });
    });
    return sync.report(id, items);
  }, { summary: 'Push lifetime totals for an account; deltas become sessions. Optional dates/play counts are used to date history on the first report.', body: '{ games: [{ id, title, playtime_minutes, last_played_at?, first_played_at?, date_added?, play_count?, recent_minutes?, recent_days?, device?, cover_url?, backfill? }] }', bigBody: true });

  r.post('/api/v1/accounts/:id/presence', (c) => {
    const a = sync.account(toInt(c.params.id));
    if (!a) throw new HttpError(404, 'Account not found');
    const playing = arr(c.body.playing, 'playing').filter((p) => p && typeof p === 'object').map((p) => ({ extId: String(p.id ?? p.ext_id ?? p.title), title: p.title || null, device: p.device || null }));
    return sync.applyPresence(a, playing, { intervalSec: toInt(c.body.interval_sec, 120) });
  }, { summary: 'Push "currently playing" for an account (e.g. from Home Assistant); used to pin sessions to exact times', body: '{ playing: [{ id, title? }], interval_sec? }' });

  r.post('/api/v1/accounts/:id/enrich', async (c) => {
    const a = sync.account(toInt(c.params.id));
    if (!a) throw new HttpError(404, 'Account not found');
    if (c.body.reset) db.prepare('UPDATE entries SET enriched_at = NULL WHERE account_id = ?').run(a.id);
    const p = sync.enrich(a.id);
    if (c.query.wait === 'true') return (await p) || { updated: 0 };
    p.catch(() => {});
    return { ok: true, started: true };
  }, {
    summary: 'Fetch achievement times / release dates now to date pre-tracking history, and read due achievements / trophies',
    body: '{ reset?: boolean }', query: { wait: 'true' },
    returns: 'with wait=true: { updated, anchored, remaining (history titles left), achievements: { read, backfilled, pending, played_since, api_calls, retry_in } | undefined }',
  });

  r.post('/api/v1/accounts/:id/licenses', (c) => {
    const a = sync.account(toInt(c.params.id));
    if (!a) throw new HttpError(404, 'Account not found');
    const text = typeof c.body === 'string' ? c.body : c.body.text;
    if (!text || typeof text !== 'string') throw new HttpError(400, 'Send { text } with the table copied from store.steampowered.com/account/licenses');
    return preview(c, () => {
      const res = applyLicenses(db, a.id, text, { settings: settings.all() });
      relearnStyle(db, { settings: settings.all() });
      return res;
    });
  }, { query: { dry_run: 'true = preview only' }, summary: 'Paste Steam\'s licenses page (date added per product) to bound pre-tracking history', body: '{ text }', bigBody: true });

  r.get('/api/v1/now-playing', () => sync.nowPlaying(), { summary: 'Games currently being played (from presence)' });

  r.post('/api/v1/sync', () => {
    const ids = db.prepare('SELECT id, platform FROM accounts WHERE enabled = 1').all().filter((a) => !providers[a.platform]?.push).map((a) => a.id);
    for (const id of ids) sync.sync(id, 'manual').catch(() => {});
    return { ok: true, started: ids.length };
  }, { summary: 'Sync all enabled accounts now' });

  r.get('/api/v1/syncs', (c) => {
    const where = []; const args = [];
    if (c.query.account_id) { where.push('s.account_id = ?'); args.push(toInt(c.query.account_id)); }
    return db.prepare(`SELECT s.*, a.name account_name, a.platform FROM syncs s LEFT JOIN accounts a ON a.id = s.account_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.id DESC LIMIT ?`)
      .all(...args, clamp(c.query.limit, 50, 1, 500)).map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  }, { summary: 'Sync history', query: { account_id: '', limit: '' } });

  // ---------- settings & tokens ----------
  r.get('/api/v1/settings', () => {
    const s = settings.public();
    return { ...s, schedule_label: describeSchedule(s), next_global_run: nextRun(s, Date.now()) };
  }, { summary: 'Get settings' });
  r.put('/api/v1/settings', (c) => {
    const v = validateSettings(c.body || {});
    if (v.errors.length) throw new HttpError(400, v.errors.join('; '));
    const prev = settings.all();
    settings.set(v.values);
    for (const a of db.prepare('SELECT id FROM accounts').all()) sync.refreshNext(a.id);
    // history caps changed -> re-date history with the new limits
    if ('history_learn' in v.values && v.values.history_learn !== prev.history_learn) relearnStyle(db, { settings: settings.all() });
    if (['history_max_day_minutes', 'history_max_game_day_minutes', 'use_recent_on_import'].some((k) => k in v.values && v.values[k] !== prev[k])) {
      db.prepare('UPDATE entries SET inferred_v = 0 WHERE baseline_min > 0').run();
      flushRollups(db);
      reinferPending(db, { settings: settings.all() });
      flushRollups(db);
    }
    const s = settings.public();
    return { ...s, schedule_label: describeSchedule(s) };
  }, { summary: 'Update settings (partial)', body: 'Any subset of the settings object' });

  r.get('/api/v1/tokens', () => db.prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_tokens ORDER BY id').all(), { summary: 'List API tokens' });
  r.post('/api/v1/tokens', (c) => auth.createToken(c.body.name), { summary: 'Create an API token (shown once)', body: '{ name }' });
  r.delete('/api/v1/tokens/:id', (c) => { db.prepare('DELETE FROM api_tokens WHERE id = ?').run(toInt(c.params.id)); return { ok: true }; }, { summary: 'Revoke an API token' });

  // ---------- import / export / backup ----------
  r.post('/api/v1/import', (c) => {
    let rows;
    if (typeof c.body === 'string' || c.rawType === 'csv') rows = parseCsv(c.rawBody);
    else if (Array.isArray(c.body)) rows = c.body;
    else if (Array.isArray(c.body.games)) rows = c.body.games;
    else if (typeof c.body.csv === 'string') rows = parseCsv(c.body.csv);
    else throw new HttpError(400, 'Send a CSV body, a JSON array, or { games: [...] }');
    return preview(c, () => {
      const res = importRows(db, rows, { settings: settings.all() });
      res.style_relearned = relearnStyle(db, { settings: settings.all(), log: app.log?.scoped?.('inference') });
      return res;
    });
  }, { query: { dry_run: 'true = report what would happen without changing anything' }, summary: 'Import games/history (CSV or JSON). Joins what is here: synced games keep their platform totals and gain dates / exact past sessions; manual and imported games are updated; empty details are filled, never overwritten.', body: 'CSV text or { games: [{ title, platform?, playtime_minutes|playtime_hours, last_played?, status?, rating?, notes?, sessions?: [{ date|started_at, minutes }] }] }', bigBody: true });

  r.post('/api/v1/import/gametrack', (c) => {
    const buf = c.rawBuffer;
    if (!isZip(buf)) throw new HttpError(400, 'Upload the GameTrack export .zip (Settings → Export in GameTrack)');
    const tables = gameTrackTables(readZip(buf));
    return preview(c, () => importGameTrack(db, tables, { settings: settings.all() }));
  }, { query: { dry_run: 'true = preview only' }, summary: 'Import a GameTrack export ZIP: unlock times date synced history, untracked hours become history, statuses/ratings/covers fill gaps', body: 'the .zip file (Content-Type: application/zip)', bigBody: true, binary: true });

  r.get('/api/v1/export', async (c) => {
    const csv = c.query.format === 'csv';
    c.stream(200, csv ? 'text/csv; charset=utf-8' : 'application/json', { 'Content-Disposition': `attachment; filename="vestigo-export.${csv ? 'csv' : 'json'}"` });
    // a cancelled download ends the loop, which closes the generator and releases its statement
    // (left open, it blocks backups and WAL checkpoints on the shared connection)
    for (const chunk of exportChunks(db, csv ? 'csv' : 'json')) {
      if (c.res.destroyed) break;
      if (!c.res.write(chunk) && !c.res.destroyed) {
        await new Promise((r) => {
          const done = () => { c.res.off('drain', done); c.res.off('close', done); r(); };
          c.res.on('drain', done);
          c.res.on('close', done);
        });
      }
    }
    if (!c.res.destroyed) c.res.end();
    return undefined;
  }, {
    summary: 'Export everything (streamed JSON, or ?format=csv)', query: { format: 'json|csv' },
    returns: 'JSON: { format, version, app, exported_at, games: [{ title, platform, account, playtime_minutes, …, sessions, achievements?: [{ id, name, unlocked, unlocked_at, rarity?, points?, grade? }] }] } '
      + '(achievements only on entries that have them; importing ignores them - they come back from the platform). CSV: unchanged columns.',
  });

  r.get('/api/v1/backup', (c) => {
    const tmp = path.join(os.tmpdir(), `vestigo-backup-${Date.now()}.db`);
    // a read-only connection of its own: SQLite refuses VACUUM while a statement is running on the
    // app's connection (an export still downloading); either way it copies one consistent snapshot
    const src = app.dbFile && app.dbFile !== ':memory:' ? new DatabaseSync(app.dbFile, { readOnly: true }) : db;
    try { src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { if (src !== db) src.close(); }
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    c.sendRaw(200, buf, 'application/vnd.sqlite3', { 'Content-Disposition': `attachment; filename="vestigo-${new Date().toISOString().slice(0, 10)}.db"` });
    return undefined;
  }, { summary: 'Download a consistent SQLite backup' });

  // ---------- integrations ----------
  // ---------- history inference ----------
  r.patch('/api/v1/entries/:id/history', (c) => {
    const id = toInt(c.params.id);
    const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
    if (!e) throw new HttpError(404, 'Entry not found');
    if (!e.baseline_min) throw new HttpError(400, 'This entry has no pre-tracking history');
    const b = c.body;
    const h = JSON.parse(e.hist || '{}');
    if ('mode' in b) { if (!['auto', 'undated'].includes(b.mode)) throw new HttpError(400, 'mode must be auto or undated'); h.mode = b.mode; }
    if ('first_played_at' in b || 'last_played_at' in b) {
      // empty / null clears the window; text that is not a date is refused (and changes nothing)
      const start = timeField(b, 'first_played_at');
      const end = timeField(b, 'last_played_at');
      if (start && end && end < start) throw new HttpError(400, 'last_played_at must be after first_played_at');
      h.manual = start || end ? { start: start || undefined, end: end || undefined } : null;
    }
    if (b.reset) { delete h.manual; h.mode = 'auto'; }
    if (b.confirm) {
      // "looks right": keep the current estimate exactly as it is, and pin its window so
      // later re-dating (new evidence, algorithm updates) never moves it
      const w = h.inference?.window;
      if (!w) throw new HttpError(400, 'There is no estimate to confirm');
      h.manual = { start: w[0], end: w[1], confirmed: true };
      h.mode = 'auto';
      h.inference = { ...h.inference, confidence: 'high', reasons: ['You confirmed this estimate', ...(h.inference.reasons || []).filter((r) => r !== 'You confirmed this estimate')] };
      tx(db, () => {
        db.prepare('UPDATE entries SET hist = ? WHERE id = ?').run(JSON.stringify(h), id);
        db.prepare("UPDATE sessions SET confidence = 'high' WHERE entry_id = ? AND source = 'inferred' AND kind = 'estimate'").run(id);
        flushRollups(db);
      });
      return getGame(e.game_id);
    }
    tx(db, () => {
      db.prepare('UPDATE entries SET hist = ? WHERE id = ?').run(JSON.stringify(h), id);
      flushRollups(db);
      reinferMany(db, [id], { settings: settings.all() });
      flushRollups(db);
    });
    return getGame(e.game_id);
  }, { summary: 'Adjust how pre-tracking history is dated: manual first/last played window, or mode=undated to keep it out of charts', body: '{ first_played_at?, last_played_at?, mode?: "auto"|"undated", reset?: boolean, confirm?: boolean (keep the current estimate) }' });

  r.post('/api/v1/history/reinfer', () => {
    db.prepare('UPDATE entries SET inferred_v = 0 WHERE baseline_min > 0').run();
    flushRollups(db);
    const n = reinferPending(db, { log: app.log?.scoped?.('inference'), settings: settings.all() });
    flushRollups(db);
    return { ok: true, entries: n };
  }, { summary: 'Re-date all pre-tracking history with the current algorithm' });

  // Games whose pre-tracking history is least certain first (low-confidence + undated minutes),
  // for the "Improve history" page: one quick answer per game re-dates it.
  r.get('/api/v1/history/review', (c) => {
    const limit = clamp(c.query.limit, 30, 1, 200);
    const offset = clamp(c.query.offset, 0, 0, 1e9);
    const platform = c.query.platform || null;
    return memo(db, `hist-review:${limit}:${offset}:${platform}`, () => {
      const where = `e.baseline_min > 0 AND e.excluded = 0 AND json_extract(e.hist, '$.manual') IS NULL
        AND COALESCE(json_extract(e.hist, '$.mode'), 'auto') = 'auto' ${platform ? 'AND e.platform = ?' : ''}`;
      const args = platform ? [platform] : [];
      const rows = db.prepare(`SELECT * FROM (SELECT e.id, e.platform, e.baseline_min, e.hist, e.game_id, g.title, g.cover_url, a.name account_name,
          (SELECT SUM(CASE WHEN s.kind = 'baseline' OR s.confidence = 'low' THEN s.minutes WHEN s.confidence = 'medium' THEN s.minutes * 0.5 ELSE 0 END)
             FROM sessions s WHERE s.entry_id = e.id AND s.source = 'inferred') unc
        FROM entries e JOIN games g ON g.id = e.game_id LEFT JOIN accounts a ON a.id = e.account_id WHERE ${where})
        WHERE unc > 0 ORDER BY unc DESC, id LIMIT ? OFFSET ?`).all(...args, limit, offset);
      const total = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(unc), 0) m FROM (SELECT (SELECT SUM(CASE WHEN s.kind = 'baseline' OR s.confidence = 'low' THEN s.minutes WHEN s.confidence = 'medium' THEN s.minutes * 0.5 ELSE 0 END)
          FROM sessions s WHERE s.entry_id = e.id AND s.source = 'inferred') unc FROM entries e WHERE ${where}) WHERE unc > 0`).get(...args);
      const meter = Object.fromEntries(['high', 'medium', 'low', 'undated', 'manual'].map((k) => [k, 0]));
      for (const r of db.prepare(`SELECT CASE WHEN json_extract(e.hist, '$.manual') IS NOT NULL THEN 'manual' WHEN s.kind = 'baseline' THEN 'undated' ELSE s.confidence END k, SUM(s.minutes) m
          FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE s.source = 'inferred' AND e.excluded = 0 GROUP BY k`).all()) meter[r.k || 'low'] = (meter[r.k || 'low'] || 0) + r.m;
      const style = styleOf(db);
      return {
        total: total.n, uncertain_minutes: Math.round(total.m), meter,
        style: style ? { games: style.games, learned_at: style.learned_at } : null,
        items: rows.map((r) => {
          const h = JSON.parse(r.hist || '{}');
          return {
            entry_id: r.id, game_id: r.game_id, title: r.title, cover_url: r.cover_url, platform: r.platform, account_name: r.account_name,
            minutes: r.baseline_min, uncertain_minutes: Math.round(r.unc), confidence: h.inference?.confidence || null, window: h.inference?.window || null,
            undated: h.inference?.undated || 0, reasons: h.inference?.reasons || [],
            evidence: { first_played_at: h.first_played_at || null, last_played_at: h.last_played_at || null, date_added: h.date_added || null, release_at: h.release_at || null, tracking_start: h.tracking_start || null },
          };
        }),
      };
    });
  }, { summary: 'Games whose pre-tracking history dating is least certain (for quick manual answers)', query: { limit: 'max 200', offset: '', platform: '' } });

  r.get('/api/v1/history/summary', () => memo(db, 'hist-summary', () => {
    const rows = db.prepare(`SELECT s.kind, s.confidence, COUNT(DISTINCT s.entry_id) entries, SUM(s.minutes) minutes FROM sessions s JOIN entries e ON e.id = s.entry_id
      WHERE s.source = 'inferred' AND e.excluded = 0 GROUP BY s.kind, s.confidence`).all();
    const style = styleOf(db);
    // only titles that can still be enriched (as on /system): custom accounts never are
    const enrichable = db.prepare('SELECT id, platform FROM accounts').all().filter((a) => providers[a.platform]?.enrich).map((a) => a.id);
    const pending = enrichable.length ? db.prepare(`SELECT COUNT(*) n FROM entries WHERE baseline_min > 0 AND enriched_at IS NULL AND account_id IN (${enrichable.map(() => '?').join(',')})`).get(...enrichable).n : 0;
    return { rows, pending_enrichment: pending, version: INFER_VERSION,
      style: style ? { games: style.games, learned_at: style.learned_at } : null };
  }), { summary: 'How much pre-tracking history is dated, by confidence' });

  // ---------- logs & diagnostics ----------
  r.get('/api/v1/logs', (c) => {
    const q = c.query;
    const where = []; const args = [];
    if (q.level) { const lv = q.level.split(','); where.push(`level IN (${lv.map(() => '?').join(',')})`); args.push(...lv); }
    if (q.source) { where.push('source LIKE ?'); args.push(`${q.source}%`); }
    if (q.q) { // literal text: % and _ are not wildcards
      const like = `%${q.q.replace(/[\\%_]/g, '\\$&')}%`;
      where.push("(message LIKE ? ESCAPE '\\' OR context LIKE ? ESCAPE '\\')"); args.push(like, like);
    }
    if (q.since) { where.push('time >= ?'); args.push(toTime(q.since)); }
    if (q.before) { where.push('id < ?'); args.push(toInt(q.before)); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // (older versions stored oversized contexts cut off mid-JSON)
    const context = (s) => { try { return s ? JSON.parse(s) : null; } catch { return { truncated: true, preview: s.slice(0, 2000) }; } };
    const items = db.prepare(`SELECT * FROM logs ${w} ORDER BY id DESC LIMIT ?`).all(...args, clamp(q.limit, 200, 1, 1000))
      .map((l) => ({ ...l, context: context(l.context) }));
    const counts = db.prepare('SELECT level, COUNT(*) n FROM logs WHERE time > ? GROUP BY level').all(Date.now() - 86_400_000);
    return { items, counts_24h: Object.fromEntries(counts.map((x) => [x.level, x.n])), next: items.length ? items.at(-1).id : null };
  }, { summary: 'Persisted warnings and errors (30 days)', query: { level: 'warn,error', source: 'sync, presence, api, …', q: 'search', since: '', before: 'cursor (id)', limit: '' } });

  r.delete('/api/v1/logs', () => { db.prepare('DELETE FROM logs').run(); return { ok: true }; }, { summary: 'Clear the error log' });

  r.get('/api/v1/system', () => {
    const size = (f) => { try { return fsp.statSync(f).size; } catch { return 0; } };
    const dbFile = app.dbFile;
    const count = (sql, ...a) => db.prepare(sql).get(...a).n;
    const hour = Math.floor(Date.now() / 3_600_000);
    const accounts = db.prepare('SELECT * FROM accounts ORDER BY id').all().map(parseAccount).map((a) => {
      const day = db.prepare('SELECT COALESCE(SUM(calls),0) calls, COALESCE(SUM(errors),0) errors, COALESCE(SUM(rate_limited),0) rate_limited FROM api_usage WHERE account_id = ? AND hour > ?').get(a.id, hour - 24);
      const last = db.prepare('SELECT status, error, duration_ms, started_at, trigger FROM syncs WHERE account_id = ? ORDER BY id DESC LIMIT 1').get(a.id);
      const fails = count("SELECT COUNT(*) n FROM syncs WHERE account_id = ? AND status = 'error' AND started_at > ?", a.id, Date.now() - 7 * 86_400_000);
      return {
        ...publicAccount(a, sync), api_usage_24h: day, last_sync: last || null, failed_syncs_7d: fails,
        can_enrich: !!providers[a.platform]?.enrich,
        enrichment_pending: providers[a.platform]?.enrich ? count('SELECT COUNT(*) n FROM entries WHERE account_id = ? AND baseline_min > 0 AND enriched_at IS NULL', a.id) : 0,
        // how far reading achievements / trophies has got (null: the platform has none)
        achievements: providers[a.platform]?.achievements ? achievementProgress(db, a.id) : null,
        capabilities: providers[a.platform]?.capabilities || null,
      };
    });
    const mem = process.memoryUsage();
    return {
      version, revision, node: process.version, platform: `${process.platform}/${process.arch}`, pid: process.pid, uid: process.getuid?.() ?? null,
      uptime_s: Math.round(process.uptime()), started_at: app.http?.started_at,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone, tz_env: process.env.TZ || null,
      data_dir: dbFile === ':memory:' ? null : dbFile, db_bytes: size(dbFile) + size(`${dbFile}-wal`), memory_mb: Math.round(mem.rss / 1048576), heap_mb: Math.round(mem.heapUsed / 1048576),
      http: app.http || null,
      auth_enabled: auth.enabled(),
      counts: {
        games: count('SELECT COUNT(*) n FROM games'), entries: count('SELECT COUNT(*) n FROM entries'),
        sessions_tracked: count("SELECT COUNT(*) n FROM sessions WHERE kind = 'play'"),
        sessions_estimated: count("SELECT COUNT(*) n FROM sessions WHERE kind = 'estimate'"),
        rollup_rows: count('SELECT COUNT(*) n FROM play_days'), rollup_queue: count('SELECT COUNT(*) n FROM rollup_queue'),
        snapshots: count('SELECT COUNT(*) n FROM snapshots'), presence_spans: count('SELECT COUNT(*) n FROM presence'),
        logs: count('SELECT COUNT(*) n FROM logs'), achievements: count('SELECT COUNT(*) n FROM achievements'),
      },
      errors_24h: count("SELECT COUNT(*) n FROM logs WHERE level = 'error' AND time > ?", Date.now() - 86_400_000),
      warnings_24h: count("SELECT COUNT(*) n FROM logs WHERE level = 'warn' AND time > ?", Date.now() - 86_400_000),
      accounts,
      console: app.log?.recent?.().slice(-80) || [],
    };
  }, {
    summary: 'Diagnostics: versions, storage, per-account health, API usage & rate limits, recent console output',
    returns: 'accounts[].achievements (Steam, Xbox, PlayStation; null elsewhere): { titles (played titles), done, pending (not read yet), pending_with_history (of those, read by the history enrichment; the rest by the one-time back-fill), '
      + 'refresh_due (played since last read: read after the next sync), achievements, unlocked, last_read_at, version }',
  });

  r.get('/api/v1/widget', () => {
    const l = lifetime(db);
    // today / this week use tracked play only, like the dashboard KPIs
    const w = computeStats(db, { range: 'week', weekStartsOn: settings.get('week_starts_on'), estimates: 'exclude' });
    const t = computeStats(db, { range: '1d', estimates: 'exclude' });
    const last = db.prepare(`${SESSION_SELECT} WHERE s.kind = 'play' AND e.excluded = 0 ORDER BY s.sort_time DESC LIMIT 1`).get();
    return {
      today_hours: +(t.total_minutes / 60).toFixed(1), week_hours: +(w.total_minutes / 60).toFixed(1), lifetime_hours: Math.round(l.total_minutes / 60),
      games: l.games, sessions: l.sessions, streak_days: w.streaks.current, top_game_week: w.top_games[0]?.title || null, last_played: last?.title || null,
    };
  }, { summary: 'Flat numbers for dashboards (Homepage, Homarr, Home Assistant)' });
}
