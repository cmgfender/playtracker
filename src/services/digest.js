// The weekly summary: last week's play in a few lines, sent through the notification webhook on
// the first day of the next week and shown on Home. Tracked play only (no estimated history).

import { computeStats, dayKey, parseDay, resolveRange } from './stats.js';
import { fmtMinutes } from '../util.js';

const DAY = 86_400_000;
const LATE_DAYS = 3; // a summary missed for longer (the server was off) is skipped, not sent late

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Start of the week `weeksAgo` weeks before the one containing `now` (local midnight). */
export function weekStart(now = Date.now(), weekStartsOn = 1, weeksAgo = 0) {
  const d = new Date(resolveRange('week', now, weekStartsOn).from);
  d.setDate(d.getDate() - 7 * weeksAgo);
  return d.getTime();
}

/**
 * The week `weeksAgo` weeks back (0 = this week so far, 1 = last week): totals, the change from
 * the week before, top games, new games, achievements and highlights.
 */
export function weeklySummary(db, { weeksAgo = 1, weekStartsOn = 1, now = Date.now() } = {}) {
  const from = weekStart(now, weekStartsOn, weeksAgo);
  const next = new Date(from); next.setDate(next.getDate() + 7);
  const end = Math.min(now, next.getTime() - 1);
  const stats = (at) => computeStats(db, { range: 'week', now: at, weekStartsOn, estimates: 'exclude', topLimit: 5 });
  const week = stats(end);
  const prev = stats(from - 1);
  const to = week.range.to;

  const ach = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(a.points), 0) points FROM achievements a JOIN entries e ON e.id = a.entry_id
    WHERE a.unlocked = 1 AND a.unlocked_at >= ? AND a.unlocked_at <= ? AND e.excluded = 0`).get(from, to);
  const rarest = db.prepare(`SELECT a.name, a.rarity, a.grade, g.title, g.id game_id FROM achievements a JOIN entries e ON e.id = a.entry_id JOIN games g ON g.id = e.game_id
    WHERE a.unlocked = 1 AND a.unlocked_at >= ? AND a.unlocked_at <= ? AND e.excluded = 0 AND a.rarity IS NOT NULL ORDER BY a.rarity ASC LIMIT 1`).get(from, to) || null;
  const platinums = db.prepare(`SELECT g.title FROM achievements a JOIN entries e ON e.id = a.entry_id JOIN games g ON g.id = e.game_id
    WHERE a.unlocked = 1 AND a.unlocked_at >= ? AND a.unlocked_at <= ? AND e.excluded = 0 AND a.grade = 'platinum' ORDER BY a.unlocked_at`).all(from, to).map((r) => r.title);
  // first played ever (estimated history included, so a game tracked only recently is not "new")
  const fromDay = dayKey(from); const toDay = dayKey(to);
  const fresh = db.prepare(`SELECT g.id game_id, g.title, MIN(p.day) first FROM play_days p JOIN games g ON g.id = p.game_id
    WHERE p.excluded = 0 GROUP BY p.game_id HAVING first >= ? AND first <= ? ORDER BY first`).all(fromDay, toDay);

  const delta = prev.tracked_minutes ? Math.round(((week.tracked_minutes - prev.tracked_minutes) / prev.tracked_minutes) * 100) : null;
  const busiest = week.busiest_day ? { ...week.busiest_day, weekday: new Date(parseDay(week.busiest_day.day)).toLocaleDateString('en-US', { weekday: 'long' }) } : null;
  return {
    week: { from, to, start_day: fromDay, end_day: dayKey(next.getTime() - 1), complete: next.getTime() - 1 <= now, weeks_ago: weeksAgo },
    minutes: week.tracked_minutes,
    sessions: week.sessions,
    games_played: week.games_played,
    days_played: week.days_played,
    previous_minutes: prev.tracked_minutes,
    change_percent: delta,
    top_games: week.top_games.slice(0, 3).map((g) => ({ game_id: g.game_id, title: g.title, cover_url: g.cover_url, minutes: g.minutes, sessions: g.sessions, platforms: g.platforms })),
    platforms: week.platforms,
    new_games: fresh.map((g) => ({ game_id: g.game_id, title: g.title })),
    achievements: { unlocked: ach.n, points: ach.points, rarest, platinums },
    longest_session: week.longest_session,
    busiest_day: busiest,
    streak_days: week.streaks.current,
  };
}

/** The summary as chat text (Discord / Slack / the generic webhook's `text`). */
export function summaryText(s) {
  const d = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const head = `Vestigo · your week (${d(s.week.from)} – ${d(s.week.to)})`;
  if (!s.minutes) return `${head}\nNo tracked play this week${s.previous_minutes ? ` (${fmtMinutes(s.previous_minutes)} the week before)` : ''}.`;
  const change = s.change_percent == null ? '' : s.change_percent === 0 ? ', same as the week before' : `, ${Math.abs(s.change_percent)}% ${s.change_percent > 0 ? 'more' : 'less'} than the week before`;
  const lines = [head, `${fmtMinutes(s.minutes)} over ${plural(s.days_played, 'day')} · ${plural(s.sessions, 'session')} · ${plural(s.games_played, 'game')}${change}`];
  if (s.top_games.length) lines.push(...s.top_games.map((g, i) => `${i + 1}. ${g.title} — ${fmtMinutes(g.minutes)}`));
  if (s.new_games.length) lines.push(`New: ${s.new_games.slice(0, 5).map((g) => g.title).join(', ')}${s.new_games.length > 5 ? ` and ${s.new_games.length - 5} more` : ''}`);
  const a = s.achievements;
  if (a.unlocked) {
    let line = `${plural(a.unlocked, 'achievement')} unlocked${a.points ? ` (${a.points} G)` : ''}`;
    if (a.rarest) line += ` · rarest: ${a.rarest.name} in ${a.rarest.title} (${a.rarest.rarity < 10 ? a.rarest.rarity.toFixed(1) : Math.round(a.rarest.rarity)}%)`;
    lines.push(line);
  }
  if (a.platinums.length) lines.push(`Platinum: ${a.platinums.join(', ')}`);
  if (s.longest_session) lines.push(`Longest session: ${fmtMinutes(s.longest_session.minutes)} of ${s.longest_session.title}`);
  if (s.busiest_day) lines.push(`Busiest day: ${s.busiest_day.weekday} (${fmtMinutes(s.busiest_day.minutes)})`);
  if (s.streak_days > 1) lines.push(`Current streak: ${s.streak_days} days`);
  return lines.join('\n');
}

/**
 * When the summary of last week is due: the first day of this week at `time`. Returns the
 * week to send (its start, as YYYY-MM-DD) or null when nothing is due now.
 */
export function summaryDue(s, lastSent, now = Date.now()) {
  if (!s.weekly_summary || !s.webhook_url) return null;
  const start = weekStart(now, s.week_starts_on ?? 1);
  const [h, m] = String(s.weekly_summary_time || '09:00').split(':').map(Number);
  const at = new Date(start); at.setHours(h, m, 0, 0);
  if (now < at.getTime() || now - at.getTime() > LATE_DAYS * DAY) return null;
  const week = dayKey(weekStart(now, s.week_starts_on ?? 1, 1));
  return lastSent === week ? null : week;
}

/** Sends last week's summary once, on the first day of the week at weekly_summary_time. */
export class WeeklySummary {
  constructor({ db, settings, log, send }) {
    this.db = db;
    this.settings = settings;
    this.log = log;
    this.send = send; // (url, summary, text) => Promise
    this.failures = 0;
    this.retryAt = 0;
  }

  async tick(now = Date.now()) {
    const s = this.settings.all();
    const week = summaryDue(s, s.weekly_summary_sent, now);
    if (!week || now < this.retryAt || this.busy) return false;
    this.busy = true;
    try {
      const summary = weeklySummary(this.db, { weeksAgo: 1, weekStartsOn: s.week_starts_on ?? 1, now });
      await this.send(s.webhook_url, summary, summaryText(summary));
      this.settings.set({ weekly_summary_sent: week });
      this.failures = 0;
      this.log?.info(`Weekly summary sent for the week of ${week}`);
      return true;
    } catch (err) {
      // tried again with growing gaps (5, 10, 20 … minutes, at most an hour) until the day is over
      this.failures++;
      this.retryAt = now + Math.min(60, 5 * 2 ** (this.failures - 1)) * 60_000;
      this.log?.warn(`Weekly summary not sent: ${err.message}`);
      return false;
    } finally {
      this.busy = false;
    }
  }

  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), 60_000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }
}
