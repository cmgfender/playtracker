// Helpers more than one page uses: KPI tiles, session rows and their edit/log dialogs, empty states, achievement icons, series names.
import {
  esc, fmtMin, fmtHours, fmtDate, fmtTime, dayLabel, plat, platDot, platTag, cover, icon, api, toast, undoToast, fail, modal,
  confirmBox, rerender, state, applyTheme, plural,
} from '../app.js';
import { BASIS_FILL } from '../charts.js';

export const arrow = () => icon('arrowR', 'ic-inline'); // trailing "go there" arrow on links

export const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// time-of-day axis: 12a / 6a / 12p / 6p, or 00 / 06 / 12 / 18 where the clock is 24-hour
const H24 = /h2[34]/.test(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle || '');
export function hourLabel(h) { return H24 ? String(h).padStart(2, '0') : `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`; }

export function seriesLabel(key, group) {
  if (group === 'month') return new Date(`${key}-01T12:00`).toLocaleDateString(undefined, { month: 'short' });
  if (group === 'year') return key;
  const d = new Date(`${key}T12:00`);
  if (group === 'week') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { day: 'numeric' });
}

/** A bucket in words, for chart summaries: "Oct 2", "the week of Oct 2", "October 2026". */
export function seriesName(key, group) {
  if (group === 'month') return new Date(`${key}-01T12:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  if (group === 'year') return key;
  const d = new Date(`${key}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return group === 'week' ? `the week of ${d}` : d;
}

function seriesTip(key, group, minutes) {
  let label;
  if (group === 'month') label = seriesName(key, group);
  else if (group === 'year') label = key;
  else if (group === 'week') label = `Week of ${new Date(`${key}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  else label = new Date(`${key}T12:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${label}: ${fmtMin(minutes)}`;
}

// Tracked play stacks by platform; inferred pre-tracking history sits on top, hatched.
// What history rests on, as charts and legends show it (with the fills of charts.js BASIS_FILL)
export const BASIS = [
  ['imported', 'Imported sessions', 'Exact past sessions from an import (JSON/CSV, GameTrack)'],
  ['confirmed', 'History you confirmed', 'Estimated history whose dates you confirmed or set yourself'],
  ['anchored', 'Dated by unlocks', 'Estimated history on days with an achievement or trophy unlock'],
  ['estimated', 'Estimated history', 'Playtime from before tracking began, dated from first/last played and release dates'],
];

// Tracked play stacks by platform; imported sessions and the kinds of estimated history sit on
// top, each in its own pattern. Older answers without series_by_basis: all estimates hatched.
export function stackedSeries(stats) {
  const plats = Object.keys(stats.series_by_platform || {});
  const imp = stats.series_imported_by_platform || {};
  const by = stats.series_by_basis;
  const est = stats.series_estimated || [];
  return stats.series.map((s, i) => {
    const parts = by ? BASIS.map(([k, label]) => [k, label, by[k]?.[i] || 0]).filter(([, , v]) => v > 0) : (est[i] ? [['estimated', 'estimated from history', est[i]]] : []);
    const extra = parts.map(([, label, v]) => `${fmtMin(v)} ${label.toLowerCase()}`).join(', ');
    return {
      label: seriesLabel(s.key, stats.range.group),
      name: seriesName(s.key, stats.range.group),
      value: s.minutes,
      tip: seriesTip(s.key, stats.range.group, s.minutes) + (extra ? ` (${extra})` : ''),
      stack: [
        ...plats.map((p) => ({ key: p, value: Math.max(0, (stats.series_by_platform[p][i] || 0) - (imp[p]?.[i] || 0)), color: plat(p).color })),
        ...parts.map(([k, , v]) => ({ key: k, value: v, color: BASIS_FILL[k] })),
      ],
    };
  });
}

/** Legend entries for the kinds of history in the range, each with its pattern and minutes. */
export function estimatedLegend(stats) {
  const m = stats.minutes_by_basis;
  if (!m) return stats.estimated_minutes ? `<span title="${BASIS[3][2]}"><i class="dot hatch-dot"></i>Estimated history · ${fmtMin(stats.estimated_minutes, { short: true })}</span>` : '';
  return BASIS.filter(([k]) => m[k] > 0).map(([k, label, why]) => `<span title="${esc(why)}"><i class="dot basis-${k}"></i>${label} · ${fmtMin(m[k], { short: true })}</span>`).join('');
}

const CONF = {
  exact: ['live', 'good', 'Exact times from live presence or a manual log'],
  pinned: ['', '', 'End pinned to the platform\'s last-played time'],
  window: ['≈', '', 'Exact time unknown — spread across the sync window'],
  high: ['high', 'good', 'Dated from first and last played'],
  medium: ['medium', 'warn', 'Dated from achievements / recent play'],
  low: ['low', 'bad', 'Rough estimate — only one date known'],
};

export function kpi(label, value, sub = '', extra = '', cls = '') {
  return `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}${extra}</div>`;
}

export const hoursVal = (m) => `${fmtHours(m)}<small>h</small>`;

function sessionWhen(s) {
  if (s.precise) return `${fmtTime(s.started_at)} – ${fmtTime(s.ended_at)}`;
  if (s.window_start && s.window_end) {
    const span = s.window_end - s.window_start;
    if (span < 36 * 3600e3) return `between ${fmtTime(s.window_start)} and ${fmtTime(s.window_end)}`;
    return `${fmtDate(s.window_start)} – ${fmtDate(s.window_end)}`;
  }
  return fmtDate(s.window_end || s.created_at);
}

/** sessionWhen() for one phone line: "6:26–11:49 PM", "~" in front of times spread over a sync window. */
function sessionWhenShort(s) {
  const ampm = /\s?([AP]M)$/i;
  const span = (a, b) => {
    const x = fmtTime(a); const y = fmtTime(b);
    return x.match(ampm)?.[1] && x.match(ampm)?.[1] === y.match(ampm)?.[1] ? `${x.replace(ampm, '')}–${y}` : `${x}–${y}`;
  };
  if (s.precise) return span(s.started_at, s.ended_at);
  if (s.window_start && s.window_end) {
    if (s.window_end - s.window_start < 36 * 3600e3) return `~${span(s.window_start, s.window_end)}`;
    return `${fmtDate(s.window_start)}–${fmtDate(s.window_end)}`;
  }
  return fmtDate(s.window_end || s.created_at);
}

function sourceBadge(s) {
  // the "≈" badges carry the session's note too: on a phone the note itself is not shown
  const approx = (t) => esc(s.note ? `${t} · ${s.note}` : t);
  if (s.kind === 'baseline') return '<span class="badge">history</span>';
  if (s.kind === 'estimate') {
    const k = s.basis === 'confirmed' ? 'confirmed' : s.basis === 'anchored' ? 'anchored' : 'estimated';
    const label = { confirmed: 'confirmed', anchored: 'by unlocks', estimated: `estimated · ${s.confidence || ''}` }[k];
    return `<span class="badge basis-b" title="${esc(BASIS.find(([x]) => x === k)[2])}${k === 'estimated' && CONF[s.confidence] ? ` (${esc(CONF[s.confidence][2])})` : ''}"><i class="dot basis-${k}" aria-hidden="true"></i>${esc(label)}</span>`;
  }
  if (s.source === 'manual') return '<span class="badge accent">manual</span>';
  if (s.note?.startsWith('Length estimated')) return '<span class="badge" title="The platform reports no playtime for this game and live presence missed this session: it ends at the reported last-played time, with your typical session length. Edit it if you know better.">≈ length</span>';
  if (s.confidence === 'exact') return `<span class="badge good" title="${CONF.exact[2]}">● live</span>${s.device ? `<span class="badge">${esc(s.device)}</span>` : ''}`;
  if (s.device) return `<span class="badge">${esc(s.device)}</span>${s.precise ? '' : `<span class="badge" title="${approx('Exact time unknown — spread across the sync window')}">≈</span>`}`;
  if (s.source === 'import') return `<span class="badge basis-b" title="${BASIS[0][2]}"><i class="dot basis-imported" aria-hidden="true"></i>imported</span>`;
  if (s.source === 'api') return '<span class="badge">api</span>';
  return s.precise ? '' : `<span class="badge" title="${approx('Exact time unknown — spread across the sync window')}">≈</span>`;
}

/**
 * A session row. On a phone line 2 is one line: platform dot, compact time, source badge (the note
 * moves into the badge's title). platLabel: name the platform (a game page whose game has several entries);
 * dated: that line starts with the day (a list whose day headers a phone hides).
 */
export function sessionItem(s, { showGame = true, selectable = false, selected = false, platLabel = true, dated = false } = {}) {
  const t = s.ended_at || s.window_end || s.created_at;
  const day = dated ? `${['Today', 'Yesterday'].includes(dayLabel(t)) ? dayLabel(t) : fmtDate(t)} · ` : '';
  return `<div class="item sess ${selected ? 'sel' : ''}" data-sid="${s.id}">
    ${selectable ? `<input type="checkbox" class="check" data-sel="${s.id}" ${selected ? 'checked' : ''} aria-label="Select ${esc(s.title)}, ${esc(fmtMin(s.minutes))}">` : ''}
    ${showGame ? `<a href="/game/${s.game_id}" data-link>${cover(s)}</a>` : `<span class="dot" style="background:${plat(s.platform).color};width:10px;height:10px" title="${esc(plat(s.platform).label)}"></span>`}
    <div class="grow">
      ${showGame ? `<a href="/game/${s.game_id}" data-link class="ttl ellipsis" style="display:block">${esc(s.title)}</a>` : ''}
      <div class="sub">${showGame ? platDot(s.platform) : platLabel ? `<b style="color:var(--text)">${esc(plat(s.platform).label)}</b>` : ''}<span class="when">${esc(sessionWhen(s))}</span><span class="when-c">${esc(day + sessionWhenShort(s))}</span>${sourceBadge(s)}${s.note ? `<span class="note ellipsis" title="${esc(s.note)}">· ${esc(s.note)}</span>` : ''}</div>
      ${sessionAchLine(s)}
    </div>
    <div class="amt">${fmtMin(s.minutes)}</div>
    ${selectable ? '' : `<button class="btn ghost sm icon" data-edit-session="${s.id}" aria-label="Edit session">${icon('edit')}</button>`}
  </div>`;
}

export function groupByDay(sessions) {
  const groups = [];
  let cur = null;
  for (const s of sessions) {
    const t = s.ended_at || s.window_end || s.created_at;
    const d = new Date(t); d.setHours(0, 0, 0, 0);
    if (!cur || cur.day !== d.getTime()) { cur = { day: d.getTime(), items: [], minutes: 0 }; groups.push(cur); }
    cur.items.push(s); cur.minutes += s.minutes;
  }
  return groups;
}

// a short faded trail above an empty state's icon: the mark's capsules, oldest faintest
const TRAIL = '<svg class="em-trail" viewBox="0 0 80 28" width="80" height="28" fill="none" stroke="currentColor" stroke-width="4.2" stroke-linecap="round" aria-hidden="true"><path d="M9 5 12 10.5" opacity=".15"/><path d="M25 14.5 28 20" opacity=".3"/><path d="M52 20 55 14.5" opacity=".5"/></svg>';
/** An empty page or list: the trail, an icon tile, a heading, a line and its actions (buttons in a row). */
export function emptyState(ic, title, text, actions = '') {
  return `<div class="empty">${TRAIL}<div class="em-ic">${icon(ic)}</div><h2>${title}</h2><p style="max-width:460px;margin:0 auto 16px">${text}</p>${actions ? `<div class="row wrap em-act">${actions}</div>` : ''}</div>`;
}

// ---------- achievements ----------
/** Under this share of players an unlock counts as rare. */
export const RARE = 10;
export const fmtRarity = (r) => `${r < 10 ? (Math.round(r * 10) / 10).toFixed(1) : Math.round(r)}%`;
/** "4.2%" with a "rare" marker under RARE, or nothing when the platform gives no rarity. */
export function rarityText(x) {
  if (x.rarity == null) return '';
  const rare = x.rarity < RARE;
  return `<span class="rar${rare ? ' rare' : ''}" title="${esc(`${fmtRarity(x.rarity)} of players have it`)}">${rare ? '<span class="rare-tag">rare</span>' : ''}${fmtRarity(x.rarity)}</span>`;
}
/** An achievement's icon over a trophy (PlayStation grades tinted); a locked one shows a lock. */
export function achIcon(x, { size = 36, locked = false } = {}) {
  const src = locked ? x.icon_locked_url || x.icon_url : x.icon_url;
  return `<span class="ach-ic${x.grade ? ` g-${x.grade}` : ''}${locked ? ' locked' : ''}" style="width:${size}px;height:${size}px" aria-hidden="true">${icon(locked ? 'lock' : 'trophy')}${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">` : ''}</span>`;
}
/** "3 achievements · 1 rare (4.2%)" with up to three tiny icons, under a session row that has unlocks. */
function sessionAchLine(s) {
  const a = s.achievements;
  if (!a?.count) return '';
  const rare = a.items.filter((x) => x.rarity != null && x.rarity < RARE);
  const rarest = Math.min(...rare.map((x) => x.rarity));
  const names = a.items.map((x) => x.name).filter(Boolean);
  return `<div class="ach-line" title="${esc(names.join(', ') + (a.count > names.length ? '…' : ''))}">${a.items.slice(0, 3).map((x) => achIcon(x, { size: 16 })).join('')}<span>${plural(a.count, 'achievement')}${rare.length ? ` · ${rare.length} rare (${fmtRarity(rarest)})` : ''}</span></div>`;
}

// ---------- session edit / log ----------
/**
 * The Log session game search: a combobox over a listbox of games. Arrow keys move the active
 * option (aria-activedescendant), Enter picks it, Escape closes the list (not the dialog); a hidden
 * live line says how many games were found and which one was picked.
 */
function gamePicker(input, onPick) {
  let timer; let seq = 0; let active = -1;
  const box = document.createElement('div');
  box.className = 'list card gp-list';
  box.id = 'gp-list';
  box.setAttribute('role', 'listbox');
  box.setAttribute('aria-label', 'Games');
  box.hidden = true;
  const live = document.createElement('div');
  live.className = 'vh';
  live.setAttribute('aria-live', 'polite');
  input.after(box, live);
  Object.entries({ role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'gp-list', 'aria-autocomplete': 'list' }).forEach(([k, v]) => input.setAttribute(k, v));
  const opts = () => [...box.querySelectorAll('[role=option]')];
  const setActive = (i) => {
    const o = opts();
    active = o.length ? (i + o.length) % o.length : -1;
    o.forEach((x, j) => { x.classList.toggle('active', j === active); x.setAttribute('aria-selected', String(j === active)); });
    if (active >= 0) { input.setAttribute('aria-activedescendant', o[active].id); o[active].scrollIntoView({ block: 'nearest' }); } else input.removeAttribute('aria-activedescendant');
  };
  const open = (on) => {
    box.hidden = !on;
    input.setAttribute('aria-expanded', String(on));
    if (!on) setActive(-1);
  };
  const search = async () => {
    const q = input.value.trim();
    const my = ++seq;
    if (!q) { open(false); live.textContent = ''; return; }
    const r = await api(`/games?q=${encodeURIComponent(q)}&limit=8&sort=recent&hidden=all`);
    if (my !== seq) return;
    box.innerHTML = r.items.map((g, i) => `<button type="button" class="item gp-opt" role="option" id="gp-o-${i}" tabindex="-1" aria-selected="false" data-pick="${g.id}">${cover(g)}<span class="grow"><span class="ttl ellipsis">${esc(g.title)}</span><span class="sub">${g.platforms.map(platDot).join('')} ${fmtMin(g.minutes)}</span></span></button>`).join('')
      + `<button type="button" class="item gp-opt" role="option" id="gp-o-new" tabindex="-1" aria-selected="false" data-new="1"><span class="grow muted">${icon('plus', 'ic-inline')} Add “${esc(q)}” as a new game</span></button>`;
    open(true);
    active = -1;
    live.textContent = `${plural(r.items.length, 'game')} found`;
  };
  const pick = async (o) => {
    const g = o.dataset.pick ? await api(`/games/${o.dataset.pick}`) : await api('/games', { method: 'POST', body: { title: input.value.trim() } });
    input.value = g.title;
    open(false);
    live.textContent = `${g.title} picked`;
    onPick(g);
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => search().catch(fail), 160); });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (box.hidden) { await search().catch(fail); if (box.hidden) return; }
      setActive(active < 0 && e.key === 'ArrowUp' ? -1 : active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter' && !box.hidden) {
      e.preventDefault();
      const o = opts()[active];
      if (o) pick(o).catch(fail);
    } else if (e.key === 'Escape' && !box.hidden) {
      e.preventDefault(); // the list closes, the dialog stays
      open(false);
    }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (!box.contains(document.activeElement) && document.activeElement !== input) open(false); }, 150));
  // pointer: pick on press, so the input keeps focus
  box.addEventListener('mousedown', (e) => e.preventDefault());
  box.addEventListener('click', (e) => { const o = e.target.closest('[role=option]'); if (o) pick(o).catch(fail); });
}

function localInput(t) {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

export function logSessionModal(game = null, onDone = rerender, { minutes = 60 } = {}) {
  let picked = game;
  const now = Date.now();
  modal({
    title: 'Log a session',
    body: `<form class="stack" id="log-form">
      <div class="field"><label>Game</label>${game ? `<div class="row">${cover(game)}<b>${esc(game.title)}</b></div>` : '<input class="input" id="gp" placeholder="Search your library or type a new title" autocomplete="off">'}</div>
      <div class="field"><label>Duration</label>
        <div class="row"><input class="input" type="number" min="0" max="168" name="h" value="${Math.floor(minutes / 60)}" style="width:90px" aria-label="Duration, hours"> <span class="muted" aria-hidden="true">h</span>
        <input class="input" type="number" min="0" max="59" name="m" value="${minutes % 60}" style="width:90px" aria-label="Duration, minutes"> <span class="muted" aria-hidden="true">m</span></div>
        <div class="chips" style="margin-top:0">${[15, 30, 60, 90, 120, 180].map((m) => `<button type="button" class="chip" data-quick="${m}">${fmtMin(m)}</button>`).join('')}</div>
      </div>
      <div class="field"><label>Ended at</label><input class="input" type="datetime-local" name="ended" value="${localInput(now)}"></div>
      <div class="field"><label>Note <span class="dim">(optional)</span></label><input class="input" name="note" placeholder="Beat the first boss…"></div>
    </form>`,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="log-save">Save session</button>',
    autofocus: !game, // the search is what you came for, keyboard and all
    onMount(el, close) {
      if (!game) gamePicker(el.querySelector('#gp'), (g) => { picked = g; });
      el.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => {
        const m = Number(b.dataset.quick);
        el.querySelector('[name=h]').value = Math.floor(m / 60);
        el.querySelector('[name=m]').value = m % 60;
      }));
      el.querySelector('#log-save').addEventListener('click', async () => {
        const f = el.querySelector('#log-form');
        const minutes = Number(f.h.value || 0) * 60 + Number(f.m.value || 0);
        if (!picked) return toast('Pick a game first', { bad: true });
        if (!minutes) return toast('Enter a duration', { bad: true });
        try {
          await api('/sessions', { method: 'POST', body: { game_id: picked.id, minutes, ended_at: new Date(f.ended.value).getTime(), note: f.note.value } });
          close(); toast(`Logged ${fmtMin(minutes)} of ${picked.title}`); onDone();
        } catch (e) { fail(e); }
      });
    },
  });
}

/** Log a deleted manual session again: same game, start, end, minutes, note, and history or not. */
export async function restoreSession(s) {
  const n = await api('/sessions', { method: 'POST', body: { game_id: s.game_id, minutes: s.minutes, started_at: s.started_at, ended_at: s.ended_at, note: s.note || '' } });
  if (s.kind === 'baseline') await api(`/sessions/${n.id}`, { method: 'PATCH', body: { kind: 'baseline' } });
  return n;
}

async function editSessionModal(id, onDone = rerender) {
  let s;
  try { s = await api(`/sessions/${id}`); } catch (e) { return fail(e); }
  // the history of a synced game is like a synced session: it can only leave the stats
  const local = s.source !== 'sync' && !(s.source === 'inferred' && s.account_id);
  // pre-tracking history keeps its minutes and is never counted as tracked play
  const inferred = s.source === 'inferred';
  modal({
    title: esc(s.title),
    body: `<div class="stack">
      <div class="row wrap">${platTag(s.platform)} ${sourceBadge(s)} <span class="muted small">${esc(sessionWhen(s))}</span></div>
      ${s.achievements?.count ? `<div class="ach-sess"><h3 class="small">${plural(s.achievements.count, 'achievement')} unlocked during this session</h3><div class="list">${s.achievements.items.map((x) => `<div class="item ach-row">${achIcon(x, { size: 32 })}<div class="grow"><div class="ttl ellipsis">${esc(x.name || 'Achievement')}</div><div class="sub">${fmtTime(x.unlocked_at)}${x.points ? ` · ${x.points}G` : ''}${x.grade ? ` · ${esc(x.grade)}` : ''}</div></div>${rarityText(x)}</div>`).join('')}</div></div>` : ''}
      ${!local ? `<div class="card small muted" style="padding:12px">${icon('info', 'ic-inline')} Synced from ${esc(plat(s.platform).label)}. ${s.source === 'inferred'
        ? `This is history from before tracking started: its <b>${fmtMin(s.minutes)}</b> are part of the platform's total, so it can only leave the stats.`
        : `The platform only reported <b>${fmtMin(s.minutes)}</b> played between ${fmtDate(s.window_start)} ${fmtTime(s.window_start)} and ${fmtDate(s.window_end)} ${fmtTime(s.window_end)}. You can pin the exact time below.`}</div>` : ''}
      ${local && !inferred ? `<div class="field"><label>Minutes</label><input class="input" type="number" name="minutes" value="${s.minutes}" min="1"></div>` : ''}
      <div class="grid grid-2">
        <div class="field"><label>Started</label><input class="input" type="datetime-local" name="started" value="${s.started_at ? localInput(s.started_at) : ''}"></div>
        <div class="field"><label>Ended</label><input class="input" type="datetime-local" name="ended" value="${s.ended_at ? localInput(s.ended_at) : ''}"></div>
      </div>
      <div class="field"><label>Note</label><input class="input" name="note" value="${esc(s.note || '')}"></div>
      ${!inferred ? `<div class="setting" style="border:0;padding:0"><div><div class="t">Count in stats</div><div class="d">Off = treat as pre-tracking history (still counts toward lifetime)</div></div>
        <label class="switch"><input type="checkbox" name="play" ${s.kind === 'play' ? 'checked' : ''}><span></span></label></div>` : ''}
    </div>`,
    foot: `<button class="btn danger" id="s-del">${icon('trash')}${local ? 'Delete' : 'Remove from stats'}</button><span class="grow"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="s-save">Save</button>`,
    onMount(el, close) {
      const v = (n) => el.querySelector(`[name=${n}]`);
      el.querySelector('#s-save').addEventListener('click', async () => {
        const body = { note: v('note').value };
        // kind only when the switch changed (history has none)
        if (v('play') && v('play').checked !== v('play').defaultChecked) body.kind = v('play').checked ? 'play' : 'baseline';
        // only times you changed: unchanged ones let new minutes move the start
        if (v('started').value && v('started').value !== v('started').defaultValue) body.started_at = new Date(v('started').value).getTime();
        if (v('ended').value && v('ended').value !== v('ended').defaultValue) body.ended_at = new Date(v('ended').value).getTime();
        if (local && !inferred) body.minutes = Number(v('minutes').value);
        try { await api(`/sessions/${s.id}`, { method: 'PATCH', body }); close(); toast('Session updated'); onDone(); } catch (e) { fail(e); }
      });
      el.querySelector('#s-del').addEventListener('click', async () => {
        // a manual session comes back from what it was; a synced one back into the stats; an imported
        // or pushed one cannot come back the same (it would return as a manual session), so it asks first
        if (local && s.source !== 'manual' && !(await confirmBox(`Delete this ${fmtMin(s.minutes)} session of ${esc(s.title)}? It came from ${s.source === 'api' ? 'the API' : 'an import'} and cannot be restored.`, { ok: 'Delete', danger: true, title: 'Delete session?' }))) return;
        try {
          await api(`/sessions/${s.id}`, { method: 'DELETE' });
          close();
          if (s.source === 'manual') {
            undoToast('Session deleted', () => restoreSession(s), onDone);
          } else if (!local && !inferred && s.kind === 'play') {
            undoToast('Removed from stats', () => api(`/sessions/${s.id}`, { method: 'PATCH', body: { kind: 'play', note: s.note || '' } }), onDone);
          } else toast(local ? 'Session deleted' : 'Removed from stats');
          onDone();
        } catch (e) { fail(e); }
      });
    },
  });
}

export function bindSessionEdits(root, onDone) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit-session]');
    if (b) editSessionModal(b.dataset.editSession, onDone);
  });
}

// ---------- time ----------
export const H = 3600e3;
export const D = 24 * H;

export const dayKey = (t) => { const x = new Date(t); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

// ---------- settings ----------
export async function saveSettings(patch) {
  const r = await api('/settings', { method: 'PUT', body: patch });
  state.settings = { ...state.settings, ...r };
  applyTheme(state.settings);
  return r;
}
