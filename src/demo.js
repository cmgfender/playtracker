// Seed a database with ~120 days of simulated daily syncs so the UI can be explored
// without real credentials:  node src/demo.js [path/to/db]
import { openDb, tx } from './db.js';
import { resolveDbFile } from './env.js';
import { Settings } from './services/settings.js';
import { applyItems, parseAccount } from './services/sync.js';

const LIB = {
  steam: [
    ['1145360', 'Hades', 5400, 0.5], ['1086940', "Baldur's Gate 3", 9000, 0.9], ['413150', 'Stardew Valley', 12000, 0.25],
    ['367520', 'Hollow Knight', 2500, 0.15], ['1245620', 'ELDEN RING', 7200, 0.4], ['620', 'Portal 2', 900, 0.02],
    ['292030', 'The Witcher 3: Wild Hunt', 6000, 0.05], ['1091500', 'Cyberpunk 2077', 3000, 0.2], ['250900', 'The Binding of Isaac: Rebirth', 4000, 0.1],
    ['105600', 'Terraria', 2200, 0.05], ['2379780', 'Balatro', 600, 0.6], ['1794680', 'Vampire Survivors', 1300, 0.1], ['753640', 'Outer Wilds', 0, 0.05],
  ],
  xbox: [
    ['1717113201', 'Forza Horizon 5', 4000, 0.3], ['219630713', 'Halo Infinite', 2600, 0.15], ['1659804324', 'Starfield', 1800, 0.08],
    ['2043073184', 'Hollow Knight: Voidheart Edition', 300, 0.02], ['1934093525', 'Sea of Thieves', 2100, 0.12],
  ],
  psn: [
    ['PPSA01411', "Marvel's Spider-Man 2", 1900, 0.3], ['PPSA07950', 'Final Fantasy VII Rebirth', 3600, 0.35], ['PPSA01628', 'Astro Bot', 700, 0.25],
    ['CUSA07408', 'God of War', 1500, 0.04], ['PPSA02292', 'ELDEN RING (PS5)', 1200, 0.1], ['CUSA00419', 'Bloodborne', 2400, 0.03],
  ],
};

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

export function seedDemo(db, { days = 120, now = Date.now() } = {}) {
  const settings = new Settings(db);
  const rand = rng(42);
  const DAY = 86_400_000;
  const accounts = {};
  for (const p of Object.keys(LIB)) {
    const name = { steam: 'Demo Steam', xbox: 'Demo Xbox', psn: 'Demo PlayStation' }[p];
    accounts[p] = Number(db.prepare('INSERT INTO accounts(platform, name, enabled, created_at) VALUES (?, ?, 0, ?)').run(p, name, now - days * DAY).lastInsertRowid);
  }
  const totals = Object.fromEntries(Object.entries(LIB).map(([p, list]) => [p, list.map((g) => g[2])]));
  const start = new Date(now - days * DAY); start.setHours(4, 0, 0, 0);
  const firstPlayed = {};
  for (let d = 0; d <= days; d++) {
    const t = start.getTime() + d * DAY;
    if (t > now) break;
    const weekend = [0, 6].includes(new Date(t).getDay());
    for (const [p, list] of Object.entries(LIB)) {
      const accId = accounts[p];
      const items = list.map(([extId, title, , weight], i) => {
        if (d > 0 && rand() < weight * (weekend ? 0.55 : 0.28)) totals[p][i] += Math.round(20 + rand() * (weekend ? 240 : 110));
        // first sync: realistic "last played" spread over the past year (drives history inference)
        const lastPlayed = d === 0 ? t - Math.round((1 + rand() * 360) * DAY) : t - Math.round(rand() * 6 * 3600_000);
        if (d === 0 && totals[p][i]) firstPlayed[`${p}:${i}`] = lastPlayed - Math.round((30 + rand() * 500) * DAY);
        return {
          extId, title, playtimeMin: totals[p][i], lastPlayedAt: totals[p][i] ? lastPlayed : null,
          ...(p === 'psn' && totals[p][i] ? { firstPlayedAt: firstPlayed[`${p}:${i}`], playCount: Math.round(totals[p][i] / 95) + d } : {}),
          ...(p === 'steam' && d === 0 ? { recentMin: weight > 0.3 ? Math.round(rand() * 600) : 0 } : {}),
          coverUrl: p === 'steam' ? `https://cdn.cloudflare.steamstatic.com/steam/apps/${extId}/library_600x900.jpg` : null,
          iconUrl: null,
        };
      });
      tx(db, () => {
        const account = parseAccount(db.prepare('SELECT * FROM accounts WHERE id = ?').get(accId));
        const syncId = Number(db.prepare("INSERT INTO syncs(account_id, trigger, started_at, initial, status) VALUES (?, 'schedule', ?, ?, 'ok')").run(accId, t, d === 0 ? 1 : 0).lastInsertRowid);
        const s = applyItems(db, account, items, { settings: settings.all(), now: t, syncId, initial: d === 0 });
        db.prepare('UPDATE syncs SET finished_at = ?, games_seen = ?, games_changed = ?, games_new = ?, sessions_created = ?, minutes_added = ?, baseline_minutes = ? WHERE id = ?')
          .run(t + 2000, s.games_seen, s.games_changed, s.games_new, s.sessions_created, s.minutes_added, s.baseline_minutes, syncId);
        db.prepare("UPDATE accounts SET last_sync_at = ?, last_status = 'ok' WHERE id = ?").run(t, accId);
      });
    }
  }
  db.prepare("UPDATE games SET status = 'playing' WHERE title IN ('Balatro', 'Baldur''s Gate 3', 'Final Fantasy VII Rebirth')").run();
  db.prepare("UPDATE games SET status = 'completed', rating = 10, favorite = 1 WHERE title IN ('Hades', 'Hollow Knight', 'Astro Bot')").run();
  db.prepare("UPDATE games SET status = 'backlog' WHERE title = 'Outer Wilds'").run();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] || resolveDbFile(); // the database the server would open
  const db = openDb(file);
  if (db.prepare('SELECT COUNT(*) n FROM accounts').get().n) {
    console.error('Database already has accounts; refusing to seed demo data.');
    process.exit(1);
  }
  seedDemo(db);
  console.log(`Seeded demo data into ${file}`);
}
