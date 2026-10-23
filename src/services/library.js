import { normalizeTitle } from './titles.js';

// Helpers for games / entries shared by sync, import and the API.

export function findOrCreateGame(db, { title, coverUrl }, { autoMerge = true, now = Date.now() } = {}) {
  const norm = normalizeTitle(title);
  if (autoMerge) {
    const g = db.prepare('SELECT * FROM games WHERE norm_title = ? AND merge_locked = 0 ORDER BY id LIMIT 1').get(norm);
    if (g) {
      if (!g.cover_url && coverUrl) db.prepare('UPDATE games SET cover_url = ? WHERE id = ?').run(coverUrl, g.id);
      return g.id;
    }
  }
  const r = db.prepare('INSERT INTO games(title, norm_title, cover_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(cleanTitle(title), norm, coverUrl || null, now, now);
  return Number(r.lastInsertRowid);
}

export function cleanTitle(title) {
  return String(title || 'Untitled').replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();
}

/** The local "manual" entry of a game, used for hand-logged sessions. */
export function manualEntry(db, gameId, now = Date.now()) {
  const extId = `game:${gameId}`;
  // a counted one first: new play must not land in an entry excluded as a double count
  let e = db.prepare("SELECT * FROM entries WHERE account_id IS NULL AND platform = 'manual' AND game_id = ? ORDER BY excluded, id LIMIT 1").get(gameId);
  if (e) return e;
  const g = db.prepare('SELECT title FROM games WHERE id = ?').get(gameId);
  const r = db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, first_seen_at) VALUES (NULL, ?, 'manual', ?, ?, ?)")
    .run(gameId, `${extId}:${now}`, g?.title || 'Manual', now);
  return db.prepare('SELECT * FROM entries WHERE id = ?').get(r.lastInsertRowid);
}

/** Remove games that no longer have any entries. */
export function pruneEmptyGames(db) {
  db.prepare('DELETE FROM games WHERE id NOT IN (SELECT DISTINCT game_id FROM entries)').run();
}

/** Move all entries of `sourceIds` into `targetId`, consolidating manual entries. */
export function mergeGames(db, targetId, sourceIds) {
  const now = Date.now();
  const target = db.prepare('SELECT * FROM games WHERE id = ?').get(targetId);
  if (!target) throw Object.assign(new Error('Target game not found'), { status: 404 });
  for (const sid of sourceIds) {
    if (sid === targetId) continue;
    const src = db.prepare('SELECT * FROM games WHERE id = ?').get(sid);
    if (!src) continue;
    db.prepare('UPDATE entries SET game_id = ? WHERE game_id = ?').run(targetId, sid);
    // keep the richest metadata
    db.prepare(`UPDATE games SET
      cover_url = COALESCE(cover_url, ?), rating = COALESCE(rating, ?),
      notes = CASE WHEN COALESCE(notes,'') = '' THEN ? WHEN COALESCE(?, '') = '' THEN notes ELSE notes || char(10) || ? END,
      favorite = MAX(favorite, ?), status = CASE WHEN status = 'unset' THEN ? ELSE status END, updated_at = ?
      WHERE id = ?`).run(src.cover_url, src.rating, src.notes, src.notes, src.notes, src.favorite, src.status, now, targetId);
    db.prepare('DELETE FROM games WHERE id = ?').run(sid);
  }
  // consolidate multiple manual entries: one counted and one excluded at most, so a merge
  // never changes what is counted
  const manuals = db.prepare("SELECT * FROM entries WHERE account_id IS NULL AND platform = 'manual' AND game_id = ? ORDER BY id").all(targetId);
  const keep = {};
  for (const m of manuals) {
    const k = keep[m.excluded];
    if (!k) { keep[m.excluded] = m; continue; }
    db.prepare('UPDATE sessions SET entry_id = ? WHERE entry_id = ?').run(k.id, m.id);
    db.prepare('UPDATE entries SET playtime_min = playtime_min + ? WHERE id = ?').run(m.playtime_min, k.id);
    db.prepare('DELETE FROM entries WHERE id = ?').run(m.id);
  }
}

/** Detach an entry into its own game. */
export function splitEntry(db, entryId) {
  const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
  if (!e) throw Object.assign(new Error('Entry not found'), { status: 404 });
  const count = db.prepare('SELECT COUNT(*) n FROM entries WHERE game_id = ?').get(e.game_id).n;
  if (count < 2) return e.game_id;
  const now = Date.now();
  const r = db.prepare('INSERT INTO games(title, norm_title, cover_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(cleanTitle(e.title), normalizeTitle(e.title), e.cover_url, now, now);
  const gid = Number(r.lastInsertRowid);
  db.prepare('UPDATE entries SET game_id = ? WHERE id = ?').run(gid, entryId);
  return gid;
}
