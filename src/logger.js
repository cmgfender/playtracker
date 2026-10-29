import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import { unmemoized } from './services/stats.js';

// Structured logger:
//  - stdout (what `docker logs` / the Unraid log viewer shows), pretty or JSON
//  - optional rotating file (VESTIGO_LOG_FILE, or PLAYTRACKER_LOG_FILE)
//  - warnings & errors persisted to the `logs` table so they can be browsed,
//    filtered and counted in the UI / API (attach with logger.attachDb()).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

export function createLogger({
  level = process.env.LOG_LEVEL || 'info',
  json = process.env.LOG_FORMAT === 'json',
  file = env('LOG_FILE', ''),
  maxFileBytes = 5 * 1024 * 1024,
  quiet = false,
} = {}) {
  let db = null;
  let insert = null;
  let persisted = 0;
  const min = LEVELS[level] ?? LEVELS.info;
  const tty = process.stdout.isTTY && !json;
  const recent = []; // ring buffer of the latest lines, for the diagnostics page

  function writeFile(line) {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size > maxFileBytes) fs.renameSync(file, `${file}.1`);
      } catch { /* no file yet */ }
      fs.appendFileSync(file, line + '\n');
    } catch { /* never let logging crash the app */ }
  }

  // the stored context must stay valid JSON: an oversized one is kept as a truncated preview
  function contextJson(ctx) {
    const s = JSON.stringify(ctx);
    return s.length > 20000 ? JSON.stringify({ truncated: true, preview: s.slice(0, 10000) }) : s;
  }

  function serializeError(err) {
    if (!(err instanceof Error)) return err;
    return { name: err.name, message: err.message, stack: err.stack, status: err.status, code: err.code };
  }

  function log(lvl, source, message, details) {
    if ((LEVELS[lvl] ?? 0) < min) return;
    const time = new Date();
    let err = null;
    if (message instanceof Error) { err = message; message = message.message; }
    if (details instanceof Error) { err = details; details = undefined; }
    if (details && typeof details === 'object' && details.error instanceof Error) { err = details.error; details = { ...details }; delete details.error; }
    const ctx = details && typeof details === 'object' ? details : details !== undefined ? { value: details } : undefined;
    const entry = { time: time.toISOString(), level: lvl, source, message: String(message), ...(ctx ? { ctx } : {}), ...(err ? { error: serializeError(err) } : {}) };
    let line;
    if (json) line = JSON.stringify(entry);
    else {
      const extra = ctx ? ` ${JSON.stringify(ctx)}` : '';
      const stack = err?.stack && lvl === 'error' ? `\n${err.stack}` : '';
      line = `${time.toISOString()} ${lvl.toUpperCase().padEnd(5)} [${source}] ${entry.message}${extra}${stack}`;
    }
    const out = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    if (!quiet) out.write((tty ? `${COLORS[lvl]}${line}\x1b[0m` : line) + '\n');
    writeFile(json ? line : line.replace(/\x1b\[[0-9;]*m/g, ''));
    recent.push(line.slice(0, 2000));
    if (recent.length > 300) recent.shift();
    if (db && LEVELS[lvl] >= LEVELS.warn) {
      try {
        unmemoized(db, insert.run(time.getTime(), lvl, source, entry.message.slice(0, 2000), ctx ? contextJson(ctx) : null, err?.stack ? String(err.stack).slice(0, 20000) : null));
        if (++persisted % 200 === 0) prune();
      } catch { /* db may be closing */ }
    }
  }

  function prune() {
    if (!db) return;
    // keep 30 days and at most 20k rows
    db.prepare('DELETE FROM logs WHERE time < ?').run(Date.now() - 30 * 86_400_000);
    db.prepare('DELETE FROM logs WHERE id <= (SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET 20000)').run();
  }

  const scoped = (source) => ({
    debug: (m, d) => log('debug', source, m, d),
    info: (m, d) => log('info', source, m, d),
    warn: (m, d) => log('warn', source, m, d),
    error: (m, d) => log('error', source, m, d),
    child: (s) => scoped(`${source}:${s}`),
  });

  const root = scoped('app');
  return Object.assign(root, {
    scoped,
    recent: () => [...recent],
    attachDb(database) {
      db = database;
      insert = db.prepare('INSERT INTO logs(time, level, source, message, context, stack) VALUES (?, ?, ?, ?, ?, ?)');
      prune();
    },
    detachDb() { db = null; },
  });
}

/** Adapter so older code passing a console-like object keeps working. */
export function asLogger(log) {
  if (log?.scoped) return log;
  const l = log || console;
  const wrap = (source) => ({
    debug: (m, d) => l.debug?.(`[${source}] ${m instanceof Error ? m.message : m}`, d ?? ''),
    info: (m, d) => l.info?.(`[${source}] ${m instanceof Error ? m.message : m}`, d ?? ''),
    warn: (m, d) => l.warn?.(`[${source}] ${m instanceof Error ? m.message : m}`, d ?? ''),
    error: (m, d) => l.error?.(`[${source}] ${m instanceof Error ? m.message : m}`, d ?? ''),
    child: (s) => wrap(`${source}:${s}`),
  });
  return Object.assign(wrap('app'), { scoped: wrap, recent: () => [], attachDb() {}, detachDb() {} });
}
