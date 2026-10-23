import { tx } from '../db.js';
import { providers } from '../providers/index.js';
import { httpJson } from '../providers/http.js';
import { findOrCreateGame } from './library.js';
import { normalizeTitle } from './titles.js';
import { nextRun } from './schedule.js';
import { sendWebhook } from './webhook.js';
import { flushRollups } from './rollup.js';
import { allocate } from './inference.js';
import { reinferMany, mergeEvidence, reinferPending, relearnStyle } from './inference.js';
import { asLogger } from '../logger.js';
import { modelFor, deviceDelta, intSplit } from './model.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PIN_MAX = 360; // a single delta up to 6h is treated as one continuous session

/** Apply the keys that changed between `before` and `after` to the current stored state. */
export function mergeState(current, before, after) {
  const out = { ...current };
  for (const [k, v] of Object.entries(after)) if (JSON.stringify(v) !== JSON.stringify(before?.[k])) out[k] = v;
  return out;
}

export function parseAccount(row) {
  if (!row) return null;
  return {
    ...row,
    config: safeJson(row.config, {}),
    state: safeJson(row.state, {}),
    schedule: row.schedule ? safeJson(row.schedule, null) : null,
    enabled: !!row.enabled,
  };
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }

/**
 * Core algorithm: compare reported lifetime playtime against the last snapshot and turn
 * the difference into play sessions. Every platform-specific decision goes through the
 * account's platform model (model.js): which real-time window a report covers (reporting
 * lag), what "last played" means (session start vs end, self-calibrating), whether an
 * in-progress session is already counted, which counters bound the delta (Steam's
 * 14-day minutes), which device was used and how versions group into one product.
 *
 * Hints are used in order of strength:
 *   presence spans   -> exact start/end (one real session stays one session across reports)
 *   launch counter   -> number of sessions in the window (PSN)
 *   last played      -> pins the session (start or end, per platform)
 *   large deltas     -> spread over the window's days, weighted to the last activity
 *
 * Pre-tracking playtime (first import, late-appearing titles) is never recorded as play:
 * it becomes the entry's history and is dated by the inference engine (inference.js).
 */
