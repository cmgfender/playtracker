import { tx } from '../db.js';
import { findOrCreateGame } from './library.js';
import { normalizeTitle } from './titles.js';
import { toTime } from '../util.js';

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
  return tx(db, () => {
    for (const row of rows) {
      const title = String(row.title || row.name || row.game || '').trim();
      if (!title) { res.skipped++; continue; }
      const platform = String(row.platform || row.source || 'import').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32) || 'import';
      const gameId = findOrCreateGame(db, { title, coverUrl: row.cover_url || null }, { autoMerge: settings?.auto_merge_titles !== false, now });
      res.games++;
      const status = String(row.status || '').toLowerCase();
      db.prepare(`UPDATE games SET status = CASE WHEN ? != '' THEN ? ELSE status END, rating = COALESCE(?, rating),
        notes = COALESCE(NULLIF(?, ''), notes), favorite = MAX(favorite, ?), updated_at = ? WHERE id = ?`)
        .run(STATUSES.has(status) ? status : '', STATUSES.has(status) ? status : '', row.rating ? Math.min(10, Math.max(0, Number(row.rating) || 0)) : null,
          row.notes || '', row.favorite === true || row.favorite === 'true' || row.favorite === '1' ? 1 : 0, now, gameId);

      const extId = `import:${normalizeTitle(title)}`;
      let entry = db.prepare('SELECT * FROM entries WHERE account_id IS NULL AND platform = ? AND ext_id = ?').get(platform, extId);
      const lastPlayed = toTime(row.last_played || row.last_played_at);
      if (!entry) {
        const r = db.prepare('INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, last_played_at, first_seen_at, last_synced_at) VALUES (NULL, ?, ?, ?, ?, 0, ?, ?, ?)')
          .run(gameId, platform, extId, title, lastPlayed, now, now);
        entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(r.lastInsertRowid);
        res.entries_created++;
      } else res.entries_updated++;

      let sessionMinutes = 0;
      const sessions = Array.isArray(row.sessions) ? row.sessions : [];
      for (const s of sessions) {
        const minutes = Math.round(Number(s.minutes) || 0);
        const start = toTime(s.started_at || s.date || s.start);
        if (minutes <= 0 || !start) continue;
        const end = toTime(s.ended_at) || start + minutes * MIN;
        const dup = db.prepare("SELECT id FROM sessions WHERE entry_id = ? AND kind = 'play' AND started_at = ? AND minutes = ?").get(entry.id, start, minutes);
        if (dup) continue;
        db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, note, created_at) VALUES (?, 'import', 'play', ?, ?, ?, ?, ?, ?, ?)")
          .run(entry.id, minutes, start, end, start, end, s.note || null, now);
        sessionMinutes += minutes;
        res.sessions++;
        res.tracked_minutes += minutes;
      }
      const reported = minutesOf(row);
      const newTotal = Math.max(reported, entry.playtime_min + sessionMinutes);
      const baseline = newTotal - entry.playtime_min - sessionMinutes;
      if (baseline > 0) {
        db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_end, note, created_at) VALUES (?, 'import', 'baseline', ?, ?, 'Imported history', ?)")
          .run(entry.id, baseline, now, now);
        res.baseline_minutes += baseline;
      }
      db.prepare('UPDATE entries SET playtime_min = ?, last_played_at = COALESCE(?, last_played_at) WHERE id = ?').run(newTotal, lastPlayed, entry.id);
    }
    return res;
  });
}

export function exportAll(db) {
  const games = db.prepare('SELECT * FROM games ORDER BY title').all();
  const entries = db.prepare('SELECT e.*, a.name account_name FROM entries e LEFT JOIN accounts a ON a.id = e.account_id').all();
  const sessions = db.prepare("SELECT * FROM sessions WHERE kind = 'play' ORDER BY COALESCE(started_at, window_start)").all();
  const sByEntry = new Map();
  for (const s of sessions) {
    if (!sByEntry.has(s.entry_id)) sByEntry.set(s.entry_id, []);
    sByEntry.get(s.entry_id).push(s);
  }
  const eByGame = new Map();
  for (const e of entries) {
    if (!eByGame.has(e.game_id)) eByGame.set(e.game_id, []);
    eByGame.get(e.game_id).push(e);
  }
  const rows = [];
  for (const g of games) {
    for (const e of eByGame.get(g.id) || []) {
      rows.push({
        title: g.title,
        platform: e.platform,
        account: e.account_name || null,
        playtime_minutes: e.playtime_min,
        last_played: e.last_played_at ? new Date(e.last_played_at).toISOString() : null,
        status: g.status, rating: g.rating, notes: g.notes, favorite: !!g.favorite, excluded: !!e.excluded,
        sessions: (sByEntry.get(e.id) || []).map((s) => ({
          started_at: new Date(s.started_at || s.window_start || s.window_end).toISOString(),
          ended_at: s.ended_at ? new Date(s.ended_at).toISOString() : null,
          window_end: s.window_end ? new Date(s.window_end).toISOString() : null,
          minutes: s.minutes, source: s.source, note: s.note,
        })),
      });
    }
  }
  return { format: 'playtracker-export', version: 1, exported_at: new Date().toISOString(), games: rows };
}

export function toCsv(rows) {
  const cols = ['title', 'platform', 'account', 'playtime_minutes', 'playtime_hours', 'last_played', 'status', 'rating', 'favorite', 'excluded', 'sessions', 'notes'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map((c) => esc(c === 'playtime_hours' ? (r.playtime_minutes / 60).toFixed(1) : c === 'sessions' ? r.sessions.length : r[c])).join(','));
  }
  return lines.join('\n');
}
