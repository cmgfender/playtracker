// Platform history models.
//
// Every platform reports history differently: when totals update, what "last played"
// means, which extra counters exist. Instead of special-casing platforms inside the sync
// engine, each provider declares a `profile.history` and the engine asks this model how
// to interpret a report. The model can also *learn*: when live presence shows exactly
// when a session happened, it checks what the platform's "last played" timestamp really
// marks (session start vs end) and corrects the declared default per account.

const MIN = 60_000;
const DAY = 86_400_000;

export const HISTORY_DEFAULTS = {
  // How the lifetime counter advances:
  //   'on-exit'   - only when a session ends (in-progress play is never in the total)
  //   'delayed'   - after the session ends, with a lag of `lag_min`
  //   'periodic'  - during play, flushed every so often (a long session spans several reports)
  //   'on-report' - whenever an external reporter pushes a total
  update: 'on-report',
  lag_min: 0,
  // What the last-played timestamp marks: 'start' (launch), 'end' (exit) or 'activity'
  last_played: 'end',
  first_played: false,      // platform reports when the title was first played
  play_count: false,        // platform reports a launch counter
  recent: null,             // { days, strict } rolling "minutes in the last N days" counter
  devices: null,            // per-device lifetime counters reported (keys)
  offline_counter: null,    // per-device key that grows when offline play is uploaded late
  complete_library: true,   // every report lists the whole library (titles missing = removed)
  grouping: null,           // how multiple ids form one product (e.g. PS4 + PS5 versions)
  max_session_min: 720,     // longest believable single session
  single_title: false,      // the account can only run one game at a time
  granularity: 'minute',
};

/** Votes needed (and agreement ratio) before calibration overrides the declared meaning. */
const CALIBRATION_MIN_VOTES = 3;
const CALIBRATION_AGREEMENT = 0.75;

