// Automatic backups: a consistent copy of the database (VACUUM INTO) in <data>/backups on a
// schedule, the newest few kept. One more copy is made before an update changes the schema.
// Only files this module names are ever pruned: anything else in the folder is left alone.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { env } from '../env.js';
import { nextRun } from './schedule.js';

const HOUR = 3600_000;
const RETRY_AFTER = 6 * HOUR; // a failed backup (disk full, folder not writable) is tried again this much later
const KEEP_BEFORE_UPGRADE = 3;
const SCHEDULED = /^vestigo-\d{4}-\d{2}-\d{2}-\d{6}\.db$/;
const BEFORE_UPGRADE = /^vestigo-before-v\d+-\d{4}-\d{2}-\d{2}-\d{6}\.db$/;

const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };

/** Where backups go: VESTIGO_BACKUP_DIR, else a backups folder beside the database. null for an in-memory database. */
export function backupDir(dbFile) {
  if (!dbFile || dbFile === ':memory:') return null;
  return env('BACKUP_DIR') || path.join(path.dirname(path.resolve(dbFile)), 'backups');
}

/**
 * Copy the database at `dbFile` (or the open `db` when in memory) to `dest`, consistently: through a
 * read-only connection of its own, written to a temporary name and renamed when complete, so a
 * half-written file never looks like a backup.
 */
export function snapshot({ db, dbFile, dest }) {
  const part = `${dest}.partial`;
  const src = dbFile && dbFile !== ':memory:' ? new DatabaseSync(dbFile, { readOnly: true }) : db;
  try {
    try { fs.unlinkSync(part); } catch { /* none left over */ }
    src.exec(`VACUUM INTO '${part.replace(/'/g, "''")}'`);
    fs.renameSync(part, dest);
  } catch (err) {
    try { fs.unlinkSync(part); } catch { /* never written */ }
    throw err;
  } finally {
    if (src !== db) src.close();
  }
  return fs.statSync(dest).size;
}

/** The backups in `dir`, newest first: { name, kind: 'scheduled' | 'before-upgrade', at, bytes }. */
export function listBackups(dir) {
  if (!dir) return [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const kind = SCHEDULED.test(name) ? 'scheduled' : BEFORE_UPGRADE.test(name) ? 'before-upgrade' : null;
    if (!kind) continue;
    try { const st = fs.statSync(path.join(dir, name)); out.push({ name, kind, at: Math.round(st.mtimeMs), bytes: st.size }); } catch { /* removed meanwhile */ }
  }
  return out.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
}

export const isBackupName = (name) => SCHEDULED.test(name) || BEFORE_UPGRADE.test(name);

/** Remove the oldest backups of `kind` beyond `keep`. Returns the names removed. */
function prune(dir, kind, keep) {
  const removed = [];
  for (const b of listBackups(dir).filter((x) => x.kind === kind).slice(Math.max(1, keep))) {
    try { fs.unlinkSync(path.join(dir, b.name)); removed.push(b.name); } catch { /* already gone */ }
  }
  return removed;
}

/**
 * Before migrations run: copy a database whose schema is older than `version` (an update is about
 * to change it), so going back to the previous image stays possible. Never throws: a failed copy
 * is logged and the update goes ahead, as it did before backups existed.
 */
export function backupBeforeUpgrade(dbFile, version, log) {
  const dir = backupDir(dbFile);
  if (!dir) return null;
  let current = 0;
  try {
    if (!fs.statSync(dbFile).size) return null;
    const ro = new DatabaseSync(dbFile, { readOnly: true });
    try { current = ro.prepare('PRAGMA user_version').get().user_version; } finally { ro.close(); }
  } catch { return null; } // no database yet, or not readable: nothing to keep
  if (!current || current >= version) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = `vestigo-before-v${version}-${stamp(Date.now())}.db`;
    const bytes = snapshot({ dbFile, dest: path.join(dir, name) });
    prune(dir, 'before-upgrade', KEEP_BEFORE_UPGRADE);
    log?.info(`Database schema ${current} → ${version}: saved a copy first (backups/${name}, ${(bytes / 1048576).toFixed(1)} MB)`);
    return name;
  } catch (err) {
    log?.warn(`Could not copy the database before upgrading it: ${err.message}`);
    return null;
  }
}

export class Backups {
  constructor({ db, dbFile, settings, log }) {
    this.db = db;
    this.dbFile = dbFile;
    this.settings = settings;
    this.log = log;
    this.dir = backupDir(dbFile);
    this.lastError = null; // { at, message }
    this.running = false;
  }

  /** The time the next scheduled backup is due, or null (off, or in memory). */
  nextAt(now = Date.now()) {
    const s = this.settings.all();
    if (!this.dir || s.backup_mode === 'off') return null;
    const last = listBackups(this.dir).find((b) => b.kind === 'scheduled');
    const sched = { schedule_mode: s.backup_mode === 'weekly' ? 'weekly' : 'daily', schedule_time: s.backup_time, schedule_weekday: s.week_starts_on ?? 1 };
    let next = nextRun(sched, last ? last.at : null, now);
    if (this.lastError && next < this.lastError.at + RETRY_AFTER) next = this.lastError.at + RETRY_AFTER;
    return next;
  }

  /** Make a backup now and prune old ones. Returns { name, bytes, removed }. */
  run({ reason = 'manual' } = {}) {
    if (!this.dir) throw new Error('Backups need a database file (this instance runs in memory)');
    if (this.running) throw new Error('A backup is already running');
    this.running = true;
    const t0 = Date.now();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const name = `vestigo-${stamp(t0)}.db`;
      const bytes = snapshot({ db: this.db, dbFile: this.dbFile, dest: path.join(this.dir, name) });
      const removed = prune(this.dir, 'scheduled', this.keep());
      this.lastError = null;
      this.log?.info(`Backup saved: ${name} (${(bytes / 1048576).toFixed(1)} MB, ${Date.now() - t0}ms)${removed.length ? `, removed ${removed.length} older` : ''}`, { reason });
      return { name, bytes, removed };
    } catch (err) {
      this.lastError = { at: Date.now(), message: err.message };
      this.log?.error(`Backup failed: ${err.message} (in ${this.dir}; tried again in ${RETRY_AFTER / HOUR} hours)`, { reason });
      throw err;
    } finally {
      this.running = false;
    }
  }

  keep() { return Math.min(90, Math.max(1, Math.floor(Number(this.settings.get('backup_keep')) || 7))); }

  status(now = Date.now()) {
    const s = this.settings.all();
    const files = listBackups(this.dir);
    const scheduled = files.filter((b) => b.kind === 'scheduled');
    return {
      enabled: !!this.dir && s.backup_mode !== 'off', mode: s.backup_mode, time: s.backup_time, keep: this.keep(), dir: this.dir,
      count: scheduled.length, total_bytes: files.reduce((a, b) => a + b.bytes, 0),
      last: scheduled[0] || null, next_at: this.nextAt(now), last_error: this.lastError,
      files,
    };
  }

  start() {
    if (!this.dir) return;
    const tick = () => {
      if (this.running) return;
      const next = this.nextAt();
      if (next != null && next <= Date.now()) { try { this.run({ reason: 'schedule' }); } catch { /* logged, retried later */ } }
    };
    // the first check waits a few minutes: an update's first backup runs once startup work is done
    this.first = setTimeout(tick, 3 * 60_000);
    this.first.unref?.();
    this.timer = setInterval(tick, 60_000);
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }
}
