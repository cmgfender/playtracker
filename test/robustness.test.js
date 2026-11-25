// Robustness of the small parts around the tracker: unfinished backup files, log lines whose
// context cannot be written as JSON, ZIP uploads that are cut short or encrypted, and the
// schedule's label for "every 1".
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/server.js';
import { Backups, backupBeforeUpgrade, listBackups, sweepPartials } from '../src/services/backup.js';
import { SCHEMA_VERSION } from '../src/db.js';
import { createLogger, toJson } from '../src/logger.js';
import { readZip } from '../src/services/zip.js';
import { describeSchedule } from '../src/services/schedule.js';
import { clip, sendSummary } from '../src/services/webhook.js';

const HOUR = 3600_000;
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `vg-${name}-`));

/** A file in `dir` last written `ageMs` ago. */
function aged(dir, name, ageMs, body = 'x') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
  return file;
}

describe('backups: files left by an interrupted backup', () => {
  const STALE = ['vestigo-2026-01-02-033000.db.partial', 'vestigo-before-v9-2026-01-02-033000.db.partial'];
  // not this module's temporary names: someone else's files, however old
  const FOREIGN = ['my-copy.db.partial', 'vestigo.db.partial', 'vestigo-2026-01-02.db.partial', 'vestigo-2026-01-02-033000.db.partial.bak', 'notes.txt'];

  test('sweepPartials removes only its own temporary names, and only once they stopped growing', () => {
    const dir = tmpDir('partials');
    for (const f of [...STALE, ...FOREIGN]) aged(dir, f, 3 * HOUR);
    aged(dir, 'vestigo-2026-01-03-033000.db.partial', 5 * 60_000); // may still be written
    fs.mkdirSync(path.join(dir, 'vestigo-2026-01-04-033000.db.partial')); // a folder is never removed
    const old = new Date(Date.now() - 3 * HOUR);
    fs.utimesSync(path.join(dir, 'vestigo-2026-01-04-033000.db.partial'), old, old);

    assert.deepEqual(sweepPartials(dir).sort(), [...STALE].sort());
    const left = fs.readdirSync(dir);
    for (const f of [...FOREIGN, 'vestigo-2026-01-03-033000.db.partial', 'vestigo-2026-01-04-033000.db.partial']) assert.ok(left.includes(f), f);
    assert.equal(left.length, FOREIGN.length + 2);
    assert.deepEqual(sweepPartials(dir), [], 'nothing left to remove');
  });

  test('sweepPartials without a folder (in memory, or never created) removes nothing and does not throw', () => {
    assert.deepEqual(sweepPartials(null), []);
    assert.deepEqual(sweepPartials(path.join(os.tmpdir(), 'vg-no-such-folder', 'backups')), []);
  });

  test('the next backup clears them; finished backups and other files stay', () => {
    const dir = tmpDir('backup-sweep');
    const { app: a, close } = createApp({ dbFile: path.join(dir, 'vestigo.db'), password: '', scheduler: false, log: quiet });
    try {
      const backups = path.join(dir, 'backups');
      const first = a.backups.run();
      for (const f of [...STALE, ...FOREIGN]) aged(backups, f, 3 * HOUR);
      fs.renameSync(path.join(backups, first.name), path.join(backups, 'vestigo-2026-01-01-033000.db')); // an earlier name: the next backup has its own
      const second = a.backups.run();
      assert.deepEqual(Object.keys(second).sort(), ['bytes', 'name', 'removed'], 'the result keeps its shape');
      const left = fs.readdirSync(backups);
      for (const f of STALE) assert.ok(!left.includes(f), `${f} removed`);
      for (const f of FOREIGN) assert.ok(left.includes(f), `${f} kept`);
      assert.equal(listBackups(backups).length, 2, 'both finished backups are kept');
    } finally { close(); }
  });

  test('the worker-thread backup clears them too, and says so in the log', async () => {
    const dir = tmpDir('backup-sweep-async');
    const file = path.join(dir, 'vestigo.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE t(x)');
    const lines = [];
    const b = new Backups({ db, dbFile: file, settings: { all: () => ({ backup_mode: 'daily', backup_time: '03:30' }), get: () => 7 }, log: { ...quiet, info: (m) => lines.push(m) } });
    try {
      fs.mkdirSync(b.dir, { recursive: true });
      aged(b.dir, STALE[0], 2 * HOUR);
      await b.runAsync();
      assert.deepEqual(fs.readdirSync(b.dir).filter((f) => f.endsWith('.partial')), []);
      assert.ok(lines.some((l) => /Removed 1 unfinished backup file /.test(l)), lines.join('\n'));
      lines.length = 0;
      fs.renameSync(path.join(b.dir, listBackups(b.dir)[0].name), path.join(b.dir, 'vestigo-2026-01-01-033000.db'));
      await b.runAsync();
      assert.ok(!lines.some((l) => /unfinished/.test(l)), 'nothing said when there was nothing to remove');
    } finally { db.close(); }
  });

  test('they are cleared before the copy is made (room a backup on a nearly full disk needs), so even when it then fails', () => {
    const dir = tmpDir('backup-fail');
    const file = path.join(dir, 'vestigo.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE t(x)');
    const b = new Backups({ db, dbFile: file, settings: { all: () => ({}), get: () => 7 }, log: quiet });
    try {
      fs.mkdirSync(b.dir, { recursive: true });
      aged(b.dir, STALE[0], 2 * HOUR);
      aged(b.dir, 'vestigo-2026-01-01-033000.db', 2 * HOUR); // a finished backup
      b.dbFile = path.join(dir, 'missing', 'vestigo.db'); // the copy cannot be made
      assert.throws(() => b.run());
      assert.ok(b.lastError);
      assert.deepEqual(fs.readdirSync(b.dir), ['vestigo-2026-01-01-033000.db'], 'the unfinished file is gone, the finished backup stays');
    } finally { db.close(); }
  });

  test('a backup refused because one is already running removes nothing', () => {
    const dir = tmpDir('backup-busy');
    const b = new Backups({ db: null, dbFile: path.join(dir, 'vestigo.db'), settings: { all: () => ({}), get: () => 7 }, log: quiet });
    fs.mkdirSync(b.dir, { recursive: true });
    aged(b.dir, STALE[0], 2 * HOUR);
    b.running = true;
    assert.throws(() => b.run(), /already running/);
    assert.ok(fs.existsSync(path.join(b.dir, STALE[0])));
  });

  test('the copy before a schema upgrade clears them as well', () => {
    const dir = tmpDir('backup-upgrade');
    const file = path.join(dir, 'vestigo.db');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE t(x); PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    db.close();
    const backups = path.join(dir, 'backups');
    fs.mkdirSync(backups);
    for (const f of STALE) aged(backups, f, 2 * HOUR);
    const name = backupBeforeUpgrade(file, SCHEMA_VERSION, quiet);
    assert.match(name, /^vestigo-before-v\d+-/);
    assert.deepEqual(fs.readdirSync(backups), [name]);
  });
});

