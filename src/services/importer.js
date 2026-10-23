import { tx } from '../db.js';
import { findOrCreateGame } from './library.js';
import { normalizeTitle, importedAccount } from './titles.js';
import { toTime } from '../util.js';
import { flushRollups } from './rollup.js';
import { mergeEvidence, reinferMany } from './inference.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const STATUSES = new Set(['unset', 'backlog', 'playing', 'paused', 'completed', 'beaten', 'dropped', 'wishlist']);

/**
 * A file's one delimiter: whichever of comma, semicolon or tab its header line uses most. That is
 * the first line with any text, as in parseCsv: blank lines before it (or bare delimiters) are skipped.
 */
function delimiterOf(src) {
  let n = { ',': 0, ';': 0, '\t': 0 };
  let q = false; let text = false;
  for (const c of src) {
    if (c === '"') q = !q;
    else if (!q && (c === '\n' || c === '\r')) {
      if (text) break;
      n = { ',': 0, ';': 0, '\t': 0 };
    } else if (!q && c in n) n[c]++;
    else if (c.trim()) text = true;
  }
  return n[';'] > n[','] && n[';'] >= n['\t'] ? ';' : n['\t'] > n[','] ? '\t' : ',';
}

export function parseCsv(text, { commaOnly = false } = {}) {
  const rows = [];
  let row = []; let cell = ''; let q = false;
  const src = String(text).replace(/^﻿/, '');
  const sep = commaOnly ? ',' : delimiterOf(src);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
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
    const hm = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(String(h)); // h:mm, or a spreadsheet's [h]:mm:ss
    if (hm) return Number(hm[1]) * 60 + Number(hm[2]) + Math.round(Number(hm[3] || 0) / 60);
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
  const res = {
    games: 0, entries_created: 0, entries_updated: 0, merged_synced: 0, sessions: 0, sessions_restored: 0,
    baseline_minutes: 0, tracked_minutes: 0, skipped: 0, details_filled: 0,
    // synced games the file adds something to; rows that are already here in full
    synced_updated: 0, unchanged: 0,
  };
  const st = {
    // imports assist: they fill what is empty and never overwrite what is already set
    game: db.prepare('SELECT status, rating, notes, favorite FROM games WHERE id = ?'),
    setGame: db.prepare('UPDATE games SET status = ?, rating = ?, notes = ?, favorite = ?, updated_at = ? WHERE id = ?'),
    findEntry: db.prepare('SELECT * FROM entries WHERE account_id IS NULL AND platform = ? AND ext_id = ?'),
    insEntry: db.prepare('INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, last_played_at, first_seen_at, last_synced_at) VALUES (NULL, ?, ?, ?, ?, 0, ?, ?, ?)'),
    getEntry: db.prepare('SELECT * FROM entries WHERE id = ?'),
    // same key the export writes (start, else the window), so re-imports are recognised
    existing: db.prepare("SELECT COALESCE(started_at, window_start, window_end) started_at, minutes FROM sessions WHERE entry_id = ? AND kind = 'play'"),
    overlaps: db.prepare("SELECT 1 FROM sessions WHERE entry_id = ? AND kind = 'play' AND COALESCE(started_at, window_start) < ? AND COALESCE(ended_at, window_end) > ? LIMIT 1"),
    insPlay: db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, note, created_at) VALUES (?, 'import', 'play', ?, ?, ?, ?, ?, ?, ?)"),
    addHistory: db.prepare('UPDATE entries SET baseline_min = baseline_min + ? WHERE id = ?'),
    updEntry: db.prepare('UPDATE entries SET playtime_min = ?, last_played_at = MAX(COALESCE(last_played_at, 0), COALESCE(?, 0)) WHERE id = ?'),
    exclude: db.prepare('UPDATE entries SET excluded = 1 WHERE id = ?'),
    setHist: db.prepare('UPDATE entries SET hist = ? WHERE id = ?'),
    hasEntries: db.prepare('SELECT 1 FROM entries WHERE game_id = ? LIMIT 1'),
    hide: db.prepare('UPDATE games SET hidden = 1 WHERE id = ?'),
    lock: db.prepare('UPDATE games SET merge_locked = 1 WHERE id = ?'),
  };
  const toInfer = new Set();
  const lock = new Set(); // games to lock against auto-merging once every row has joined them
  // Existing entries, so a file that overlaps what is already here joins it instead of adding a
  // second copy: by platform + account name + title (our own exports; an imported copy also by
  // the account its ext_id names), and synced entries by platform + title / title alone.
  let index = null; let synced = null; let byHand = null;
  const build = () => {
    index = new Map(); synced = new Map(); byHand = new Map();
    for (const e of db.prepare('SELECT e.id, e.platform, e.title, e.account_id, e.ext_id, e.playtime_min, e.excluded, lower(a.name) acc FROM entries e LEFT JOIN accounts a ON a.id = e.account_id').iterate()) {
      const norm = normalizeTitle(e.title);
      if (e.account_id == null && e.platform === 'manual' && !e.excluded) {
        if (!byHand.has(norm)) byHand.set(norm, []);
        byHand.get(norm).push(e);
      }
      const keys = [`${e.platform}|${e.acc || ''}|${norm}`];
      if (e.account_id == null && e.ext_id?.startsWith('import:')) keys.push(`${e.platform}|${importedAccount(e.ext_id, e.title)}|${norm}`);
      for (const k of keys) if (!index.has(k)) index.set(k, e);
      if (e.account_id != null) for (const sk of [`${e.platform}|${norm}`, `*|${norm}`]) {
        if (!synced.has(sk)) synced.set(sk, []);
        synced.get(sk).push(e);
      }
    }
  };
  const indexed = () => { if (!index) build(); return index; };
  const syncedFor = (platform, acc, norm, minutes) => {
    if (!synced) build();
    const same = synced.get(`${platform}|${norm}`) || [];
    if (same.length) return same.find((e) => acc && e.acc === acc) || same[0];
    // no platform in the file: the one synced copy of this title, when the file's hours fit it
    // (more hours than the platform reports means a different copy, e.g. another console)
    if (GENERIC.has(platform)) {
      const any = synced.get(`*|${norm}`) || [];
      if (any.length === 1 && (!minutes || minutes <= any[0].playtime_min * 1.05 + 60)) return any[0];
    }
    return null;
  };
  // A row that names no platform at all, nor an account, for a game you only log by hand, joins it
  // when its hours fit what you logged (an older count of the same play) - the same rule as for
  // synced games. More hours stay a copy of their own: a spreadsheet can't say whether its hours
  // include yours, so nothing you logged is ever absorbed. A file that lists hand-logged rows
  // itself (an export) keeps its entries apart, as it recorded them.
  const handLoggedFor = (platform, acc, norm, minutes, fileHasHand) => {
    if (!UNNAMED.has(platform) || acc || fileHasHand) return null;
    if (!byHand) build();
    const m = byHand.get(norm) || [];
    return m.length === 1 && (!minutes || minutes <= m[0].playtime_min * 1.05 + 60) ? m[0] : null;
  };
  const str = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? '' : String(v));
  const flag = (v) => v === true || v === 'true' || v === '1' || v === 1;
  // a session's end as given when it is after its start, else start + its minutes
  const endOf = (s, start, minutes) => { const end = toTime(s.ended_at); return end > start ? end : start + minutes * MIN; };

  /** Status / rating / notes / favourite: only where the library has nothing yet. True if any was filled. */
  const fillGame = (gameId, row) => {
    const g = st.game.get(gameId);
    if (!g) return false;
    const status = str(row.status).toLowerCase();
    const rating = row.rating !== undefined && row.rating !== '' && Number.isFinite(Number(row.rating)) && Number(row.rating) > 0 ? Math.min(10, Math.max(0, Number(row.rating))) : null;
    const notes = str(row.notes).trim();
    const next = {
      status: g.status === 'unset' && STATUSES.has(status) && status !== 'unset' ? status : g.status,
      rating: g.rating == null && rating != null ? rating : g.rating,
      // notes are added to yours (once), never replace them
      notes: !notes ? g.notes : !g.notes ? notes : String(g.notes).includes(notes) ? g.notes : `${g.notes}\n\n${notes}`,
      favorite: Math.max(g.favorite || 0, flag(row.favorite) ? 1 : 0),
    };
    if (next.status !== g.status || next.rating !== g.rating || next.notes !== g.notes || next.favorite !== (g.favorite || 0)) {
      st.setGame.run(next.status, next.rating, next.notes, next.favorite, now, gameId);
      res.details_filled++;
      return true;
    }
    return false;
  };

  /** Dates from the file, as evidence: fill gaps, keep the earliest first-played. */
  const fillEvidence = (entryId, ev) => {
    const h = JSON.parse(st.getEntry.get(entryId)?.hist || '{}');
    const patch = {};
    if (ev.first_played_at && (!h.first_played_at || ev.first_played_at < h.first_played_at)) patch.first_played_at = ev.first_played_at;
    if (ev.date_added && !h.date_added) patch.date_added = ev.date_added;
    if (ev.last_played_at && !h.last_played_at) patch.last_played_at = ev.last_played_at;
    if (ev.play_count && !(h.play_count >= ev.play_count)) patch.play_count = ev.play_count;
    if (ev.tracking_start) patch.tracking_start = ev.tracking_start; // mergeEvidence keeps an existing one
    if (Object.keys(patch).length) mergeEvidence(db, entryId, patch);
    return Object.keys(patch).length > 0;
  };

  // dates as evidence never lie in the future: a date-only "today" is noon, which can still be ahead
  const past = (v) => { const t = toTime(v); return t && t <= now + DAY ? Math.min(t, now) : undefined; };
  const evidenceOf = (row) => ({
    first_played_at: past(row.first_played || row.first_played_at || row.started),
    date_added: past(row.date_added || row.added || row.purchased || row.acquired || row.date_acquired),
    play_count: Number(row.play_count || row.launches || row.sessions_count) || undefined,
  });

  /**
   * Your history choice from the file (Don't chart / a first-played window / a confirmed
   * estimate), for an entry that has history and no choice of its own here. True if applied.
   */
  const fillChoice = (entryId, row) => {
    const x = row.history && typeof row.history === 'object' && !Array.isArray(row.history) ? row.history : {};
    const mode = str(x.mode ?? row.history_mode).toLowerCase();
    const start = toTime(x.start ?? row.history_start) ?? undefined;
    const end = toTime(x.end ?? row.history_end) ?? undefined;
    if (mode !== 'undated' && !start && !end) return false;
    const e = st.getEntry.get(entryId);
    const h = JSON.parse(e?.hist || '{}');
    if (!e?.baseline_min || h.mode === 'undated' || h.manual) return false;
    if (mode === 'undated') h.mode = 'undated';
    else if (start && end && end < start) return false;
    else {
      // a confirmed estimate's exact days come back while they still add up to the history
      const chunks = Array.isArray(x.chunks) ? x.chunks.map((c) => (Array.isArray(c) ? [toTime(c[0]), toTime(c[1]), Math.round(Number(c[2])), c[3] === 'recent' ? 'recent' : 'history'] : null)) : [];
      const exact = x.confirmed === true && chunks.length && chunks.every((c) => c && c[0] && c[1] >= c[0] && c[2] > 0);
      h.manual = { start, end, ...(exact ? { confirmed: true, chunks, undated: Math.max(0, Math.round(Number(x.undated) || 0)) } : {}) };
    }
    st.setHist.run(JSON.stringify(h), entryId);
    toInfer.add(entryId);
    res.history_choices = (res.history_choices || 0) + 1;
    return true;
  };

  const fileHand = new Set();
  for (const row of rows) {
    if (row && typeof row === 'object' && String(row.platform || row.source || '').toLowerCase() === 'manual') fileHand.add(normalizeTitle(str(row.title || row.name || row.game).trim()));
  }

  return tx(db, () => {
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) { res.skipped++; continue; }
      const title = str(row.title || row.name || row.game).trim();
      if (!title) { res.skipped++; continue; }
      const platform = String(row.platform || row.source || 'import').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32) || 'import';
      const norm = normalizeTitle(title);
      const acc = str(row.account).trim().toLowerCase();
      const reported = minutesOf(row);
      // never in the future (a date-only "today" is noon; a later date is no evidence)
      const lp = toTime(row.last_played || row.last_played_at);
      const lastPlayed = lp && lp <= now + DAY ? Math.min(lp, now) : null;
      const sessions = Array.isArray(row.sessions) ? row.sessions : [];
      res.games++;

      // 1) one of your synced accounts already tracks this game: the platform's total stands; the
      //    file only adds evidence (dates, details) and exact past sessions in place of estimates
      const extId = acc ? `import:${acc}:${norm}` : `import:${norm}`;
      let entry = st.findEntry.get(platform, extId);
      const same = entry ? null : indexed().get(`${platform}|${acc}|${norm}`);
      const syncedEntry = !entry && !(same && same.account_id == null) ? (same?.account_id != null ? same : syncedFor(platform, acc, norm, reported)) : null;
      if (syncedEntry) {
        const se = st.getEntry.get(syncedEntry.id);
        const details = fillGame(se.game_id, row);
        const filled = fillEvidence(se.id, { ...evidenceOf(row), last_played_at: undefined });
        // exact sessions from before tracking began replace that much estimated history
        const h = JSON.parse(se.hist || '{}');
        const trackedFrom = h.tracking_start || se.first_seen_at;
        let room = se.baseline_min;
        let restored = 0;
        const have = new Set(st.existing.all(se.id).map((x) => `${x.started_at}:${x.minutes}`));
        for (const s of sessions) {
          const minutes = Math.round(Number(s.minutes) || 0);
          const start = toTime(s.started_at || s.date || s.start);
          if (minutes <= 0 || !start || minutes > room) continue;
          const end = endOf(s, start, minutes);
          if (end > trackedFrom || have.has(`${start}:${minutes}`) || st.overlaps.get(se.id, end, start)) continue;
          st.insPlay.run(se.id, minutes, start, end, start, end, str(s.note) || null, now);
          have.add(`${start}:${minutes}`);
          room -= minutes; restored += minutes; res.sessions_restored++;
        }
        if (restored) { st.addHistory.run(-restored, se.id); res.tracked_minutes += restored; }
        if (restored || filled) toInfer.add(se.id);
        const chose = fillChoice(se.id, row);
        res.merged_synced++;
        if (restored || filled || details || chose) res.synced_updated++; else res.unchanged++;
        continue;
      }

      // 2) a manual / imported entry for this game is already here: join it
      const hand = !entry && !same ? handLoggedFor(platform, acc, norm, reported, fileHand.has(norm)) : null;
      if (hand) entry = st.getEntry.get(hand.id);
      let gameId = entry?.game_id ?? same?.game_id ?? (same ? st.getEntry.get(same.id).game_id : null);
      if (gameId == null) {
        gameId = findOrCreateGame(db, { title, coverUrl: str(row.cover_url) || null }, { autoMerge: settings?.auto_merge_titles !== false, now });
        if (!st.hasEntries.get(gameId)) {
          // a game new to the library keeps the choices your export recorded
          if (flag(row.hidden)) st.hide.run(gameId);
          if (flag(row.merge_locked)) lock.add(gameId);
        }
      }
      if (!entry && same) entry = st.getEntry.get(same.id);
      const details = fillGame(gameId, row);
      const existed = !!entry;
      if (!entry) {
        const r = st.insEntry.run(gameId, platform, extId, title, lastPlayed, now, now);
        entry = st.getEntry.get(r.lastInsertRowid);
        index.set(`${platform}|${acc}|${norm}`, { id: entry.id, game_id: gameId, account_id: null });
        res.entries_created++;
        // your exclusions only apply to entries the file creates; existing ones keep yours
        if (flag(row.excluded)) { st.exclude.run(entry.id); res.excluded = (res.excluded || 0) + 1; }
      }

      let sessionMinutes = 0;
      let earliestSession = Infinity;
      // re-imports are idempotent: skip sessions already present (same start + length)
      const have = sessions.length && existed ? new Set(st.existing.all(entry.id).map((x) => `${x.started_at}:${x.minutes}`)) : new Set();
      for (const s of sessions) {
        const minutes = Math.round(Number(s.minutes) || 0);
        const start = toTime(s.started_at || s.date || s.start);
        if (minutes <= 0 || !start) continue;
        const end = endOf(s, start, minutes);
        // tracked play never lies in the future: its minutes stay in the file's total, as history
        if (end > now + 5 * MIN) { res.skipped_sessions = (res.skipped_sessions || 0) + 1; continue; }
        const k = `${start}:${minutes}`;
        // joined to hand-logged play: a session overlapping one you logged is that one
        if (have.has(k) || (hand && st.overlaps.get(entry.id, end, start))) continue;
        have.add(k);
        st.insPlay.run(entry.id, minutes, start, end, start, end, str(s.note) || null, now);
        sessionMinutes += minutes;
        earliestSession = Math.min(earliestSession, start);
        res.sessions++;
        res.tracked_minutes += minutes;
      }
      // Totals never go down: the larger of the file's total and what is already here. Sessions
      // the file's own total covers (an updated file listing one more session) take their
      // minutes from the history; without such a total they add to what is here.
      const tracked = entry.playtime_min - entry.baseline_min + sessionMinutes;
      const newTotal = reported >= tracked ? Math.max(reported, entry.playtime_min) : entry.playtime_min + sessionMinutes;
      const baseline = newTotal - tracked - entry.baseline_min; // change of the history
      let changed = sessionMinutes > 0 || details || newTotal !== entry.playtime_min || (lastPlayed != null && lastPlayed > (entry.last_played_at || 0));
      if (baseline > 0) {
        // Totals not covered by explicit sessions are history: date them from whatever the
        // file tells us (first played / date added / last played / play count).
        st.addHistory.run(baseline, entry.id);
        fillEvidence(entry.id, {
          ...evidenceOf(row),
          tracking_start: Number.isFinite(earliestSession) ? earliestSession : now,
          last_played_at: lastPlayed ? Math.min(lastPlayed, Number.isFinite(earliestSession) ? earliestSession : lastPlayed) : undefined,
        });
        toInfer.add(entry.id);
        res.baseline_minutes += baseline;
      } else {
        if (baseline < 0) { st.addHistory.run(baseline, entry.id); toInfer.add(entry.id); }
        if (existed && fillEvidence(entry.id, evidenceOf(row))) { changed = true; if (entry.baseline_min > 0) toInfer.add(entry.id); }
      }
      st.updEntry.run(newTotal, lastPlayed, entry.id);
      if (fillChoice(entry.id, row)) changed = true;
      if (existed) { if (changed) res.entries_updated++; else res.unchanged++; }
    }
    for (const id of lock) st.lock.run(id);
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

