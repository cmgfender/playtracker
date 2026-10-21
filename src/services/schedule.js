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

  if (mode === 'daily' || mode === 'days') {
    const step = mode === 'daily' ? 1 : every;
    // Next slot strictly after lastRun, then (step-1) more days.
    let slot = atTime(lastRun, time);
    if (slot.getTime() <= lastRun) slot.setDate(slot.getDate() + 1);
    slot.setDate(slot.getDate() + (step - 1));
    return slot.getTime();
  }

  if (mode === 'weekly') {
    const wd = Number(s.schedule_weekday ?? 1);
    const slot = atTime(lastRun, time);
    let diff = (wd - slot.getDay() + 7) % 7;
    if (diff === 0 && slot.getTime() <= lastRun) diff = 7;
    slot.setDate(slot.getDate() + diff);
    // Guard against very short gaps (e.g. manual sync an hour before the slot).
    if (slot.getTime() - lastRun < 12 * HOUR) slot.setDate(slot.getDate() + 7);
    return slot.getTime();
  }

  if (mode === 'monthly') {
    const md = Math.min(28, Math.max(1, Number(s.schedule_monthday ?? 1)));
    const slot = atTime(lastRun, time);
    slot.setDate(md);
    if (slot.getTime() <= lastRun) slot.setMonth(slot.getMonth() + 1);
    if (slot.getTime() - lastRun < 2 * DAY) slot.setMonth(slot.getMonth() + 1);
    return slot.getTime();
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
