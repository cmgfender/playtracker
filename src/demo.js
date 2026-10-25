// Seed a database with ~120 days of simulated daily syncs so the UI can be explored
// without real credentials:  node src/demo.js [path/to/db]
import { openDb, tx } from './db.js';
import { resolveDbFile } from './env.js';
import { Settings } from './services/settings.js';
import { applyItems, parseAccount } from './services/sync.js';
import { storeAchievements, ACH_VERSION } from './services/achievements.js';
import { sessionInterval } from './services/stats.js';

const ACH_NAMES = ['First Steps', 'Explorer', 'Collector', 'Night Owl', 'Sharpshooter', 'Survivor', 'Treasure Hunter', 'Untouchable', 'Lorekeeper', 'Daredevil',
  'Pacifist', 'Globetrotter', 'Speedrunner', 'Master Tactician', 'Big Spender', 'Champion', 'Perfectionist', 'Secret Keeper', 'Legend', 'Completionist'];
const COMPLETE = new Set(['Hades', 'Astro Bot', 'Halo Infinite']);

/** Demo achievements / trophies: unlocked during the entries' sessions (tracked or dated history). */
function seedAchievements(db, rand, now) {
  for (const e of db.prepare('SELECT e.id, e.platform, g.title FROM entries e JOIN games g ON g.id = e.game_id WHERE e.account_id IS NOT NULL AND e.playtime_min > 0').all()) {
    const sessions = db.prepare("SELECT kind, minutes, started_at, ended_at, window_start, window_end, created_at FROM sessions WHERE entry_id = ? AND kind IN ('play', 'estimate')").all(e.id);
    if (!sessions.length) continue;
    const n = 12 + Math.floor(rand() * 28);
    const reach = COMPLETE.has(e.title) ? 1 : rand() * 0.9;
    const items = Array.from({ length: n }, (_, i) => {
      const s = rand() < reach ? sessions[Math.floor(rand() * sessions.length)] : null;
      const [a, b] = s ? sessionInterval(s) : [0, 0];
      return {
        id: e.platform === 'psn' ? `NPWR9${String(e.id).padStart(4, '0')}_00:${i}` : e.platform === 'xbox' ? String(i + 1) : `ACH_${i}`,
        name: `${ACH_NAMES[i % ACH_NAMES.length]}${i >= ACH_NAMES.length ? ` ${Math.floor(i / ACH_NAMES.length) + 1}` : ''}`,
        description: `Demo achievement ${i + 1} of ${e.title}`,
        unlocked: !!s, unlocked_at: s ? Math.round(a + rand() * (b - a)) : null,
        rarity: Math.round((0.4 + rand() ** 2 * 85) * 10) / 10,
        points: e.platform === 'xbox' ? [5, 10, 15, 20, 25, 50, 100][Math.floor(rand() * 7)] : null,
        grade: e.platform === 'psn' ? ['bronze', 'bronze', 'bronze', 'silver', 'silver', 'gold'][Math.floor(rand() * 6)] : null,
        hidden: rand() < 0.1,
      };
    });
    if (e.platform === 'psn') {
      // the platinum: earned with the last of the others
      const all = items.every((x) => x.unlocked);
      items.push({ id: `NPWR9${String(e.id).padStart(4, '0')}_00:${n}`, name: `${e.title} Platinum`, description: 'Earn every other trophy', grade: 'platinum', rarity: 2.1,
        unlocked: all, unlocked_at: all ? Math.max(...items.map((x) => x.unlocked_at)) : null });
    }
    storeAchievements(db, e.id, items, { now });
    db.prepare('UPDATE entries SET ach_v = ?, ach_at = ? WHERE id = ?').run(ACH_VERSION, now, e.id);
  }
}

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
  seedAchievements(db, rand, now);
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
