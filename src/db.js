import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  // 1: initial schema
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    platform TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    schedule TEXT,
    last_sync_at INTEGER,
    next_sync_at INTEGER,
    last_status TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE games (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    norm_title TEXT NOT NULL,
    cover_url TEXT,
    status TEXT NOT NULL DEFAULT 'unset',
    rating INTEGER,
    notes TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    merge_locked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX games_norm ON games(norm_title);

  CREATE TABLE entries (
    id INTEGER PRIMARY KEY,
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    game_id INTEGER NOT NULL REFERENCES games(id),
    platform TEXT NOT NULL,
    ext_id TEXT NOT NULL,
    title TEXT NOT NULL,
    icon_url TEXT,
    cover_url TEXT,
    playtime_min INTEGER NOT NULL DEFAULT 0,
    last_played_at INTEGER,
    first_seen_at INTEGER NOT NULL,
    last_synced_at INTEGER,
    excluded INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX entries_account_ext ON entries(account_id, ext_id) WHERE account_id IS NOT NULL;
  CREATE UNIQUE INDEX entries_local_ext ON entries(platform, ext_id) WHERE account_id IS NULL;
  CREATE INDEX entries_game ON entries(game_id);

  CREATE TABLE syncs (
    id INTEGER PRIMARY KEY,
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL DEFAULT 'manual',
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    initial INTEGER NOT NULL DEFAULT 0,
    games_seen INTEGER NOT NULL DEFAULT 0,
    games_changed INTEGER NOT NULL DEFAULT 0,
    games_new INTEGER NOT NULL DEFAULT 0,
    sessions_created INTEGER NOT NULL DEFAULT 0,
    minutes_added INTEGER NOT NULL DEFAULT 0,
    baseline_minutes INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX syncs_account ON syncs(account_id, started_at);

  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    sync_id INTEGER REFERENCES syncs(id) ON DELETE SET NULL,
    taken_at INTEGER NOT NULL,
    playtime_min INTEGER NOT NULL
  );
  CREATE INDEX snapshots_entry ON snapshots(entry_id, taken_at);

  -- kind = 'play'     : real play detected in [window_start, window_end]
  -- kind = 'baseline' : pre-existing playtime at first sight (mass import) - counts
  --                     toward lifetime totals but never toward period stats
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    sync_id INTEGER REFERENCES syncs(id) ON DELETE SET NULL,
    source TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'play',
    minutes INTEGER NOT NULL,
    window_start INTEGER,
    window_end INTEGER,
    started_at INTEGER,
    ended_at INTEGER,
    note TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_entry ON sessions(entry_id);
  CREATE INDEX sessions_window ON sessions(kind, window_end);

  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE login_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE dismissed_duplicates (
    key TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  `,
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
