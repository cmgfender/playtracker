export const DEFAULT_SETTINGS = {
  // Sync schedule: 'hourly' | 'daily' | 'weekly' | 'monthly' | 'days' | 'hours' | 'off'
  schedule_mode: 'daily',
  schedule_every: 2,          // N for 'days' / 'hours'
  schedule_time: '04:00',     // local time of day for daily/weekly/monthly/days
  schedule_weekday: 1,        // 0=Sun .. 6=Sat for weekly
  schedule_monthday: 1,       // 1..28 for monthly

  // Session detection
  min_session_minutes: 2,     // ignore deltas smaller than this (noise)
  max_overage_minutes: 15,    // tolerance before a delta larger than wall-clock time is split into baseline
  use_recent_on_import: true, // Steam's playtime_2weeks becomes a real session on first import
  auto_merge_titles: true,    // group same-title games across platforms automatically
  week_starts_on: 1,          // 0=Sun, 1=Mon
  stats_estimates: 'include', // charts include inferred pre-tracking history (flagged) - 'include' | 'exclude'
  history_max_day_minutes: 720,      // inferred history: max minutes per day across all games
  history_max_game_day_minutes: 600, // inferred history: max minutes per day for one game

  // Notifications
  webhook_url: '',
  webhook_on: 'sessions',     // 'sessions' | 'always' | 'errors'

  // UI
  theme: 'dark',
  accent: '#7c5cff',
  default_library_sort: 'recent',
};

export class Settings {
  constructor(db) {
    this.db = db;
    this.cache = null;
  }

  all() {
    if (!this.cache) {
      const out = { ...DEFAULT_SETTINGS };
      for (const row of this.db.prepare('SELECT key, value FROM settings').all()) {
        try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = row.value; }
      }
      this.cache = out;
    }
    return { ...this.cache };
  }

  get(key) {
    return this.all()[key];
  }

  set(patch) {
    const stmt = this.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v));
    this.cache = null;
    return this.all();
  }

  // Settings safe to send to the browser (no secrets).
  public() {
    const s = this.all();
    delete s.password_hash;
    return s;
  }
}

const VALID_MODES = ['off', 'hourly', 'hours', 'daily', 'days', 'weekly', 'monthly'];

export function validateSettings(patch) {
  const out = {};
  const errors = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[k];
    if (typeof def === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) { errors.push(`${k} must be a number`); continue; }
      out[k] = n;
    } else if (typeof def === 'boolean') {
      out[k] = v === true || v === 'true' || v === 1 || v === '1';
    } else {
      out[k] = String(v ?? '');
    }
  }
  if (out.schedule_mode && !VALID_MODES.includes(out.schedule_mode)) errors.push(`schedule_mode must be one of ${VALID_MODES.join(', ')}`);
  if (out.schedule_time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(out.schedule_time)) errors.push('schedule_time must be HH:MM');
  if ('schedule_every' in out && (out.schedule_every < 1 || out.schedule_every > 365)) errors.push('schedule_every must be 1..365');
  if ('schedule_weekday' in out && (out.schedule_weekday < 0 || out.schedule_weekday > 6)) errors.push('schedule_weekday must be 0..6');
  if ('schedule_monthday' in out && (out.schedule_monthday < 1 || out.schedule_monthday > 28)) errors.push('schedule_monthday must be 1..28');
  if (out.webhook_url && !/^https?:\/\//.test(out.webhook_url)) errors.push('webhook_url must be http(s)');
  if (out.stats_estimates && !['include', 'exclude'].includes(out.stats_estimates)) errors.push('stats_estimates must be include or exclude');
  return { values: out, errors };
}
