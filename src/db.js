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
  // 2: scale - indexed sort key, per-day/per-hour rollups maintained via a trigger-fed queue
  `
  ALTER TABLE sessions ADD COLUMN sort_time INTEGER GENERATED ALWAYS AS (COALESCE(ended_at, window_end, created_at)) VIRTUAL;
  DROP INDEX IF EXISTS sessions_window;
  DROP INDEX IF EXISTS sessions_entry;
  CREATE INDEX sessions_entry_kind_time ON sessions(entry_id, kind, sort_time);
  CREATE INDEX sessions_kind_time ON sessions(kind, sort_time);
  CREATE INDEX sessions_sync ON sessions(sync_id);
  ALTER TABLE entries ADD COLUMN last_session_at INTEGER;
  CREATE INDEX entries_platform_game ON entries(platform, game_id);
  CREATE INDEX games_title ON games(title COLLATE NOCASE);
  CREATE INDEX games_created ON games(created_at);

  CREATE INDEX sessions_kind_minutes ON sessions(kind, minutes, entry_id);

  -- Minutes of each play session split across local calendar days / hours. game_id,
  -- platform and excluded are copied from entries (kept in sync by triggers) so stats
  -- are served from covering indexes without joins. ends = 1 on the session's last day,
  -- so SUM(ends) counts sessions.
  CREATE TABLE play_days (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    entry_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    excluded INTEGER NOT NULL DEFAULT 0,
    day TEXT NOT NULL,
    minutes REAL NOT NULL,
    ends INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX play_days_range ON play_days(excluded, day, platform, game_id, minutes, ends);
  CREATE INDEX play_days_game ON play_days(game_id, excluded, day, platform, minutes, ends);
  CREATE INDEX play_days_entry ON play_days(entry_id);
  CREATE INDEX play_days_session ON play_days(session_id);
  CREATE TABLE play_hours (
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    entry_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    excluded INTEGER NOT NULL DEFAULT 0,
    day TEXT NOT NULL,
    hour INTEGER NOT NULL,
    minutes REAL NOT NULL
  );
  CREATE INDEX play_hours_range ON play_hours(excluded, day, platform, game_id, hour, minutes);
  CREATE INDEX play_hours_entry ON play_hours(entry_id);
  CREATE INDEX play_hours_session ON play_hours(session_id);
  CREATE TRIGGER entries_rollup_sync AFTER UPDATE OF game_id, excluded ON entries
  WHEN OLD.game_id IS NOT NEW.game_id OR OLD.excluded IS NOT NEW.excluded BEGIN
    UPDATE play_days SET game_id = NEW.game_id, excluded = NEW.excluded WHERE entry_id = NEW.id;
    UPDATE play_hours SET game_id = NEW.game_id, excluded = NEW.excluded WHERE entry_id = NEW.id;
  END;

  CREATE TABLE rollup_queue (session_id INTEGER PRIMARY KEY);
  CREATE TABLE rollup_entry_queue (entry_id INTEGER PRIMARY KEY);
  CREATE TRIGGER sessions_rollup_ins AFTER INSERT ON sessions BEGIN
    INSERT OR IGNORE INTO rollup_queue(session_id) VALUES (NEW.id);
  END;
  CREATE TRIGGER sessions_rollup_upd AFTER UPDATE OF kind, minutes, window_start, window_end, started_at, ended_at, entry_id ON sessions BEGIN
    INSERT OR IGNORE INTO rollup_queue(session_id) VALUES (NEW.id);
    INSERT OR IGNORE INTO rollup_entry_queue(entry_id) VALUES (OLD.entry_id);
  END;
  CREATE TRIGGER sessions_rollup_del AFTER DELETE ON sessions BEGIN
    INSERT OR IGNORE INTO rollup_entry_queue(entry_id) VALUES (OLD.entry_id);
  END;
  INSERT INTO rollup_queue(session_id) SELECT id FROM sessions;
  `,
  // 3: error log, history inference, presence tracking, API usage accounting
  `
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY,
    time INTEGER NOT NULL,
    level TEXT NOT NULL,
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    context TEXT,
    stack TEXT
  );
  CREATE INDEX logs_time ON logs(time);
  CREATE INDEX logs_level_time ON logs(level, time);

  -- kind: 'play' (tracked), 'estimate' (inferred pre-tracking history, charted but flagged),
  --       'baseline' (undatable history: lifetime totals only)
  -- confidence: play -> exact | pinned | window ; estimate -> high | medium | low
  ALTER TABLE sessions ADD COLUMN confidence TEXT;
  ALTER TABLE sessions ADD COLUMN device TEXT;

  -- Pre-tracking playtime and everything known about when it happened
  -- (first/last played, achievement unlock times, release date, ...).
  ALTER TABLE entries ADD COLUMN baseline_min INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE entries ADD COLUMN hist TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE entries ADD COLUMN inferred_v INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE entries ADD COLUMN first_played_at INTEGER;
  ALTER TABLE entries ADD COLUMN play_count INTEGER;
  ALTER TABLE entries ADD COLUMN enriched_at INTEGER;
  CREATE INDEX entries_infer ON entries(inferred_v) WHERE baseline_min > 0;

  -- existing installs: fold old "Imported history" baselines into baseline_min so they get inferred
  UPDATE entries SET baseline_min = (SELECT COALESCE(SUM(minutes), 0) FROM sessions s
    WHERE s.entry_id = entries.id AND s.kind = 'baseline' AND s.note IN ('Imported history', 'Playtime before tracking started'));
  DELETE FROM sessions WHERE kind = 'baseline' AND note IN ('Imported history', 'Playtime before tracking started');

  ALTER TABLE play_days ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE play_hours ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0;
  DROP INDEX play_days_range;
  DROP INDEX play_days_game;
  DROP INDEX play_hours_range;
  CREATE INDEX play_days_range ON play_days(excluded, estimated, day, platform, game_id, minutes, ends);
  CREATE INDEX play_days_game ON play_days(game_id, excluded, estimated, day, platform, minutes, ends);
  CREATE INDEX play_hours_range ON play_hours(excluded, estimated, day, platform, game_id, hour, minutes);

  -- "currently playing" observations from presence APIs; used to pin sessions to exact times
  CREATE TABLE presence (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    ext_id TEXT NOT NULL,
    title TEXT,
    started_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX presence_open ON presence(account_id, ended_at);
  CREATE INDEX presence_ext ON presence(account_id, ext_id, started_at);

  -- per account, per hour API call accounting (rate-limit awareness + diagnostics)
  CREATE TABLE api_usage (
    account_id INTEGER NOT NULL,
    hour INTEGER NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    rate_limited INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, hour)
  );

  ALTER TABLE syncs ADD COLUMN duration_ms INTEGER;
  ALTER TABLE syncs ADD COLUMN details TEXT;
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
  db._inTx = true;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db._inTx = false;
  }
}
