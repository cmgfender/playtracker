// Fixture: a database exactly as the first PlayTracker release (schema version 1) left it,
// with data written the way that release wrote it (pre-tracking time as 'baseline' sessions
// noted "Playtime before tracking started" / "Imported history"). Used to check that an
// upgrade keeps every game, minute, setting and token.
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Frozen copy of the v1 schema as shipped in the first release (git 4cd8941, src/db.js).
const V1_SCHEMA = `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, schedule TEXT, last_sync_at INTEGER,
    next_sync_at INTEGER, last_status TEXT, last_error TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE games (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, norm_title TEXT NOT NULL, cover_url TEXT,
    status TEXT NOT NULL DEFAULT 'unset', rating INTEGER, notes TEXT, favorite INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0, merge_locked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX games_norm ON games(norm_title);
  CREATE TABLE entries (
    id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE, game_id INTEGER NOT NULL REFERENCES games(id),
    platform TEXT NOT NULL, ext_id TEXT NOT NULL, title TEXT NOT NULL, icon_url TEXT, cover_url TEXT,
    playtime_min INTEGER NOT NULL DEFAULT 0, last_played_at INTEGER, first_seen_at INTEGER NOT NULL, last_synced_at INTEGER,
    excluded INTEGER NOT NULL DEFAULT 0, meta TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX entries_account_ext ON entries(account_id, ext_id) WHERE account_id IS NOT NULL;
  CREATE UNIQUE INDEX entries_local_ext ON entries(platform, ext_id) WHERE account_id IS NULL;
  CREATE INDEX entries_game ON entries(game_id);
  CREATE TABLE syncs (
    id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE, trigger TEXT NOT NULL DEFAULT 'manual',
    started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL DEFAULT 'running', initial INTEGER NOT NULL DEFAULT 0,
    games_seen INTEGER NOT NULL DEFAULT 0, games_changed INTEGER NOT NULL DEFAULT 0, games_new INTEGER NOT NULL DEFAULT 0,
    sessions_created INTEGER NOT NULL DEFAULT 0, minutes_added INTEGER NOT NULL DEFAULT 0, baseline_minutes INTEGER NOT NULL DEFAULT 0, error TEXT
  );
  CREATE INDEX syncs_account ON syncs(account_id, started_at);
  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    sync_id INTEGER REFERENCES syncs(id) ON DELETE SET NULL, taken_at INTEGER NOT NULL, playtime_min INTEGER NOT NULL
  );
  CREATE INDEX snapshots_entry ON snapshots(entry_id, taken_at);
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    sync_id INTEGER REFERENCES syncs(id) ON DELETE SET NULL, source TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'play',
    minutes INTEGER NOT NULL, window_start INTEGER, window_end INTEGER, started_at INTEGER, ended_at INTEGER, note TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_entry ON sessions(entry_id);
  CREATE INDEX sessions_window ON sessions(kind, window_end);
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
  );
  CREATE TABLE login_sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE dismissed_duplicates (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
`;

export const LEGACY_TOKEN = 'pt_legacy-token-from-version-one-0123456789';
const H = 3_600_000;
const D = 24 * H;
const T0 = Date.UTC(2025, 4, 1, 12); // tracking started 2025-05-01

/** What the fixture contains, so tests can assert nothing was lost. */
export const LEGACY = {
  T0,
  games: {
    Hades: { minutes: 630, status: 'completed', rating: 9, notes: 'Best roguelike', tracked: 100, history: 500 },
    Celeste: { minutes: 300, status: 'beaten', rating: null, notes: null, tracked: 60, history: 240 },
    'Stardew Valley': { minutes: 90, status: 'playing', rating: null, notes: null, tracked: 90, history: 0 },
  },
  total_minutes: 1020,
  tracked_minutes: 250, // play sessions: 60 + 40 (Hades) + 60 (Celeste) + 90 (Stardew)
  play_sessions: 4,
  theme: 'light',
  schedule_mode: 'weekly',
  dismissed: 'merge:1:2',
  lastPlayedHades: T0 + 19 * D,
  account: { name: 'Legacy Switch', platform: 'custom' },
};

