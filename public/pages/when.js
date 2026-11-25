// "When did you play this?" with everything known about it: the release, the day it was added to
// the library, first and last played, the first and last achievement, the first tracked session -
// so history is dated from evidence instead of a guess. Also the period picker of the Improve
// history answers, and Add a game (your library and IGDB as you type, the hours played before).
import { esc, fmtMin, fmtDate, plat, platDot, cover, icon, api, toast, fail, modal, plural, STATUSES, navigate, rerender } from '../app.js';

const DAYF = { year: 'numeric', month: 'short', day: 'numeric' };
const MONF = { year: 'numeric', month: 'short' };
const day = (t) => fmtDate(t, DAYF);
const DAY = 864e5;
/** An IGDB release (a calendar day at midnight UTC) as noon of that day here. */
const igdbDay = (t) => { if (!t) return null; const d = new Date(t); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12).getTime(); };

/** A time as the value of an <input type=date> (its local day). */
export const dateValue = (t) => (t ? new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '');
/** An <input type=date> value as the API takes it: noon on a start day, 8 pm on an end day. */
const apiTime = (v, end) => (v ? `${v}T${end ? '20' : '12'}:00:00` : null);

// ---------------------------------------------------------------------
// Period picker: "Mostly played in [2018] [Apr – Jun] [ ] until [2019]"
// ---------------------------------------------------------------------
export const PERIODS = [['year', 'Whole year', 0, 11], ['q1', 'Jan – Mar', 0, 2], ['q2', 'Apr – Jun', 3, 5], ['q3', 'Jul – Sep', 6, 8], ['q4', 'Oct – Dec', 9, 11],
  ...['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => [`m${i}`, m, i, i])];

/** The years to offer: from the oldest evidence (or `back` years) to `hi`, newest first; with no guess, "Year…" first, to be picked. */
export function yearOptions(hi, lo, guess) {
  const out = guess == null ? ['<option value="" selected>Year…</option>'] : [];
  for (let y = hi; y >= lo; y--) out.push(`<option value="${y}" ${y === guess ? 'selected' : ''}>${y}</option>`);
  return out.join('');
}

export function periodPicker({ hi, lo, guess, until = null, label = 'Mostly played in' }) {
  return `<span class="small">${label}</span>
    <select class="input sm" name="y" style="width:auto" aria-label="Year">${yearOptions(hi, lo, guess)}</select>
    <select class="input sm" name="p" style="width:auto" aria-label="Period">${PERIODS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
    <label class="small row" style="gap:4px"><input type="checkbox" name="span" ${until ? 'checked' : ''}> until</label>
    <select class="input sm${until ? '' : ' hide'}" name="y2" style="width:auto" aria-label="Until year">${yearOptions(hi, lo, until ?? guess)}</select>`;
}

/** Toggle the until-year with its checkbox (call from a change listener). */
export function periodChange(e) {
  if (e.target.name === 'span') e.target.closest('[data-period]')?.querySelector('[name=y2]')?.classList.toggle('hide', !e.target.checked);
}

/** The picked period as [start, end] times: the 1st at noon to the last day at 8 pm (never after now); null with no year picked. */
export function readPeriod(root) {
  if (!root.querySelector('[name=y]').value) return null;
  const y = Number(root.querySelector('[name=y]').value);
  const [, , m0, m1] = PERIODS.find(([k]) => k === root.querySelector('[name=p]').value);
  const y2 = root.querySelector('[name=span]').checked && root.querySelector('[name=y2]').value ? Math.max(y, Number(root.querySelector('[name=y2]').value)) : y;
  const start = new Date(y, m0, 1, 12).getTime();
  const end = Math.min(Date.now(), new Date(y2, m1 + 1, 0, 20).getTime());
  return [start, Math.max(start, end)];
}

// ---------------------------------------------------------------------
// The evidence: a strip of unlocks by month (or year) with the dates on it, and the list
// ---------------------------------------------------------------------
const STRIP_MARKS = ['release', 'release_igdb', 'added', 'first_played', 'last_played', 'first_tracked'];

/** Achievements per month (or year) before tracking, the window shaded, the platform's dates as ticks. */
export function evidenceStrip(ctx, win) {
  const times = ctx.unlocks?.times || [];
  const hi = ctx.tracking_start;
  const pts = [...ctx.marks.filter((m) => m.key !== 'account' && m.key !== 'tracking' && m.at < hi).map((m) => m.at), ...(times.length ? [times[0]] : []), ...(win || []).filter(Boolean)];
  if (!pts.length) return '';
  const lo = Math.min(...pts);
  if (!(hi > lo)) return '';
  const byYear = hi - lo > 6 * 365 * DAY;
  const d0 = new Date(lo);
  const bins = [];
  for (let t = byYear ? new Date(d0.getFullYear(), 0, 1).getTime() : new Date(d0.getFullYear(), d0.getMonth(), 1).getTime(); t <= hi;) {
    const d = new Date(t);
    const next = (byYear ? new Date(d.getFullYear() + 1, 0, 1) : new Date(d.getFullYear(), d.getMonth() + 1, 1)).getTime();
    bins.push([t, next]);
    t = next;
  }
  const counts = bins.map(([a, b]) => times.filter((x) => x >= a && x < b).length);
  const max = Math.max(1, ...counts);
  const x0 = bins[0][0]; const x1 = bins.at(-1)[1];
  const pct = (t) => ((Math.min(Math.max(t, x0), x1) - x0) / (x1 - x0)) * 100;
  const binName = ([a]) => (byYear ? String(new Date(a).getFullYear()) : fmtDate(a, MONF));
  const band = win && (win[0] || win[1]) ? `<span class="win" style="left:${pct(win[0] ?? x0)}%;width:${Math.max(0.6, pct(win[1] ?? hi) - pct(win[0] ?? x0))}%"></span>` : '';
  const ticks = ctx.marks.filter((m) => STRIP_MARKS.includes(m.key)).map((m) => `<b class="mk k-${m.key}" style="left:${pct(m.at)}%" title="${esc(m.label)}: ${day(m.at)}"></b>`).join('');
  const years = byYear ? bins.map(([a]) => new Date(a).getFullYear()) : [...new Set(bins.map(([a]) => new Date(a).getFullYear()))];
  const axis = years.length > 1 ? [years[0], ...(years.length > 2 ? [years[Math.floor(years.length / 2)]] : []), years.at(-1)] : [binName(bins[0]), binName(bins.at(-1))];
  return `<div class="htl" role="img" aria-label="${esc(times.length ? `${plural(times.length, 'achievement')} before tracking, ${byYear ? 'by year' : 'by month'}` : 'The dates known about this game')}">
      <div class="bars">${counts.map((n, i) => `<i style="height:${n ? Math.max(10, (n / max) * 100) : 0}%" title="${binName(bins[i])}: ${plural(n, 'achievement')}"></i>`).join('')}</div>
      ${band}${ticks}<div class="ax">${axis.map((a) => `<span>${esc(a)}</span>`).join('')}</div></div>
    <div class="htl-key tiny muted">${times.length ? '<span><i class="sw k-unlock"></i>Achievements</span>' : ''}<span><i class="sw k-win"></i>Dates set</span><span><i class="sw k-tick"></i>Release, added, played</span></div>`;
}

/** "21 achievements before tracking: Jul 2017 (15), Aug 2017 (4)…" */
function unlockLine(u) {
  if (!u?.before_tracking) return '';
  const top = [...u.by_month].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)).slice(0, 3)
    .sort((a, b) => a.key.localeCompare(b.key)).map((x) => `${fmtDate(new Date(`${x.key}-15T12:00`).getTime(), MONF)} (${x.n})`);
  return `${plural(u.before_tracking, 'achievement')} before tracking${u.by_month.length > 3 ? `, over ${u.by_month.length} months; most in` : ':'} ${top.join(', ')}`;
}

