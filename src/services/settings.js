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
  history_learn: true,               // learn this player's play pattern from fully tracked games to date history

  // Notifications
  webhook_url: '',
  webhook_on: 'sessions',     // 'sessions' | 'always' | 'errors'
  weekly_summary: true,       // last week's summary through the webhook, on the first day of the week (week_starts_on)
  weekly_summary_time: '09:00',

  // Automatic backups to <data>/backups (or VESTIGO_BACKUP_DIR)
  backup_mode: 'daily',       // 'daily' | 'weekly' (on week_starts_on) | 'off'
  backup_time: '03:30',
  backup_keep: 7,             // scheduled backups kept (1..90); the oldest beyond this are removed

  // UI (stored server-side so every device gets the same look)
  theme: 'dark',              // 'dark' | 'black' (OLED) | 'light' | 'auto'
  accent: '#7656ff',          // Vestigo Violet; the UI reads a stored #7c5cff (the old default) as this
  default_library_sort: 'recent',
  ui_density: 'comfortable',  // 'comfortable' | 'compact'
  cover_size: 'm',            // library grid: 's' | 'm' | 'l'
  cover_titles: 'auto',       // title on covers: 'auto' (only without art) | 'always' | 'never'
  library_view: 'grid',       // 'grid' | 'list'
  library_hide_unplayed: false,
  time_format: 'hm',          // 'hm' (1h 5m) | 'decimal' (1.1h)
  start_page: 'home',         // 'home' | 'library' | 'sessions' | 'stats'
  // home sections in order; a leading '-' hides one
  dashboard_layout: 'kpis,live,jump,suggest,recap,chart,top,recent,accounts,-heatmap,-backlog',
};

export const DASHBOARD_SECTIONS = ['kpis', 'live', 'jump', 'suggest', 'recap', 'chart', 'top', 'recent', 'accounts', 'heatmap', 'backlog'];
const ENUMS = {
  theme: ['dark', 'black', 'light', 'auto'],
  ui_density: ['comfortable', 'compact'],
  cover_size: ['s', 'm', 'l'],
  cover_titles: ['auto', 'always', 'never'],
  library_view: ['grid', 'list'],
  time_format: ['hm', 'decimal'],
  start_page: ['home', 'library', 'sessions', 'stats'],
  default_library_sort: ['recent', 'trending', 'playtime', 'title', 'added', 'rating'],
  stats_estimates: ['include', 'exclude'],
  webhook_on: ['sessions', 'always', 'errors'],
  backup_mode: ['daily', 'weekly', 'off'],
};
const BOOLS = new Map([[true, true], ['true', true], [1, true], ['1', true], [false, false], ['false', false], [0, false], ['0', false]]);

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
    delete s.history_style; // learned data, not a setting
    delete s.weekly_summary_sent; // the last week summarized
    return s;
  }
}

const VALID_MODES = ['off', 'hourly', 'hours', 'daily', 'days', 'weekly', 'monthly'];

export function validateSettings(patch) {
  const out = {};
  const errors = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, k)) continue; // not `in`: that also sees toString, constructor, ...
    const def = DEFAULT_SETTINGS[k];
    if (typeof def === 'number') {
      // numbers and numeric strings only (Number() would turn null, '', true and [3] into numbers)
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
      if (!Number.isFinite(n)) { errors.push(`${k} must be a number`); continue; }
      out[k] = n;
    } else if (typeof def === 'boolean') {
      if (!BOOLS.has(v)) { errors.push(`${k} must be true or false`); continue; }
      out[k] = BOOLS.get(v);
    } else {
      out[k] = String(v ?? '');
    }
  }
  const badInt = (k, min, max) => k in out && !(Number.isInteger(out[k]) && out[k] >= min && out[k] <= max);
  if ('schedule_mode' in out && !VALID_MODES.includes(out.schedule_mode)) errors.push(`schedule_mode must be one of ${VALID_MODES.join(', ')}`);
  if ('schedule_time' in out && !/^([01]\d|2[0-3]):[0-5]\d$/.test(out.schedule_time)) errors.push('schedule_time must be HH:MM');
  for (const k of ['weekly_summary_time', 'backup_time']) if (k in out && !/^([01]\d|2[0-3]):[0-5]\d$/.test(out[k])) errors.push(`${k} must be HH:MM`);
  if (badInt('backup_keep', 1, 90)) errors.push('backup_keep must be 1..90');
  if (badInt('schedule_every', 1, 365)) errors.push('schedule_every must be 1..365');
  if (badInt('schedule_weekday', 0, 6)) errors.push('schedule_weekday must be 0..6');
  if (badInt('schedule_monthday', 1, 28)) errors.push('schedule_monthday must be 1..28');
  if (badInt('week_starts_on', 0, 6)) errors.push('week_starts_on must be 0..6 (0 = Sunday)');
  for (const k of ['min_session_minutes', 'max_overage_minutes']) if (k in out && out[k] < 0) errors.push(`${k} cannot be negative`);
  // per-day caps for dated history: a day has 1440 minutes, and 0 or less would leave no room at all
  for (const k of ['history_max_day_minutes', 'history_max_game_day_minutes']) if (k in out && (out[k] < 1 || out[k] > 1440)) errors.push(`${k} must be 1..1440`);
  if (out.webhook_url && !/^https?:\/\//.test(out.webhook_url)) errors.push('webhook_url must be http(s)');
  for (const [k, allowed] of Object.entries(ENUMS)) if (k in out && !allowed.includes(out[k])) errors.push(`${k} must be one of ${allowed.join(', ')}`);
  if ('accent' in out && !/^#[0-9a-f]{6}$/i.test(out.accent)) errors.push('accent must be a #rrggbb color');
  if ('dashboard_layout' in out) {
    const parts = out.dashboard_layout.split(',').map((x) => x.trim()).filter(Boolean);
    const names = parts.map((x) => x.replace(/^-/, ''));
    if (names.some((n) => !DASHBOARD_SECTIONS.includes(n)) || new Set(names).size !== names.length) errors.push(`dashboard_layout sections: ${DASHBOARD_SECTIONS.join(', ')}`);
    // sections added in later versions appear (hidden) at the end
    else out.dashboard_layout = [...parts, ...DASHBOARD_SECTIONS.filter((n) => !names.includes(n)).map((n) => `-${n}`)].join(',');
  }
  return { values: out, errors };
}
