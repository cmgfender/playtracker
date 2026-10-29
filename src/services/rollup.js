import { spreadByDay, sessionInterval, dayKey } from './stats.js';

// Sessions are written in many places (sync, import, API, edits). Triggers put every
// touched session id into rollup_queue; flushRollups() turns them into per-day and
// per-hour rows so stats never have to scan or re-spread the raw session table.

const MIN = 60_000;
// play_days.basis: what the minutes rest on (see migration 10)
export const BASIS = { tracked: 0, imported: 1, anchored: 2, confirmed: 3, estimated: 4 };
const basisOf = (s) => (s.kind === 'estimate' ? (s.basis === 'confirmed' ? 3 : s.basis === 'anchored' ? 2 : 4) : s.source === 'import' ? 1 : 0);
const HOUR = 3_600_000;

function spreadByHour(s) {
  if (!(s.started_at && s.ended_at && s.ended_at > s.started_at)) return [];
  const [a, b] = sessionInterval(s);
  const len = b - a;
  const out = new Map();
  for (let t = a; t < b;) {
    const d = new Date(t);
    const next = Math.min(b, new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime());
    const key = `${dayKey(t)}|${d.getHours()}`;
    out.set(key, (out.get(key) || 0) + (s.minutes * (next - t)) / len);
    t = next;
  }
  return [...out.entries()].map(([k, m]) => { const [day, h] = k.split('|'); return [day, Number(h), m]; });
}

export function flushRollups(db, { batch = 5000 } = {}) {
  const pending = db.prepare('SELECT 1 FROM rollup_queue LIMIT 1').get() || db.prepare('SELECT 1 FROM rollup_entry_queue LIMIT 1').get();
  if (!pending) return 0;
  const take = db.prepare('SELECT session_id FROM rollup_queue LIMIT ?');
  const get = db.prepare('SELECT s.id, s.entry_id, s.kind, s.source, s.basis, s.minutes, s.window_start, s.window_end, s.started_at, s.ended_at, s.created_at, e.game_id, e.platform, e.excluded FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE s.id = ?');
  const delD = db.prepare('DELETE FROM play_days WHERE session_id = ?');
  const delH = db.prepare('DELETE FROM play_hours WHERE session_id = ?');
  const insD = db.prepare('INSERT INTO play_days(session_id, entry_id, game_id, platform, excluded, estimated, basis, day, minutes, ends) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insH = db.prepare('INSERT INTO play_hours(session_id, entry_id, game_id, platform, excluded, estimated, day, hour, minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const deq = db.prepare('DELETE FROM rollup_queue WHERE session_id = ?');
  const qEntry = db.prepare('INSERT OR IGNORE INTO rollup_entry_queue(entry_id) VALUES (?)');
  const nested = db.isTransaction ?? db._inTx;
  let total = 0;
  for (;;) {
    const ids = take.all(batch).map((r) => r.session_id);
    if (!ids.length) break;
    if (!nested) db.exec('BEGIN IMMEDIATE');
    try {
      for (const id of ids) {
        delD.run(id); delH.run(id);
        const s = get.get(id);
        if (s) {
          qEntry.run(s.entry_id);
          if ((s.kind === 'play' || s.kind === 'estimate') && s.minutes > 0) {
            const est = s.kind === 'estimate' ? 1 : 0;
            const days = spreadByDay(s);
            const b = basisOf(s);
            days.forEach(([day, m], i) => insD.run(id, s.entry_id, s.game_id, s.platform, s.excluded, est, b, day, m, (!est && i === days.length - 1) ? 1 : 0));
            for (const [day, h, m] of spreadByHour(s)) insH.run(id, s.entry_id, s.game_id, s.platform, s.excluded, est, day, h, m);
          }
        }
        deq.run(id);
      }
      if (!nested) db.exec('COMMIT');
    } catch (err) {
      if (!nested) db.exec('ROLLBACK');
      throw err;
    }
    total += ids.length;
  }
  // last_session_at per entry (indexed max)
  db.prepare(`UPDATE entries SET last_session_at = (SELECT MAX(sort_time) FROM sessions s WHERE s.entry_id = entries.id AND s.kind = 'play')
    WHERE id IN (SELECT entry_id FROM rollup_entry_queue)`).run();
  db.prepare('DELETE FROM rollup_entry_queue').run();
  return total;
}

/**
 * Rebuild everything (first upgrade, timezone change). Bulk path: drop the rollup
 * indexes, stream every play session once, then recreate the indexes - far faster
 * than maintaining wide covering indexes row by row.
 */
export function rebuildRollups(db) {
  const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('play_days', 'play_hours') AND sql IS NOT NULL").all();
  const insD = db.prepare('INSERT INTO play_days(session_id, entry_id, game_id, platform, excluded, estimated, basis, day, minutes, ends) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insH = db.prepare('INSERT INTO play_hours(session_id, entry_id, game_id, platform, excluded, estimated, day, hour, minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const all = db.prepare(`SELECT s.id, s.kind, s.source, s.basis, s.entry_id, s.minutes, s.window_start, s.window_end, s.started_at, s.ended_at, s.created_at, e.game_id, e.platform, e.excluded
    FROM sessions s JOIN entries e ON e.id = s.entry_id WHERE s.kind IN ('play', 'estimate') AND s.minutes > 0`);
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const i of idx) db.exec(`DROP INDEX ${i.name}`);
    db.exec('DELETE FROM play_days; DELETE FROM play_hours; DELETE FROM rollup_queue; DELETE FROM rollup_entry_queue;');
    for (const s of all.iterate()) {
      const est = s.kind === 'estimate' ? 1 : 0;
      const days = spreadByDay(s);
      const b = basisOf(s);
      days.forEach(([day, m], k) => insD.run(s.id, s.entry_id, s.game_id, s.platform, s.excluded, est, b, day, m, (!est && k === days.length - 1) ? 1 : 0));
      for (const [day, h, m] of spreadByHour(s)) insH.run(s.id, s.entry_id, s.game_id, s.platform, s.excluded, est, day, h, m);
      n++;
    }
    for (const i of idx) db.exec(i.sql);
    db.exec("UPDATE entries SET last_session_at = (SELECT MAX(sort_time) FROM sessions s WHERE s.entry_id = entries.id AND s.kind = 'play')");
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return n;
}

/** Day buckets depend on the server timezone; rebuild when it changes. */
export function ensureRollupTimezone(db, settings, log = console) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (settings.get('rollup_tz') === tz) return flushRollups(db);
  const had = settings.get('rollup_tz');
  const pending = db.prepare('SELECT COUNT(*) n FROM sessions').get().n;
  if (pending > 20_000) log.info?.(`[rollup] indexing ${pending} sessions for fast stats (one-time)…`);
  const n = rebuildRollups(db);
  settings.set({ rollup_tz: tz });
  if (had) log.info?.(`[rollup] timezone changed ${had} -> ${tz}, rebuilt ${n} sessions`);
  return n;
}

export { MIN, HOUR };