/** One line of evidence for a list row: "Released 2017 · achievements Jul 2017 – Sep 2017 (21) · last played Dec 2023 (Xbox)". */
export function evidenceLine(it) {
  const m = Object.fromEntries((it.marks || []).map((x) => [x.key, x]));
  const rel = m.release || m.release_igdb;
  const parts = [
    rel && `released ${new Date(rel.at).getFullYear()}`,
    m.added && `added ${fmtDate(m.added.at, MONF)}`,
    m.first_played && `first played ${fmtDate(m.first_played.at, MONF)}`,
    m.first_unlock && (m.last_unlock ? `achievements ${fmtDate(m.first_unlock.at, MONF)} – ${fmtDate(m.last_unlock.at, MONF)} (${it.unlocks?.before_tracking})` : `an achievement ${fmtDate(m.first_unlock.at, MONF)}`),
    m.last_played && `last played ${fmtDate(m.last_played.at, MONF)}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ').replace(/^./, (c) => c.toUpperCase()) : '';
}

/** The earliest and latest evidence of play (first played / first unlock … last unlock / last played), or null. */
export function evidenceSpan(ctx) {
  const pick = (keys, f) => {
    const ms = keys.map((k) => ctx.marks.find((m) => m.key === k)).filter((m) => m && m.at <= ctx.tracking_start);
    return ms.length ? ms.reduce((a, b) => (f(b.at, a.at) ? b : a)) : null;
  };
  const s = pick(['first_played', 'first_unlock'], (x, y) => x < y);
  const e = pick(['last_unlock', 'last_played'], (x, y) => x > y);
  if (!s || !e || e.at <= s.at) return null;
  const name = { first_played: 'first played', first_unlock: 'the first achievement', last_unlock: 'the last achievement', last_played: 'last played' };
  // [start, end, "from the first achievement to last played"]
  return [s.at, e.at, `from ${name[s.key]} to ${name[e.key]}`];
}

export const conflictList = (list) => (list?.length ? `<ul class="hconf">${list.map((c) => `<li>${icon('info', 'ic-inline')}${esc(c.text)}</li>`).join('')}</ul>` : '');

// ---------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------
/**
 * Set when an entry's history was played, with its evidence beside the fields.
 * `entry` (from GET /games/:id) and `game` fill in for an entry with no history yet (a game added by hand).
 */
export async function whenDialog(entryId, { entry = null, game = null, onDone = rerender } = {}) {
  const byHand = entry ? entry.account_id == null && entry.platform === 'manual' : false;
  let ctx;
  try {
    ctx = await api(`/entries/${entryId}/history/context`);
  } catch (e) {
    if (!byHand) return fail(e);
    // no hours before it yet: only the release IGDB has
    const rel = igdbDay(game?.meta?.release_date);
    ctx = { entry_id: entryId, platform: 'manual', minutes: 0, tracking_start: entry.first_seen_at, mode: 'auto', window: null, manual: null, marks: [...(rel ? [{ key: 'release_igdb', label: 'Released', at: rel, source: 'IGDB', use: 'start' }] : []), { key: 'tracking', label: 'Added to Vestigo', at: entry.first_seen_at }], unlocks: { times: [], by_month: [], before_tracking: 0 }, others: [], conflicts: [] };
  }
  const manual = ctx.manual;
  const cur = manual ? [manual.start, manual.end] : ctx.window || [null, null];
  const span = evidenceSpan(ctx);
  const where = `${platDot(ctx.platform)} ${esc(ctx.account_name || plat(ctx.platform).label)}`;
  const markRow = (m) => {
    const btn = m.key === 'tracking' || m.key === 'first_tracked' || m.key === 'account' ? ''
      : `<button type="button" class="btn sm ghost" data-use="${m.use === 'end' ? 'e' : 's'}" data-at="${m.at}">${m.use === 'end' ? 'End here' : 'Start here'}</button>`;
    return `<div class="hm-row"><span class="hm-l"><i class="hm-k k-${m.key}"></i>${esc(m.label)}</span>
      <span class="hm-v"><b>${day(m.at)}</b>${m.detail ? ` · “${esc(m.detail)}”` : ''}${m.source ? ` <span class="muted">· ${esc(m.source)}</span>` : ''}</span><span class="hm-b">${btn}</span></div>`;
  };
  const others = (ctx.others || []).map((o) => `<div class="tiny muted">${platDot(o.platform)} Also ${fmtMin(o.minutes)} on ${esc(o.account_name || plat(o.platform).label)}${o.window ? `, ${o.manual ? 'set to' : 'estimated'} ${fmtDate(o.window[0], MONF)} – ${fmtDate(o.window[1], MONF)}` : ''}</div>`).join('');
  const m = modal({
    title: 'When did you play this?',
    wide: true,
    body: `<p class="small muted" style="margin-top:0">${byHand ? `Played before you added it on ${day(ctx.tracking_start)}.` : `<b style="color:var(--text)">${fmtMin(ctx.minutes)}</b> on ${where} happened before tracking began on ${day(ctx.tracking_start)}.`}
        Set when you played it and the hours are spread across those dates. A start on the 1st of a month and an end on the last day of one is taken as a period and spread evenly.</p>
      ${ctx.enrich_pending ? '<p class="small" style="color:var(--warn-ink)">Achievement times for this game are still being read: they may tell more in a few minutes.</p>' : ''}
      <div id="h-strip">${evidenceStrip(ctx, cur)}</div>
      ${ctx.marks.length ? `<h3 class="ach-h" style="margin-top:14px">What is known</h3><div class="hm-list">${ctx.marks.map(markRow).join('')}</div>` : ''}
      ${ctx.unlocks.before_tracking ? `<p class="tiny muted" style="margin:6px 0 0">${esc(unlockLine(ctx.unlocks))}</p>` : ''}
      ${others}
      <form id="h-f" class="stack" style="margin-top:14px">
        ${byHand ? `<div class="field"><label for="h-hours">Hours played before you added it</label><input class="input" id="h-hours" name="hours" type="number" min="0" step="0.5" inputmode="decimal" value="${ctx.minutes ? Math.round((ctx.minutes / 60) * 10) / 10 : ''}" style="max-width:160px"></div>` : ''}
        <div class="grid grid-2"><div class="field"><label for="h-s">Started playing</label><input class="input" id="h-s" type="date" name="s" value="${dateValue(cur[0])}"></div>
        <div class="field"><label for="h-e">Last played</label><input class="input" id="h-e" type="date" name="e" value="${dateValue(cur[1])}" max="${dateValue(ctx.tracking_start)}"></div></div>
        ${span ? `<div class="row wrap" style="gap:8px"><button type="button" class="btn sm" id="h-fit">${icon('check')}Use the evidence: ${fmtDate(span[0], MONF)} – ${fmtDate(span[1], MONF)}</button><span class="tiny muted">${esc(span[2])}</span></div>` : ''}
        <div id="h-conf" aria-live="polite">${conflictList(ctx.conflicts)}</div>
      </form>`,
    // (a game added by hand has no evidence to date it from: automatic would leave it undated)
    foot: `${manual && !byHand ? '<button class="btn ghost" id="h-reset">Reset to automatic</button>' : ''}<span class="grow"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="h-save">Save</button>`,
    onMount(el, close) {
      const s = el.querySelector('[name=s]'); const e = el.querySelector('[name=e]');
      const t = (inp, end) => (inp.value ? new Date(apiTime(inp.value, end)).getTime() : null);
      let seq = 0; let timer;
      // the evidence against the dates as they are typed: the strip's band, and what disagrees
      const check = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const my = ++seq;
          const win = [t(s, false), t(e, true)];
          el.querySelector('#h-strip').innerHTML = evidenceStrip(ctx, win);
          if (!ctx.minutes || (!win[0] && !win[1])) { el.querySelector('#h-conf').innerHTML = ''; return; }
          if (win[0] && win[1] && win[1] < win[0]) { el.querySelector('#h-conf').innerHTML = conflictList([{ text: 'Last played is before the start' }]); return; }
          const q = new URLSearchParams(Object.entries({ start: s.value ? apiTime(s.value) : '', end: e.value ? apiTime(e.value, true) : '' }).filter(([, v]) => v));
          const r = await api(`/entries/${entryId}/history/context?${q}`).catch(() => null);
          if (my === seq && r && el.isConnected) el.querySelector('#h-conf').innerHTML = conflictList(r.conflicts);
        }, 220);
      };
      s.addEventListener('input', check); e.addEventListener('input', check);
      el.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-use]');
        if (b) { (b.dataset.use === 's' ? s : e).value = dateValue(Number(b.dataset.at)); check(); }
      });
      el.querySelector('#h-fit')?.addEventListener('click', () => { s.value = dateValue(span[0]); e.value = dateValue(span[1]); check(); });
      el.querySelector('#h-reset')?.addEventListener('click', async () => {
        try { await api(`/entries/${entryId}/history`, { method: 'PATCH', body: { reset: true } }); } catch (err) { return fail(err); }
        close(); toast('Back to automatic dating'); onDone();
      });
      let saving = false;
      el.querySelector('#h-save').addEventListener('click', async () => {
        if (saving) return;
        if (s.value && e.value && e.value < s.value) return toast('Last played is before the start', { bad: true });
        const body = { first_played_at: apiTime(s.value), last_played_at: apiTime(e.value, true), mode: 'auto' };
        if (byHand) {
          const h = Number(el.querySelector('[name=hours]').value || 0);
          if (!(h >= 0)) return toast('Enter the hours as a number', { bad: true });
          body.minutes = Math.round(h * 60);
          if (!body.minutes && !ctx.minutes) { close(); return undefined; }
        }
        saving = true;
        try { await api(`/entries/${entryId}/history`, { method: 'PATCH', body }); } catch (err) { saving = false; return fail(err); }
        close(); toast(body.minutes === 0 ? 'Hours before tracking removed' : 'History re-dated'); onDone();
        return undefined;
      });
    },
  });
  return m;
}

// ---------------------------------------------------------------------
// Add a game: your library and IGDB as you type, where it was played, the hours played before
// ---------------------------------------------------------------------
export async function addGameModal() {
  const ig = await api('/igdb/status').catch(() => null);
  const igdbOn = !!(ig?.configured && ig?.enabled !== false);
  const thisYear = new Date().getFullYear();
  let picked = null; // the IGDB game chosen
  let seq = 0; let timer;
  modal({
    title: 'Add a game',
    wide: true,
    body: `<form class="stack" id="ag" autocomplete="off">
      <div class="field"><label for="ag-title">Title</label><input class="input" id="ag-title" name="title" required placeholder="Super Mario 64" aria-describedby="ag-hint">
        <div id="ag-sugg" class="list ag-sugg" hidden></div>
        <p class="tiny muted" id="ag-hint" style="margin:6px 0 0">${igdbOn ? 'Type to look it up on IGDB (cover, release date, platforms) and in your library.' : 'Type to find it in your library. With IGDB set up (under Game metadata in Settings) it is looked up as you type, with its cover and release date.'}</p></div>
      <div id="ag-picked"></div>
      <div class="grid grid-2">
        <div class="field"><label for="ag-on">Played on <span class="dim">(optional)</span></label><input class="input" id="ag-on" name="played_on" list="ag-plats" placeholder="Nintendo 64, Switch, emulator…"><datalist id="ag-plats"></datalist></div>
        <div class="field"><label for="ag-st">Status</label><select class="input" id="ag-st" name="status">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="ag-hours">Hours played so far <span class="dim">(optional)</span></label>
        <input class="input" id="ag-hours" name="hours" type="number" min="0" step="0.5" inputmode="decimal" style="max-width:160px" placeholder="0">
        <p class="tiny muted" style="margin:6px 0 0">Play from before today. It is dated like history from a platform (hatched in charts) and never counts as today's play. Sessions from now on: log them on the game page.</p></div>
      <div class="row wrap" id="ag-when" data-period style="gap:6px" hidden>${periodPicker({ hi: thisYear, lo: 1970, guess: null, label: 'Played in' })}</div>
      <details><summary class="small muted" style="cursor:pointer">Cover image</summary>
        <div class="field" style="margin-top:8px"><label for="ag-cover">Cover image URL <span class="dim">(optional)</span></label><input class="input" id="ag-cover" name="cover_url" placeholder="https://…"></div></details>
    </form>`,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="ag-save">Add game</button>',
    onMount(el, close) {
      const f = el.querySelector('#ag');
      const sugg = el.querySelector('#ag-sugg');
      const when = el.querySelector('#ag-when');
      // the years to offer start at the release (or 1970); the year guessed is the release year - with
      // none known, nothing is guessed: old hours dated to this year would land in this year's stats
      const setYears = (release) => {
        const ry = release ? new Date(release).getFullYear() : null;
        const lo = Math.min(ry ?? 1970, thisYear);
        for (const n of ['y', 'y2']) when.querySelector(`[name=${n}]`).innerHTML = yearOptions(thisYear, Math.max(1970, ry ? lo : 1970), ry);
      };
      f.hours.addEventListener('input', () => { when.hidden = !(Number(f.hours.value) > 0); });
      when.addEventListener('change', periodChange);
      const showPicked = () => {
        const p = picked;
        el.querySelector('#ag-picked').innerHTML = p ? `<div class="item ag-pick">${p.thumb_url ? `<img src="${esc(p.thumb_url)}" width="45" height="60" alt="" loading="lazy">` : ''}
            <div class="grow"><div class="ttl">${esc(p.name)}</div><div class="sub">${p.release_date ? `Released ${day(p.release_date)}` : 'Release date unknown'}${p.platforms.length ? ` · ${esc(p.platforms.slice(0, 6).join(', '))}${p.platforms.length > 6 ? '…' : ''}` : ''}</div>
            <div class="tiny muted">From IGDB: genres, series and the typical time to beat follow once it is added.</div></div>
            <button type="button" class="btn sm ghost" id="ag-unpick">Not this one</button></div>` : '';
        el.querySelector('#ag-unpick')?.addEventListener('click', () => { picked = null; showPicked(); setYears(null); });
        el.querySelector('#ag-plats').innerHTML = (p?.platforms || []).map((x) => `<option value="${esc(x)}">`).join('');
      };
      const search = async () => {
        const q = f.title.value.trim();
        const my = ++seq;
        if (q.length < 2) { sugg.hidden = true; return; }
        const [lib, found] = await Promise.all([
          api(`/games?q=${encodeURIComponent(q)}&limit=4&hidden=all`).catch(() => ({ items: [] })),
          igdbOn && q.length >= 3 ? api(`/igdb/search?q=${encodeURIComponent(q)}`).catch(() => []) : Promise.resolve([]),
        ]);
        if (my !== seq || !el.isConnected) return;
        const mine = lib.items.map((g) => `<a class="item" href="/game/${g.id}" data-mine="${g.id}">${cover(g, 'sm')}<div class="grow"><div class="ttl ellipsis">${esc(g.title)}</div><div class="sub">Already in your library · ${g.platforms.map(platDot).join('')} ${fmtMin(g.minutes)}</div></div>${icon('arrowR', 'ic-inline')}</a>`);
        const theirs = found.slice(0, 6).map((x, i) => `<button type="button" class="item" data-ig="${i}">${x.thumb_url ? `<img src="${esc(x.thumb_url)}" width="34" height="45" alt="" loading="lazy" style="border-radius:6px">` : '<span style="width:34px"></span>'}
            <div class="grow" style="text-align:left"><div class="ttl ellipsis">${esc(x.name)}</div><div class="sub">${x.year || 'year unknown'}${x.platforms.length ? ` · ${esc(x.platforms.slice(0, 5).join(', '))}${x.platforms.length > 5 ? '…' : ''}` : ''}${x.main ? '' : ' · DLC, bundle or edition'}</div></div></button>`);
        for (const x of found) x.release_date = igdbDay(x.release_date);
        sugg._found = found;
        sugg.innerHTML = (mine.length ? `<div class="tiny muted ag-h">In your library</div>${mine.join('')}` : '') + (theirs.length ? `<div class="tiny muted ag-h">On IGDB</div>${theirs.join('')}` : '');
        sugg.hidden = !mine.length && !theirs.length;
      };
      f.title.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => search().catch(() => {}), 350); });
      sugg.addEventListener('click', (e) => {
        const mine = e.target.closest('[data-mine]');
        if (mine) { e.preventDefault(); close(); navigate(`/game/${mine.dataset.mine}`); return; }
        const b = e.target.closest('[data-ig]');
        if (!b) return;
        picked = sugg._found[Number(b.dataset.ig)];
        f.title.value = picked.name;
        if (picked.cover_url && !f.cover_url.value) f.cover_url.value = picked.cover_url;
        sugg.hidden = true;
        setYears(picked.release_date);
        showPicked();
        f.played_on.focus();
      });
      let saving = false; // a second click while the first save is out must not add the game twice
      el.querySelector('#ag-save').addEventListener('click', async () => {
        if (saving) return;
        const title = f.title.value.trim();
        if (!title) { toast('Enter a title', { bad: true }); f.title.focus(); return; }
        const hours = Number(f.hours.value || 0);
        if (!(hours >= 0)) { toast('Enter the hours as a number', { bad: true }); f.hours.focus(); return; }
        const body = { title, cover_url: f.cover_url.value, status: f.status.value, played_on: f.played_on.value.trim() || undefined };
        if (hours > 0) {
          const per = readPeriod(when);
          if (!per) { toast('Pick the year you played it, roughly', { bad: true }); when.querySelector('[name=y]').focus(); return; }
          let [s, e] = per;
          // not before it came out: "1996" for a game released in June 1996 starts in June
          if (picked?.release_date && s < picked.release_date && e > picked.release_date) s = picked.release_date;
          body.history = { minutes: Math.round(hours * 60), first_played_at: new Date(s).toISOString(), last_played_at: new Date(e).toISOString(), coarse: true };
        }
        saving = true;
        let g;
        try { g = await api('/games', { method: 'POST', body }); } catch (err) { saving = false; fail(err); return; }
        // the IGDB game you picked is its match (kept: never matched again on its own)
        if (picked) await api(`/games/${g.id}/meta`, { method: 'PUT', body: { igdb_id: picked.id } }).catch(() => {});
        close();
        navigate(`/game/${g.id}`);
      });
    },
  });
}
