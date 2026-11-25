// Your own eras: stretches of your life you name ("College", "High school", "After the wedding"),
// each a legend of what you played in it. Kept in settings (key legend_eras), so they travel with
// backups and need no schema of their own.

import { HttpError } from '../../util.js';

const KEY = 'legend_eras';
const MAX = 60;
const pad = (n) => String(n).padStart(2, '0');

/** "2012", "2012-09" or "2012-09-01" as a day: the first of the period, or its last (`end`). Null when empty. */
function day(v, end, field) {
  if (v == null || v === '') return null;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(String(v).trim());
  if (!m) throw new HttpError(400, `${field} must be a date: 2012, 2012-09 or 2012-09-01`);
  const y = Number(m[1]); const mo = m[2] ? Number(m[2]) : (end ? 12 : 1);
  const last = new Date(y, mo, 0).getDate();
  const d = m[3] ? Number(m[3]) : (end ? last : 1);
  if (y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > last) throw new HttpError(400, `${field} is not a real date`);
  return `${y}-${pad(mo)}-${pad(d)}`;
}

function clean(body, was = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const name = 'name' in b ? String(b.name ?? '').trim().replace(/\s+/g, ' ') : was.name;
  if (!name) throw new HttpError(400, 'An era needs a name');
  if (name.length > 60) throw new HttpError(400, 'An era\'s name is at most 60 characters');
  const from = 'from' in b ? day(b.from, false, 'from') : was.from;
  if (!from) throw new HttpError(400, 'An era needs the date it began');
  const to = 'to' in b ? day(b.to, true, 'to') : (was.to ?? null);
  if (to && to < from) throw new HttpError(400, 'An era ends after it begins');
  const note = 'note' in b ? String(b.note ?? '').trim().slice(0, 200) : (was.note || '');
  return { name, from, to, note };
}

/** Your eras, oldest first: [{ id, name, from (YYYY-MM-DD), to (YYYY-MM-DD | null: still going), note }]. */
export function listEras(settings) {
  const v = settings.get(KEY);
  return (Array.isArray(v) ? v : []).filter((e) => e && e.id && e.name && e.from).sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.id - b.id));
}

export function addEra(settings, body) {
  const all = listEras(settings);
  if (all.length >= MAX) throw new HttpError(400, `At most ${MAX} eras`);
  const era = { id: all.reduce((a, e) => Math.max(a, e.id), 0) + 1, ...clean(body) };
  settings.set({ [KEY]: [...all, era] });
  return era;
}

export function updateEra(settings, id, body) {
  const all = listEras(settings);
  const was = all.find((e) => e.id === id);
  if (!was) throw new HttpError(404, 'No such era');
  const era = { id, ...clean(body, was) };
  settings.set({ [KEY]: all.map((e) => (e.id === id ? era : e)) });
  return era;
}

export function removeEra(settings, id) {
  const all = listEras(settings);
  if (!all.some((e) => e.id === id)) throw new HttpError(404, 'No such era');
  settings.set({ [KEY]: all.filter((e) => e.id !== id) });
  return { ok: true };
}