describe('logger: a context that cannot be written as JSON', () => {
  /** Run `fn` with everything written to stdout and stderr captured. */
  function captured(fn) {
    const out = [];
    const { write: o } = process.stdout; const { write: e } = process.stderr;
    process.stdout.write = (s) => { out.push(String(s)); return true; };
    process.stderr.write = (s) => { out.push(String(s)); return true; };
    try { fn(); } finally { process.stdout.write = o; process.stderr.write = e; }
    return out.join('');
  }

  test('toJson: plain values are written as JSON.stringify writes them', () => {
    for (const v of [null, 1, 'a', [1, 'b', null], { a: 1, b: { c: [true, false] }, d: undefined }, { when: new Date(0) }]) assert.equal(toJson(v), JSON.stringify(v));
    assert.equal(toJson(undefined), undefined);
  });

  test('toJson: an Error inside keeps its name, message and status', () => {
    const err = Object.assign(new TypeError('bad token'), { status: 401, code: 'E_AUTH' });
    const back = JSON.parse(toJson({ account: 3, cause: err, list: [err] }));
    assert.deepEqual([back.cause.name, back.cause.message, back.cause.status, back.cause.code], ['TypeError', 'bad token', 401, 'E_AUTH']);
    assert.equal(back.list[0].message, 'bad token');
    assert.equal(back.account, 3);
  });

  test('toJson: a BigInt is written as its digits', () => {
    assert.deepEqual(JSON.parse(toJson({ id: 76561198000000000n, n: [1n] })), { id: '76561198000000000', n: ['1'] });
  });

  test('toJson: a value that contains itself is cut at the loop; a value merely used twice is written twice', () => {
    const a = { name: 'a' }; a.self = a; a.list = [a, { up: a }];
    assert.deepEqual(JSON.parse(toJson(a)), { name: 'a', self: '[Circular]', list: ['[Circular]', { up: '[Circular]' }] });
    const shared = { n: 1 };
    const loop = { x: shared, y: shared, inner: { z: shared } }; loop.inner.top = loop;
    assert.deepEqual(JSON.parse(toJson(loop)), { x: { n: 1 }, y: { n: 1 }, inner: { z: { n: 1 }, top: '[Circular]' } });
    const big = { id: 5n }; big.me = big;
    assert.deepEqual(JSON.parse(toJson(big)), { id: '5', me: '[Circular]' });
  });

  test('toJson: a throwing toJSON or getter yields a note, not an exception', () => {
    assert.match(JSON.parse(toJson({ toJSON() { throw new Error('nope'); } })).unserializable, /nope/);
    assert.match(JSON.parse(toJson({ get x() { throw new Error('getter'); } })).unserializable, /getter/);
  });

  for (const json of [false, true]) {
    test(`a circular or BigInt context never throws out of the logger (${json ? 'JSON' : 'plain'} lines)`, () => {
      const log = createLogger({ json, file: '' });
      const ctx = { id: 9n }; ctx.self = ctx;
      const text = captured(() => {
        assert.doesNotThrow(() => log.warn('sync failed', ctx));
        assert.doesNotThrow(() => log.info('fine', { cause: new Error('inner') }));
      });
      assert.match(text, /sync failed/);
      assert.match(text, /\[Circular\]/);
      assert.match(text, /inner/, 'the nested error is readable');
      if (json) for (const line of text.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line), line);
      assert.equal(log.recent().length, 2);
    });
  }

  test('a warning with such a context is still stored, as valid JSON', () => {
    const dir = tmpDir('logger');
    const log = createLogger({ quiet: true, file: path.join(dir, 'app.log') });
    const { app: a, close } = createApp({ dbFile: ':memory:', password: '', scheduler: false, log });
    try {
      const ctx = { account: 1, id: 12n, err: new RangeError('too far') }; ctx.loop = ctx;
      log.scoped('sync').warn('odd context', ctx);
      const row = a.db.prepare("SELECT context FROM logs WHERE message = 'odd context'").get();
      assert.ok(row, 'the line reached the logs table');
      const back = JSON.parse(row.context);
      assert.deepEqual([back.account, back.id, back.loop, back.err.name, back.err.message], [1, '12', '[Circular]', 'RangeError', 'too far']);
      assert.match(fs.readFileSync(path.join(dir, 'app.log'), 'utf8'), /odd context .*\[Circular\]/);
    } finally { close(); }
  });
});