export function buildLegacyV1(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec('BEGIN');
  db.exec(V1_SCHEMA);
  db.exec('PRAGMA user_version = 1');
  const ins = (sql, ...a) => Number(db.prepare(sql).run(...a).lastInsertRowid);
  ins("INSERT INTO settings(key, value) VALUES ('theme', ?)", JSON.stringify(LEGACY.theme));
  ins("INSERT INTO settings(key, value) VALUES ('schedule_mode', ?)", JSON.stringify(LEGACY.schedule_mode));
  const acc = ins("INSERT INTO accounts(platform, name, config, state, enabled, last_sync_at, last_status, created_at) VALUES ('custom', ?, '{}', '{}', 1, ?, 'ok', ?)",
    LEGACY.account.name, T0 + 19 * D, T0 - D);
  const s1 = ins("INSERT INTO syncs(account_id, trigger, started_at, finished_at, status, initial, games_seen, baseline_minutes) VALUES (?, 'api', ?, ?, 'ok', 1, 1, 500)", acc, T0, T0 + 1000);
  const s2 = ins("INSERT INTO syncs(account_id, trigger, started_at, finished_at, status, games_seen, sessions_created, minutes_added) VALUES (?, 'api', ?, ?, 'ok', 1, 1, 60)", acc, T0 + 9 * D, T0 + 9 * D + 1000);
  const s3 = ins("INSERT INTO syncs(account_id, trigger, started_at, finished_at, status, games_seen, sessions_created, minutes_added) VALUES (?, 'api', ?, ?, 'ok', 1, 1, 30)", acc, T0 + 14 * D, T0 + 14 * D + 1000);
  const s4 = ins("INSERT INTO syncs(account_id, trigger, started_at, finished_at, status, games_seen, sessions_created, minutes_added) VALUES (?, 'api', ?, ?, 'ok', 1, 1, 40)", acc, T0 + 19 * D, T0 + 19 * D + 1000);

  const game = (title, status, rating, notes) => ins("INSERT INTO games(title, norm_title, status, rating, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    title, title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), status, rating, notes, T0 - 30 * D, T0);
  const gH = game('Hades', 'completed', 9, 'Best roguelike');
  const gC = game('Celeste', 'beaten', null, null);
  const gS = game('Stardew Valley', 'playing', null, null);

  const eH = ins("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, last_played_at, first_seen_at, last_synced_at) VALUES (?, ?, 'custom', 'hades', 'Hades', 630, ?, ?, ?)",
    acc, gH, LEGACY.lastPlayedHades, T0, T0 + 19 * D);
  const eC = ins("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, last_played_at, first_seen_at, last_synced_at) VALUES (NULL, ?, 'import', 'celeste', 'Celeste', 300, ?, ?, ?)",
    gC, T0 - 60 * D, T0 - 2 * D, T0 - 2 * D);
  const eS = ins("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, last_played_at, first_seen_at, last_synced_at) VALUES (NULL, ?, 'manual', ?, 'Stardew Valley', 90, ?, ?, ?)",
    gS, `game:${gS}:${T0}`, T0 + 5 * D + 1.5 * H, T0 + 5 * D, T0 + 5 * D);

  for (const [t, m, sid] of [[T0, 500, s1], [T0 + 9 * D, 560, s2], [T0 + 14 * D, 590, s3], [T0 + 19 * D, 630, s4]]) {
    ins('INSERT INTO snapshots(entry_id, sync_id, taken_at, playtime_min) VALUES (?, ?, ?, ?)', eH, sid, t, m);
  }
  const sess = (entry, sync, source, kind, minutes, ws, we, st, en, note, created) => ins(
    'INSERT INTO sessions(entry_id, sync_id, source, kind, minutes, window_start, window_end, started_at, ended_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    entry, sync, source, kind, minutes, ws, we, st, en, note, created);
  // Hades (custom account): history at first report, two tracked sessions, one synced session the user removed from stats
  sess(eH, s1, 'sync', 'baseline', 500, null, T0, null, null, 'Playtime before tracking started', T0);
  sess(eH, s2, 'sync', 'play', 60, T0 + 8 * D, T0 + 9 * D, T0 + 9 * D - 2 * H, T0 + 9 * D - H, null, T0 + 9 * D);
  sess(eH, s3, 'sync', 'baseline', 30, T0 + 9 * D, T0 + 14 * D, null, null, 'Removed from stats', T0 + 14 * D);
  sess(eH, s4, 'sync', 'play', 40, T0 + 14 * D, T0 + 19 * D, T0 + 19 * D - 40 * 60_000, T0 + 19 * D, null, T0 + 19 * D);
  // Celeste (CSV import): untracked hours + one imported session
  sess(eC, null, 'import', 'baseline', 240, null, T0 - 2 * D, null, null, 'Imported history', T0 - 2 * D);
  sess(eC, null, 'import', 'play', 60, T0 - 60 * D - H, T0 - 60 * D, T0 - 60 * D - H, T0 - 60 * D, null, T0 - 2 * D);
  // Stardew (logged by hand)
  sess(eS, null, 'manual', 'play', 90, T0 + 5 * D, T0 + 5 * D + 1.5 * H, T0 + 5 * D, T0 + 5 * D + 1.5 * H, 'Year 1 spring', T0 + 5 * D);

  ins('INSERT INTO api_tokens(name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?)', 'Home Assistant',
    crypto.createHash('sha256').update(LEGACY_TOKEN).digest('hex'), LEGACY_TOKEN.slice(0, 7), T0);
  ins('INSERT INTO dismissed_duplicates(key, created_at) VALUES (?, ?)', LEGACY.dismissed, T0);
  db.exec('COMMIT');
  db.close();
}
