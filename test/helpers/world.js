// A simulated player + platforms that report play the way the real ones do.
// Used by the long-run verification test.
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function localDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }

/**
 * Realistic per-platform timeline: each game has a first day, an intense burst, a taper and
 * occasional returns; at most one game at a time; evening sessions, some past midnight.
 * Returns non-overlapping sessions {game, start, end, minutes}.
 */
export function makeTimeline({ seed, from, to, games, legacyGames = [] }) {
  const r = rng(seed);
  const plans = Array.from({ length: games }, (_, g) => {
    const first = from + r() * (to - from) * 0.85;
    return { g, first, burst: 7 + r() * 25, rate: 0.5 + r() * 0.4, tail: 0.04 + r() * 0.12, last: first + (30 + r() * 300) * DAY };
  });
  const sessions = [];
  for (let day = localDay(from); day < to; day = addDays(day, 1)) {
    let t = day + (17 + r() * 4) * HOUR;
    for (let slot = 0; slot < 2; slot++) {
      const candidates = plans.filter((p) => !legacyGames.includes(p.g) && day >= localDay(p.first) && day <= p.last).map((p) => {
        const age = (day - p.first) / DAY;
        return { p, w: age < p.burst ? p.rate : p.tail };
      });
      const pick = candidates.find((c) => r() < c.w / (slot + 1));
      if (!pick) continue;
      const minutes = Math.round(25 + r() * (slot ? 90 : 200));
      const start = Math.round(Math.max(t, day + 12 * HOUR));
      const end = start + minutes * MIN;
      if (end > to) continue;
      sessions.push({ game: pick.p.g, start, end, minutes });
      t = end + (20 + r() * 90) * MIN;
    }
  }
  // legacy games: old play before platform timestamps existed (no last-played reported)
  for (const g of legacyGames) {
    for (let i = 0; i < 6; i++) {
      const start = from - (900 + i * 3) * DAY;
      sessions.push({ game: g, start, end: start + 90 * MIN, minutes: 90, legacy: true });
    }
  }
  return sessions.sort((a, b) => a.start - b.start);
}

const done = (truth, g, t) => truth.filter((s) => s.game === g && s.end <= t);

export const platforms = {
  steam: {
    extId: (g) => String(1000 + g),
    title: (g) => `Steam Game ${g}`,
    /** offline sessions are only uploaded at `uploadAt` */
    report(truth, t, games, { refunded = new Set(), owned = null } = {}) {
      const out = [];
      for (let g = 0; g < games; g++) {
        if (refunded.has(g)) continue;
        if (owned && !owned(g, t)) continue;
        const visible = truth.filter((s) => s.game === g && s.end <= t && (!s.uploadAt || s.uploadAt <= t));
        const total = visible.reduce((a, s) => a + s.minutes, 0);
        const offline = visible.filter((s) => s.uploadAt).reduce((a, s) => a + s.minutes, 0);
        const recent = visible.filter((s) => s.end > t - 14 * DAY).reduce((a, s) => a + s.minutes, 0);
        const launches = truth.filter((s) => s.game === g && s.start <= t && !s.legacy && (!s.uploadAt || s.uploadAt <= t));
        out.push({
          extId: this.extId(g), title: this.title(g), playtimeMin: total, recentMin: recent,
          lastPlayedAt: launches.at(-1)?.start ?? null, // legacy play has no timestamp
          devices: { windows: total - offline, deck: 0, offline }, meta: { has_stats: true },
        });
      }
      return out;
    },
  },
  psn: {
    extId: (g) => `PPSA${String(g).padStart(5, '0')}_00`,
    title: (g) => `PS Game ${g}`,
    report(truth, t, games) {
      return Array.from({ length: games }, (_, g) => {
        const d = done(truth, g, t - 15 * MIN);
        return {
          extId: this.extId(g), title: this.title(g), playtimeMin: d.reduce((a, s) => a + s.minutes, 0),
          lastPlayedAt: d.at(-1)?.end ?? null, firstPlayedAt: d[0]?.start ?? null, playCount: d.length, groupKey: `psn-concept:${g}`,
        };
      }).filter((i) => i.playtimeMin > 0 || i.playCount > 0);
    },
  },
  xbox: {
    extId: (g) => String(5000 + g),
    title: (g) => `Xbox Game ${g}`,
    report(truth, t, games, { only = null } = {}) {
      const out = [];
      for (let g = 0; g < games; g++) {
        if (only && !only.includes(g)) continue;
        let total = 0; let last = null;
        for (const s of truth.filter((x) => x.game === g && x.start <= t)) {
          const flushed = Math.min(s.minutes, Math.max(0, Math.floor((t - 10 * MIN - s.start) / (5 * MIN)) * 5));
          total += s.end <= t - 10 * MIN ? s.minutes : flushed;
          last = Math.min(t, s.end);
        }
        if (total > 0) out.push({ extId: this.extId(g), title: this.title(g), playtimeMin: total, lastPlayedAt: last });
      }
      return out;
    },
  },
};

/** Minutes per local day for a set of sessions (minute-resolution split). */
export function minutesByDay(sessions) {
  const m = new Map();
  for (const s of sessions) {
    for (let t = s.start; t < s.end; t += MIN) {
      const d = new Date(t);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
  }
  return m;
}

export function minutesByMonth(dayMap) {
  const m = new Map();
  for (const [k, v] of dayMap) m.set(k.slice(0, 7), (m.get(k.slice(0, 7)) || 0) + v);
  return m;
}

/** Share of minutes in the wrong bucket (0 = perfect). */
export function misplacement(a, b) {
  let err = 0; let total = 0;
  for (const v of a.values()) total += v;
  for (const k of new Set([...a.keys(), ...b.keys()])) err += Math.abs((a.get(k) || 0) - (b.get(k) || 0));
  return total ? err / 2 / total : 0;
}