export function modelFor(provider, account = null) {
  const h = { ...HISTORY_DEFAULTS, ...(provider?.profile?.history || {}) };
  const declared = account?.config?.last_played_meaning || h.last_played;
  const cal = account?.state?.calibration?.last_played || null;
  let meaning = declared;
  let calibrated = false;
  if (cal) {
    const total = (cal.start || 0) + (cal.end || 0);
    const lead = (cal.start || 0) >= (cal.end || 0) ? 'start' : 'end';
    if (total >= CALIBRATION_MIN_VOTES && Math.max(cal.start || 0, cal.end || 0) / total >= CALIBRATION_AGREEMENT) {
      meaning = lead;
      calibrated = true;
    }
  }
  const lagMs = h.lag_min * MIN;
  const slackMs = lagMs + 2 * MIN;
  const maxSessionMs = h.max_session_min * MIN;

  return {
    ...h,
    declared,
    lastPlayed: meaning === 'activity' ? 'end' : meaning,
    calibrated,
    calibration: cal,

    /**
     * The real-time window a delta between two reports covers. A platform with a reporting
     * lag describes play up to (report time - lag), so the window shifts back by the lag.
     */
    window(prevReportAt, now) {
      return [prevReportAt - lagMs, now - lagMs];
    },

    /**
     * Most minutes a delta covering [ws, we] can plausibly hold. Platforms that report a
     * session only when it ends (on-exit / delayed) can deliver a session that started
     * before the window, so they get one extra maximum-length session of headroom.
     */
    capacityMin(ws, we) {
      const elapsed = Math.max(0, (we - ws) / MIN);
      return h.update === 'on-exit' || h.update === 'delayed' ? elapsed + h.max_session_min : elapsed;
    },

    /** Does an open (still running) session already contribute to reported totals? */
    countsInProgress() {
      return h.update === 'periodic' || h.update === 'on-report';
    },

    /**
     * Can presence span `s` (from live tracking) be part of this delta?
     * on-exit/delayed platforms only report sessions that ended at least `lag` ago.
     */
    spanReported(s, ws, we) {
      const end = s.ended_at ?? s.last_seen_at;
      if (s.ended_at == null && !this.countsInProgress()) return false;
      if (end <= ws - slackMs || s.started_at >= we + slackMs) return false;
      if (!this.countsInProgress() && s.ended_at > we + slackMs) return false;
      return true;
    },

    /**
     * Pin a session of `minutes` using the platform's last-played timestamp, honouring what
     * that timestamp means. Returns null when the timestamp can't belong to this delta
     * (e.g. Steam's last-played is the launch of a session that is still running).
     */
    pin(minutes, ws, we, lastPlayedAt) {
      if (!lastPlayedAt) return null;
      const len = minutes * MIN;
      if (this.lastPlayed === 'start') {
        // the session started at lastPlayedAt and must have finished within the window
        if (lastPlayedAt < ws - maxSessionMs || lastPlayedAt + len > we + slackMs) return null;
        return { started: lastPlayedAt, ended: Math.min(lastPlayedAt + len, we + slackMs) };
      }
      // 'end': the session ended at lastPlayedAt
      if (lastPlayedAt > we + slackMs || lastPlayedAt <= ws - slackMs) return null;
      return { started: Math.max(lastPlayedAt - len, ws - maxSessionMs), ended: lastPlayedAt };
    },

    /** Anchor day/time used when spreading a long delta (where the last play happened). */
    lastActivity(lastPlayedAt, minutes, ws, we) {
      if (!lastPlayedAt || lastPlayedAt > we + slackMs || lastPlayedAt < ws) return null;
      // a launch time proves activity at that moment (the session may still be running)
      return lastPlayedAt;
    },

    /**
     * Rolling "recent minutes" counters bound how much of a delta can be recent. Anything
     * beyond it was played earlier and uploaded late (offline play) - not this window.
     */
    recentBound(delta, ws, now, recentMin) {
      if (!h.recent?.strict || recentMin == null) return { inWindow: delta, late: 0 };
      if (now - ws > h.recent.days * DAY) return { inWindow: delta, late: 0 };
      const inWindow = Math.min(delta, Math.max(0, recentMin));
      return { inWindow, late: delta - inWindow };
    },

    /** Calibration vote: does `lastPlayedAt` sit at the start or the end of a known span? */
    vote(lastPlayedAt, span) {
      if (!lastPlayedAt || !span) return null;
      const s = span.started_at;
      const e = span.ended_at ?? span.last_seen_at;
      const ds = Math.abs(lastPlayedAt - s);
      const de = Math.abs(lastPlayedAt - e);
      if (Math.min(ds, de) > 15 * MIN || e - s < 10 * MIN) return null; // too ambiguous to learn from
      return ds < de ? 'start' : 'end';
    },

    describe() {
      const upd = { 'on-exit': 'when a game closes', delayed: `after a session, with ~${h.lag_min} min delay`, periodic: `periodically during play (~${h.lag_min} min lag)`, 'on-report': 'whenever you push a report' }[h.update];
      return {
        update: upd,
        last_played: `${meaning === 'start' ? 'session start (launch)' : 'session end'}${calibrated ? ` — calibrated from ${(cal.start || 0) + (cal.end || 0)} observed sessions` : declared !== meaning ? '' : ' (declared)'}`,
        counters: [h.first_played && 'first played', h.play_count && 'launch count', h.recent && `last ${h.recent.days} days`, h.devices && `per device (${h.devices.join(', ')})`].filter(Boolean),
        grouping: h.grouping,
      };
    },
  };
}

export function deviceDelta(model, prev, next) {
  if (!next || !prev) return { device: null, offline: false };
  let best = null; let bestInc = 0;
  for (const [k, v] of Object.entries(next)) {
    if (k === model.offline_counter) continue;
    const inc = (v || 0) - (prev[k] || 0);
    if (inc > bestInc) { bestInc = inc; best = k; }
  }
  const off = model.offline_counter;
  return { device: best, offline: !!off && (next[off] || 0) > (prev[off] || 0) };
}

/** Split an integer total into integer parts proportional to weights (largest remainder). */
export function intSplit(total, weights) {
  total = Math.round(total);
  const sum = weights.reduce((a, w) => a + Math.max(0, w), 0);
  if (!weights.length) return [];
  if (sum <= 0) return weights.map((_, i) => (i === weights.length - 1 ? total : 0));
  const raw = weights.map((w) => (total * Math.max(0, w)) / sum);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((a, x) => a + x, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k][1]]++;
  return out;
}
