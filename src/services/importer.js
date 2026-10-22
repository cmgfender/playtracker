import { tx } from '../db.js';
import { findOrCreateGame } from './library.js';
import { normalizeTitle } from './titles.js';
import { toTime } from '../util.js';
import { flushRollups } from './rollup.js';
import { mergeEvidence, reinferMany } from './inference.js';

const MIN = 60_000;
const STATUSES = new Set(['unset', 'backlog', 'playing', 'paused', 'completed', 'beaten', 'dropped', 'wishlist']);

export function parseCsv(text) {
  const rows = [];
  let row = []; let cell = ''; let q = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim()));
  if (!nonEmpty.length) return [];
  const head = nonEmpty[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return nonEmpty.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

function minutesOf(row) {
  const pick = (...keys) => keys.map((k) => row[k]).find((v) => v !== undefined && v !== null && v !== '');
  const m = pick('playtime_minutes', 'minutes', 'playtime_min', 'time_played_minutes');
  if (m !== undefined) return Math.max(0, Math.round(Number(m) || 0));
  const h = pick('playtime_hours', 'hours', 'hours_played', 'playtime', 'time_played');
  if (h !== undefined) {
    const hm = /^(\d+):(\d{2})$/.exec(String(h));
    if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
    return Math.max(0, Math.round((Number(String(h).replace(',', '.')) || 0) * 60));
  }
  return 0;
}

/**
 * Import games + optional session history. Totals not covered by explicit sessions become a
 * 'baseline' (lifetime only), so a mass import never shows up as one giant burst of play.
 * Rows: { title, platform?, playtime_minutes|playtime_hours, last_played?, status?, rating?, notes?, sessions?: [{date|started_at, minutes, note}] }
 */
export function importRows(db, rows, { settings, now = Date.now() } = {}) {
  const res = { games: 0, entries_created: 0, entries_updated: 0, sessions: 0, baseline_minutes: 0, tracked_minutes: 0, skipped: 0 };
  const st = {
    game: db.prepare(`UPDATE games SET status = CASE WHEN ? != '' THEN ? ELSE status END, rating = COALESCE(?, rating),
        notes = COALESCE(NULLIF(?, ''), notes), favorite = MAX(favorite, ?), updated_at = ? WHERE id = ?`),
    findEntry: db.prepare('SELECT * FROM entries WHERE account_id IS NULL AND platform = ? AND ext_id = ?'),
    insEntry: db.prepare('INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, last_played_at, first_seen_at, last_synced_at) VALUES (NULL, ?, ?, ?, ?, 0, ?, ?, ?)'),
    getEntry: db.prepare('SELECT * FROM entries WHERE id = ?'),
    // same key the export writes (start, else the window), so re-imports are recognised
    existing: db.prepare("SELECT COALESCE(started_at, window_start, window_end) started_at, minutes FROM sessions WHERE entry_id = ? AND kind = 'play'"),
    insPlay: db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, note, created_at) VALUES (?, 'import', 'play', ?, ?, ?, ?, ?, ?, ?)"),
    addHistory: db.prepare('UPDATE entries SET baseline_min = baseline_min + ? WHERE id = ?'),
    updEntry: db.prepare('UPDATE entries SET playtime_min = ?, last_played_at = COALESCE(?, last_played_at) WHERE id = ?'),
    exclude: db.prepare('UPDATE entries SET excluded = 1 WHERE id = ?'),
  };
  const toInfer = new Set();
  // existing entries by platform + account name + title, so re-importing an export (or a file
  // that overlaps games already here) updates them instead of adding a second copy
  let index = null;
  const indexed = () => {
    if (!index) {
      index = new Map();
      for (const e of db.prepare('SELECT e.id, e.platform, e.title, e.account_id, lower(a.name) acc FROM entries e LEFT JOIN accounts a ON a.id = e.account_id').iterate()) {
        const k = `${e.platform}|${e.acc || ''}|${normalizeTitle(e.title)}`;
        if (!index.has(k)) index.set(k, e);
      }
    }
    return index;
  };
  const str = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? '' : String(v));
  return tx(db, () => {
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) { res.skipped++; continue; }
      const title = str(row.title || row.name || row.game).trim();
      if (!title) { res.skipped++; continue; }
      const platform = String(row.platform || row.source || 'import').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32) || 'import';
      const gameId = findOrCreateGame(db, { title, coverUrl: str(row.cover_url) || null }, { autoMerge: settings?.auto_merge_titles !== false, now });
      res.games++;
      const status = str(row.status).toLowerCase();
      st.game.run(STATUSES.has(status) ? status : '', STATUSES.has(status) ? status : '', row.rating ? Math.min(10, Math.max(0, Number(row.rating) || 0)) : null,
          str(row.notes), row.favorite === true || row.favorite === 'true' || row.favorite === '1' ? 1 : 0, now, gameId);

      // one entry per source: our own exports carry the account name, so two copies of a game
      // (e.g. a Steam account entry and a spreadsheet entry) stay separate on re-import
      const acc = str(row.account).trim().toLowerCase();
      const extId = acc ? `import:${acc}:${normalizeTitle(title)}` : `import:${normalizeTitle(title)}`;
      let entry = st.findEntry.get(platform, extId);
      if (!entry) {
        const same = indexed().get(`${platform}|${acc}|${normalizeTitle(title)}`);
        if (same?.account_id != null) {
          // a synced account already tracks this game: its totals come from the platform, so only
          // the game's details and exclusion are taken from the file
          if (row.excluded === true || row.excluded === 'true' || row.excluded === '1') st.exclude.run(same.id);
          res.matched_synced = (res.matched_synced || 0) + 1;
          continue;
        }
        if (same) entry = st.getEntry.get(same.id); // manual / imported entry already here
      }
      const existed = !!entry;
      const lastPlayed = toTime(row.last_played || row.last_played_at);
      if (!entry) {
        const r = st.insEntry.run(gameId, platform, extId, title, lastPlayed, now, now);
        entry = st.getEntry.get(r.lastInsertRowid);
        index?.set(`${platform}|${acc}|${normalizeTitle(title)}`, { id: entry.id, account_id: null });
        res.entries_created++;
      } else res.entries_updated++;

      let sessionMinutes = 0;
      let earliestSession = Infinity;
      const sessions = Array.isArray(row.sessions) ? row.sessions : [];
      // re-imports are idempotent: skip sessions already present (same start + length)
      const have = sessions.length && existed ? new Set(st.existing.all(entry.id).map((x) => `${x.started_at}:${x.minutes}`)) : new Set();
      for (const s of sessions) {
        const minutes = Math.round(Number(s.minutes) || 0);
        const start = toTime(s.started_at || s.date || s.start);
        if (minutes <= 0 || !start) continue;
        const end = toTime(s.ended_at) || start + minutes * MIN;
        const k = `${start}:${minutes}`;
        if (have.has(k)) continue;
        have.add(k);
        st.insPlay.run(entry.id, minutes, start, end, start, end, s.note || null, now);
        sessionMinutes += minutes;
        earliestSession = Math.min(earliestSession, start);
        res.sessions++;
        res.tracked_minutes += minutes;
      }
      const reported = minutesOf(row);
      const newTotal = Math.max(reported, entry.playtime_min + sessionMinutes);
      const baseline = newTotal - entry.playtime_min - sessionMinutes;
      if (baseline > 0) {
        // Totals not covered by explicit sessions are history: date them from whatever the
        // file tells us (first played / date added / last played / play count).
        st.addHistory.run(baseline, entry.id);
        const firstPlayed = toTime(row.first_played || row.first_played_at || row.started);
        const dateAdded = toTime(row.date_added || row.added || row.purchased || row.acquired || row.date_acquired);
        const playCount = Number(row.play_count || row.launches || row.sessions_count) || undefined;
        mergeEvidence(db, entry.id, {
          tracking_start: Number.isFinite(earliestSession) ? earliestSession : now,
          last_played_at: lastPlayed ? Math.min(lastPlayed, Number.isFinite(earliestSession) ? earliestSession : lastPlayed) : undefined,
          first_played_at: firstPlayed ?? undefined,
          date_added: dateAdded ?? undefined,
          play_count: playCount,
        });
        toInfer.add(entry.id);
        res.baseline_minutes += baseline;
      }
      st.updEntry.run(newTotal, lastPlayed, entry.id);
      if (row.excluded === true || row.excluded === 'true' || row.excluded === '1') { st.exclude.run(entry.id); res.excluded = (res.excluded || 0) + 1; }
    }
    res.estimated_minutes = 0;
    res.undated_minutes = 0;
    flushRollups(db);
    for (const r of reinferMany(db, toInfer, { settings })) {
      if (r) { res.estimated_minutes += r.chunks.reduce((a, c) => a + c.minutes, 0); res.undated_minutes += r.undated; }
    }
    flushRollups(db);
    return res;
  });
}

