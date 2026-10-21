// History inference: decide *when* pre-tracking playtime most likely happened.
//
// Platforms only tell us lifetime totals, so a first import would otherwise dump hundreds
// of hours onto import day. Instead every bit of evidence we have is combined:
//
//   evidence                         source                              effect
//   ------------------------------   ---------------------------------   -------------------------------
//   last played                      Steam rtime_last_played, PSN,       hard end of the window
//                                    Xbox lastTimePlayed, CSV
//   first played                     PSN firstPlayedDateTime, CSV        hard start of the window
//   recent minutes (N days)          Steam playtime_2weeks               exact minutes inside last N days
//   play count                       PSN playCount                       number of play days / burst length
//   achievement/trophy unlocks       Steam GetPlayerAchievements,        activity anchors (when play
//                                    Xbox achievements                   actually happened)
//   date added / purchased           CSV date_added, first seen in a     lower bound for the start
//                                    later sync
//   release date                     Steam store appdetails              lower bound (can't play earlier)
//   account created                  Steam GetPlayerSummaries            lower bound
//   manual override                  user (game page)                    replaces start/end
//
// Minutes are spread over the window with a "burst then taper" shape (people play a game
// intensely after starting it, then return occasionally, with a bump near the last session),
// anchors add weight on the days achievements were earned, each day is capped at a
// plausible maximum and days with only a few minutes are folded into busier ones.
// The result is stored as 'estimate' sessions: charted (and flagged) in stats, excluded
// from streaks; anything we can't date at all stays 'baseline' (lifetime totals only).

export const INFER_VERSION = 2;
const DAY = 86_400_000;

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }
function daysBetween(a, b) { return Math.round((startOfDay(b) - startOfDay(a)) / DAY); }

/**
 * Allocate `minutes` across days [0, n) using weights, honoring a per-day cap and a
 * minimum per active day. Returns an array of minutes per day (floats).
 */
export function allocate(minutes, weights, { cap = 600, minDay = 15 } = {}) {
  const n = weights.length;
  const alloc = new Array(n).fill(0);
  if (!n || minutes <= 0) return alloc;
  const caps = Array.isArray(cap) ? cap : null;
  const capOf = (i) => (caps ? caps[i] : cap);
  if (minutes < minDay) {
    // too little to spread: put it all on the most likely day that has room
    let best = -1;
    for (let i = 0; i < n; i++) if (capOf(i) >= minutes && (best < 0 || weights[i] > weights[best])) best = i;
    if (best < 0) for (let i = 0; i < n; i++) if (best < 0 || capOf(i) > capOf(best)) best = i;
    alloc[best] = Math.min(minutes, capOf(best));
    return alloc;
  }
  const active = weights.map((w, i) => w > 0 && capOf(i) > 0);
  if (!active.some(Boolean)) active.fill(true);
  for (let iter = 0; iter < 25; iter++) {
    let wsum = 0;
    for (let i = 0; i < n; i++) if (active[i] && alloc[i] < capOf(i)) wsum += weights[i] || 1e-9;
    const fixed = alloc.reduce((a, x, i) => a + (active[i] && alloc[i] >= capOf(i) ? capOf(i) : 0), 0);
    let remaining = minutes - fixed;
    // distribute remaining over non-capped active days
    for (let i = 0; i < n; i++) {
      if (!active[i]) { alloc[i] = 0; continue; }
      if (alloc[i] >= capOf(i)) { alloc[i] = capOf(i); continue; }
      alloc[i] = wsum ? (remaining * (weights[i] || 1e-9)) / wsum : 0;
    }
    let changed = false;
    for (let i = 0; i < n; i++) if (alloc[i] > capOf(i)) { alloc[i] = capOf(i); changed = true; }
    // fold tiny days into busier ones (never drop the last active day)
    if (minutes >= minDay) {
      const activeCount = active.filter(Boolean).length;
      let smallest = -1;
      for (let i = 0; i < n; i++) if (active[i] && alloc[i] < minDay && (smallest < 0 || alloc[i] < alloc[smallest])) smallest = i;
      if (smallest >= 0 && activeCount > 1 && wsum > 0) {
        // drop all tiny days at once for speed, keeping the heaviest-weighted one
        let best = -1;
        for (let i = 0; i < n; i++) if (active[i] && (best < 0 || weights[i] > weights[best])) best = i;
        for (let i = 0; i < n; i++) if (active[i] && alloc[i] < minDay && i !== best) { active[i] = false; changed = true; }
      }
    }
    remaining = minutes - alloc.reduce((a, x) => a + x, 0);
    if (!changed && Math.abs(remaining) < 0.01) break;
  }
  return alloc;
}