export function applyItems(db, account, items, { settings, now = Date.now(), syncId = null, initial, source = 'sync', complete = true }) {
  const model = modelFor(providers[account.platform], account);
  const minSession = Math.max(0, Number(settings.min_session_minutes) || 0);
  const overage = Math.max(0, Number(settings.max_overage_minutes) || 0);
  const useRecent = settings.use_recent_on_import !== false;
  const autoMerge = settings.auto_merge_titles !== false;
  const prevSync = account.last_sync_at;
  const stats = {
    games_seen: 0, games_changed: 0, games_new: 0, sessions_created: 0, minutes_added: 0, baseline_minutes: 0,
    history_minutes: 0, estimated_minutes: 0, exact_sessions: 0, late_minutes: 0, removed: 0, new_sessions: [],
    calibration: { start: 0, end: 0 },
  };

  const getEntry = db.prepare('SELECT * FROM entries WHERE account_id = ? AND ext_id = ?');
  const groupGame = db.prepare('SELECT game_id FROM entries WHERE group_key = ? ORDER BY id LIMIT 1');
  const insEntry = db.prepare(`INSERT INTO entries(account_id, game_id, platform, ext_id, title, icon_url, cover_url, playtime_min, last_played_at, first_played_at, play_count, first_seen_at, last_synced_at, meta, group_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updEntry = db.prepare(`UPDATE entries SET title = ?, icon_url = COALESCE(?, icon_url), cover_url = COALESCE(?, cover_url),
    playtime_min = ?, last_played_at = COALESCE(?, last_played_at), first_played_at = COALESCE(first_played_at, ?), play_count = COALESCE(?, play_count),
    last_synced_at = ?, meta = ?, missing_since = NULL WHERE id = ?`);
  const touchEntry = db.prepare(`UPDATE entries SET title = ?, icon_url = COALESCE(?, icon_url), cover_url = COALESCE(?, cover_url),
    last_played_at = COALESCE(?, last_played_at), first_played_at = COALESCE(first_played_at, ?), missing_since = NULL WHERE id = ?`);
  const insSnap = db.prepare('INSERT INTO snapshots(entry_id, sync_id, taken_at, playtime_min) VALUES (?, ?, ?, ?)');
  // Imported copies of this platform's games (a restored export, a spreadsheet, GameTrack) that
  // a newly synced entry takes over, so linking an account joins your data instead of doubling it.
  let importedCopies = null;
  const importedCopy = (title) => {
    if (!importedCopies) {
      importedCopies = new Map();
      for (const e of db.prepare("SELECT * FROM entries WHERE account_id IS NULL AND platform = ? AND ext_id LIKE 'import:%'").all(account.platform)) {
        const k = normalizeTitle(e.title);
        if (!importedCopies.has(k)) importedCopies.set(k, e);
      }
    }
    const k = normalizeTitle(title);
    const e = importedCopies.get(k);
    if (e) importedCopies.delete(k);
    return e || null;
  };
  /** Move an imported copy's real sessions, evidence and your decisions onto the synced entry. */
  const adopt = (entry, old, playtime) => {
    const playMin = db.prepare("SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE entry_id = ? AND kind = 'play'").get(old.id).m;
    const firstPlay = db.prepare("SELECT MIN(COALESCE(started_at, window_start)) t FROM sessions WHERE entry_id = ? AND kind = 'play'").get(old.id).t;
    db.prepare("UPDATE sessions SET entry_id = ? WHERE entry_id = ? AND kind = 'play'").run(entry.id, old.id);
    db.prepare('DELETE FROM sessions WHERE entry_id = ?').run(old.id);
    const h = safeJson(old.hist, {});
    mergeEvidence(db, entry.id, {
      anchors: h.anchors?.length ? h.anchors : undefined, first_played_at: h.first_played_at ?? undefined, date_added: h.date_added ?? undefined,
      release_at: h.release_at ?? undefined, manual: h.manual ?? undefined, mode: h.mode ?? undefined,
    });
    if (old.excluded) db.prepare('UPDATE entries SET excluded = 1 WHERE id = ?').run(entry.id);
    // keep the game you organised (status, rating, notes) when the titles grouped differently
    if (old.game_id !== entry.game_id) {
      const created = entry.game_id;
      db.prepare('UPDATE entries SET game_id = ? WHERE id = ?').run(old.game_id, entry.id);
      entry.game_id = old.game_id;
      db.prepare('DELETE FROM games WHERE id = ? AND NOT EXISTS (SELECT 1 FROM entries WHERE game_id = ?) AND created_at = ?').run(created, created, now);
    }
    db.prepare('DELETE FROM entries WHERE id = ?').run(old.id);
    // the platform's total stands; your recorded play is part of it, the rest is history
    const total = Math.max(playtime, playMin);
    if (total !== playtime) db.prepare('UPDATE entries SET playtime_min = ? WHERE id = ?').run(total, entry.id);
    stats.adopted = (stats.adopted || 0) + 1;
    return { playMin, rest: total - playMin, firstPlay };
  };
  const fillCover = db.prepare('UPDATE games SET cover_url = ? WHERE id = ? AND cover_url IS NULL');
  const addHistory = db.prepare('UPDATE entries SET baseline_min = baseline_min + ? WHERE id = ?');
  const insSession = db.prepare(`INSERT INTO sessions(entry_id, sync_id, source, kind, minutes, window_start, window_end, started_at, ended_at, confidence, device, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const extendSession = db.prepare('UPDATE sessions SET minutes = minutes + ?, ended_at = MAX(COALESCE(ended_at, 0), ?), window_end = MAX(COALESCE(window_end, 0), ?) WHERE id = ?');
  const sessionMinutes = db.prepare('SELECT minutes FROM sessions WHERE id = ?');
  const spansFor = db.prepare('SELECT * FROM presence WHERE account_id = ? AND ext_id = ? AND started_at < ? AND COALESCE(ended_at, last_seen_at) > ? ORDER BY started_at');
  const linkSpan = db.prepare('UPDATE presence SET session_id = ? WHERE id = ?');
  // a recorded session claims any live-presence span it covers, so a span is never used twice
  const claimSpans = db.prepare(`UPDATE presence SET session_id = ? WHERE account_id = ? AND ext_id = ? AND session_id IS NULL
    AND started_at < ? AND COALESCE(ended_at, last_seen_at) > ?`);
  const lastPlay = db.prepare("SELECT * FROM sessions WHERE entry_id = ? AND kind = 'play' ORDER BY sort_time DESC, id DESC LIMIT 1");
  const pinnedAt = db.prepare("SELECT * FROM sessions WHERE entry_id = ? AND kind = 'play' AND started_at = ? AND confidence = 'pinned'");
  const unpin = db.prepare("UPDATE sessions SET started_at = NULL, ended_at = NULL, window_start = ?, window_end = ?, confidence = 'window', note = ? WHERE id = ?");
  const continueSession = db.prepare('UPDATE sessions SET minutes = ?, started_at = ?, ended_at = ?, window_start = MIN(window_start, ?), window_end = MAX(window_end, ?), confidence = ? WHERE id = ?');
  const toInfer = new Set();
  const seen = [];
  // only tracked play is certain enough to subtract (estimates are approximate -> never over-flag)
  const recentCounted = db.prepare(`SELECT COALESCE(SUM(minutes), 0) m FROM sessions WHERE entry_id = ? AND kind = 'play'
    AND COALESCE(started_at, window_start) >= ? AND sort_time <= ?`);
  // How long this player's sessions usually are (learned from exactly-observed sessions)
  const observed = db.prepare(`SELECT s.minutes FROM sessions s JOIN entries e ON e.id = s.entry_id
    WHERE e.account_id = ? AND s.kind = 'play' AND s.confidence = 'exact' ORDER BY s.id DESC LIMIT 300`).all(account.id).map((r) => r.minutes).sort((a, b) => a - b);
  const typical = observed.length >= 5
    ? { median: observed[Math.floor(observed.length / 2)], long: observed[Math.floor(observed.length * 0.9)] }
    : { median: 120, long: 240 };

  const play = (entry, title, { minutes, windowStart, windowEnd, started = null, ended = null, confidence, device = null, note = null }) => {
    minutes = Math.round(minutes);
    if (minutes <= 0) return null;
    // window barely longer than the session: we know exactly when it happened
    if (!ended && windowEnd - windowStart <= (minutes + 10) * MIN) { started = windowStart; ended = windowEnd; confidence = 'pinned'; }
    const r = insSession.run(entry.id, syncId, source, 'play', minutes, Math.min(windowStart, started ?? windowStart), Math.max(windowEnd, ended ?? windowEnd), started, ended, confidence, device, note, now);
    const id = Number(r.lastInsertRowid);
    if (started && ended && claimSpans.run(id, account.id, entry.ext_id ?? String(curExt), ended - 5 * MIN, started + 5 * MIN).changes && confidence === 'pinned') {
      // live presence corroborates the pinned times
      db.prepare("UPDATE sessions SET confidence = 'exact' WHERE id = ?").run(id);
      confidence = 'exact';
    }
    stats.sessions_created++;
    stats.minutes_added += minutes;
    if (confidence === 'exact') stats.exact_sessions++;
    stats.new_sessions.push({ id, entry_id: entry.id, game_id: entry.game_id, title, minutes, platform: account.platform, confidence });
    return id;
  };

  let curExt = null;
  const recordDelta = (entry, it, delta, ws, we, prevMeta) => {
    curExt = String(it.extId);
    const title = it.title || entry.title;
    const { device, offline } = deviceDelta(model, prevMeta?.devices, it.devices);
    const baseNote = offline ? 'Includes offline play reported on reconnect' : null;
    let remaining = delta;

    // 1) live presence spans -> exact sessions (a session reported over several syncs stays one session)
    const spans = spansFor.all(account.id, String(it.extId), we + 15 * MIN, ws - model.max_session_min * MIN)
      .filter((sp) => model.spanReported(sp, ws, we) && (!sp.session_id || model.countsInProgress()));
    if (spans.length) {
      const caps = spans.map((sp) => {
        const len = Math.max(1, ((sp.ended_at ?? sp.last_seen_at) - sp.started_at) / MIN);
        const used = sp.session_id ? (sessionMinutes.get(sp.session_id)?.minutes || 0) : 0;
        return Math.max(1, len - used);
      });
      const total = caps.reduce((a, x) => a + x, 0);
      const covered = Math.min(remaining, Math.round(total * 1.25 + 5));
      const parts = intSplit(covered, caps);
      spans.forEach((sp, i) => {
        const m = parts[i];
        if (m <= 0) return;
        const end = sp.ended_at ?? sp.last_seen_at;
        if (sp.session_id) {
          extendSession.run(m, end, end, sp.session_id);
          stats.minutes_added += m;
        } else {
          // presence is ground truth for when the session ran; minutes are what the platform credited
          const id = play(entry, title, { minutes: m, windowStart: ws, windowEnd: we, started: sp.started_at, ended: end, confidence: 'exact', device: sp.device || device, note: baseNote });
          if (id) linkSpan.run(id, sp.id);
        }
      });
      // learn what this platform's last-played timestamp really marks
      if (it.lastPlayedAt) {
        const nearest = spans.reduce((best, sp) => {
          const d = Math.min(Math.abs(it.lastPlayedAt - sp.started_at), Math.abs(it.lastPlayedAt - (sp.ended_at ?? sp.last_seen_at)));
          return !best || d < best.d ? { sp, d } : best;
        }, null);
        const v = model.vote(it.lastPlayedAt, nearest?.sp);
        if (v) stats.calibration[v]++;
      }
      remaining -= covered;
      if (remaining <= 0) return;
      if (remaining < Math.max(1, minSession)) {
        // a few minutes beyond what presence saw: part of the last observed session, not a new one
        const last = lastPlay.get(entry.id);
        if (last) { extendSession.run(Math.round(remaining), last.ended_at ?? last.window_end ?? now, last.window_end ?? now, last.id); return; }
      }
    }

    const pcDelta = model.play_count && it.playCount != null && entry.play_count != null ? it.playCount - entry.play_count : 0;
    const k = Math.max(1, Math.min(30, pcDelta));
    const spanDays = (we - ws) / DAY;

    // 2) several launches in the window (launch counter): k sessions, the last one pinned
    if (k > 1) {
      const parts = intSplit(remaining, Array(k).fill(1));
      const last = model.pin(parts[k - 1], ws, we, it.lastPlayedAt);
      for (let i = 0; i < k; i++) {
        if (i === k - 1 && last) play(entry, title, { minutes: parts[i], windowStart: ws, windowEnd: we, ...last, confidence: 'pinned', device, note: baseNote });
        else play(entry, title, { minutes: parts[i], windowStart: ws, windowEnd: last ? Math.max(ws + MIN, Math.min(we, last.started)) : we, confidence: 'window', device, note: baseNote ?? `${k} launches in this window` });
      }
      return;
    }

    // 3a) platforms that count in-progress play: a delta touching the previous session is
    //     the rest of that session (it was still running at the last report) - extend it
    if (model.countsInProgress() && it.lastPlayedAt) {
      const prev = lastPlay.get(entry.id);
      const slack = (model.lag_min + 5) * MIN;
      // only if the previous session was cut off by the last report (it ends at the report boundary)
      const cutOff = prev?.ended_at && prev.ended_at >= ws - slack;
      if (cutOff && prev.started_at && it.lastPlayedAt - remaining * MIN < prev.ended_at + slack && it.lastPlayedAt >= prev.started_at) {
        const minutes = prev.minutes + Math.round(remaining);
        const ended = Math.max(prev.ended_at, it.lastPlayedAt);
        continueSession.run(minutes, Math.min(prev.started_at, ended - minutes * MIN), ended, ws, we, prev.confidence === 'exact' ? 'exact' : 'pinned', prev.id);
        stats.minutes_added += Math.round(remaining);
        return;
      }
    }

    // 3-) self-repair for 'start' platforms: if this launch time was already used to pin an
    //     earlier delta, that earlier delta could not have started there (the launch was a
    //     session still running at the last report) - move it to before the launch.
    if (model.lastPlayed === 'start' && it.lastPlayedAt) {
      const clash = pinnedAt.get(entry.id, it.lastPlayedAt);
      if (clash) {
        const end = it.lastPlayedAt - 5 * MIN;
        unpin.run(Math.max(clash.window_start ?? end - (clash.minutes + 120) * MIN, end - (clash.minutes + 120) * MIN), end, 'Re-placed: the launch time belonged to a later session', clash.id);
      }
    }

    // 3) one continuous session, pinned by last played (start or end, per platform)
    if (remaining <= PIN_MAX) {
      const pin = model.pin(remaining, ws, we, it.lastPlayedAt);
      const lp = it.lastPlayedAt;
      if (model.lastPlayed === 'start' && lp && lp > ws && lp < we + 2 * MIN && (!pin || remaining > typical.long)) {
        // A launch time only proves the LAST session started then. When the delta doesn't fit
        // after it, or is longer than this player's long sessions: a typical session at the
        // launch, the rest earlier in the same sitting. (If that launch was really a session
        // still running at report time, the next report re-places it - see 3- above.)
        const room = Math.max(0, Math.floor((we - lp) / MIN) - 1);
        const lastPart = Math.max(0, Math.min(Math.round(remaining) - 1, typical.median, room));
        const before = Math.round(remaining) - lastPart;
        if (lastPart > 0) play(entry, title, { minutes: lastPart, windowStart: ws, windowEnd: we, started: lp, ended: lp + lastPart * MIN, confidence: 'pinned', device, note: baseNote });
        const end = Math.max(ws + MIN, lp - 5 * MIN);
        play(entry, title, { minutes: before, windowStart: Math.max(ws, end - (before + 120) * MIN), windowEnd: end, confidence: 'window', device, note: baseNote ?? 'Earlier session before the last launch' });
        return;
      }
      if (pin && model.lastPlayed === 'end' && remaining > typical.long) {
        // mirror case for 'end' platforms: last played only proves when the LAST session ended
        const lastPart = Math.min(Math.round(remaining) - 1, typical.median);
        const before = Math.round(remaining) - lastPart;
        play(entry, title, { minutes: lastPart, windowStart: ws, windowEnd: we, started: lp - lastPart * MIN, ended: lp, confidence: 'pinned', device, note: baseNote });
        const end = Math.max(ws + MIN, lp - lastPart * MIN - 5 * MIN);
        play(entry, title, { minutes: before, windowStart: Math.max(ws, end - (before + 120) * MIN), windowEnd: end, confidence: 'window', device, note: baseNote ?? 'Earlier session before the last one' });
        return;
      }
      if (pin) { play(entry, title, { minutes: remaining, windowStart: ws, windowEnd: we, ...pin, confidence: 'pinned', device, note: baseNote }); return; }
    }

    // 4) big delta over a multi-day window: spread over days, weighted to the last activity
    if (remaining > PIN_MAX && spanDays > 1.2) {
      const anchor = model.lastActivity(it.lastPlayedAt, remaining, ws, we);
      let end = anchor || we;
      // an end at exactly local midnight leaves no time on that day (date-only timestamps)
      if (end === startOfDay(end) && end > ws) end -= 1;
      const d0 = startOfDay(ws);
      const n = Math.max(1, Math.round((startOfDay(end) - d0) / DAY) + 1);
      const weights = Array.from({ length: n }, (_, i) => 1 + (anchor ? 3 * Math.exp(-((n - 1 - i) ** 2) / 2) : 0));
      const alloc = intSplit(remaining, allocate(remaining, weights, { cap: 600, minDay: 15 }));
      alloc.forEach((m, i) => {
        if (m <= 0) return;
        const ds = Math.max(ws, addDays(d0, i));
        const de = Math.min(end, addDays(d0, i + 1) - 1);
        if (de <= ds) return;
        play(entry, title, { minutes: m, windowStart: ds, windowEnd: de, confidence: 'window', device, note: baseNote ?? 'Spread over the sync window' });
      });
      return;
    }
    play(entry, title, { minutes: remaining, windowStart: ws, windowEnd: we, confidence: 'window', device, note: baseNote });
  };

  const history = (entry, minutes, it, extra = {}) => {
    if (minutes <= 0) return;
    addHistory.run(minutes, entry.id);
    mergeEvidence(db, entry.id, {
      tracking_start: now,
      last_played_at: it.lastPlayedAt ?? undefined,
      first_played_at: model.first_played ? (it.firstPlayedAt ?? undefined) : undefined,
      play_count: model.play_count ? (it.playCount ?? undefined) : undefined,
      date_added: it.dateAdded ?? undefined,
      recent_min: useRecent && it.recentMin ? Math.min(it.recentMin, minutes) : undefined,
      recent_days: model.recent?.days ?? undefined,
      ...extra,
    });
    stats.history_minutes += minutes;
    toInfer.add(entry.id);
  };

  const recentDays = model.recent?.days || 14;
  for (const it of items) {
    if (!it || it.extId == null) continue;
    stats.games_seen++;
    const extId = String(it.extId);
    let playtime = Math.max(0, Math.floor(Number(it.playtimeMin) || 0));
    const lastPlayedAt = it.lastPlayedAt || null;
    const meta = { ...(it.meta || {}), ...(it.devices ? { devices: it.devices } : {}) };
    const metaJson = JSON.stringify(meta);
    const recent = it.recentMin == null ? null : Math.max(0, Math.floor(Number(it.recentMin) || 0));
    let entry = getEntry.get(account.id, extId);

    if (!entry) {
      stats.games_new++;
      // versions of one product (PS4 + PS5) share a game regardless of their titles
      const grouped = it.groupKey ? groupGame.get(it.groupKey) : null;
      const gameId = grouped?.game_id ?? findOrCreateGame(db, { title: it.title, coverUrl: it.coverUrl }, { autoMerge, now });
      const r = insEntry.run(account.id, gameId, account.platform, extId, String(it.title || extId), it.iconUrl || null, it.coverUrl || null,
        playtime, lastPlayedAt, it.firstPlayedAt || null, it.playCount ?? null, now, now, metaJson, it.groupKey || null);
      entry = { id: Number(r.lastInsertRowid), game_id: gameId, title: it.title, play_count: null };
      seen.push(entry.id);
      fillCover.run(it.coverUrl || null, gameId);
      insSnap.run(entry.id, syncId, now, playtime);
      const copy = importedCopy(it.title || extId);
      if (copy) {
        const a = adopt(entry, copy, playtime);
        history(entry, a.rest, { ...it, lastPlayedAt: a.firstPlay ? Math.min(it.lastPlayedAt ?? a.firstPlay, a.firstPlay) : it.lastPlayedAt }, a.firstPlay ? { tracking_start: a.firstPlay } : {});
        continue;
      }
      if (playtime <= 0) continue;

      const [ws, we] = model.window(prevSync ?? now, now);
      const playedBeforeWindow = prevSync && lastPlayedAt && lastPlayedAt < ws - 2 * MIN;
      const startedBeforeWindow = prevSync && it.firstPlayedAt && it.firstPlayedAt < ws - 2 * MIN;
      const isImport = initial || !prevSync || it.backfill || playedBeforeWindow;
      if (isImport) {
        // first sight of existing playtime -> history (dated by inference, never a burst today)
        history(entry, playtime, it);
        continue;
      }
      const elapsed = (we - ws) / MIN;
      if (!startedBeforeWindow && playtime <= model.capacityMin(ws, we) + overage) {
        // brand-new game, all of it played since the last report
        recordDelta(entry, it, playtime, it.firstPlayedAt && it.firstPlayedAt > ws ? Math.max(ws, it.firstPlayedAt - 2 * MIN) : ws, we, null);
        stats.games_changed++;
        continue;
      }
      // partly older: a recent-minutes counter tells us how much is new, the rest is history
      const fresh = model.recent && recent ? Math.min(recent, playtime, elapsed) : 0;
      if (fresh >= Math.max(1, minSession)) { recordDelta(entry, it, fresh, Math.max(ws, now - recentDays * DAY), we, null); stats.games_changed++; }
      history(entry, playtime - (fresh >= Math.max(1, minSession) ? fresh : 0), it, { recent_min: undefined });
      continue;
    }

    seen.push(entry.id);
    // totals of presence-tracked titles (no platform playtime) are ours: a report fetched before a
    // presence session was recorded must never take it away
    if (account.state?.unmetered?.[extId] && !it.backfill) playtime = Math.max(playtime, entry.playtime_min);
    const delta = playtime - entry.playtime_min;
    if (delta === 0 || (delta > 0 && delta < minSession)) {
      // Nothing (or too little) changed. Keep the old snapshot time when a small delta is
      // pending so it accumulates into the next real session.
      if (delta === 0) updEntry.run(String(it.title || entry.title), it.iconUrl || null, it.coverUrl || null, entry.playtime_min, lastPlayedAt, it.firstPlayedAt || null, it.playCount ?? null, now, metaJson, entry.id);
      else touchEntry.run(String(it.title || entry.title), it.iconUrl || null, it.coverUrl || null, lastPlayedAt, it.firstPlayedAt || null, entry.id);
      continue;
    }

    if (delta < 0) {
      // A lower total than before is almost always a glitch (an empty stat, a bad report) that
      // comes back later; following it would count the time again on recovery. The total stays
      // at its high-water mark and only play above it is new.
      touchEntry.run(String(it.title || entry.title), it.iconUrl || null, it.coverUrl || null, lastPlayedAt, it.firstPlayedAt || null, entry.id);
      stats.decreases = (stats.decreases || 0) + 1;
      continue;
    }

    const prevMeta = safeJson(entry.meta, {});
    updEntry.run(String(it.title || entry.title), it.iconUrl || null, it.coverUrl || null, playtime, lastPlayedAt, it.firstPlayedAt || null, it.playCount ?? null, now, metaJson, entry.id);
    insSnap.run(entry.id, syncId, now, playtime);
    if (it.backfill) {
      // a total that only now became available (a title tracked by presence whose platform starts
      // reporting playtime): what we tracked is part of it, the rest is history from before
      // tracking - never new play today
      const firstTracked = db.prepare("SELECT MIN(COALESCE(started_at, window_start)) t FROM sessions WHERE entry_id = ? AND kind = 'play'").get(entry.id).t;
      history(entry, delta, { ...it, lastPlayedAt: firstTracked ? Math.min(it.lastPlayedAt ?? firstTracked, firstTracked) : it.lastPlayedAt }, { tracking_start: firstTracked || now });
      continue;
    }

    stats.games_changed++;
    let [ws, we] = model.window(entry.last_synced_at || prevSync || entry.first_seen_at, now);
    // a rolling recent counter narrows long (weekly/monthly) windows ...
    if (model.recent && recent != null && recent >= delta && we - ws > recentDays * DAY) ws = now - recentDays * DAY;
    // ... and bounds how much of the delta can be recent at all (the rest was uploaded late)
    // minutes of this title we already recorded entirely inside the counter's period
    const counted = model.recent?.strict && recent != null
      ? recentCounted.get(entry.id, now - recentDays * DAY + 2 * HOUR, ws + 2 * MIN).m
      : 0;
    const { inWindow, late } = model.recentBound(delta, ws, now, recent, counted);
    const capacity = model.capacityMin(ws, we);
    // within tolerance -> all of it; beyond -> only what fits in the window
    const p = inWindow <= capacity + overage ? inWindow : Math.max(0, Math.floor(capacity));
    const excess = late + (inWindow - p);
    if (p > 0) recordDelta(entry, it, p, ws, we, prevMeta);
    if (excess > 0) {
      // more playtime than the window can hold: played earlier, reported late (offline play / back-fill)
      insSession.run(entry.id, syncId, source, 'baseline', excess, null, now, null, null, null, null, late ? 'Played earlier and uploaded late (outside the recent-play window) - undated' : 'Reported late by the platform (offline play / back-fill) - undated', now);
      stats.baseline_minutes += excess;
      stats.late_minutes += excess;
    }
  }

  // one game at a time per account: a later launch (of any game) caps the previous pinned
  // session; minutes that don't fit move to an earlier sitting of that game
  if (model.single_title && model.lastPlayed === 'start' && stats.new_sessions.length > 1) {
    const ids = stats.new_sessions.map((x) => x.id);
    const rows = db.prepare(`SELECT * FROM sessions WHERE id IN (SELECT value FROM json_each(?)) AND started_at IS NOT NULL AND confidence IN ('pinned', 'exact') ORDER BY started_at`).all(JSON.stringify(ids));
    for (let i = 0; i + 1 < rows.length; i++) {
      const cur = rows[i]; const nxt = rows[i + 1];
      if (cur.confidence !== 'pinned' || cur.ended_at <= nxt.started_at) continue;
      const fits = Math.max(0, Math.floor((nxt.started_at - cur.started_at) / MIN) - 1);
      const overflow = cur.minutes - fits;
      if (overflow <= 0) continue;
      const end = cur.started_at - 5 * MIN;
      if (fits > 0) db.prepare('UPDATE sessions SET minutes = ?, ended_at = ? WHERE id = ?').run(fits, cur.started_at + fits * MIN, cur.id);
      else db.prepare('DELETE FROM sessions WHERE id = ?').run(cur.id);
      insSession.run(cur.entry_id, syncId, source, 'play', overflow, Math.max(cur.window_start, end - (overflow + 120) * MIN), Math.max(cur.window_start + MIN, end), null, null, 'window', cur.device, 'Earlier sitting (another game was launched)', now);
      cur.ended_at = cur.started_at + fits * MIN;
    }
  }

  // titles that vanished from a complete library report (refunds, hidden titles)
  if (complete && model.complete_library && items.length && seen.length) {
    const r = db.prepare('UPDATE entries SET missing_since = ? WHERE account_id = ? AND missing_since IS NULL AND id NOT IN (SELECT value FROM json_each(?))')
      .run(now, account.id, JSON.stringify(seen));
    stats.removed = Number(r.changes);
  }

  if (toInfer.size) {
    flushRollups(db); // day-load accounting reads the rollups
    for (const r of reinferMany(db, toInfer, { account, settings })) {
      if (r) { stats.estimated_minutes += r.chunks.reduce((a, c) => a + c.minutes, 0); stats.baseline_minutes += r.undated; }
    }
  }
  flushRollups(db);
  return stats;
}

export class SyncService {
  constructor({ db, settings, log }) {
    this.db = db;
    this.settings = settings;
    this.log = asLogger(log).scoped('sync');
    this.plog = asLogger(log).scoped('presence');
    this.running = new Map();
    this.enriching = new Map(); // accountId -> in-flight promise
    this.enrichTries = new Map(); // entryId -> failed enrichment attempts
    this.soon = new Map();
    this.quota = new Map(); // accountId -> { limit, remaining, resetAt, blockedUntil } from API headers
    for (const a of db.prepare("SELECT id, json_extract(state, '$.rate_limited_until') u FROM accounts").all()) {
      if (a.u > Date.now()) this.quota.set(a.id, { remaining: 0, blockedUntil: a.u });
    }
    this.presenceState = new Map(); // accountId -> { lastPoll, failures, error }
    this.timer = null;
    this.stopping = false;
  }

  account(id) {
    return parseAccount(this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
  }

  scheduleFor(account) {
    const s = this.settings.all();
    return account.schedule ? { ...s, ...account.schedule } : s;
  }

  computeNext(account) {
    if (!account.enabled || providers[account.platform]?.push) return null;
    let scheduled = nextRun(this.scheduleFor(account), account.last_sync_at, Date.now());
    // titles deferred by an hourly API budget (Xbox first import): keep going hour by hour
    if (account.state?.deferred_titles?.length && account.last_sync_at) {
      const backfill = account.last_sync_at + HOUR + 2 * MIN;
      if (scheduled == null || backfill < scheduled) scheduled = backfill;
    }
    const soon = this.soon.get(account.id);
    const next = soon && (scheduled == null || soon < scheduled) ? soon : scheduled;
    // never before an exhausted API quota resets
    const blocked = this.blockedUntil(account.id);
    return next != null && blocked > next ? blocked : next;
  }

  refreshNext(accountId) {
    const a = this.account(accountId);
    if (a) this.db.prepare('UPDATE accounts SET next_sync_at = ? WHERE id = ?').run(this.computeNext(a), a.id);
  }

  isRunning(id) {
    return this.running.has(id);
  }

  // ---------- API usage accounting ----------
  usage(accountId) {
    const hour = Math.floor(Date.now() / HOUR);
    return this.db.prepare('SELECT calls, errors, rate_limited FROM api_usage WHERE account_id = ? AND hour = ?').get(accountId, hour) || { calls: 0, errors: 0, rate_limited: 0 };
  }

  /** Until when an account's API quota is exhausted (0 when it isn't). */
  blockedUntil(accountId) {
    return this.quota.get(accountId)?.blockedUntil || 0;
  }

  recordCall(accountId, r, counters) {
    const hour = Math.floor(Date.now() / HOUR);
    if (r.rate && (r.rate.remaining != null || r.rate.resetAt)) {
      const q = this.quota.get(accountId) || {};
      this.quota.set(accountId, { ...q, limit: r.rate.limit ?? q.limit, remaining: r.rate.remaining, resetAt: r.rate.resetAt, at: Date.now() });
    }
    if (r.rateLimited) {
      // pause this account's calls (syncs, presence, enrichment) until the quota resets
      const q = this.quota.get(accountId) || {};
      const reset = r.rate?.resetAt || (q.resetAt && q.at > Date.now() - MIN ? q.resetAt : null);
      const until = Math.max(Date.now() + MIN, Math.min(Date.now() + HOUR + MIN, reset ? reset + 5000 : Date.now() + 15 * MIN));
      this.quota.set(accountId, { ...q, remaining: 0, blockedUntil: until });
      try { this.db.prepare("UPDATE accounts SET state = json_set(COALESCE(state, '{}'), '$.rate_limited_until', ?) WHERE id = ?").run(until, accountId); } catch { /* best effort */ }
    }
    try {
      this.db.prepare(`INSERT INTO api_usage(account_id, hour, calls, errors, rate_limited) VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(account_id, hour) DO UPDATE SET calls = calls + 1, errors = errors + excluded.errors, rate_limited = rate_limited + excluded.rate_limited`)
        .run(accountId, hour, r.ok ? 0 : 1, r.rateLimited ? 1 : 0);
    } catch { /* never fail a request on accounting */ }
    if (counters) {
      counters.calls++;
      if (!r.ok) counters.errors++;
      if (r.rateLimited) counters.rate_limited++;
      counters.ms += r.ms;
      counters.hosts[r.host] = (counters.hosts[r.host] || 0) + 1;
    }
    if (r.rateLimited) this.log.warn(`Rate limited by ${r.host}`, { account_id: accountId, status: r.status });
  }

  ctxFor(account, { counters, warnings } = {}) {
    const getEntry = this.db.prepare('SELECT * FROM entries WHERE account_id = ? AND ext_id = ?');
    return {
      http: (url, opts, cfg = {}) => httpJson(url, opts, { ...cfg, onResult: (r) => this.recordCall(account.id, r, counters) }),
      getEntry: (ext) => getEntry.get(account.id, String(ext)),
      // our own count for this hour, tightened by what the API itself reports (it also counts
      // calls made elsewhere with the same key)
      remainingBudget: (limit) => {
        if (this.blockedUntil(account.id) > Date.now()) return 0;
        const own = limit - this.usage(account.id).calls;
        const q = this.quota.get(account.id);
        // a reported count is trusted until its reset (or for an hour when the API names none)
        const fresh = q && q.remaining != null && (q.resetAt ? q.resetAt > Date.now() : q.at > Date.now() - HOUR);
        return fresh ? Math.min(own, q.remaining) : own;
      },
      warn: (m) => { warnings?.push(m); this.log.warn(m, { account: `${account.platform}/${account.name}` }); },
      stopped: () => this.stopping,
    };
  }

  /** Fetch from the provider and apply. Concurrent calls for the same account share one run. */
  sync(accountId, trigger = 'manual') {
    if (this.running.has(accountId)) return this.running.get(accountId);
    const p = this._sync(accountId, trigger).finally(() => this.running.delete(accountId));
    this.running.set(accountId, p);
    return p;
  }

  async _sync(accountId, trigger, pushedItems = null) {
    const account = this.account(accountId);
    if (!account) throw Object.assign(new Error('Account not found'), { status: 404 });
    const provider = providers[account.platform];
    if (!provider) throw new Error(`Unknown platform ${account.platform}`);
    const db = this.db;
    const startedAt = Date.now();
    const initial = !account.last_sync_at;
    this.soon.delete(account.id);
    const counters = { calls: 0, errors: 0, rate_limited: 0, ms: 0, hosts: {} };
    const warnings = [];
    const syncId = Number(db.prepare('INSERT INTO syncs(account_id, trigger, started_at, initial) VALUES (?, ?, ?, ?)').run(account.id, trigger, startedAt, initial ? 1 : 0).lastInsertRowid);
    const label = `${account.platform}/${account.name}`;
    try {
      let items = pushedItems;
      let state = account.state;
      let info = null;
      let complete = !pushedItems;
      if (!items) {
        const res = await provider.fetchLibrary(account, this.ctxFor(account, { counters, warnings }));
        items = res.items;
        state = res.state ?? state;
        info = res.info || null;
        if (res.complete === false) complete = false;
        if (res.warning) warnings.push(res.warning);
        if (!items) throw new Error('This account receives data through the API (POST /api/v1/accounts/:id/report)');
      }
      const now = Date.now();
      const warning = warnings.length ? warnings.join('; ').slice(0, 1000) : null;
      const stats = tx(db, () => {
        const s = applyItems(db, account, items, { settings: this.settings.all(), now, syncId, initial, source: 'sync', complete });
        // learned last-played semantics (from presence) accumulate per account
        if (s.calibration.start || s.calibration.end) {
          const prevCal = state?.calibration?.last_played || account.state?.calibration?.last_played || { start: 0, end: 0 };
          state = { ...(state || {}), calibration: { ...(state?.calibration || {}), last_played: { start: prevCal.start + s.calibration.start, end: prevCal.end + s.calibration.end, updated_at: now } } };
        }
        const details = { api: counters, warnings, info, history_minutes: s.history_minutes, estimated_minutes: s.estimated_minutes, exact_sessions: s.exact_sessions, late_minutes: s.late_minutes, removed: s.removed, calibration: s.calibration };
        db.prepare(`UPDATE syncs SET finished_at = ?, status = ?, games_seen = ?, games_changed = ?, games_new = ?, sessions_created = ?, minutes_added = ?, baseline_minutes = ?, error = ?, duration_ms = ?, details = ? WHERE id = ?`)
          .run(now, warning ? 'warning' : 'ok', s.games_seen, s.games_changed, s.games_new, s.sessions_created, s.minutes_added, s.history_minutes + s.baseline_minutes, warning, Date.now() - startedAt, JSON.stringify(details), syncId);
        // only what this sync changed, onto the latest stored state (presence polls, quota pauses,
        // cover lookups may have written to it while the sync was running)
        db.prepare('UPDATE accounts SET state = ?, last_sync_at = ?, last_status = ?, last_error = ? WHERE id = ?')
          .run(JSON.stringify(mergeState(this.account(account.id).state, account.state, state || {})), now, warning ? 'warning' : 'ok', warning, account.id);
        return s;
      });
      this.refreshNext(account.id);
      this.presenceSessions(account.id, { fallbacks: items.filter((i) => i.unmeteredPlayAt).map((i) => ({ extId: String(i.extId), at: i.unmeteredPlayAt, prev: i.prevPlayedAt })) });
      this.relearn();
      const result = { sync_id: syncId, account_id: account.id, initial, ...stats, api_calls: counters.calls, duration_ms: Date.now() - startedAt };
      this.log.info(`${label}: ${stats.games_seen} games, ${stats.sessions_created} sessions (+${stats.minutes_added}m)${stats.history_minutes ? `, ${Math.round(stats.history_minutes / 60)}h history dated (${Math.round(stats.estimated_minutes / 60)}h charted)` : ''}${initial ? ' [initial import]' : ''} in ${result.duration_ms}ms, ${counters.calls} API calls`);
      this.notify(account, result, null);
      if (provider.enrich) this.enrich(account.id).catch((e) => this.log.error(`Enrichment failed for ${label}`, e));
      if (provider.resolveCovers) this.resolveCovers(account.id).catch((e) => this.log.warn(`Cover lookup failed for ${label}: ${e.message}`));
      return result;
    } catch (err) {
      const msg = String(err?.message || err);
      if (err?.rateLimited) {
        // quota used up: not a failure of the account; it resumes when the quota resets
        const until = this.blockedUntil(account.id) || Date.now() + 15 * MIN;
        const note = `${msg} - paused until ${new Date(until).toLocaleTimeString()}, then continues automatically`;
        db.prepare("UPDATE syncs SET finished_at = ?, status = 'warning', error = ?, duration_ms = ?, details = ? WHERE id = ?")
          .run(Date.now(), note, Date.now() - startedAt, JSON.stringify({ api: counters, warnings, rate_limited_until: until }), syncId);
        db.prepare("UPDATE accounts SET last_status = 'warning', last_error = ? WHERE id = ?").run(note, account.id);
        this.refreshNext(account.id);
        this.log.warn(`${label}: ${note}`, { account_id: account.id, trigger });
        throw Object.assign(err, { syncId, status: 429 });
      }
      const status = err?.auth ? 'auth' : 'error';
      db.prepare("UPDATE syncs SET finished_at = ?, status = 'error', error = ?, duration_ms = ?, details = ? WHERE id = ?")
        .run(Date.now(), msg, Date.now() - startedAt, JSON.stringify({ api: counters, warnings, auth: !!err?.auth, stack: err?.stack?.split('\n').slice(0, 6).join('\n') }), syncId);
      db.prepare('UPDATE accounts SET last_status = ?, last_error = ? WHERE id = ?').run(status === 'auth' ? 'error' : 'error', err?.auth ? `${msg} - update the credentials for this account` : msg, account.id);
      this.log.error(`${label} failed: ${msg}`, { account_id: account.id, trigger, auth: !!err?.auth, api_calls: counters.calls, ...(err?.auth || err?.name === 'ProviderError' ? {} : { error: err }) });
      this.notify(account, null, msg);
      throw Object.assign(err instanceof Error ? err : new Error(msg), { syncId, status: 502 });
    }
  }

  /** Data pushed by an external reporter (custom accounts or any account). */
  report(accountId, items) {
    if (this.running.has(accountId)) throw Object.assign(new Error('A sync is already running for this account'), { status: 409 });
    const p = this._sync(accountId, 'api', items).finally(() => this.running.delete(accountId));
    // note: API reports may cover only part of a library, so they never mark titles as removed
    this.running.set(accountId, p);
    return p;
  }

  // ---------- enrichment (background): date history with achievement times, release dates ----------
  enrich(accountId, opts) {
    if (this.enriching.has(accountId)) return this.enriching.get(accountId);
    const p = this._enrich(accountId, opts).finally(() => this.enriching.delete(accountId));
    this.enriching.set(accountId, p);
    return p;
  }

  async _enrich(accountId, { limit = 300 } = {}) {
    const account = this.account(accountId);
    const provider = providers[account?.platform];
    if (!account || !provider?.enrich) return null;
    const entries = this.db.prepare('SELECT * FROM entries WHERE account_id = ? AND baseline_min > 0 AND enriched_at IS NULL ORDER BY baseline_min DESC LIMIT ?').all(accountId, limit);
    if (!entries.length) return { updated: 0, anchored: 0, remaining: 0 };
    const counters = { calls: 0, errors: 0, rate_limited: 0, ms: 0, hosts: {} };
    const t0 = Date.now();
    try {
      const { updates, state } = await provider.enrich(account, entries, this.ctxFor(account, { counters }));
      let anchored = 0;
      let progressed = 0;
      tx(this.db, () => {
        // refreshed tokens (PSN) are kept
        if (state) this.db.prepare('UPDATE accounts SET state = ? WHERE id = ?').run(JSON.stringify({ ...this.account(accountId).state, ...state }), accountId);
        for (const u of updates) {
          mergeEvidence(this.db, u.entryId, { anchors: u.anchors?.length ? u.anchors : undefined, release_at: u.release_at });
          if (u.anchors?.length) anchored++;
          // a title that keeps failing is given up after 3 attempts (no endless retry loop)
          const tries = u.done ? 0 : (this.enrichTries.get(u.entryId) || 0) + 1;
          if (u.done || tries >= 3) { this.db.prepare('UPDATE entries SET enriched_at = ? WHERE id = ?').run(Date.now(), u.entryId); this.enrichTries.delete(u.entryId); } else this.enrichTries.set(u.entryId, tries);
          if (u.done || tries >= 3) progressed++;
        }
        flushRollups(this.db);
        reinferMany(this.db, updates.map((u) => u.entryId), { account, settings: this.settings.all() });
        flushRollups(this.db);
      });
      if (anchored) this.relearn({ force: true });
      this.log.info(`Enriched ${updates.length} ${account.platform} titles (${anchored} with activity timestamps) in ${Math.round((Date.now() - t0) / 1000)}s, ${counters.calls} API calls`);
      // more to do? continue later within rate limits
      const left = this.db.prepare('SELECT COUNT(*) n FROM entries WHERE account_id = ? AND baseline_min > 0 AND enriched_at IS NULL').get(accountId).n;
      if (left && progressed && !this.stopping) setTimeout(() => this.enrich(accountId).catch((e) => this.log.error('Enrichment failed', e)), account.platform === 'xbox' ? HOUR / 2 : account.platform === 'psn' ? 15 * MIN : 5000).unref?.();
      return { updated: updates.length, anchored, remaining: left };
    } catch (err) {
      this.log.error(`Enrichment of ${account.platform}/${account.name} failed: ${err.message}`, err);
      throw err;
    }
  }

  /** Fix cover art for titles whose art isn't at the platform's classic path (Steam). */
  async resolveCovers(accountId) {
    const account = this.account(accountId);
    const provider = providers[account?.platform];
    if (!provider?.resolveCovers) return null;
    const done = new Set(account.state.cover_checked || []);
    const todo = this.db.prepare('SELECT ext_id FROM entries WHERE account_id = ?').all(accountId).map((r) => r.ext_id).filter((id) => !done.has(Number(id)));
    if (!todo.length) return { updated: 0 };
    const counters = { calls: 0, errors: 0, rate_limited: 0, ms: 0, hosts: {} };
    const { covers, checked } = await provider.resolveCovers(account, todo, this.ctxFor(account, { counters }));
    let updated = 0;
    tx(this.db, () => {
      const fresh = this.account(accountId).state;
      const state = { ...fresh, covers: { ...(fresh.covers || {}), ...covers }, cover_checked: [...done, ...checked.map(Number)] };
      this.db.prepare('UPDATE accounts SET state = ? WHERE id = ?').run(JSON.stringify(state), accountId);
      const upd = this.db.prepare(`UPDATE games SET cover_url = ? WHERE id = (SELECT game_id FROM entries WHERE account_id = ? AND ext_id = ?)
        AND (cover_url IS NULL OR cover_url LIKE '%/steam/apps/%/library_600x900.jpg')`);
      const updEntry = this.db.prepare('UPDATE entries SET cover_url = ? WHERE account_id = ? AND ext_id = ?');
      for (const [appid, url] of Object.entries(covers)) {
        updated += upd.run(url, accountId, String(appid)).changes;
        updEntry.run(url, accountId, String(appid));
      }
    });
    if (updated) this.log.info(`Found cover art for ${updated} ${account.platform} titles`);
    if (todo.length > checked.length && checked.length && !this.stopping) setTimeout(() => this.resolveCovers(accountId).catch(() => {}), 60_000).unref?.();
    return { updated, remaining: todo.length - checked.length };
  }

  // ---------- presence ("currently playing") ----------
  presenceEnabled(account) {
    const p = providers[account.platform];
    return account.enabled && (p?.presence || p?.push) && account.config.presence !== 'off';
  }

  /** Update presence spans from a list of currently-playing titles. Closing a span schedules a sync. */
  applyPresence(account, playing, { intervalSec = 120, now = Date.now() } = {}) {
    const db = this.db;
    const prev = this.presenceState.get(account.id) || {};
    const open = db.prepare('SELECT * FROM presence WHERE account_id = ? AND ended_at IS NULL').all(account.id);
    const ids = new Set(playing.map((p) => String(p.extId)));
    const half = (intervalSec * 1000) / 2;
    let closed = 0;
    tx(db, () => {
      for (const s of open) {
        if (ids.has(s.ext_id)) db.prepare('UPDATE presence SET last_seen_at = ? WHERE id = ?').run(now, s.id);
        else {
          db.prepare('UPDATE presence SET ended_at = ? WHERE id = ?').run(Math.min(now, s.last_seen_at + half), s.id);
          closed++;
        }
      }
      for (const p of playing) {
        if (open.some((s) => s.ext_id === String(p.extId))) continue;
        const start = prev.lastPoll && now - prev.lastPoll < intervalSec * 3000 ? Math.round((prev.lastPoll + now) / 2) : now;
        db.prepare('INSERT INTO presence(account_id, ext_id, title, started_at, last_seen_at, device) VALUES (?, ?, ?, ?, ?, ?)').run(account.id, String(p.extId), p.title || null, start, now, p.device || null);
        this.plog.info(`${account.platform}/${account.name} started playing ${p.title || p.extId}`);
      }
      // keep presence history bounded
      db.prepare('DELETE FROM presence WHERE account_id = ? AND ended_at IS NOT NULL AND ended_at < ?').run(account.id, now - 90 * DAY);
    });
    if (closed) this.presenceSessions(account.id, { now });
    if (closed && !providers[account.platform]?.push) {
      const delay = (providers[account.platform]?.profile?.presence?.sync_after_sec || 300) * 1000;
      this.soon.set(account.id, now + delay);
      this.refreshNext(account.id);
      this.plog.info(`${account.platform}/${account.name}: session ended, syncing in ${Math.round(delay / 60000)} min`);
    }
    return { open: ids.size, closed };
  }

  /**
   * Titles whose platform reports no playtime at all (Xbox PC / Game Pass titles without a
   * MinutesPlayed stat) can only be tracked by presence: each finished presence span becomes an
   * exact session and is added to the title's total (the platform never reports one to compare).
   */
  presenceSessions(accountId, { now = Date.now(), fallbacks = [] } = {}) {
    const account = this.account(accountId);
    const unmetered = account?.state?.unmetered;
    if (!unmetered || !Object.keys(unmetered).length) return 0;
    const db = this.db;
    const minMin = Math.max(1, Number(this.settings.get('min_session_minutes')) || 2);
    const spans = db.prepare(`SELECT * FROM presence WHERE account_id = ? AND ended_at IS NOT NULL AND session_id IS NULL AND ended_at > ?
      ORDER BY started_at`).all(accountId, now - 3 * DAY).filter((sp) => unmetered[sp.ext_id]);
    const missed = fallbacks.filter((f) => unmetered[f.extId] && f.at && f.at <= now + 5 * MIN);
    if (!spans.length && !missed.length) return 0;
    let made = 0;
    let estimated = 0;
    tx(db, () => {
      for (const sp of spans) {
        const entry = db.prepare('SELECT * FROM entries WHERE account_id = ? AND ext_id = ?').get(accountId, sp.ext_id);
        if (!entry) continue; // not in the library yet: the sync after this span adds it
        const minutes = Math.round((sp.ended_at - sp.started_at) / MIN);
        if (minutes < minMin) { db.prepare('UPDATE presence SET session_id = 0 WHERE id = ?').run(sp.id); continue; }
        const r = db.prepare(`INSERT INTO sessions(entry_id, sync_id, source, kind, minutes, window_start, window_end, started_at, ended_at, confidence, device, note, created_at)
          VALUES (?, NULL, 'presence', 'play', ?, ?, ?, ?, ?, 'exact', ?, ?, ?)`)
          .run(entry.id, minutes, sp.started_at, sp.ended_at, sp.started_at, sp.ended_at, sp.device || null, 'From live presence (platform reports no playtime for this title)', now);
        db.prepare('UPDATE presence SET session_id = ? WHERE id = ?').run(r.lastInsertRowid, sp.id);
        db.prepare('UPDATE entries SET playtime_min = playtime_min + ?, last_played_at = MAX(COALESCE(last_played_at, 0), ?) WHERE id = ?').run(minutes, sp.ended_at, entry.id);
        made++;
      }
      // fallback: the platform says the title was played (new last-played time) but presence saw
      // nothing (quota pause, container down, presence off). Record one session ending then, as
      // long as this player's typical session (capped by the time since the previous play),
      // clearly marked as an estimated length.
      if (missed.length) {
        const lens = db.prepare(`SELECT s.minutes FROM sessions s JOIN entries e ON e.id = s.entry_id
          WHERE e.account_id = ? AND s.kind = 'play' AND s.confidence = 'exact' ORDER BY s.id DESC LIMIT 200`).all(accountId).map((r) => r.minutes).sort((a, b) => a - b);
        const typical = lens.length >= 5 ? lens[lens.length >> 1] : 60;
        for (const f of missed) {
          const entry = db.prepare('SELECT * FROM entries WHERE account_id = ? AND ext_id = ?').get(accountId, f.extId);
          if (!entry) continue;
          // presence running then or ending near it (Xbox last-played marks the end), or an
          // existing session ending near it, already explains this play
          const seen = db.prepare(`SELECT 1 FROM presence WHERE account_id = ? AND ext_id = ? AND started_at <= ? AND COALESCE(ended_at, ?) >= ? LIMIT 1`)
            .get(accountId, f.extId, f.at + 30 * MIN, now, f.at - 30 * MIN);
          const covered = db.prepare(`SELECT 1 FROM sessions WHERE entry_id = ? AND kind = 'play' AND COALESCE(ended_at, window_end) BETWEEN ? AND ? LIMIT 1`)
            .get(entry.id, f.at - 30 * MIN, f.at + 30 * MIN);
          if (seen || covered) continue;
          const gap = f.prev ? Math.floor((f.at - f.prev) / MIN) : Infinity;
          const minutes = Math.max(minMin, Math.min(typical, gap, 360));
          const start = f.at - minutes * MIN;
          const r = db.prepare(`INSERT INTO sessions(entry_id, sync_id, source, kind, minutes, window_start, window_end, started_at, ended_at, confidence, device, note, created_at)
            VALUES (?, NULL, 'sync', 'play', ?, ?, ?, ?, ?, 'pinned', NULL, ?, ?)`)
            .run(entry.id, minutes, start, f.at, start, f.at, 'Length estimated: the platform reports no playtime for this title and live presence missed this session', now);
          db.prepare('UPDATE entries SET playtime_min = playtime_min + ?, last_played_at = MAX(COALESCE(last_played_at, 0), ?) WHERE id = ?').run(minutes, f.at, entry.id);
          if (r.lastInsertRowid) estimated++;
        }
      }
      flushRollups(db);
    });
    if (made) this.plog.info(`${account.platform}/${account.name}: ${made} session${made > 1 ? 's' : ''} recorded from presence (title reports no playtime)`);
    if (estimated) this.plog.info(`${account.platform}/${account.name}: ${estimated} session${estimated > 1 ? 's' : ''} with estimated length (no playtime reported and presence missed ${estimated > 1 ? 'them' : 'it'})`);
    return made + estimated;
  }

  async pollPresence(account) {
    const provider = providers[account.platform];
    const st = this.presenceState.get(account.id) || { failures: 0 };
    const now = Date.now();
    const ctx = this.ctxFor(account);
    try {
      const res = await provider.presence(account, ctx);
      if (res === null) return; // provider declined (no budget / not configured yet)
      if (res.state) this.db.prepare('UPDATE accounts SET state = ? WHERE id = ?').run(JSON.stringify({ ...this.account(account.id).state, ...res.state }), account.id);
      st.error = res.unavailable || null;
      // the last non-empty raw report, for diagnostics
      if (res.seen?.length) st.seen = { at: now, online: res.online || null, titles: res.seen.slice(0, 10) };
      if (res.shape) st.shape = { at: now, ...res.shape };
      else if (res.online) st.online = res.online;
      this.applyPresence(account, res.playing || [], { intervalSec: provider.profile.presence.interval_sec, now });
      if (st.failures >= 3) this.plog.info(`${account.platform}/${account.name}: presence recovered`);
      st.failures = 0;
    } catch (err) {
      st.failures++;
      st.error = err.message;
      // log the first failure and then only every 10th to avoid flooding
      if (st.failures === 1 || st.failures % 10 === 0) this.plog.warn(`${account.platform}/${account.name}: presence check failed (${st.failures}x): ${err.message}`, { account_id: account.id });
    } finally {
      st.lastPoll = now;
      this.presenceState.set(account.id, st);
    }
  }

  nowPlaying() {
    return this.db.prepare(`SELECT p.account_id, p.ext_id, p.title presence_title, p.started_at, p.last_seen_at, a.platform, a.name account_name,
        e.game_id, g.title, g.cover_url
      FROM presence p JOIN accounts a ON a.id = p.account_id
      LEFT JOIN entries e ON e.account_id = p.account_id AND e.ext_id = p.ext_id LEFT JOIN games g ON g.id = e.game_id
      WHERE p.ended_at IS NULL AND p.last_seen_at > ?`).all(Date.now() - 20 * MIN)
      .map((r) => ({ ...r, title: r.title || r.presence_title || r.ext_id, minutes: Math.round((r.last_seen_at - r.started_at) / MIN) }));
  }

  presenceInfo(accountId) {
    const st = this.presenceState.get(accountId);
    return st ? { last_poll: st.lastPoll || null, failures: st.failures, error: st.error || null, online: st.online || st.seen?.online || null, last_seen: st.seen || null, reply_shape: st.shape || undefined } : null;
  }

  notify(account, result, error) {
    const s = this.settings.all();
    if (!s.webhook_url) return;
    if (s.webhook_on === 'errors' && !error) return;
    if (s.webhook_on === 'sessions' && !error && !(result?.sessions_created > 0)) return;
    sendWebhook(s.webhook_url, { account, result, error }).catch((e) => this.log.warn(`Webhook delivery failed: ${e.message}`));
  }

  /** Newly finished tracked games teach the player's style; re-date history if it moved. */
  relearn({ force = false } = {}) {
    // cheap, but no need to redo it for every account of a burst of syncs
    if (!force && this.learnedAt && Date.now() - this.learnedAt < 10 * MIN) return;
    this.learnedAt = Date.now();
    try { relearnStyle(this.db, { settings: this.settings.all(), log: this.log }); } catch (e) { this.log.error('Learning play style failed', e); }
  }

  start() {
    // History inferred by an older algorithm version (or migrated installs) is redone once.
    try {
      flushRollups(this.db);
      if (!relearnStyle(this.db, { settings: this.settings.all(), log: this.log })) reinferPending(this.db, { log: this.log, settings: this.settings.all() });
      flushRollups(this.db);
    } catch (e) { this.log.error('History inference failed', e); }
    const tick = async () => {
      const rows = this.db.prepare('SELECT * FROM accounts WHERE enabled = 1').all().map(parseAccount);
      const now = Date.now();
      for (const a of rows) {
        const provider = providers[a.platform];
        const next = this.computeNext(a);
        if (a.next_sync_at !== next) this.db.prepare('UPDATE accounts SET next_sync_at = ? WHERE id = ?').run(next, a.id);
        if (next != null && next <= now && !this.running.has(a.id)) {
          // back off 30 minutes after a failed attempt
          const last = this.db.prepare('SELECT started_at, status FROM syncs WHERE account_id = ? ORDER BY id DESC LIMIT 1').get(a.id);
          if (!(last?.status === 'error' && now - last.started_at < 30 * MIN)) {
            const trigger = this.soon.has(a.id) && this.soon.get(a.id) <= now ? 'session-end' : a.state?.deferred_titles?.length ? 'backfill' : 'schedule';
            this.sync(a.id, trigger).catch(() => {});
          }
        }
        if (provider?.presence && this.presenceEnabled(a) && a.last_sync_at && this.blockedUntil(a.id) <= now) {
          const st = this.presenceState.get(a.id) || {};
          const backoff = Math.min(10, 2 ** Math.max(0, (st.failures || 0) - 1));
          if (!st.lastPoll || now - st.lastPoll >= provider.profile.presence.interval_sec * 1000 * backoff) await this.pollPresence(a);
        }
      }
    };
    // cover art for titles imported before cover lookup existed (or added since)
    this.coverTimer = setTimeout(() => {
      for (const a of this.db.prepare('SELECT id, platform FROM accounts WHERE enabled = 1 AND last_sync_at IS NOT NULL').all()) {
        if (providers[a.platform]?.resolveCovers) this.resolveCovers(a.id).catch((e) => this.log.warn(`Cover lookup failed: ${e.message}`));
      }
    }, 20_000);
    this.coverTimer.unref?.();
    const run = () => tick().catch((e) => this.log.error('Scheduler tick failed', e));
    this.timer = setInterval(run, 30_000);
    this.timer.unref?.();
    this.firstTick = setTimeout(run, 5_000);
    this.firstTick.unref?.();
  }

  stop() {
    this.stopping = true;
    clearInterval(this.timer);
    clearTimeout(this.firstTick);
    clearTimeout(this.coverTimer);
  }
}