const CSV_COLS = ['title', 'platform', 'account', 'playtime_minutes', 'playtime_hours', 'last_played', 'status', 'rating', 'favorite', 'excluded', 'sessions', 'notes'];
const csvEsc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r\t;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const iso = (t) => (t ? new Date(t).toISOString() : null);

/**
 * Stream the whole library as JSON or CSV, one entry at a time, so exports of huge
 * histories never have to be built in memory. Yields string chunks.
 */
export function* exportChunks(db, format = 'json') {
  const rows = db.prepare(`SELECT e.id, e.platform, e.playtime_min, e.last_played_at, e.excluded, a.name account_name,
      g.title, g.status, g.rating, g.notes, g.favorite
    FROM entries e JOIN games g ON g.id = e.game_id LEFT JOIN accounts a ON a.id = e.account_id
    ORDER BY g.title COLLATE NOCASE, e.id`);
  const sessions = db.prepare("SELECT started_at, ended_at, window_start, window_end, minutes, source, note FROM sessions WHERE entry_id = ? AND kind = 'play' ORDER BY sort_time");
  const count = db.prepare("SELECT COUNT(*) n FROM sessions WHERE entry_id = ? AND kind = 'play'");
  if (format === 'csv') {
    yield CSV_COLS.join(',') + '\n';
    let buf = '';
    for (const r of rows.iterate()) {
      const rec = { title: r.title, platform: r.platform, account: r.account_name, playtime_minutes: r.playtime_min, playtime_hours: (r.playtime_min / 60).toFixed(1),
        last_played: iso(r.last_played_at), status: r.status, rating: r.rating, favorite: !!r.favorite, excluded: !!r.excluded, sessions: count.get(r.id).n, notes: r.notes };
      buf += CSV_COLS.map((c) => csvEsc(rec[c])).join(',') + '\n';
      if (buf.length > 64_000) { yield buf; buf = ''; }
    }
    if (buf) yield buf;
    return;
  }
  yield `{"format":"playtracker-export","version":1,"exported_at":"${new Date().toISOString()}","games":[`;
  let first = true;
  let buf = '';
  for (const r of rows.iterate()) {
    const rec = {
      title: r.title, platform: r.platform, account: r.account_name || null, playtime_minutes: r.playtime_min, last_played: iso(r.last_played_at),
      status: r.status, rating: r.rating, notes: r.notes, favorite: !!r.favorite, excluded: !!r.excluded,
      sessions: sessions.all(r.id).map((s) => ({
        started_at: iso(s.started_at || s.window_start || s.window_end), ended_at: iso(s.ended_at), window_end: iso(s.window_end),
        minutes: s.minutes, source: s.source, note: s.note,
      })),
    };
    buf += (first ? '\n' : ',\n') + JSON.stringify(rec);
    first = false;
    if (buf.length > 64_000) { yield buf; buf = ''; }
  }
  yield `${buf}\n]}\n`;
}
