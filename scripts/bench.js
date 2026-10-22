// Load-test PlayTracker with a huge library:  node scripts/bench.js [games] [sessions]
// Seeds an in-memory DB directly, then times the heaviest API endpoints.
import { createApp } from '../src/server.js';
import { applyItems, parseAccount } from '../src/services/sync.js';
import { Settings } from '../src/services/settings.js';
import { tx } from '../src/db.js';

const GAMES = Number(process.argv[2] || 20000);
const SESSIONS = Number(process.argv[3] || 500000);
const quiet = { info() {}, warn() {}, error() {} };
const DAY = 86_400_000;

const { server, app, close } = createApp({ dbFile: process.env.BENCH_DB || ':memory:', log: quiet, scheduler: false });
const { db } = app;
const settings = new Settings(db);
const now = Date.now();
const words = ['Star', 'Dark', 'Legend', 'Space', 'Hollow', 'Final', 'Super', 'Iron', 'Shadow', 'Neon', 'Lost', 'Crystal', 'Dragon', 'Cyber', 'Silent', 'Wild'];
const nouns = ['Knight', 'Quest', 'Saga', 'Odyssey', 'Tactics', 'Racer', 'Souls', 'Frontier', 'Chronicles', 'Arena', 'Empire', 'Drift', 'Protocol', 'Hunter'];
const title = (i) => `${words[i % words.length]} ${nouns[(i * 7) % nouns.length]} ${Math.floor(i / 200) || ''} ${i % 3 === 0 ? 'Remastered' : ''}`.replace(/\s+/g, ' ').trim() + ` #${i}`;

function time(label, fn) {
  const t = performance.now();
  const r = fn();
  const ms = performance.now() - t;
  console.log(`${label.padEnd(44)} ${ms.toFixed(0).padStart(6)} ms`);
  return r;
}

time(`initial import of ${GAMES} games x 3 accounts`, () => {
  for (const [i, platform] of ['steam', 'xbox', 'psn'].entries()) {
    const id = Number(db.prepare('INSERT INTO accounts(platform, name, enabled, created_at) VALUES (?, ?, 0, 0)').run(platform, platform).lastInsertRowid);
    const items = Array.from({ length: Math.floor(GAMES / (i + 1)) }, (_, g) => ({ extId: `${platform}-${g}`, title: title(g), playtimeMin: (g * 37) % 5000 }));
    tx(db, () => applyItems(db, parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id)), items, { settings: settings.all(), now: now - 5 * 365 * DAY, syncId: null, initial: true }));
    db.prepare('UPDATE accounts SET last_sync_at = ? WHERE id = ?').run(now - 5 * 365 * DAY, id);
  }
});

time(`insert ${SESSIONS} play sessions`, () => tx(db, () => {
  const entries = db.prepare('SELECT id FROM entries').all().map((e) => e.id);
  const ins = db.prepare("INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, started_at, ended_at, created_at) VALUES (?, 'sync', 'play', ?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < SESSIONS; i++) {
    const end = now - Math.floor(Math.random() * 5 * 365 * DAY);
    const m = 15 + Math.floor(Math.random() * 180);
    const precise = i % 3 === 0;
    ins.run(entries[Math.floor(Math.random() ** 3 * entries.length)], m, end - DAY, end, precise ? end - m * 60000 : null, precise ? end : null, end);
  }
}));
if (app.rebuildRollups) time('rebuild rollups', () => app.rebuildRollups());

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
async function hit(path, opts) {
  const t = performance.now();
  const res = await fetch(base + path, opts);
  const body = await res.arrayBuffer();
  const ms = performance.now() - t;
  console.log(`${(opts?.method || 'GET')} ${path}`.padEnd(44), `${ms.toFixed(0).padStart(6)} ms  ${(body.byteLength / 1024).toFixed(0)} KB  ${res.status}`);
}
console.log('---');
for (const p of ['/summary', '/summary', '/games?limit=120', '/games?limit=120&sort=playtime', '/games?limit=120&offset=15000', '/games?q=dragon&limit=120', '/games?limit=5000',
  '/stats?range=30d', '/stats?range=365d', '/stats?range=all', '/stats/heatmap', '/stats/year/' + new Date().getFullYear(), '/stats/lifetime',
  '/sessions?limit=150', '/sessions?limit=150&offset=200000', '/games/1', '/duplicates', '/widget', '/export']) await hit(p);
// realistic follow-up sync: last sync yesterday, 10% of games played since
db.prepare('UPDATE accounts SET last_sync_at = ?').run(now - DAY);
db.prepare('UPDATE entries SET last_synced_at = ?').run(now - DAY);
const big = Array.from({ length: GAMES }, (_, g) => ({ id: `steam-${g}`, title: title(g), playtime_minutes: (g * 37) % 5000 + (g % 10 === 0 ? 60 : 0) }));
await hit('/accounts/1/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ games: big }) });
close();
