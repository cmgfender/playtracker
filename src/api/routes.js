import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  };
}

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
    precise: !!(s.started_at && s.ended_at), note: s.note, sync_id: s.sync_id, created_at: s.created_at,
  };
}

const SESSION_SELECT = `SELECT s.*, e.game_id, e.platform, e.account_id, a.name account_name, g.title, g.cover_url
  FROM sessions s JOIN entries e ON e.id = s.entry_id JOIN games g ON g.id = e.game_id LEFT JOIN accounts a ON a.id = e.account_id`;

export function registerRoutes(r, app) {
  const { db, settings, sync, auth, version } = app;

  // ---------- meta ----------
  r.get('/api/v1/health', () => ({ ok: true, version, time: Date.now(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }), { summary: 'Health check', public: true });
  r.get('/api/v1/platforms', () => providerInfo(), { summary: 'Supported platforms and their credential fields' });

  // ---------- auth ----------
  r.get('/api/v1/auth/status', (c) => ({ auth_enabled: auth.enabled(), authenticated: c.auth.ok, via: c.auth.via, password_source: auth.passwordSource() }), { summary: 'Auth status', public: true });
  r.post('/api/v1/auth/login', (c) => {
    if (!auth.enabled()) return { ok: true };
    if (!auth.checkPassword(String(c.body.password || ''))) throw new HttpError(401, 'Wrong password');
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
    const week = computeStats(db, { range: 'week', group: 'day', weekStartsOn });
    const month = computeStats(db, { range: '30d', group: 'day', weekStartsOn });
    const today = computeStats(db, { range: '1d', group: 'day', weekStartsOn });
    const recent = db.prepare(`${SESSION_SELECT} WHERE s.kind = 'play' AND e.excluded = 0 ORDER BY s.sort_time DESC LIMIT 12`).all().map(sessionRow);
    const nowPlaying = db.prepare(`${GAME_LIST} WHERE rec.recent_minutes > 0 AND g.hidden = 0 ORDER BY agg.last_session DESC LIMIT 12`).all(recentFromDay()).map(gameRow);
    const accounts = db.prepare('SELECT * FROM accounts ORDER BY id').all().map(parseAccount).map((a) => publicAccount(a, sync));
    const pending = db.prepare("SELECT COUNT(*) n FROM sessions WHERE kind = 'play' AND sort_time > ? AND created_at > ?").get(Date.now() - 30 * 86_400_000, Date.now() - 86_400_000).n;
    return { lifetime: lifetime(db), today, week, month, recent_sessions: recent, now_playing: nowPlaying, accounts, new_sessions_24h: pending };
  }, { summary: 'Everything the dashboard needs in one call' });

  // ---------- games ----------
  r.get('/api/v1/games', (c) => {
    const q = c.query;
    const where = [];
    const args = [recentFromDay()];
    if (q.q) { where.push('(g.title LIKE ? OR g.norm_title LIKE ?)'); args.push(`%${q.q}%`, `%${normalizeTitle(q.q)}%`); }
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
    const title = String(c.body.title || '').trim();
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
      return { ...gameRow(bare), entries: [] };
    }
    const entries = db.prepare(`SELECT e.*, a.name account_name FROM entries e LEFT JOIN accounts a ON a.id = e.account_id WHERE e.game_id = ? ORDER BY e.playtime_min DESC`).all(id)
      .map((e) => ({ id: e.id, account_id: e.account_id, account_name: e.account_name, platform: e.platform, ext_id: e.ext_id, title: e.title, icon_url: e.icon_url, cover_url: e.cover_url, playtime_min: e.playtime_min, last_played_at: e.last_played_at, first_seen_at: e.first_seen_at, last_synced_at: e.last_synced_at, excluded: !!e.excluded, meta: JSON.parse(e.meta || '{}') }));
    const agg = db.prepare(`SELECT s.kind, COUNT(*) n, COALESCE(SUM(s.minutes),0) m, MIN(COALESCE(s.started_at, s.window_start, s.window_end)) first, MAX(s.minutes) longest
      FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE e.game_id = ? AND e.excluded = 0 GROUP BY s.kind`).all(id);
    const k = Object.fromEntries(agg.map((x) => [x.kind, x]));
    const firstSeen = Math.min(...entries.map((e) => e.first_seen_at));
    return {
      ...gameRow(g),
      entries,
      summary: {
        total_minutes: g.minutes,
        tracked_minutes: k.play?.m || 0,
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
    const sessions = db.prepare(`${SESSION_SELECT} WHERE s.entry_id IN (SELECT id FROM entries WHERE game_id = ?) ORDER BY s.sort_time DESC, s.id DESC LIMIT 300`).all(game.id).map(sessionRow);
    const stats = computeStats(db, { range: 'all', gameId: game.id, group: 'month', weekStartsOn: settings.get('week_starts_on'), topLimit: 1 });
    return { ...game, sessions, sessions_truncated: game.summary && game.summary.sessions > 300, series: stats.series, weekday: stats.weekday };
  }, { summary: 'Game detail with entries, latest 300 sessions, monthly history' });

  r.get('/api/v1/entries/:id/snapshots', (c) => {
    const limit = Math.min(10000, toInt(c.query.limit, 1000));
    return db.prepare('SELECT taken_at, playtime_min, sync_id FROM snapshots WHERE entry_id = ? ORDER BY taken_at DESC LIMIT ?').all(toInt(c.params.id), limit);
  }, { summary: 'Raw playtime snapshots for an entry (newest first)', query: { limit: 'max 10000' } });

  r.patch('/api/v1/games/:id', (c) => {
    const id = toInt(c.params.id);
    if (!db.prepare('SELECT id FROM games WHERE id = ?').get(id)) throw new HttpError(404, 'Game not found');
    const b = c.body;
    const sets = []; const args = [];
    if ('title' in b) { const t = cleanTitle(b.title); sets.push('title = ?', 'norm_title = ?'); args.push(t, normalizeTitle(t)); }
    if ('cover_url' in b) { sets.push('cover_url = ?'); args.push(b.cover_url || null); }
    if ('status' in b) { if (!STATUSES.includes(b.status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`); sets.push('status = ?'); args.push(b.status); }
    if ('rating' in b) { sets.push('rating = ?'); args.push(b.rating == null || b.rating === '' ? null : Math.max(0, Math.min(10, Number(b.rating)))); }
    if ('notes' in b) { sets.push('notes = ?'); args.push(b.notes ? String(b.notes).slice(0, 10000) : null); }
    for (const f of ['favorite', 'hidden', 'merge_locked']) if (f in b) { sets.push(`${f} = ?`); args.push(b[f] ? 1 : 0); }
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
    const ids = (c.body.source_ids || c.body.ids || []).map(Number).filter(Boolean);
    if (!ids.length) throw new HttpError(400, 'source_ids is required');
    tx(db, () => mergeGames(db, target, ids));
    return getGame(target);
  }, { summary: 'Merge other games into this one (duplicate tracking)', body: '{ source_ids: number[] }' });

  // ---------- entries ----------
  r.patch('/api/v1/entries/:id', (c) => {
    const id = toInt(c.params.id);
    const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
    if (!e) throw new HttpError(404, 'Entry not found');
    if ('excluded' in c.body) db.prepare('UPDATE entries SET excluded = ? WHERE id = ?').run(c.body.excluded ? 1 : 0, id);
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
    if (q.from) { where.push('s.sort_time >= ?'); args.push(toTime(q.from)); }
    if (q.to) { where.push('COALESCE(s.started_at, s.window_start, s.window_end) <= ?'); args.push(toTime(q.to)); }
    if (q.q) { where.push('s.entry_id IN (SELECT e2.id FROM entries e2 JOIN games g2 ON g2.id = e2.game_id WHERE g2.title LIKE ?)'); args.push(`%${q.q}%`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(1000, Math.max(1, toInt(q.limit, 100)));
    const offset = Math.max(0, toInt(q.offset, 0));
    const total = memo(db, `sess-count:${w}:${JSON.stringify(args)}`, () => db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(s.minutes),0) m FROM sessions s ${w}`).get(...args));
    // Keyset pagination: pass back `next` as ?before= to page deep into huge histories cheaply.
    const pw = [...where]; const pargs = [...args];
    const cur = /^(\d+):(\d+)$/.exec(q.before || '');
    if (cur) { pw.push('(s.sort_time < ? OR (s.sort_time = ? AND s.id < ?))'); pargs.push(Number(cur[1]), Number(cur[1]), Number(cur[2])); }
    const items = db.prepare(`${SESSION_SELECT} ${pw.length ? `WHERE ${pw.join(' AND ')}` : ''} ORDER BY s.sort_time DESC, s.id DESC LIMIT ? OFFSET ?`)
      .all(...pargs, limit, cur ? 0 : offset).map(sessionRow);
    const last = items.at(-1);
    const sortTime = (x) => x.ended_at || x.window_end || x.created_at;
    return { total: total.n, total_minutes: total.m, limit, offset, items, next: items.length === limit && last ? `${sortTime(last)}:${last.id}` : null };
  }, { summary: 'List sessions (newest first). Use `before` = previous `next` for fast deep paging.', query: { from: 'date/ISO/epoch', to: '', game_id: '', platform: '', account_id: '', source: 'sync|manual|import|api', kind: 'play|baseline|all', sync_id: '', q: 'title search', limit: 'max 1000', offset: '', before: 'cursor from `next`' } });

  r.get('/api/v1/sessions/:id', (c) => {
    const s = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(toInt(c.params.id));
    if (!s) throw new HttpError(404, 'Session not found');
    return sessionRow(s);
  }, { summary: 'Get one session' });

  r.post('/api/v1/sessions', (c) => {
    const b = c.body;
    const gameId = toInt(b.game_id);
    const minutes = toInt(b.minutes) ?? (b.hours ? Math.round(Number(b.hours) * 60) : null);
    if (!gameId || !db.prepare('SELECT id FROM games WHERE id = ?').get(gameId)) throw new HttpError(400, 'Valid game_id is required');
    if (!minutes || minutes <= 0 || minutes > 7 * 1440) throw new HttpError(400, 'minutes must be between 1 and 10080');
    const now = Date.now();
    let started = toTime(b.started_at);
    let ended = toTime(b.ended_at);
    if (!started && !ended && b.date) { started = toTime(b.date); ended = started + minutes * MIN; }
    if (started && !ended) ended = started + minutes * MIN;
    if (!started && ended) started = ended - minutes * MIN;
    if (!started) { ended = now; started = now - minutes * MIN; }
    const id = tx(db, () => {
      const e = manualEntry(db, gameId, now);
      const r2 = db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, note, created_at) VALUES (?, 'manual', 'play', ?, ?, ?, ?, ?, ?, ?)")
        .run(e.id, minutes, started, ended, started, ended, b.note || null, now);
      db.prepare('UPDATE entries SET playtime_min = playtime_min + ?, last_played_at = MAX(COALESCE(last_played_at, 0), ?), last_synced_at = ? WHERE id = ?').run(minutes, ended, now, e.id);
      if (b.status && STATUSES.includes(b.status)) db.prepare('UPDATE games SET status = ?, updated_at = ? WHERE id = ?').run(b.status, now, gameId);
      return Number(r2.lastInsertRowid);
    });
    return sessionRow(db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id));
  }, { summary: 'Log a manual session', body: '{ game_id, minutes|hours, started_at?|ended_at?|date?, note?, status? }' });

  function changeSession(id, patch) {
    const s = db.prepare('SELECT s.*, e.platform, e.account_id FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE s.id = ?').get(id);
    if (!s) throw new HttpError(404, 'Session not found');
    const local = s.source === 'manual' || s.source === 'import' || s.source === 'api';
    const sets = []; const args = [];
    if ('note' in patch) { sets.push('note = ?'); args.push(patch.note || null); }
    if ('kind' in patch) {
      if (!['play', 'baseline'].includes(patch.kind)) throw new HttpError(400, 'kind must be play or baseline');
      sets.push('kind = ?'); args.push(patch.kind);
    }
    if ('started_at' in patch || 'ended_at' in patch) {
      const st = 'started_at' in patch ? toTime(patch.started_at) : s.started_at;
      const en = 'ended_at' in patch ? toTime(patch.ended_at) : s.ended_at;
      if (st && en && en <= st) throw new HttpError(400, 'ended_at must be after started_at');
      sets.push('started_at = ?', 'ended_at = ?'); args.push(st, en);
      if (local) { sets.push('window_start = ?', 'window_end = ?'); args.push(st, en); }
    }
    if ('minutes' in patch) {
      const m = toInt(patch.minutes);
      if (!m || m <= 0) throw new HttpError(400, 'minutes must be positive');
      if (!local) throw new HttpError(400, 'Minutes of synced sessions come from the platform; change kind to "baseline" to drop it from stats instead');
      sets.push('minutes = ?'); args.push(m);
      db.prepare('UPDATE entries SET playtime_min = MAX(0, playtime_min + ?) WHERE id = ?').run(m - s.minutes, s.entry_id);
    }
    if (sets.length) db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  function removeSession(id) {
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'Session not found');
    if (s.source === 'sync') {
      // Lifetime playtime comes from the platform, so a synced session can only be
      // dropped from period stats (converted to baseline), not truly deleted.
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
    return sessionRow(db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id));
  }, { summary: 'Edit a session (note, times, kind; minutes for manual sessions)', body: '{ note?, started_at?, ended_at?, kind?, minutes? }' });

  r.delete('/api/v1/sessions/:id', (c) => ({ ok: true, result: tx(db, () => removeSession(toInt(c.params.id))) }),
    { summary: 'Delete a manual session, or drop a synced one from stats (becomes baseline)' });

  r.post('/api/v1/sessions/bulk', (c) => {
    const ids = (c.body.ids || []).map(Number).filter(Boolean);
    const action = c.body.action;
    if (!['baseline', 'play', 'delete'].includes(action)) throw new HttpError(400, 'action must be baseline, play or delete');
    tx(db, () => { for (const id of ids) action === 'delete' ? removeSession(id) : changeSession(id, { kind: action }); });
    return { ok: true, count: ids.length };
  }, { summary: 'Bulk convert sessions to baseline/play or delete', body: '{ ids: number[], action: "baseline"|"play"|"delete" }' });

  // ---------- stats ----------
  r.get('/api/v1/stats', (c) => computeStats(db, {
    range: c.query.range, group: c.query.group, gameId: toInt(c.query.game_id), platform: c.query.platform, weekStartsOn: settings.get('week_starts_on'),
  }), { summary: 'Aggregated stats for a range', query: { range: '7d|30d|90d|365d|week|month|year|all|year:2026|month:2026-05', group: 'day|week|month|year', game_id: '', platform: '' } });
  r.get('/api/v1/stats/lifetime', () => lifetime(db), { summary: 'Lifetime totals (including imported history)' });
  r.get('/api/v1/stats/heatmap', (c) => heatmap(db, { year: c.query.year, gameId: toInt(c.query.game_id) }), { summary: 'Minutes per day for a year', query: { year: '', game_id: '' } });
  r.get('/api/v1/stats/year/:year', (c) => yearInReview(db, toInt(c.params.year), { weekStartsOn: settings.get('week_starts_on') }), { summary: 'Year in review' });
  r.get('/api/v1/stats/years', () => {
    const first = db.prepare('SELECT MIN(day) d FROM play_days').get().d;
    const ys = [];
    if (first) for (let y = new Date().getFullYear(); y >= Number(first.slice(0, 4)); y--) if (db.prepare('SELECT 1 FROM play_days WHERE day >= ? AND day <= ? LIMIT 1').get(`${y}-01-01`, `${y}-12-31`)) ys.push(y);
    const cur = new Date().getFullYear();
    if (!ys.includes(cur)) ys.unshift(cur);
    return ys;
  }, { summary: 'Years that have play data' });

  // ---------- duplicates ----------
  r.get('/api/v1/duplicates', (c) => {
    const d = findDuplicates(db, { threshold: Number(c.query.threshold) || 0.8, limit: Math.min(5000, toInt(c.query.limit, 300)) });
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
    const res = await p.fetchLibrary({ id: 0, platform, config, state: {} }, { getEntry: () => null });
    return { ok: true, games: res.items.length, played: res.items.filter((i) => i.playtimeMin > 0).length, minutes: res.items.reduce((a, i) => a + (i.playtimeMin || 0), 0), warning: res.warning || null, sample: res.items.slice(0, 5).map((i) => i.title) };
  }, { summary: 'Test credentials without saving', body: '{ platform, config }' });

  r.post('/api/v1/accounts', (c) => {
    const platform = String(c.body.platform || '');
    const config = c.body.config || {};
    requireFields(platform, config);
    const name = String(c.body.name || providers[platform].label).slice(0, 80);
    const schedule = c.body.schedule ? JSON.stringify(validateSettings(c.body.schedule).values) : null;
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
    if (b.config && JSON.stringify(config) !== JSON.stringify(a.config)) state = {}; // credentials changed -> drop cached tokens
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
      pruneEmptyGames(db);
    });
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
    const items = games.map((g) => ({
      extId: String(g.id ?? g.ext_id ?? g.title),
      title: g.title || g.name || String(g.id),
      playtimeMin: g.playtime_minutes ?? (g.playtime_hours != null ? Math.round(g.playtime_hours * 60) : 0),
      lastPlayedAt: toTime(g.last_played_at),
      coverUrl: g.cover_url || null,
      iconUrl: g.icon_url || null,
      backfill: !!g.backfill,
    }));
    return sync.report(id, items);
  }, { summary: 'Push lifetime totals for an account; deltas become sessions', body: '{ games: [{ id, title, playtime_minutes, last_played_at?, cover_url?, backfill? }] }' });

  r.post('/api/v1/sync', () => {
    const ids = db.prepare('SELECT id, platform FROM accounts WHERE enabled = 1').all().filter((a) => !providers[a.platform]?.push).map((a) => a.id);
    for (const id of ids) sync.sync(id, 'manual').catch(() => {});
    return { ok: true, started: ids.length };
  }, { summary: 'Sync all enabled accounts now' });

  r.get('/api/v1/syncs', (c) => {
    const where = []; const args = [];
    if (c.query.account_id) { where.push('s.account_id = ?'); args.push(toInt(c.query.account_id)); }
    return db.prepare(`SELECT s.*, a.name account_name, a.platform FROM syncs s LEFT JOIN accounts a ON a.id = s.account_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY s.id DESC LIMIT ?`)
      .all(...args, Math.min(500, toInt(c.query.limit, 50)));
  }, { summary: 'Sync history', query: { account_id: '', limit: '' } });

  // ---------- settings & tokens ----------
  r.get('/api/v1/settings', () => {
    const s = settings.public();
    return { ...s, schedule_label: describeSchedule(s), next_global_run: nextRun(s, Date.now()) };
  }, { summary: 'Get settings' });
  r.put('/api/v1/settings', (c) => {
    const v = validateSettings(c.body || {});
    if (v.errors.length) throw new HttpError(400, v.errors.join('; '));
    settings.set(v.values);
    for (const a of db.prepare('SELECT id FROM accounts').all()) sync.refreshNext(a.id);
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
    const res = importRows(db, rows, { settings: settings.all() });
    return res;
  }, { summary: 'Import games/history (CSV or JSON). Totals without sessions become baseline history.', body: 'CSV text or { games: [{ title, platform?, playtime_minutes|playtime_hours, last_played?, status?, rating?, notes?, sessions?: [{ date|started_at, minutes }] }] }' });

  r.get('/api/v1/export', async (c) => {
    const csv = c.query.format === 'csv';
    c.stream(200, csv ? 'text/csv; charset=utf-8' : 'application/json', { 'Content-Disposition': `attachment; filename="playtracker-export.${csv ? 'csv' : 'json'}"` });
    for (const chunk of exportChunks(db, csv ? 'csv' : 'json')) {
      if (!c.res.write(chunk)) await new Promise((r) => c.res.once('drain', r));
    }
    c.res.end();
    return undefined;
  }, { summary: 'Export everything (streamed JSON, or ?format=csv)', query: { format: 'json|csv' } });

  r.get('/api/v1/backup', (c) => {
    const tmp = path.join(os.tmpdir(), `playtracker-backup-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const buf = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    c.sendRaw(200, buf, 'application/vnd.sqlite3', { 'Content-Disposition': `attachment; filename="playtracker-${new Date().toISOString().slice(0, 10)}.db"` });
    return undefined;
  }, { summary: 'Download a consistent SQLite backup' });

  // ---------- integrations ----------
  r.get('/api/v1/widget', () => {
    const l = lifetime(db);
    const w = computeStats(db, { range: 'week', weekStartsOn: settings.get('week_starts_on') });
    const t = computeStats(db, { range: '1d' });
    const last = db.prepare(`${SESSION_SELECT} WHERE s.kind = 'play' AND e.excluded = 0 ORDER BY s.sort_time DESC LIMIT 1`).get();
    return {
      today_hours: +(t.total_minutes / 60).toFixed(1), week_hours: +(w.total_minutes / 60).toFixed(1), lifetime_hours: Math.round(l.total_minutes / 60),
      games: l.games, sessions: l.sessions, streak_days: w.streaks.current, top_game_week: w.top_games[0]?.title || null, last_played: last?.title || null,
    };
  }, { summary: 'Flat numbers for dashboards (Homepage, Homarr, Home Assistant)' });
}
