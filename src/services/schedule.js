const HOUR = 3600_000;
const DAY = 24 * HOUR;

function atTime(date, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * Compute the next time a sync should run.
 * @param {object} s schedule settings (schedule_mode, schedule_every, schedule_time, ...)
 * @param {number|null} lastRun epoch ms of the last sync (null = never)
 * @param {number} now epoch ms
 * @returns {number|null} epoch ms, or null when scheduling is off
 */
export function nextRun(s, lastRun, now = Date.now()) {
  const mode = s.schedule_mode;
  const every = Math.max(1, Math.floor(Number(s.schedule_every) || 1));
  const time = s.schedule_time || '04:00';
  if (mode === 'off') return null;
  if (lastRun == null) return now;

  if (mode === 'hourly') return lastRun + HOUR;
  if (mode === 'hours') return lastRun + every * HOUR;

  // Move `day` by whole days/months first and set the time last (atTime): on a spring-forward
  // day a missing 02:30 becomes 03:30, and moving that slot would keep the shifted hour.
  const day = new Date(lastRun);
  if (mode === 'daily' || mode === 'days') {
    const step = mode === 'daily' ? 1 : every;
    // Next slot strictly after lastRun, then (step-1) more days.
    if (atTime(day, time).getTime() <= lastRun) day.setDate(day.getDate() + 1);
    day.setDate(day.getDate() + (step - 1));
    return atTime(day, time).getTime();
  }

  if (mode === 'weekly') {
    const wd = Number(s.schedule_weekday ?? 1);
    let diff = (wd - day.getDay() + 7) % 7;
    if (diff === 0 && atTime(day, time).getTime() <= lastRun) diff = 7;
    day.setDate(day.getDate() + diff);
    // Guard against very short gaps (e.g. manual sync an hour before the slot).
    if (atTime(day, time).getTime() - lastRun < 12 * HOUR) day.setDate(day.getDate() + 7);
    return atTime(day, time).getTime();
  }

  if (mode === 'monthly') {
    const md = Math.min(28, Math.max(1, Number(s.schedule_monthday ?? 1)));
    day.setDate(md);
    if (atTime(day, time).getTime() <= lastRun) day.setMonth(day.getMonth() + 1);
    if (atTime(day, time).getTime() - lastRun < 2 * DAY) day.setMonth(day.getMonth() + 1);
    return atTime(day, time).getTime();
  }

  return lastRun + DAY;
}

export function describeSchedule(s) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  switch (s.schedule_mode) {
    case 'off': return 'Manual only';
    case 'hourly': return 'Every hour';
    case 'hours': return `Every ${s.schedule_every} hours`;
    case 'daily': return `Daily at ${s.schedule_time}`;
    case 'days': return `Every ${s.schedule_every} days at ${s.schedule_time}`;
    case 'weekly': return `Weekly on ${days[s.schedule_weekday]} at ${s.schedule_time}`;
    case 'monthly': return `Monthly on day ${s.schedule_monthday} at ${s.schedule_time}`;
    default: return s.schedule_mode;
  }
}