// platforms that say nothing about where a game was played; UNNAMED ones not even the device
const GENERIC = new Set(['import', 'imported', 'pc', 'other', 'unknown', '']);
const UNNAMED = new Set(['import', 'imported', 'unknown', '']);

// columns added later go at the end, so whatever reads the export by position keeps working
const CSV_COLS = ['title', 'platform', 'account', 'playtime_minutes', 'playtime_hours', 'last_played', 'status', 'rating', 'favorite', 'excluded', 'sessions', 'notes', 'hidden', 'merge_locked', 'cover_url',
  'first_played', 'date_added', 'history_mode', 'history_start', 'history_end'];
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
  const rows = db.prepare(`SELECT e.id, e.platform, e.playtime_min, e.last_played_at, e.excluded, e.hist, a.name account_name,
      g.title, g.status, g.rating, g.notes, g.favorite, g.hidden, g.merge_locked, g.cover_url
    FROM entries e JOIN games g ON g.id = e.game_id LEFT JOIN accounts a ON a.id = e.account_id
    ORDER BY g.title COLLATE NOCASE, e.id`);
  const sessions = db.prepare("SELECT started_at, ended_at, window_start, window_end, minutes, source, note FROM sessions WHERE entry_id = ? AND kind = 'play' ORDER BY sort_time");
  const count = db.prepare("SELECT COUNT(*) n FROM sessions WHERE entry_id = ? AND kind = 'play'");
  // the dates history is dated from, and your choice for it (Don't chart / window / confirmed)
  const historyOf = (r) => {
    const h = JSON.parse(r.hist || '{}');
    const m = h.manual;
    const choice = h.mode === 'undated' ? { mode: 'undated' }
      : m && (m.start || m.end) ? { mode: 'auto', start: iso(m.start), end: iso(m.end), confirmed: !!m.confirmed, ...(m.confirmed && m.chunks?.length ? { chunks: m.chunks.map(([a, b, n, why]) => [iso(a), iso(b), n, why]), undated: m.undated || 0 } : {}) }
        : null;
    return { first_played: iso(h.first_played_at), date_added: iso(h.date_added), history: choice };
  };
  if (format === 'csv') {
    yield CSV_COLS.join(',') + '\n';
    let buf = '';
    for (const r of rows.iterate()) {
      const rec = { title: r.title, platform: r.platform, account: r.account_name, playtime_minutes: r.playtime_min, playtime_hours: (r.playtime_min / 60).toFixed(1),
        last_played: iso(r.last_played_at), status: r.status, rating: r.rating, favorite: !!r.favorite, hidden: !!r.hidden, merge_locked: !!r.merge_locked,
        excluded: !!r.excluded, sessions: count.get(r.id).n, cover_url: r.cover_url, notes: r.notes };
      const hx = historyOf(r);
      Object.assign(rec, { first_played: hx.first_played, date_added: hx.date_added, history_mode: hx.history?.mode, history_start: hx.history?.start, history_end: hx.history?.end });
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
      status: r.status, rating: r.rating, notes: r.notes, favorite: !!r.favorite, hidden: !!r.hidden, merge_locked: !!r.merge_locked,
      excluded: !!r.excluded, cover_url: r.cover_url, ...historyOf(r),
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
