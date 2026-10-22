export function fmtMinutes(min) {
  const m = Math.round(Number(min) || 0);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const toInt = (v, def = null) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

/** Accepts epoch ms/seconds, ISO strings or YYYY-MM-DD and returns epoch ms (or null). */
export function toTime(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return n < 1e11 ? n * 1000 : n;
  }
  const s = String(v);
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00`).getTime() : Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
