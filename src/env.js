import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Configuration from the environment. Vestigo was called PlayTracker before, so every VESTIGO_X
// variable also answers to its old name PLAYTRACKER_X: existing containers (Unraid templates,
// compose files) keep working unchanged after an update. VESTIGO_X wins when both are set.
// Empty values count as unset, because Unraid passes the template's empty variables.
const PREFIXES = ['VESTIGO_', 'PLAYTRACKER_'];

/** The variable that supplies setting `name` ('VESTIGO_PASSWORD', 'PLAYTRACKER_PASSWORD'), or null. */
export function envSource(name) {
  for (const p of PREFIXES) {
    const v = process.env[p + name];
    if (v !== undefined && v !== '') return p + name;
  }
  return null;
}

/** VESTIGO_<name>, else PLAYTRACKER_<name>, else `fallback`. */
export function env(name, fallback) {
  const src = envSource(name);
  return src ? process.env[src] : fallback;
}

export const dataDir = () => env('DATA', './data');

export const DB_NAME = 'vestigo.db';
const LEGACY_DB_NAME = 'playtracker.db'; // what PlayTracker created; used in place, never renamed

const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

/** Games in a database file, read through a read-only connection; -1 when it cannot be read. */
function countGames(file) {
  if (fs.statSync(file).size === 0) return 0; // an empty file is an empty database
  // a read-only look still creates the WAL side files; remove the ones only this look created
  const sidecars = ['-wal', '-shm'].map((s) => file + s).filter((f) => !isFile(f));
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return db.prepare('SELECT COUNT(*) n FROM games').get().n;
  } catch {
    return -1; // not a database, or not one of ours (no games table)
  } finally {
    try { db?.close(); } catch { /* not open */ }
    for (const f of sidecars) { try { fs.unlinkSync(f); } catch { /* never created */ } }
  }
}

/**
 * The database file to open:
 *  1. VESTIGO_DB / PLAYTRACKER_DB when set
 *  2. <data>/vestigo.db, or the <data>/playtracker.db an earlier version created (used in place)
 *  3. a new <data>/vestigo.db
 * With both files present (an old database copied into a new install, or a rollback) the one with
 * more games is used, a tie goes to vestigo.db, and the choice is logged. Nothing is moved or renamed.
 */
export function resolveDbFile({ dir = dataDir(), log } = {}) {
  const explicit = env('DB');
  if (explicit) return explicit;
  const current = path.join(dir, DB_NAME);
  const legacy = path.join(dir, LEGACY_DB_NAME);
  if (!isFile(legacy)) return current;
  if (!isFile(current)) return legacy;
  const games = { [current]: countGames(current), [legacy]: countGames(legacy) };
  const file = games[legacy] > games[current] ? legacy : current;
  const other = file === current ? legacy : current;
  const n = (f) => (games[f] < 0 ? 'unreadable' : `${games[f]} game${games[f] === 1 ? '' : 's'}`);
  log?.warn(`Both ${DB_NAME} and ${LEGACY_DB_NAME} are in ${dir}: using ${path.basename(file)} (${n(file)}), not ${path.basename(other)} (${n(other)})${games[file] === games[other] ? ' - same number of games, the newer name wins' : ''}. Move the one you don't need out of the folder to silence this.`);
  return file;
}