describe('ZIP uploads', () => {
  /** A ZIP of { name: Buffer | string }; `opt(name)` may give { method, flags, usize } per file. */
  function zip(files, opt = () => ({})) {
    const locals = []; const central = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
      const { method = 8, flags = 0, usize } = opt(name);
      const raw = Buffer.from(content);
      const data = method === 8 ? zlib.deflateRawSync(raw) : raw;
      const nameBuf = Buffer.from(name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
      lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(usize ?? raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
      ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(usize ?? raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
      locals.push(lh, nameBuf, data);
      central.push(ch, nameBuf);
      offset += 30 + nameBuf.length + data.length;
    }
    const cd = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
  }
  const refused = (fn, status, message) => assert.throws(fn, (err) => { assert.equal(err.status, status, err.message); assert.match(err.message, message); return true; });

  test('stored and deflated files are read; folders and macOS metadata are skipped', () => {
    const files = readZip(zip({ 'a.csv': 'one,two\n1,2\n', 'dir/': '', 'dir/b.json': '{"x":1}', '__MACOSX/._a.csv': 'meta', 'dir/._b.json': 'meta' }, (n) => ({ method: n === 'a.csv' ? 0 : 8 })));
    assert.deepEqual([...files.keys()], ['a.csv', 'dir/b.json']);
    assert.equal(files.get('a.csv').toString(), 'one,two\n1,2\n');
    assert.equal(files.get('dir/b.json').toString(), '{"x":1}');
  });

  test('an archive whose file data is cut short is refused, stored or deflated', () => {
    for (const method of [0, 8]) {
      const body = crypto.randomBytes(400); // does not compress: half of it is more than the directory after it
      const whole = zip({ 'games.csv': body }, () => ({ method }));
      // the same archive with the end of the file's data missing: the directory still points at it
      const dataLen = method === 0 ? body.length : zlib.deflateRawSync(body).length;
      const cutAt = 30 + 'games.csv'.length + Math.floor(dataLen / 2);
      const tail = whole.subarray(30 + 'games.csv'.length + dataLen);
      const cut = Buffer.concat([whole.subarray(0, cutAt), tail]);
      // the directory's own offset moved: point the end record at it again
      cut.writeUInt32LE(cutAt, cut.length - 22 + 16);
      assert.equal(readZip(whole).get('games.csv').length, 400);
      refused(() => readZip(cut), 400, /Corrupt ZIP entry: games\.csv is cut short/);
    }
  });

  test('a password-protected file is refused with a message that says so', () => {
    for (const method of [0, 8]) refused(() => readZip(zip({ 'secret.csv': 'a,b' }, () => ({ method, flags: 1 }))), 400, /secret\.csv is password-protected/);
    // a skipped entry (macOS metadata) being encrypted does not matter
    assert.equal(readZip(zip({ 'a.csv': 'x', '__MACOSX/._a.csv': 'y' }, (n) => ({ flags: n === 'a.csv' ? 0 : 1 }))).size, 1);
  });

  test('the size limit counts what a stored file really holds, not the size its directory declares', () => {
    const big = Buffer.alloc(4096, 0x61);
    // declared as empty: once counted as 0 bytes each, so any number of them passed the limit
    const lying = zip({ 'a.bin': big, 'b.bin': big, 'c.bin': big }, () => ({ method: 0, usize: 0 }));
    refused(() => readZip(lying, { maxBytes: 10_000 }), 413, /too large/);
    assert.equal(readZip(lying, { maxBytes: 20_000 }).size, 3);
    // deflated files are still bounded by their declared size (and inflate stops there)
    refused(() => readZip(zip({ 'a.bin': big, 'b.bin': big, 'c.bin': big }), { maxBytes: 10_000 }), 413, /too large/);
    refused(() => readZip(zip({ 'a.bin': big }, () => ({ usize: 10 }))), 400, /Corrupt ZIP data in a\.bin/);
  });
});

describe('schedule label', () => {
  const s = (o) => describeSchedule({ schedule_time: '04:00', schedule_weekday: 1, schedule_monthday: 1, ...o });

  test('"every 1" reads as hourly / daily, not "Every 1 hours"', () => {
    assert.equal(s({ schedule_mode: 'hours', schedule_every: 1 }), 'Every hour');
    assert.equal(s({ schedule_mode: 'hours', schedule_every: '1' }), 'Every hour');
    assert.equal(s({ schedule_mode: 'days', schedule_every: 1 }), 'Daily at 04:00');
  });

  test('every other label is as before', () => {
    assert.equal(s({ schedule_mode: 'hours', schedule_every: 6 }), 'Every 6 hours');
    assert.equal(s({ schedule_mode: 'days', schedule_every: 3 }), 'Every 3 days at 04:00');
    assert.equal(s({ schedule_mode: 'hourly' }), 'Every hour');
    assert.equal(s({ schedule_mode: 'daily' }), 'Daily at 04:00');
    assert.equal(s({ schedule_mode: 'weekly', schedule_weekday: 3 }), 'Weekly on Wednesday at 04:00');
    assert.equal(s({ schedule_mode: 'monthly', schedule_monthday: 15 }), 'Monthly on day 15 at 04:00');
    assert.equal(s({ schedule_mode: 'off' }), 'Manual only');
  });
});

describe('webhook: a message too long for Discord', () => {
  test('clip: a short text is untouched; a long one is cut at a line end and marked as cut', () => {
    assert.equal(clip('short', 1900), 'short');
    assert.equal(clip('x'.repeat(1900), 1900), 'x'.repeat(1900), 'exactly the limit fits');
    const lines = Array.from({ length: 200 }, (_, i) => `• Game number ${i} — 1h 30m`).join('\n');
    const out = clip(lines, 1900);
    assert.ok(out.length <= 1900, String(out.length));
    assert.ok(out.endsWith('\n…'), 'ends after a whole line, with the mark');
    assert.ok(lines.startsWith(out.slice(0, -1)), 'nothing but the end is changed');
    // one long line: cut where the limit is
    const one = clip('y'.repeat(5000), 1900);
    assert.equal(one.length, 1900);
    assert.ok(one.endsWith('y…'));
  });

  test('Discord gets the clipped text; Slack and a plain webhook get all of it', async () => {
    const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const sent = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts) => { sent.push([url, JSON.parse(opts.body)]); return { ok: true, status: 204 }; };
    try {
      await sendSummary('https://discord.com/api/webhooks/1/abc', { minutes: 1 }, long);
      await sendSummary('https://hooks.slack.com/services/T/B/x', { minutes: 1 }, long);
      await sendSummary('https://example.invalid/hook', { minutes: 1 }, long);
    } finally { globalThis.fetch = real; }
    const [discord, slack, plain] = sent.map(([, body]) => body);
    assert.ok(discord.content.length <= 1900 && discord.content.endsWith('…'), 'cut and marked');
    assert.equal(slack.text, long);
    assert.equal(plain.text, long);
  });
});

test('migration 12: a stored rarity of 0 becomes unknown; real rarities stay', async () => {
  const { openDb, SCHEMA_VERSION } = await import('../src/db.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-mig12-'));
  const file = path.join(dir, 'vestigo.db');
  const db = openDb(file);
  db.prepare("INSERT INTO games(title, norm_title, created_at, updated_at) VALUES ('X', 'x', 0, 0)").run();
  db.prepare("INSERT INTO entries(account_id, game_id, platform, ext_id, title, playtime_min, first_seen_at, last_synced_at) VALUES (NULL, 1, 'xbox', '1', 'X', 0, 0, 0)").run();
  const ins = db.prepare('INSERT INTO achievements(entry_id, ach_id, name, unlocked, rarity, first_seen_at, updated_at) VALUES (1, ?, ?, 1, ?, 0, 0)');
  ins.run('a', 'Zero', 0); ins.run('b', 'Real', 0.4); ins.run('c', 'None', null);
  db.exec('PRAGMA user_version = 11'); db.close();
  const again = openDb(file);
  try {
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.deepEqual(again.prepare('SELECT name, rarity FROM achievements ORDER BY ach_id').all().map((r) => [r.name, r.rarity]), [['Zero', null], ['Real', 0.4], ['None', null]]);
  } finally { again.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
