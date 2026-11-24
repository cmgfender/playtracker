// What is known about when an entry's pre-tracking history was played, for the people answering
// "when did you play this?": every date the platforms, IGDB and tracking report (release, added to
// the library, first and last played, the first and last achievement, the first tracked session),
// the unlocks by month, the other platforms' history of the same game - and where a window
// (yours, or one you are about to set) disagrees with that evidence.
import { realTime, looksCoarse } from './inference.js';

const DAY = 86_400_000;
const PLATFORM = { steam: 'Steam', xbox: 'Xbox', psn: 'PlayStation' };
const monthKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const fmt = (t) => new Date(t).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * The evidence about one entry's history. null when the entry has none (no pre-tracking minutes).
 * `window` overrides the window conflicts are checked against (a window about to be set).
 */
export function historyContext(db, entryId, { window = null } = {}) {
  const e = db.prepare('SELECT e.*, a.name account_name, a.state account_state FROM entries e LEFT JOIN accounts a ON a.id = e.account_id WHERE e.id = ?').get(entryId);
  if (!e || !(e.baseline_min > 0)) return null;
  const h = JSON.parse(e.hist || '{}');
  const acc = (() => { try { return JSON.parse(e.account_state || '{}'); } catch { return {}; } })();
  const ts = h.tracking_start || e.first_seen_at;
  const where = PLATFORM[e.platform] || null;
  const meta = db.prepare('SELECT release_date, name FROM game_meta WHERE game_id = ? AND igdb_id IS NOT NULL').get(e.game_id);
  // unlocks before tracking began (the ones that say when the history was played)
  const unl = db.prepare('SELECT name, unlocked_at t FROM achievements WHERE entry_id = ? AND unlocked = 1 AND unlocked_at IS NOT NULL ORDER BY unlocked_at').all(entryId)
    .filter((a) => realTime(a.t) != null);
  const pre = unl.filter((a) => a.t < ts);
  const counts = db.prepare('SELECT COUNT(*) n, SUM(unlocked) u FROM achievements WHERE entry_id = ?').get(entryId);
  const byMonth = new Map();
  for (const a of pre) byMonth.set(monthKey(a.t), (byMonth.get(monthKey(a.t)) || 0) + 1);
  const tracked = db.prepare(`SELECT MIN(COALESCE(s.started_at, s.window_start, s.window_end)) first, COUNT(*) n FROM sessions s JOIN entries x ON x.id = s.entry_id
    WHERE x.game_id = ? AND s.kind = 'play'`).get(e.game_id);
  const others = db.prepare('SELECT e.id, e.platform, e.baseline_min, e.hist, a.name account_name FROM entries e LEFT JOIN accounts a ON a.id = e.account_id WHERE e.game_id = ? AND e.id <> ? AND e.baseline_min > 0 AND e.excluded = 0')
    .all(e.game_id, entryId).map((o) => {
      const oh = JSON.parse(o.hist || '{}');
      return { entry_id: o.id, platform: o.platform, account_name: o.account_name, minutes: o.baseline_min, window: oh.inference?.window || null, manual: !!(oh.manual?.start || oh.manual?.end) };
    });

  const release = realTime(h.release_at);
  const igdbRelease = realTime(meta?.release_date);
  const marks = [
    release && { key: 'release', label: 'Released', at: release, source: e.platform === 'steam' ? 'Steam store' : 'store', use: 'start' },
    // IGDB's date is the first release of what it matched: an early-access game's 1.0, another edition's date
    igdbRelease && (!release || Math.abs(igdbRelease - release) > 30 * DAY) && { key: 'release_igdb', label: 'Released', at: igdbRelease, source: `IGDB${meta.name ? `: ${meta.name}` : ''}`, use: 'start' },
    realTime(acc.account_created_at) && e.platform === 'steam' && { key: 'account', label: 'Steam account created', at: acc.account_created_at, use: 'start' },
    realTime(h.date_added) && { key: 'added', label: 'Added to library', at: h.date_added, source: e.platform === 'steam' ? 'Steam licenses' : 'import', use: 'start' },
    realTime(h.first_played_at) && { key: 'first_played', label: 'First played', at: h.first_played_at, source: where || 'import', use: 'start' },
    pre.length && { key: 'first_unlock', label: 'First achievement', at: pre[0].t, detail: pre[0].name || null, use: 'start' },
    pre.length > 1 && { key: 'last_unlock', label: 'Last achievement before tracking', at: pre.at(-1).t, detail: pre.at(-1).name || null, use: 'end' },
    realTime(h.last_played_at) && h.last_played_at < ts + DAY && { key: 'last_played', label: 'Last played', at: Math.min(h.last_played_at, ts), source: where || 'import', use: 'end' },
    realTime(tracked?.first) && { key: 'first_tracked', label: 'First tracked session', at: tracked.first, use: 'end' },
    // (a game added by hand: the day it was added)
    { key: 'tracking', label: e.account_id == null && e.platform === 'manual' ? 'Added to Vestigo' : 'Tracking began', at: ts, use: 'end' },
  ].filter(Boolean).sort((a, b) => a.at - b.at);

  const manual = h.manual && (h.manual.start || h.manual.end) ? h.manual : null;
  const ctx = {
    entry_id: e.id, game_id: e.game_id, platform: e.platform, account_name: e.account_name, minutes: e.baseline_min, tracking_start: ts,
    mode: h.mode || 'auto', confidence: h.inference?.confidence || null, window: h.inference?.window || null, reasons: h.inference?.reasons || [],
    manual: manual ? { start: manual.start || null, end: manual.end || null, confirmed: !!manual.confirmed, coarse: !!(manual.coarse ?? looksCoarse(manual)), acknowledged: !!manual.ack } : null,
    // achievement times are still to be read: an estimate made now may move once they are
    enrich_pending: !!(e.account_id && ['steam', 'xbox', 'psn'].includes(e.platform) && !e.enriched_at),
    marks,
    unlocks: {
      total: counts.n || 0, unlocked: counts.u || 0, before_tracking: pre.length,
      times: pre.slice(-500).map((a) => a.t),
      by_month: [...byMonth].map(([key, n]) => ({ key, n })),
    },
    tracked_sessions: tracked?.n || 0,
    others,
  };
  // checked: a window about to be set, or yours (an automatic one is worked out from this evidence)
  const w = window || (manual ? [manual.start || null, manual.end || null] : null);
  ctx.conflicts = conflicts(ctx, h, w);
  return ctx;
}