function chunkDays(dayStart, alloc, { maxRun = 7 } = {}) {
  // merge consecutive active days (similar volume) into chunks to keep row counts small
  const chunks = [];
  let cur = null;
  for (let i = 0; i < alloc.length; i++) {
    const m = alloc[i];
    if (m <= 0) { cur = null; continue; }
    const start = addDays(dayStart, i);
    if (cur && cur.days < maxRun && Math.abs(m - cur.minutes / cur.days) <= Math.max(10, 0.35 * (cur.minutes / cur.days))) {
      cur.minutes += m; cur.days++; cur.end = addDays(start, 1) - 1;
    } else {
      cur = { start, end: addDays(start, 1) - 1, minutes: m, days: 1 };
      chunks.push(cur);
    }
  }
  return chunks;
}

/** Integer-round chunk minutes while preserving the total exactly. */
function roundChunks(chunks, total) {
  const out = chunks.map((c) => ({ ...c, minutes: Math.floor(c.minutes) }));
  let rest = Math.round(total) - out.reduce((a, c) => a + c.minutes, 0);
  const order = chunks.map((c, i) => [c.minutes - Math.floor(c.minutes), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && order.length; k = (k + 1) % order.length, rest--) out[order[k][1]].minutes++;
  return out.filter((c) => c.minutes > 0);
}

/**
 * @param {object} e evidence
 * @param {number} e.minutes            pre-tracking minutes to place
 * @param {number} e.trackingStart      when tracking began (nothing can be placed after it)
 * @param {number} [e.lastPlayedAt]
 * @param {number} [e.firstPlayedAt]
 * @param {number} [e.playCount]
 * @param {number[]} [e.anchors]        activity timestamps (achievement unlocks, ...)
 * @param {{minutes:number, days:number}} [e.recent]  minutes known to be in the last N days
 * @param {number} [e.dateAdded]
 * @param {number} [e.releaseAt]
 * @param {number} [e.accountCreatedAt]
 * @param {{start?:number,end?:number}} [e.manual]
 * @param {'auto'|'undated'} [e.mode]
 */
export function inferHistory(e, { pacePerDay = 90, maxPerDay = 600, minDay = 15, dayRoom = null } = {}) {
  // per-day capacity: this game's own cap, limited by what other games already use that day
  const capsFor = (d0, n) => Array.from({ length: n }, (_, i) => Math.min(maxPerDay, dayRoom ? dayRoom(addDays(d0, i)) : Infinity));
  const total = Math.max(0, Math.round(e.minutes || 0));
  const result = { chunks: [], undated: 0, confidence: null, window: null, reasons: [] };
  if (!total) return result;
  if (e.mode === 'undated') { result.undated = total; result.reasons.push('Charting disabled for this game'); return result; }
  const T = e.trackingStart || Date.now();
  const lower = Math.max(e.releaseAt || 0, e.accountCreatedAt || 0, Date.UTC(1995, 0, 1));
  const anchors = (e.anchors || []).filter((a) => a && a >= lower && a <= T).sort((a, b) => a - b);
  let remaining = total;
  const conf = [];

  // 1) Minutes known to be recent (Steam's 2-week counter): place them inside that window,
  //    never after the last played time, with a bump on the last-played day.
  let upper = Math.min(T, e.lastPlayedAt && e.lastPlayedAt <= T ? e.lastPlayedAt : T);
  if (e.recent?.minutes > 0) {
    const r = Math.min(e.recent.minutes, remaining);
    const wStart = Math.max(lower, T - (e.recent.days || 14) * DAY);
    // a last-played date older than the recent window contradicts the counter: trust the counter
    if (upper < wStart) upper = T;
    const wEnd = Math.max(wStart, upper);
    const d0 = startOfDay(wStart);
    const n = daysBetween(d0, wEnd) + 1;
    const last = n - 1;
    const weights = Array.from({ length: n }, (_, i) => 1 + 3 * Math.exp(-((last - i) ** 2) / 4)
      + anchors.reduce((a, t) => a + 2 * Math.exp(-((daysBetween(d0, t) - i) ** 2) / 2), 0));
    const alloc = allocate(r, weights, { cap: capsFor(d0, n), minDay });
    const placed = alloc.reduce((a, x) => a + x, 0);
    result.chunks.push(...chunkDays(d0, alloc).map((c) => ({ ...c, confidence: 'medium', why: 'recent' })));
    remaining -= placed;
    conf.push('medium');
    result.reasons.push(`${Math.round(placed)} min placed in the last ${e.recent.days || 14} days (platform's recent-play counter)`);
    // the rest happened before the recent window
    upper = Math.min(upper, wStart - 1);
  }

  if (remaining > 0.5) {
    let end = e.manual?.end ?? (e.lastPlayedAt && e.lastPlayedAt <= upper ? e.lastPlayedAt : null);
    const anchorMax = anchors.filter((a) => a <= upper).at(-1);
    if (end == null && anchorMax) end = anchorMax;
    if (end == null && e.recent?.minutes > 0) end = upper; // known to be before the recent window
    if (end != null) end = Math.min(end, upper);
    let start = e.manual?.start ?? e.firstPlayedAt ?? (anchors.length ? anchors[0] : null) ?? e.dateAdded ?? null;
    const knownStart = start != null;
    const knownEnd = end != null;
    const burstDays = Math.max(1, Math.ceil(remaining / pacePerDay), e.playCount ? Math.ceil(e.playCount * 1.2) : 0);

    if (!knownEnd && !knownStart) {
      result.undated = Math.round(remaining);
      result.reasons.push('No dates available - kept as undated history (lifetime totals only)');
    } else {
      if (!knownEnd) end = Math.min(upper, addDays(start, burstDays));
      if (!knownStart) start = addDays(end, -burstDays);
      start = Math.max(start, lower);
      if (start > end) start = startOfDay(end);
      // make room if even capped days cannot hold everything
      let d0 = startOfDay(start);
      let n = daysBetween(d0, end) + 1;
      const needed = Math.ceil(remaining / maxPerDay);
      if (n < needed && !(e.manual?.start)) {
        d0 = startOfDay(Math.max(lower, addDays(end, -needed + 1)));
        n = daysBetween(d0, end) + 1;
      }
      const origStart = d0;
      const build = (dStart, len) => {
        const endIdx = len - 1;
        const off = daysBetween(dStart, origStart); // days added before the original start (when widened)
        const tau = Math.max(1, Math.min(burstDays, len));
        const tauEnd = Math.max(2, tau / 3);
        const anchorIdx = anchors.filter((a) => a >= dStart && a <= end).map((a) => daysBetween(dStart, a));
        return Array.from({ length: len }, (_, i) => {
          let w = (knownStart ? 1 : 0.6) * Math.exp(-Math.max(0, i - off) / tau) + 0.03;
          if (knownEnd) w += 0.6 * Math.exp(-(endIdx - i) / tauEnd);
          for (const a of anchorIdx) w += 1.5 * Math.exp(-((a - i) ** 2) / 4.5);
          return w;
        });
      };
      let alloc = allocate(remaining, build(d0, n), { cap: capsFor(d0, n), minDay });
      let placed = alloc.reduce((a, x) => a + x, 0);
      // days already busy with other games: widen the window backwards (unless set manually)
      for (let tries = 0; remaining - placed > 0.5 && !e.manual?.start && tries < 4; tries++) {
        const extra = Math.ceil((remaining - placed) / Math.max(60, maxPerDay / 2)) * (tries + 1) + 7;
        const nd0 = startOfDay(Math.max(lower, addDays(d0, -extra)));
        if (nd0 >= d0) break;
        const nn = daysBetween(nd0, end) + 1;
        const a2 = allocate(remaining, build(nd0, nn), { cap: capsFor(nd0, nn), minDay });
        d0 = nd0; n = nn; alloc = a2;
        placed = alloc.reduce((a, x) => a + x, 0);
      }
      result.chunks.push(...chunkDays(d0, alloc).map((c) => ({ ...c, why: 'history' })));
      if (remaining - placed > 0.5) result.undated += Math.round(remaining - placed);
      let c;
      if (e.manual?.start || e.manual?.end) { c = 'high'; result.reasons.push('Window set manually'); }
      else if (e.firstPlayedAt && knownEnd) { c = 'high'; result.reasons.push('Platform reports first and last played dates'); }
      else if (anchors.length >= 3) { c = 'medium'; result.reasons.push(`${anchors.length} achievement/trophy unlock times`); }
      else if (knownStart && knownEnd) { c = 'medium'; result.reasons.push('Bounded by date added/first activity and last played'); }
      else { c = 'low'; result.reasons.push(knownEnd ? 'Only the last played date is known' : 'Only a start date is known'); }
      if (e.playCount) result.reasons.push(`${e.playCount} launches reported`);
      if (e.releaseAt && start <= e.releaseAt + DAY) result.reasons.push('Clamped to release date');
      conf.push(c);
      for (const ch of result.chunks) if (ch.why === 'history') ch.confidence = c;
      result.window = [d0, end];
    }
  }
  const rank = { high: 3, medium: 2, low: 1 };
  result.confidence = conf.sort((a, b) => rank[a] - rank[b])[0] || null;
  const toPlace = total - result.undated;
  result.chunks = roundChunks(result.chunks, toPlace).sort((a, b) => a.start - b.start);
  // window covers recent part too
  if (result.chunks.length) result.window = [result.chunks[0].start, result.chunks.at(-1).end];
  return result;
}

/** Evidence object for an entry row (+ account context). */
export function evidenceFor(entry, account, trackingStart) {
  const h = typeof entry.hist === 'string' ? JSON.parse(entry.hist || '{}') : (entry.hist || {});
  return {
    minutes: entry.baseline_min,
    trackingStart: h.tracking_start || trackingStart || entry.first_seen_at,
    lastPlayedAt: h.last_played_at ?? null,
    firstPlayedAt: h.first_played_at ?? null,
    playCount: h.play_count ?? null,
    anchors: h.anchors || [],
    recent: h.recent_min ? { minutes: h.recent_min, days: h.recent_days || 14 } : null,
    dateAdded: h.date_added ?? null,
    releaseAt: h.release_at ?? null,
    accountCreatedAt: account?.state?.account_created_at ?? h.account_created_at ?? null,
    manual: h.manual || null,
    mode: h.mode || 'auto',
  };
}

/**
 * Replace an entry's inferred history sessions (estimates + undated baseline) based on
 * its stored evidence. Safe to call repeatedly (e.g. after enrichment adds anchors).
 */
export function reinferEntry(db, entryId, { account = null, load = null, settings = null } = {}) {
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
  if (!entry) return null;
  db.prepare("DELETE FROM sessions WHERE entry_id = ? AND source = 'inferred'").run(entryId);
  const acc = account || (entry.account_id ? db.prepare('SELECT state FROM accounts WHERE id = ?').get(entry.account_id) : null);
  const accountObj = acc ? { state: typeof acc.state === 'string' ? JSON.parse(acc.state || '{}') : acc.state } : null;
  const ev = evidenceFor(entry, accountObj, entry.first_seen_at);
  const res = inferHistory(ev, { dayRoom: load ? (t) => load.room(t) : null, maxPerDay: Number(settings?.history_max_game_day_minutes) || 600 });
  load?.add(res.chunks);
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO sessions(entry_id, source, kind, minutes, window_start, window_end, confidence, note, created_at)
    VALUES (?, 'inferred', ?, ?, ?, ?, ?, ?, ?)`);
  for (const c of res.chunks) ins.run(entryId, 'estimate', c.minutes, c.start, c.end, c.confidence, c.why === 'recent' ? 'Recent play before tracking' : 'Estimated from history', now);
  if (res.undated > 0) ins.run(entryId, 'baseline', res.undated, null, ev.trackingStart, null, 'Undated history', now);
  const h = JSON.parse(entry.hist || '{}');
  h.inference = { confidence: res.confidence, window: res.window, reasons: res.reasons, undated: res.undated, estimated: res.chunks.reduce((a, c) => a + c.minutes, 0), at: now };
  db.prepare('UPDATE entries SET hist = ?, inferred_v = ? WHERE id = ?').run(JSON.stringify(h), INFER_VERSION, entryId);
  return res;
}

const dayKeyOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * Shared per-day load across ALL games, so estimates from many games never pile up on the
 * same days (no "40 hours on Saturday" after importing a big library). Starts from tracked
 * play + estimates of entries outside the batch being (re)inferred.
 */
export function createDayLoad(db, batchIds, { dailyCap = 720 } = {}) {
  const map = new Map();
  const rows = db.prepare(`SELECT day, SUM(minutes) m FROM play_days WHERE excluded = 0
    AND NOT (estimated = 1 AND entry_id IN (SELECT value FROM json_each(?))) GROUP BY day`).all(JSON.stringify([...batchIds]));
  for (const r of rows) map.set(r.day, r.m);
  return {
    room: (t) => Math.max(0, dailyCap - (map.get(dayKeyOf(t)) || 0)),
    add: (chunks) => {
      for (const c of chunks) {
        const days = Math.max(1, Math.round((c.end + 1 - c.start) / DAY));
        for (let i = 0; i < days; i++) {
          const k = dayKeyOf(addDays(c.start, i));
          map.set(k, (map.get(k) || 0) + c.minutes / days);
        }
      }
    },
  };
}

/** Infer a batch of entries, strongest evidence first, sharing the per-day load. */
export function reinferMany(db, ids, { account = null, settings = null } = {}) {
  const list = [...ids];
  if (!list.length) return [];
  db.prepare('SELECT 1').get();
  const rows = db.prepare('SELECT id, hist, baseline_min FROM entries WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(list));
  const score = (r) => {
    const h = JSON.parse(r.hist || '{}');
    return (h.manual ? 1e9 : 0) + (h.first_played_at ? 1e8 : 0) + Math.min(500, (h.anchors || []).length) * 1e5 + (h.recent_min ? 1e4 : 0) + (h.last_played_at ? 1e3 : 0);
  };
  rows.sort((a, b) => score(b) - score(a) || b.baseline_min - a.baseline_min);
  const load = createDayLoad(db, list, { dailyCap: Number(settings?.history_max_day_minutes) || 720 });
  return rows.map((r) => reinferEntry(db, r.id, { account, load, settings }));
}

/** (Re)infer every entry with history that was inferred by an older algorithm version. */
export function reinferPending(db, { limit = 100000, log, settings = null } = {}) {
  const ids = db.prepare('SELECT id FROM entries WHERE baseline_min > 0 AND inferred_v < ? LIMIT ?').all(INFER_VERSION, limit).map((r) => r.id);
  if (!ids.length) return 0;
  const t = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    reinferMany(db, ids, { settings });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  log?.info?.(`Dated pre-tracking history for ${ids.length} titles in ${Date.now() - t}ms`);
  return ids.length;
}

/** Merge new evidence into an entry's hist JSON (without re-inferring). */
export function mergeEvidence(db, entryId, patch) {
  const row = db.prepare('SELECT hist FROM entries WHERE id = ?').get(entryId);
  if (!row) return;
  const h = JSON.parse(row.hist || '{}');
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === 'tracking_start' && h.tracking_start) continue;
    if (k === 'anchors') h.anchors = [...new Set([...(h.anchors || []), ...v])].sort((a, b) => a - b).slice(-500);
    else h[k] = v;
  }
  db.prepare('UPDATE entries SET hist = ? WHERE id = ?').run(JSON.stringify(h), entryId);
}