/**
 * Where a window disagrees with the evidence. Each: { kind, text }. A window's start or end may be
 * null (only one of them set): that side is not checked.
 */
export function conflicts(ctx, h, w) {
  if (!w || (w[0] == null && w[1] == null) || ctx.mode === 'undated') return [];
  const [s, en] = w;
  const ts = ctx.tracking_start;
  const out = [];
  const times = ctx.unlocks.times;
  const where = PLATFORM[ctx.platform] || 'The import';
  if (s != null) {
    const before = times.filter((t) => t < s - DAY);
    if (before.length) out.push({ kind: 'unlocks_before', at: before[0], n: before.length, text: `${plural(before.length, 'achievement')} unlocked before this start, the first on ${fmt(before[0])}` });
    const fp = realTime(h.first_played_at);
    if (fp && fp < s - 7 * DAY) out.push({ kind: 'first_played_before', at: fp, text: `${where} says it was first played on ${fmt(fp)}, before this start` });
    // a start before the game existed (unless unlocks say the release date is wrong for this copy)
    const rel = realTime(h.release_at) ?? null;
    const igdb = ctx.marks.find((m) => m.key === 'release_igdb')?.at ?? null;
    const firstUnlock = times[0] ?? Infinity;
    for (const [r, src] of [[rel, 'the store'], [igdb, 'IGDB']]) {
      if (r && s < r - 30 * DAY && firstUnlock > r - DAY) {
        out.push({ kind: 'before_release', at: r, text: `This start is before ${src === 'IGDB' ? 'the release date IGDB has' : 'the release date'} (${fmt(r)})${src === 'IGDB' ? ' - an early-access game\'s or another edition\'s date may be later than yours' : ''}` });
        break;
      }
    }
  }
  if (en != null) {
    const after = times.filter((t) => t > en + DAY && t < ts);
    if (after.length) out.push({ kind: 'unlocks_after', at: after.at(-1), n: after.length, text: `${plural(after.length, 'achievement')} unlocked after this end, the last on ${fmt(after.at(-1))}` });
    const lp = realTime(h.last_played_at);
    if (lp && lp < ts && lp > en + 7 * DAY) out.push({ kind: 'last_played_after', at: lp, text: `${where} says it was last played on ${fmt(lp)}, after this end` });
  }
  return out;
}
