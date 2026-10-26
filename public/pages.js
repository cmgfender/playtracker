import {
  $, $$, esc, fmtMin, fmtHours, ago, fmtDate, fmtTime, dayLabel, plat, platDot, platTag, platIcon, STATUSES, cover, icon,
  api, toast, undoToast, fail, modal, confirmBox, navigate, rerender, state, watchSync, syncStarted, applyTheme, paintAccent, accentOf, scrollMotion, plural, setTitle, MARK, tagline,
  NAV_GROUPS, navItems, applyBadges, coverHue,
} from './app.js';

const arrow = () => icon('arrowR', 'ic-inline'); // trailing "go there" arrow on links
import { barChart, sparkline, donut, heatmap, topList, platformLegend, mountCharts, curveChart, dayName } from './charts.js';
import { insights, eraStrip } from './insights.js';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// time-of-day axis: 12a / 6a / 12p / 6p, or 00 / 06 / 12 / 18 where the clock is 24-hour
const H24 = /h2[34]/.test(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle || '');
export function hourLabel(h) { return H24 ? String(h).padStart(2, '0') : `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`; }
// a URL safe inside CSS url('...'): quotes, parentheses, backslashes and newlines percent-encoded
const cssUrl = (u) => String(u).replace(/['"()\\\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

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
function stackedSeries(stats) {
  const plats = Object.keys(stats.series_by_platform || {});
  const est = stats.series_estimated || [];
  return stats.series.map((s, i) => ({
    label: seriesLabel(s.key, stats.range.group),
    name: seriesName(s.key, stats.range.group),
    value: s.minutes,
    tip: seriesTip(s.key, stats.range.group, s.minutes) + (est[i] ? ` (${fmtMin(est[i])} estimated from history)` : ''),
    stack: [...plats.map((p) => ({ key: p, value: stats.series_by_platform[p][i] || 0, color: plat(p).color })), ...(est[i] ? [{ key: 'estimated', value: est[i], color: 'url(#pt-hatch)' }] : [])],
  }));
}

function estimatedLegend(stats) {
  return stats.estimated_minutes ? `<span title="Playtime from before tracking began, dated from first/last played, achievements and release dates"><i class="dot hatch-dot"></i>Estimated history · ${fmtMin(stats.estimated_minutes, { short: true })}</span>` : '';
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

const hoursVal = (m) => `${fmtHours(m)}<small>h</small>`;

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
  if (s.kind === 'estimate') return `<span class="badge" title="${esc(CONF[s.confidence]?.[2] || '')}">estimated · ${esc(s.confidence || '')}</span>`;
  if (s.source === 'manual') return '<span class="badge accent">manual</span>';
  if (s.note?.startsWith('Length estimated')) return '<span class="badge" title="The platform reports no playtime for this game and live presence missed this session: it ends at the reported last-played time, with your typical session length. Edit it if you know better.">≈ length</span>';
  if (s.confidence === 'exact') return `<span class="badge good" title="${CONF.exact[2]}">● live</span>${s.device ? `<span class="badge">${esc(s.device)}</span>` : ''}`;
  if (s.device) return `<span class="badge">${esc(s.device)}</span>${s.precise ? '' : `<span class="badge" title="${approx('Exact time unknown — spread across the sync window')}">≈</span>`}`;
  if (s.source === 'import') return '<span class="badge">imported</span>';
  if (s.source === 'api') return '<span class="badge">api</span>';
  return s.precise ? '' : `<span class="badge" title="${approx('Exact time unknown — spread across the sync window')}">≈</span>`;
}

/**
 * A session row. On a phone line 2 is one line: platform dot, compact time, source badge (the note
 * moves into the badge's title). platLabel: name the platform (a game page whose game has several entries);
 * dated: that line starts with the day (a list whose day headers a phone hides).
 */
function sessionItem(s, { showGame = true, selectable = false, selected = false, platLabel = true, dated = false } = {}) {
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

function groupByDay(sessions) {
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

export function logSessionModal(game = null, onDone = rerender) {
  let picked = game;
  const now = Date.now();
  modal({
    title: 'Log a session',
    body: `<form class="stack" id="log-form">
      <div class="field"><label>Game</label>${game ? `<div class="row">${cover(game)}<b>${esc(game.title)}</b></div>` : '<input class="input" id="gp" placeholder="Search your library or type a new title" autocomplete="off">'}</div>
      <div class="field"><label>Duration</label>
        <div class="row"><input class="input" type="number" min="0" max="168" name="h" value="1" style="width:90px" aria-label="Duration, hours"> <span class="muted" aria-hidden="true">h</span>
        <input class="input" type="number" min="0" max="59" name="m" value="0" style="width:90px" aria-label="Duration, minutes"> <span class="muted" aria-hidden="true">m</span></div>
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
async function restoreSession(s) {
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

function bindSessionEdits(root, onDone) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit-session]');
    if (b) editSessionModal(b.dataset.editSession, onDone);
  });
}

// =====================================================================
// Dashboard
// =====================================================================
const H = 3600e3;
const D = 24 * H;
/** How often a schedule syncs, and that in words: [ms, 'daily'] (null: manual only). */
function scheduleEvery(s) {
  const n = Math.max(1, Math.floor(Number(s.schedule_every) || 1));
  switch (s.schedule_mode) {
    case 'hourly': return [H, 'hourly'];
    case 'hours': return [n * H, n === 1 ? 'hourly' : `every ${n} hours`];
    case 'daily': return [D, 'daily'];
    case 'days': return [n * D, n === 1 ? 'daily' : `every ${n} days`];
    case 'weekly': return [7 * D, 'weekly'];
    case 'monthly': return [31 * D, 'monthly'];
    default: return null;
  }
}
/** "4:00 AM" within a day, else the date. */
const soon = (t) => (t - Date.now() < D ? fmtTime(t) : `${fmtDate(t)} ${fmtTime(t)}`);

/**
 * Is tracking working? bad: an account's last sync failed; warn: accounts paused, or a sync is
 * overdue by half its interval again; good: up to date. Null without accounts.
 */
function trackingHealth(accounts) {
  if (!accounts.length) return null;
  const on = accounts.filter((a) => a.enabled);
  const failing = on.filter((a) => a.last_status === 'error' && !a.syncing);
  if (failing.length) return { level: 'bad', text: `${failing[0].name} sync failed${failing.length > 1 ? ` (+${failing.length - 1} more)` : ''}`, action: 'Fix' };
  const paused = accounts.length - on.length;
  if (paused) return { level: 'warn', text: `${plural(paused, 'account')} paused`, action: 'Resume' };
  if (on.some((a) => a.syncing)) return { level: 'good', text: 'Syncing now' };
  const pulled = on.filter((a) => !a.push);
  const late = pulled.map((a) => ({ a, every: scheduleEvery(a.schedule || state.settings || {}) }))
    .filter(({ a, every }) => every && a.last_sync_at && Date.now() - a.last_sync_at > 1.5 * every[0])
    .sort((x, y) => x.a.last_sync_at - y.a.last_sync_at);
  if (late.length) return { level: 'warn', text: `Last sync ${ago(late[0].a.last_sync_at)} (expected ${late[0].every[1]})` };
  const last = Math.max(0, ...on.map((a) => a.last_sync_at || 0));
  const next = Math.min(...pulled.map((a) => a.next_sync_at || Infinity));
  return { level: 'good', text: ['Up to date', last ? `${pulled.length ? 'synced' : 'last report'} ${ago(last)}` : 'waiting for the first sync', Number.isFinite(next) && `next ${soon(next)}`].filter(Boolean).join(' · ') };
}

// ---------- first run: a checklist of what is really there ----------
const FIRSTRUN = 'vg-firstrun'; // '1' while this device shows the checklist, 'done' once it is dismissed
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

async function checklistData(accounts, hasData, pre = {}) {
  const [syncs, dupes, hist] = await Promise.all([
    accounts.length ? api(`/syncs?limit=${Math.max(10, accounts.length * 3)}`).catch(() => []) : [],
    'dupes' in pre ? pre.dupes : hasData ? api('/duplicates?summary=true').catch(() => null) : null,
    'hist' in pre ? pre.hist : hasData ? api('/history/summary').catch(() => null) : null,
  ]);
  return { accounts, hasData, syncs, dupes, hist };
}

/** The steps, each done or not from the data: connect, first import (per account, live), duplicates, history dating, a password. */
function checklist({ accounts, hasData, syncs, dupes, hist }, { first = false } = {}) {
  const connected = accounts.length > 0;
  const status = (a) => {
    const s = syncs.find((x) => x.account_id === a.id);
    if (a.syncing || s?.status === 'running') return ['pulse', a.push ? 'Waiting for a report…' : 'Importing your library…'];
    if (a.last_status === 'error') return ['bad', `Failed: ${a.last_error || 'see Accounts'}`];
    if (s) return ['good', `${plural(s.games_seen || 0, 'game')} ${a.push ? 'reported' : 'imported'}`];
    return ['', a.push ? 'Waiting for the first report' : 'Waiting for the first sync'];
  };
  const nd = dupes ? dupes.counts.suggestions + dupes.counts.double_counted : 0;
  const rows = hist?.rows || [];
  const histMin = rows.reduce((t, r) => t + r.minutes, 0);
  const solid = rows.filter((r) => r.confidence === 'high' || r.confidence === 'medium').reduce((t, r) => t + r.minutes, 0);
  const pctSolid = histMin ? Math.round((solid / histMin) * 100) : 100;
  const steps = [
    { title: 'Connect an account', done: connected,
      text: connected ? esc(accounts.map((a) => a.name).join(', ')) : 'Steam, Xbox or PlayStation, or a custom account you push totals to.',
      act: `<button class="btn sm primary" data-ck="connect">${icon('plus')}Connect an account</button>` },
    { title: 'First import', done: connected && hasData,
      text: connected ? `<ul class="ck-acc">${accounts.map((a) => { const [cls, t] = status(a); return `<li class="${cls}">${platDot(a.platform)}<b>${esc(a.name)}</b><span>${esc(t)}</span></li>`; }).join('')}</ul>` : 'Your library and lifetime hours arrive with the first sync, dated as history.' },
    { title: 'Review duplicates', done: hasData && !nd,
      text: !hasData ? 'Editions and copies on several platforms, looked for after the import.' : nd ? `${plural(nd, 'possible duplicate')} found` : 'Nothing is counted twice',
      act: hasData && nd ? '<a class="btn sm" href="/duplicates" data-link>Review</a>' : '' },
    { title: 'Date old playtime', done: hasData && pctSolid >= 80,
      text: !hasData ? 'Hours played before tracking are dated from what the platforms report.' : histMin ? `${pctSolid}% of the ${fmtHours(histMin)}h before tracking is dated solidly` : 'No history before tracking to date',
      act: hasData && pctSolid < 80 ? '<a class="btn sm" href="/history" data-link>Improve history</a>' : '' },
    ...(state.authEnabled ? [] : [{ title: 'Protect with a password', done: false, text: 'Until you set one, anyone who can reach this server can see and change your data.', act: `<a class="btn sm" href="/settings#security" data-link>${icon('key')}Set a password</a>` }]),
  ];
  const active = steps.findIndex((s) => !s.done);
  const done = steps.filter((s) => s.done).length;
  return `<div class="ck-h"><h2 id="ck-title">${first ? 'Getting started' : 'Finish setting up'}</h2><span class="small muted">${done} of ${steps.length} done</span>${first ? '' : '<button class="btn ghost sm" data-ck="dismiss">Dismiss</button>'}</div>
    <ol class="checklist" aria-labelledby="ck-title">${steps.map((s, i) => `<li class="ck${s.done ? ' done' : ''}${i === active ? ' active' : ''}"${i === active ? ' aria-current="step"' : ''}><span class="ck-n" aria-hidden="true">${s.done ? icon('check') : i + 1}</span><div class="grow"><b>${s.title}</b><span class="vh">${s.done ? ', done' : i === active ? ', next' : ''}</span><div class="small muted">${s.text}</div></div>${s.act && !s.done ? s.act : ''}</li>`).join('')}</ol>`;
}

/** Connect opens the dialog right here, Dismiss hides the checklist for good; while an import runs the checklist follows it. */
function bindChecklist(root, hasData, syncing) {
  const host = root.querySelector('#checklist');
  if (!host) return;
  host.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ck]');
    if (!b) return;
    if (b.dataset.ck === 'connect') accountModal(await api('/platforms').catch(() => []));
    if (b.dataset.ck === 'dismiss') { lsSet(FIRSTRUN, 'done'); host.remove(); toast('Checklist dismissed'); }
  });
  const follow = async () => {
    if (!host.isConnected) return;
    const accs = await api('/accounts').catch(() => null);
    if (!accs || !host.isConnected) return;
    const games = hasData || (await api('/stats/lifetime').catch(() => ({ games: 0 }))).games > 0;
    if (!hasData && games && !accs.some((a) => a.syncing)) { rerender(); return; } // the import is in: the full Home
    const data = await checklistData(accs, games);
    if (!host.isConnected) return;
    host.innerHTML = checklist(data, { first: !hasData });
    if (accs.some((a) => a.syncing)) setTimeout(follow, 2500);
  };
  if (syncing) setTimeout(follow, 2500);
}

const dayKey = (t) => { const x = new Date(t); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
/**
 * "▲ 1h 20m vs last week · 3 games · 5 sessions". Like with like: this week so far (it starts on the
 * day set in Settings) against the same days of last week, tracked play only, as the heading.
 */
function weekLine(d) {
  const wk = d.week;
  const tracked = new Map(d.month.series.map((x) => [x.key, x.minutes - (x.estimated || 0)]));
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const days = ((today.getDay() - (state.settings?.week_starts_on ?? 1) + 7) % 7) + 1; // so far, today included
  let before = 0;
  for (let i = 0; i < days; i++) before += tracked.get(dayKey(today.getTime() - (7 + i) * D)) || 0;
  const diff = Math.round(wk.total_minutes - before);
  const delta = diff ? `${icon(diff > 0 ? 'up' : 'down', 'ic-inline')}<span class="vh">${diff > 0 ? 'up' : 'down'}</span> ${fmtMin(Math.abs(diff))} vs last week` : 'Same as last week';
  return `${delta} · ${plural(wk.games_played, 'game')} · ${plural(wk.sessions, 'session')}`;
}
async function dashboard(view, stale) {
  const d = await api('/summary');
  if (stale()) return;
  const hasData = d.lifetime.games > 0;
  const greeting = (() => { const h = new Date().getHours(); return h < 5 ? 'Late night session?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; })();
  const syncing = d.accounts.some((a) => a.syncing);

  if (!hasData) {
    lsSet(FIRSTRUN, lsGet(FIRSTRUN) === 'done' ? 'done' : '1');
    const ck = await checklistData(d.accounts, false);
    if (stale()) return;
    view.innerHTML = `<div class="page-h"><div><h1>${greeting}</h1><p>Let’s get your play history in.</p></div></div>
      <div class="card onboard fade-in">
        <div class="onboard-head"><div class="brand brand-stack"><span class="brand-mark">${MARK}</span><h2 class="brand-word">Welcome to Vestigo</h2></div>${tagline()}</div>
        <p class="muted" style="margin:16px auto 0;max-width:720px;text-align:center">Platforms only report lifetime totals. Vestigo snapshots them on a schedule and turns each difference into a session — and dates the hours you played before, so your charts don’t open with a 500-hour spike.</p>
        <div id="checklist">${checklist(ck, { first: true })}</div>
        <div class="row wrap" style="margin-top:18px;justify-content:center">
          <a class="btn" href="/settings#import" data-link>${icon('upload')}Import CSV / JSON</a>
          <button class="btn" id="dash-log">${icon('clock')}Log a session</button>
        </div>
      </div>`;
    $('#dash-log').addEventListener('click', () => logSessionModal());
    bindChecklist(view, false, syncing);
    return;
  }

  const wk = d.week; const mo = d.month;
  const streak = mo.streaks.current;
  const layout = parseLayout(state.settings?.dashboard_layout);
  const on = new Set(layout.filter((x) => x.on).map((x) => x.key));
  const year = new Date().getFullYear();
  const [heat, upNext, dupes, hist] = await Promise.all([
    on.has('heatmap') ? api(`/stats/heatmap?year=${year}`).catch(() => null) : null,
    on.has('backlog') ? api('/games?status=playing,backlog&sort=recent&limit=16').catch(() => null) : null,
    api('/duplicates?summary=true').catch(() => null),
    api('/history/summary').catch(() => null),
  ]);
  // the first-run checklist stays on Home (on the device that saw it) until it is dismissed
  const ck = lsGet(FIRSTRUN) === '1' ? await checklistData(d.accounts, true, { dupes, hist }) : null;
  if (stale()) return;
  const health = trackingHealth(d.accounts);
  // things to look at, each only while there is something to do
  const nDupes = dupes ? dupes.counts.suggestions + dupes.counts.double_counted : 0;
  const nRough = (hist?.rows || []).filter((r) => r.confidence === 'low').reduce((t, r) => t + r.entries, 0);
  const attention = [
    nDupes && ['/duplicates', 'dupes', plural(nDupes, 'possible duplicate'), 'Merge or exclude'],
    nRough && ['/history', 'history', `${plural(nRough, 'game')} with rough history dates`, 'Say when you played'],
    d.errors_24h && ['/system', 'info', `${plural(d.errors_24h, 'sync error')} in 24 hours`, 'View log', 'bad'],
  ].filter(Boolean);
  const noTracked = !wk.sessions && !mo.tracked_minutes;
  const html = {
    kpis: () => `<div class="kpis fade-in">
      ${kpi('This week', hoursVal(wk.total_minutes), noTracked ? 'Sessions appear after you play' : `${plural(wk.sessions, 'session')} · ${plural(wk.games_played, 'game')}`, sparkline(Array.from({ length: 7 }, (_, i) => wk.series[i]?.minutes ?? 0)), 'feature')}
      ${kpi('Today', fmtMin(d.today.total_minutes), d.today.top_games[0] ? esc(d.today.top_games[0].title) : 'Nothing yet')}
      ${kpi('Last 30 days', hoursVal(mo.tracked_minutes), `${fmtMin(mo.avg_per_day_minutes)}/day avg${mo.estimated_minutes ? ` · +${fmtHours(mo.estimated_minutes)}h est.` : ''}`)}
      ${kpi('Streak', `${streak}<small> day${streak === 1 ? '' : 's'}</small>`, `Best: ${plural(mo.streaks.longest, 'day')}`)}
      ${kpi('Lifetime', `${fmtHours(d.lifetime.total_minutes)}<small>h</small>`, `${d.lifetime.games_played} of ${d.lifetime.games} games played`)}
    </div>`,
    live: () => (d.playing_now?.length ? `<div class="card live-card"><div class="row wrap">${d.playing_now.map((p) => `<a class="row" href="${p.game_id ? `/game/${p.game_id}` : '/accounts'}" data-link style="min-width:0;flex:1">${cover({ title: p.title, cover_url: p.cover_url }, '', 'width:44px;')}<div style="min-width:0"><div class="small" style="color:var(--good);font-weight:700"><span class="live-dot"></span>Playing now · ${esc(plat(p.platform).label)}</div><div class="ttl ellipsis" style="font-weight:700">${esc(p.title)}</div><div class="tiny muted">for ${fmtMin(Math.max(1, p.minutes))}</div></div></a>`).join('')}</div></div>` : ''),
    jump: () => (d.now_playing.length ? `<div class="card"><div class="card-h"><h2>Jump back in</h2><a href="/library?sort=trending" data-link>See all</a></div>
      <div class="carousel">${d.now_playing.map((g) => `<a class="tile" href="/game/${g.id}" data-link>${cover(g)}<div class="t">${esc(g.title)}</div><div class="m">${g.platforms.map(platDot).join('')} ${fmtMin(g.recent_minutes)} · 2 wks</div></a>`).join('')}</div></div>` : ''),
    chart: () => `<div class="card"><div class="card-h"><h2>Last 30 days</h2><a href="/stats" data-link>Stats${arrow()}</a></div>
        ${barChart(stackedSeries(mo), { size: 'card', title: 'Playtime per day, last 30 days' })}${platformLegend(mo.platforms, estimatedLegend(mo))}</div>`,
    top: () => `<div class="card"><div class="card-h"><h2>Top this month</h2></div>
        ${mo.top_games.length ? topList(mo.top_games, { coverFn: (g) => cover(g), limit: 6 }) : '<p class="muted">No play in the last 30 days.</p>'}</div>`,
    recent: () => `<div class="card"><div class="card-h"><h2>Recent sessions</h2><a href="/sessions" data-link>All sessions${arrow()}</a></div>
        <div class="list" id="dash-recent">${d.recent_sessions.length ? d.recent_sessions.map((s) => sessionItem(s)).join('') : '<p class="muted">No sessions yet — they appear after the next sync detects new playtime.</p>'}</div></div>`,
    accounts: () => `<div class="card"><div class="card-h"><h2>Accounts</h2><a href="/accounts" data-link>Manage${arrow()}</a></div>
        <div class="list">${d.accounts.map((a) => `<div class="item">${platIcon(a.platform)}
          <div class="grow"><div class="ttl ellipsis">${esc(a.name)}</div><div class="sub">${a.syncing ? '<span class="pulse">Syncing…</span>' : a.last_status === 'error' ? `<span style="color:var(--bad)">Error · ${esc(a.last_error || '')}</span>`
            : a.push ? (a.last_sync_at ? `Last report ${ago(a.last_sync_at)}` : 'No reports yet') : a.last_sync_at ? `Synced ${ago(a.last_sync_at)}` : 'Not synced yet'}</div></div>
          ${!a.enabled ? '<span class="badge">Paused</span>' : a.push ? '<span class="badge" title="Totals are pushed through the API">API</span>' : `<span class="tiny muted nowrap">${a.next_sync_at ? `next ${ago(a.next_sync_at)}` : 'Manual'}</span>`}</div>`).join('') || '<p class="muted">No accounts linked.</p>'}
        </div>
        <div class="row" style="margin-top:12px"><button class="btn sm" data-action="sync-all">${icon('sync')}<span class="lbl">Sync now</span></button><a class="btn sm ghost" href="/accounts?add=1" data-link>${icon('plus')}Add</a></div></div>`,
    heatmap: () => (heat ? `<div class="card"><div class="card-h"><h2>${year} at a glance</h2><a href="/stats" data-link>Stats${arrow()}</a></div>${heatmap(year, heat.days, { weekStartsOn: state.settings?.week_starts_on ?? 1, estimated: heat.estimated_days || {} })}</div>` : ''),
    backlog: () => (upNext ? `<div class="card"><div class="card-h"><h2>Up next</h2><a href="/library?status=playing" data-link>Library${arrow()}</a></div>
      ${upNext.items.length ? `<div class="carousel">${upNext.items.map((g) => `<a class="tile" href="/game/${g.id}" data-link>${cover(g)}<div class="t">${esc(g.title)}</div><div class="m">${g.platforms.map(platDot).join('')} ${STATUSES[g.status]?.label || ''}</div></a>`).join('')}</div>`
        : '<p class="muted small" style="margin:0">Mark games as <b>Playing</b> or <b>Backlog</b> on their page and they show up here.</p>'}</div>` : ''),
  };
  // half-width sections sit side by side with the next half-width one; alone they go full width
  const blocks = [];
  const shown = layout.filter((x) => x.on && html[x.key]).map((x) => ({ ...x, out: html[x.key]() })).filter((x) => x.out);
  for (let i = 0; i < shown.length; i++) {
    const x = shown[i];
    const nx = shown[i + 1];
    if (DASH_SECTIONS[x.key].half && nx && DASH_SECTIONS[nx.key].half) { blocks.push(`<div class="grid grid-main">${x.out}${nx.out}</div>`); i++; } else blocks.push(x.out);
  }
  view.innerHTML = `
    <div class="page-h dash-h"><div><div class="eyebrow">${greeting}</div><h1>${fmtMin(wk.total_minutes)} this week</h1><p>${weekLine(d)}</p></div>
      <div class="row wrap dash-act">${health ? `<a class="health h-${health.level}" href="/accounts" data-link><span class="hdot" aria-hidden="true"></span><span>${esc(health.text)}${health.action ? ` · <u>${health.action}</u>` : ''}</span></a>` : ''}
        <button class="btn ghost sm" id="dash-custom" aria-label="Customize home" title="Customize home">${icon('settings')}<span class="desk-only">Customize</span></button><button class="btn desk-only" id="dash-log">${icon('plus')}Log session</button></div></div>
    <div class="dash">
    ${ck ? `<div class="card checklist-card" id="checklist">${checklist(ck)}</div>` : ''}
    ${attention.length ? `<div class="attn" role="group" aria-label="Needs attention">${attention.map(([href, ic, what, act, cls = '']) => `<a class="card attn-card ${cls}" href="${href}" data-link>${icon(ic)}<span class="grow"><b>${what}</b><span class="small muted">${act}</span></span>${icon('chevR', 'ic-16')}</a>`).join('')}</div>` : ''}
    ${blocks.join('\n') || `<div class="card muted">Every section is hidden. <a href="#" id="dash-custom2" class="link">Customize</a> to bring some back.</div>`}
    </div>
    <button class="fab" id="fab-log" aria-label="Log session">${icon('plus')}</button>`;
  mountCharts(view);
  $('#dash-log')?.addEventListener('click', () => logSessionModal());
  $('#fab-log').addEventListener('click', () => logSessionModal());
  const custom = (e) => { e?.preventDefault(); layoutModal(); };
  $('#dash-custom').addEventListener('click', custom);
  $('#dash-custom2')?.addEventListener('click', custom);
  bindSessionEdits(view);
  bindChecklist(view, true, false);
}

// ---------- home layout ----------
const DASH_SECTIONS = {
  kpis: { label: 'Stat cards', desc: 'This week, today, 30 days, streak, lifetime' },
  live: { label: 'Playing now', desc: 'While presence sees a game running' },
  jump: { label: 'Jump back in', desc: 'Played in the last two weeks' },
  chart: { label: 'Last 30 days', desc: 'Daily chart', half: true },
  top: { label: 'Top this month', desc: 'Most played games', half: true },
  recent: { label: 'Recent sessions', desc: '', half: true },
  accounts: { label: 'Accounts', desc: 'Sync status', half: true },
  heatmap: { label: 'Year heatmap', desc: 'Every day of this year' },
  backlog: { label: 'Up next', desc: 'Games marked Playing or Backlog' },
};
const DEFAULT_LAYOUT = 'kpis,live,jump,chart,top,recent,accounts,-heatmap,-backlog';

function parseLayout(str) {
  const out = String(str || DEFAULT_LAYOUT).split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => ({ key: x.replace(/^-/, ''), on: !x.startsWith('-') })).filter((x) => DASH_SECTIONS[x.key]);
  for (const k of Object.keys(DASH_SECTIONS)) if (!out.some((x) => x.key === k)) out.push({ key: k, on: false });
  return out;
}
const layoutString = (list) => list.map((x) => (x.on ? x.key : `-${x.key}`)).join(',');

/** Show/hide and reorder home sections; calls onChange(layoutString) on every edit. */
function layoutEditor(host, layout, onChange) {
  const list = layout.map((x) => ({ ...x }));
  const draw = () => {
    host.innerHTML = `<div class="layout-list">${list.map((x, i) => `<div class="layout-row ${x.on ? '' : 'off'}" data-i="${i}">
      <label class="switch"><input type="checkbox" data-on ${x.on ? 'checked' : ''} aria-label="Show ${esc(DASH_SECTIONS[x.key].label)}"><span></span></label>
      <div class="grow">${esc(DASH_SECTIONS[x.key].label)}${DASH_SECTIONS[x.key].desc ? ` <span class="d">· ${esc(DASH_SECTIONS[x.key].desc)}</span>` : ''}${DASH_SECTIONS[x.key].half ? ' <span class="d">· half width</span>' : ''}</div>
      <button class="btn icon ghost sm" data-up ${i === 0 ? 'disabled' : ''} aria-label="Move up">${icon('up')}</button><button class="btn icon ghost sm" data-down ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">${icon('down')}</button></div>`).join('')}</div>
      <p class="tiny muted" style="margin:8px 0 0">Two half-width sections next to each other share a row.</p>`;
  };
  host.addEventListener('click', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.closest('[data-up]') && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    else if (e.target.closest('[data-down]') && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    else return;
    draw(); onChange(layoutString(list));
  });
  host.addEventListener('change', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row || !e.target.matches('[data-on]')) return;
    list[Number(row.dataset.i)].on = e.target.checked;
    draw(); onChange(layoutString(list));
  });
  draw();
}

async function saveSettings(patch) {
  const r = await api('/settings', { method: 'PUT', body: patch });
  state.settings = { ...state.settings, ...r };
  applyTheme(state.settings);
  return r;
}

export function layoutModal() {
  let next = null;
  modal({
    title: 'Customize home',
    body: '<div id="lay-ed"></div>',
    foot: '<button class="btn ghost" id="lay-reset">Reset</button><span class="grow"></span><button class="btn" data-close>Cancel</button><button class="btn primary" id="lay-save">Save</button>',
    onMount(el, close) {
      let host = el.querySelector('#lay-ed');
      const mount = (layout) => {
        const fresh = host.cloneNode(false); // drop the old editor's listeners
        host.replaceWith(fresh); host = fresh;
        layoutEditor(host, layout, (v) => { next = v; });
      };
      mount(parseLayout(state.settings?.dashboard_layout));
      el.querySelector('#lay-reset').addEventListener('click', () => { next = DEFAULT_LAYOUT; mount(parseLayout(DEFAULT_LAYOUT)); });
      el.querySelector('#lay-save').addEventListener('click', async () => {
        try { if (next) await saveSettings({ dashboard_layout: next }); close(); rerender(); } catch (err) { fail(err); }
      });
    },
  });
}

// =====================================================================
// Library
// =====================================================================
const LIB_FLAGS = [['favorite', 'Favorites'], ['recent', 'Played in the last 2 weeks'], ['multi', 'On several platforms']];
function libState() {
  const q = new URLSearchParams(location.search);
  const list = (k) => (q.get(k) || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    q: q.get('q') || '', platform: list('platform'), status: list('status'),
    // one account at a time: GET /games takes a single account_id
    account: q.get('account_id') || '',
    sort: q.get('sort') || state.settings?.default_library_sort || 'recent', // the URL keeps any other sort
    view: state.settings?.library_view || 'grid',
    // "hide never-played" setting: show played games unless a filter in the URL says otherwise
    played: q.get('played') ?? (state.settings?.library_hide_unplayed ? 'true' : ''), hidden: q.get('hidden') || '',
    ...Object.fromEntries(LIB_FLAGS.map(([k]) => [k, q.get(k) === 'true'])),
  };
}

async function library(view, stale) {
  const st = libState();
  const [platforms, accounts] = await Promise.all([api('/stats/lifetime'), api('/accounts').catch(() => [])]);
  if (stale()) return;
  const platList = platforms.platforms.map((p) => p.platform);
  const playedDef = state.settings?.library_hide_unplayed ? 'true' : '';
  const sortOpts = [['recent', 'Recently played'], ['trending', 'Trending (2 wks)'], ['playtime', 'Most played'], ['title', 'A–Z'], ['added', 'Recently added'], ['rating', 'Top rated']];
  view.innerHTML = `
    <div class="page-h"><div><h1>Library</h1><p id="lib-count">&nbsp;</p></div>
      <div class="row"><button class="btn desk-only" id="lib-add">${icon('plus')}Add game</button></div></div>
    <div class="toolbar lib-tb">
      <div class="row lib-row1">
        <div class="search grow">${icon('search')}<input class="input" id="lib-q" type="search" placeholder="Search ${platforms.games.toLocaleString()} games…" value="${esc(st.q)}" aria-label="Search library"></div>
        <select class="input" id="lib-sort" style="width:auto" aria-label="Sort by">${sortOpts.map(([v, l]) => `<option value="${v}" ${st.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <div class="seg desk-only" aria-label="View"><button data-view="grid" class="${st.view === 'grid' ? 'on' : ''}" aria-label="Covers">${icon('grid', 'ic-16')}</button><button data-view="list" class="${st.view === 'list' ? 'on' : ''}" aria-label="List">${icon('list', 'ic-16')}</button></div>
        <button class="btn icon mob-only" id="lib-view-t" aria-label="${st.view === 'grid' ? 'Show as a list' : 'Show as covers'}">${icon(st.view === 'grid' ? 'list' : 'grid')}</button>
      </div>
      <div class="lib-row2" id="lib-filters" role="group" aria-label="Filters">
        <button class="fbtn" data-menu="platform" aria-expanded="false" aria-haspopup="true"></button>
        <button class="fbtn" data-menu="status" aria-expanded="false" aria-haspopup="true"></button>
        <button class="fbtn" data-menu="more" aria-expanded="false" aria-haspopup="true"></button>
        <span class="pills" id="lib-pills"></span>
      </div>
    </div>
    <div id="lib-items"></div>
    <div id="lib-more" style="height:40px"></div>
    <button class="fab" id="fab-add" aria-label="Add game">${icon('plus')}</button>`;

  // Server-side paging: only one page of games is ever in memory/DOM per scroll step,
  // so 50k-game libraries stay smooth on phones.
  const PAGE = 120;
  let total = 0; let loaded = 0; let maxMin = 1; let loading = false; let seq = 0;
  const box = $('#lib-items');
  const render = (items) => {
    const host = box.firstElementChild;
    host.insertAdjacentHTML('beforeend', items.map((g) => st.view === 'grid'
      ? `<a class="tile" href="/game/${g.id}" data-link><div style="position:relative">${cover(g)}<div class="flags">${g.favorite ? `<span class="badge" title="Favorite">${icon('heartFill')}</span>` : '<span></span>'}${g.status !== 'unset' ? `<span class="badge">${STATUSES[g.status]?.label || g.status}</span>` : ''}</div>${g.minutes ? `<div class="bar"><i style="width:${Math.max(3, Math.sqrt(g.minutes / maxMin) * 100)}%"></i></div>` : ''}</div>
          <div class="t">${esc(g.title)}</div><div class="m">${g.platforms.filter((p) => p !== 'manual' || g.platforms.length === 1).map(platDot).join('')}<span>${g.minutes ? fmtMin(g.minutes, { short: g.minutes >= 600 }) : 'Unplayed'}</span>${g.entry_count > 1 ? `<span class="dim">· ${g.entry_count}×</span>` : ''}</div></a>`
      : `<a class="li" href="/game/${g.id}" data-link>${cover(g)}<div class="grow"><div class="ellipsis" style="font-weight:620">${esc(g.title)}</div><div class="small muted row" style="gap:6px">${g.platforms.map(platDot).join('')}${g.last_played_at ? `Played ${ago(g.last_played_at)}` : 'Never played'}${g.status !== 'unset' ? ` · ${STATUSES[g.status]?.label}` : ''}</div></div><div class="amt" style="font-weight:700">${fmtMin(g.minutes, { short: g.minutes >= 600 })}</div></a>`).join(''));
  };
  /** The filters as query parameters (the same names in the page URL and in GET /games). */
  const filterParams = () => {
    const p = new URLSearchParams();
    if (st.q) p.set('q', st.q);
    if (st.platform.length) p.set('platform', st.platform.join(','));
    if (st.status.length) p.set('status', st.status.join(','));
    if (st.account) p.set('account_id', st.account);
    for (const [k] of LIB_FLAGS) if (st[k]) p.set(k, 'true');
    if (st.hidden) p.set('hidden', st.hidden);
    return p;
  };
  const params = (offset) => {
    const p = filterParams();
    p.set('limit', String(PAGE)); p.set('offset', String(offset)); p.set('sort', st.sort);
    if (st.played) p.set('played', st.played);
    return p;
  };
  const more = async () => {
    if (loading || loaded >= total) return;
    loading = true;
    const my = seq;
    try {
      const r = await api(`/games?${params(loaded)}`);
      if (my !== seq || stale()) return;
      loaded += r.items.length;
      render(r.items);
      if (!r.items.length) total = loaded;
    } finally { loading = false; }
    checkMore();
  };
  const load = async () => {
    const my = ++seq;
    loading = true;
    let r;
    try { r = await api(`/games?${params(0)}`); } finally { loading = false; }
    if (my !== seq || stale()) return;
    total = r.total; loaded = r.items.length; maxMin = Math.max(1, r.max_minutes || 1);
    $('#lib-count').textContent = `${r.total.toLocaleString()} game${r.total === 1 ? '' : 's'} · ${fmtHours(r.total_minutes)}h total`;
    if (!r.items.length) {
      box.innerHTML = platforms.games
        ? emptyState('search', 'Nothing matches', `No game in your library fits ${activeCount() ? 'these filters' : 'this search'}${st.q ? ` and “${esc(st.q)}”` : ''}.`, `<button class="btn primary" data-clear>${icon('x')}Clear filters</button>`)
        : emptyState('library', 'No tracks yet', 'Connect Steam, Xbox or PlayStation and Vestigo picks up your library — and every hour you’ve already played.', `<a class="btn primary" href="/accounts?add=1" data-link>${icon('plus')}Connect an account</a><a class="btn" href="/settings#import" data-link>${icon('upload')}Import CSV / JSON</a>`);
      return;
    }
    box.innerHTML = st.view === 'grid' ? '<div class="lib-grid"></div>' : '<div class="card pad-0 lib-list"></div>';
    render(r.items);
    checkMore();
  };
  // keep loading while the sentinel is on screen (tall screens / fast scrolling)
  const checkMore = () => {
    const el = $('#lib-more');
    // a view still being prepared has no layout yet: the observer takes over once it shows
    if (el && !view.hidden && el.getBoundingClientRect().top < window.innerHeight + 800) more();
  };
  const sync = () => {
    if (stale()) return; // a search typed just before leaving the page
    const p = filterParams();
    // the URL only records a played filter that differs from the default
    if (st.played !== playedDef) p.set('played', st.played);
    if (st.sort !== (state.settings?.default_library_sort || 'recent')) p.set('sort', st.sort);
    history.replaceState({}, '', `/library${p.toString() ? `?${p}` : ''}`);
    drawFilters();
    load();
  };

  // ---- filter menus: Platform (platforms + one account), Status, More; pills for what is on
  const accName = (id) => accounts.find((a) => String(a.id) === String(id))?.name || `Account ${id}`;
  const statusCount = (k) => platforms.status?.[k] || 0;
  const MORE = [...LIB_FLAGS, ['never', 'Never played'], ...(playedDef ? [['unplayed', 'Include never-played']] : []), ['hidden-all', 'Include hidden'], ['hidden-only', 'Only hidden']];
  const moreOn = (k) => (k === 'never' ? st.played === 'false' : k === 'unplayed' ? st.played === '' : k === 'hidden-all' ? st.hidden === 'all' : k === 'hidden-only' ? st.hidden === 'only' : st[k]);
  const counts = () => ({ platform: st.platform.length + (st.account ? 1 : 0), status: st.status.length, more: MORE.filter(([k]) => moreOn(k)).length });
  const activeCount = () => Object.values(counts()).reduce((a, b) => a + b, 0);
  const check = (name, value, on, label, extra = '', type = 'checkbox') => `<label class="opt"><input type="${type}" class="check${type === 'radio' ? ' radio' : ''}" name="${name}" value="${esc(value)}" ${on ? 'checked' : ''}><span class="grow">${label}</span>${extra}</label>`;
  const menuBody = (kind) => {
    if (kind === 'platform') {
      return `<fieldset><legend>Platforms</legend>${platList.map((p) => check('platform', p, st.platform.includes(p), `${platDot(p)}${esc(plat(p).label)}`, `<span class="tiny muted">${platforms.platforms.find((x) => x.platform === p)?.games ?? ''}</span>`)).join('')}</fieldset>
        ${accounts.length > 1 ? `<fieldset><legend>Account</legend>${check('account', '', !st.account, 'Any account', '', 'radio')}${accounts.map((a) => check('account', a.id, String(st.account) === String(a.id), `${platDot(a.platform)}${esc(a.name)}`, `<span class="tiny muted">${a.games ?? ''}</span>`, 'radio')).join('')}</fieldset>` : ''}`;
    }
    if (kind === 'status') return `<fieldset><legend>Status</legend>${Object.entries(STATUSES).map(([k, v]) => check('status', k, st.status.includes(k), esc(v.label), `<span class="tiny muted">${statusCount(k)}</span>`)).join('')}</fieldset>`;
    return `<fieldset><legend>Show</legend>${MORE.map(([k, l]) => check('more', k, moreOn(k), l)).join('')}</fieldset>`;
  };
  const LABELS = { platform: 'Platform', status: 'Status', more: 'More' };
  const drawFilters = () => {
    const c = counts();
    for (const b of $$('[data-menu]', view)) {
      const k = b.dataset.menu;
      b.classList.toggle('on', !!c[k]);
      b.innerHTML = `${LABELS[k]}${c[k] ? ` <span class="fcount">· ${c[k]}</span>` : ''}${icon('chevD', 'ic-14')}`;
      b.setAttribute('aria-label', `${LABELS[k]} filter${c[k] ? `, ${c[k]} on` : ''}`);
    }
    const pills = [
      ...st.platform.map((p) => [`platform:${p}`, `${platDot(p)}${esc(plat(p).label)}`]),
      ...(st.account ? [[`account:${st.account}`, esc(accName(st.account))]] : []),
      ...st.status.map((s) => [`status:${s}`, esc(STATUSES[s]?.label || s)]),
      ...MORE.filter(([k]) => moreOn(k)).map(([k, l]) => [`more:${k}`, esc(l)]),
    ];
    $('#lib-pills').innerHTML = pills.map(([k, l]) => `<button class="pill" data-rm="${esc(k)}" aria-label="Remove filter: ${esc(l.replace(/<[^>]+>/g, ''))}">${l}${icon('x', 'ic-14')}</button>`).join('')
      + (pills.length ? '<button class="pill-clear" data-clear>Clear all</button>' : '');
  };
  const apply = (name, value, on) => {
    if (name === 'platform' || name === 'status') st[name] = on ? [...new Set([...st[name], value])] : st[name].filter((x) => x !== value);
    else if (name === 'account') st.account = on ? value : '';
    else if (value === 'never') st.played = on ? 'false' : playedDef;
    else if (value === 'unplayed') st.played = on ? '' : playedDef;
    else if (value === 'hidden-all') st.hidden = on ? 'all' : (st.hidden === 'all' ? '' : st.hidden);
    else if (value === 'hidden-only') st.hidden = on ? 'only' : (st.hidden === 'only' ? '' : st.hidden);
    else st[value] = on;
    sync();
  };
  const clearAll = () => {
    Object.assign(st, { platform: [], status: [], account: '', played: playedDef, hidden: '', ...Object.fromEntries(LIB_FLAGS.map(([k]) => [k, false])) });
    sync();
  };
  let menu = null; // the open popover: { el, btn, close }
  const closeMenu = (focus = false) => {
    if (!menu) return;
    const m = menu; menu = null;
    m.btn.setAttribute('aria-expanded', 'false');
    m.close();
    if (focus) m.btn.focus();
  };
  const bindMenu = (root, kind) => {
    root.addEventListener('change', (e) => {
      const i = e.target;
      if (!i.matches('input')) return;
      apply(i.name, i.value, i.checked);
      // a radio-like pair (never / include never-played, include / only hidden) shows what is on now
      root.querySelector('.fbody').innerHTML = menuBody(kind);
      root.querySelector(`input[name="${CSS.escape(i.name)}"][value="${CSS.escape(i.value)}"]`)?.focus();
    });
  };
  const openMenu = (btn) => {
    const kind = btn.dataset.menu;
    if (menu?.btn === btn) return closeMenu(true);
    closeMenu();
    btn.setAttribute('aria-expanded', 'true');
    if (matchMedia('(max-width: 600px)').matches) {
      // a phone: the menu is a sheet
      const m = modal({ title: `${LABELS[kind]} filters`, body: `<div class="fmenu sheet"><div class="fbody">${menuBody(kind)}</div></div>`, foot: '<button class="btn ghost" data-clear-menu>Clear</button><span class="grow"></span><button class="btn primary" data-close>Done</button>',
        onMount(el) {
          bindMenu(el, kind);
          el.querySelector('[data-clear-menu]').addEventListener('click', () => {
            if (kind === 'platform') Object.assign(st, { platform: [], account: '' });
            else if (kind === 'status') st.status = [];
            else Object.assign(st, { played: playedDef, hidden: '', ...Object.fromEntries(LIB_FLAGS.map(([k]) => [k, false])) });
            sync();
            el.querySelector('.fbody').innerHTML = menuBody(kind);
          });
        } });
      const obs = new MutationObserver(() => { if (!m.el.isConnected) { obs.disconnect(); if (menu?.el === m.el) { menu = null; btn.setAttribute('aria-expanded', 'false'); } } });
      obs.observe(document.body, { childList: true });
      menu = { el: m.el, btn, close: m.close };
      return;
    }
    const el = document.createElement('div');
    el.className = 'fmenu card';
    el.id = `lib-menu-${kind}`;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', `${LABELS[kind]} filters`);
    el.innerHTML = `<div class="fbody">${menuBody(kind)}</div>`;
    btn.setAttribute('aria-controls', el.id);
    btn.after(el);
    el.style.left = `${btn.offsetLeft}px`;
    el.style.top = `${btn.offsetTop + btn.offsetHeight + 6}px`;
    // keep the card on screen: shift it left when it would leave the right edge
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth - 8) el.style.left = `${Math.max(0, btn.offsetLeft - (r.right - (innerWidth - 8)))}px`;
    bindMenu(el, kind);
    el.querySelector('input')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); } };
    const onDown = (e) => { if (!el.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeMenu(); };
    const onFocus = (e) => { if (!el.contains(e.target) && e.target !== btn) closeMenu(); };
    el.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('focusin', onFocus);
    menu = { el, btn, close: () => { el.remove(); document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('focusin', onFocus); } };
  };
  $('#lib-filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-menu]');
    if (b) return openMenu(b);
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      const [name, ...v] = rm.dataset.rm.split(':');
      const value = v.join(':');
      apply(name === 'more' ? 'more' : name, value, false);
      ($('#lib-pills [data-rm]') || $('#lib-filters [data-menu="more"]'))?.focus();
    }
  });
  // "Clear all" by the pills keeps the search; the no-match state's "Clear filters" clears it too
  view.addEventListener('click', (e) => {
    const c = e.target.closest('[data-clear]');
    if (!c) return;
    if (!c.matches('.pill-clear')) { st.q = ''; $('#lib-q').value = ''; }
    clearAll();
    $('#lib-q').focus();
  });
  drawFilters();
  let t;
  $('#lib-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value.trim(); sync(); }, 180); });
  $('#lib-sort').addEventListener('change', (e) => { st.sort = e.target.value; sync(); });
  const setView = (v) => {
    st.view = v;
    $$('[data-view]', view).forEach((x) => x.classList.toggle('on', x.dataset.view === v));
    const tb = $('#lib-view-t');
    tb.innerHTML = icon(v === 'grid' ? 'list' : 'grid');
    tb.setAttribute('aria-label', v === 'grid' ? 'Show as a list' : 'Show as covers');
    sync();
    if (state.settings?.library_view !== st.view) saveSettings({ library_view: st.view }).catch(() => {}); // remembered on every device
  };
  $$('[data-view]', view).forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#lib-view-t').addEventListener('click', () => setView(st.view === 'grid' ? 'list' : 'grid'));
  const addGame = () => modal({
    title: 'Add a game',
    body: `<form class="stack" id="ag"><div class="field"><label>Title</label><input class="input" name="title" required placeholder="The Legend of Zelda: Tears of the Kingdom"></div>
      <div class="field"><label>Cover image URL <span class="dim">(optional)</span></label><input class="input" name="cover_url" placeholder="https://…"></div>
      <div class="field"><label>Status</label><select class="input" name="status">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></div>
      <p class="small muted" style="margin:0">Manual games are perfect for Switch, retro or anything without an API. Log sessions on the game page.</p></form>`,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="ag-save">Add game</button>',
    onMount(el, close) {
      el.querySelector('#ag-save').addEventListener('click', async () => {
        const f = el.querySelector('#ag');
        if (!f.title.value.trim()) return;
        try { const g = await api('/games', { method: 'POST', body: { title: f.title.value, cover_url: f.cover_url.value, status: f.status.value } }); close(); navigate(`/game/${g.id}`); } catch (e) { fail(e); }
      });
    },
  });
  $('#lib-add').addEventListener('click', addGame);
  $('#fab-add').addEventListener('click', addGame);
  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) more(); }, { rootMargin: '800px' });
  io.observe($('#lib-more'));
  await load();
}

// =====================================================================
// Game detail
// =====================================================================
/**
 * A small menu card under `btn` (a sheet on a phone). Escape, a click outside or Tab away closes it
 * and focus goes back to the button; arrow keys move along a role=menu. onMount(el, close) wires it.
 */
function popover(btn, { title, html, onMount }) {
  if (btn.getAttribute('aria-expanded') === 'true') return;
  btn.setAttribute('aria-expanded', 'true');
  const done = () => btn.setAttribute('aria-expanded', 'false');
  const arrows = (el) => el.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = [...el.querySelectorAll('[role^="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    e.preventDefault();
    items[next]?.focus();
  });
  if (matchMedia('(max-width: 600px)').matches) {
    const m = modal({ title: esc(title), body: html, onMount(el, close) { arrows(el); onMount?.(el, close); } });
    const obs = new MutationObserver(() => { if (!m.el.isConnected) { obs.disconnect(); done(); } });
    obs.observe(document.body, { childList: true });
    return;
  }
  const el = document.createElement('div');
  el.className = 'fmenu card pop';
  el.innerHTML = html;
  btn.after(el);
  const onDown = (e) => { if (!el.contains(e.target) && !btn.contains(e.target)) close(); };
  const onFocus = (e) => { if (!el.contains(e.target)) close(); };
  function close(focus = false) {
    if (!el.isConnected) return;
    el.remove(); done();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('focusin', onFocus);
    if (focus) btn.focus();
  }
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } });
  arrows(el);
  document.addEventListener('pointerdown', onDown, true);
  setTimeout(() => document.addEventListener('focusin', onFocus));
  onMount?.(el, () => close(true));
  el.querySelector('button, input, a[href]')?.focus();
}

/** The game's curve: the running total (tracked over hatched history, sessions and unlocks below) or minutes per month. */
function gameCurve(series, mode, g) {
  if (mode === 'month') {
    return barChart(series.slice(-36).map((x) => ({ label: x.label, name: x.name, value: x.minutes, tip: `${x.name}: ${x.minutes ? fmtMin(x.minutes) : 'no play'}${x.estimated ? ` (${fmtMin(x.estimated)} estimated)` : ''}${x.sessions ? ` · ${plural(x.sessions, 'session')}` : ''}${x.unlocked ? ` · ${x.unlocked} unlocked` : ''}`,
      stack: [{ value: x.tracked, color: 'var(--accent-mark)' }, { key: 'estimated', value: x.estimated || 0, color: 'url(#pt-hatch)' }] })), { size: 'page', title: `${g.title}, playtime by month` });
  }
  return curveChart({ series }, { title: `${g.title}, playtime over time`, keys: `${g.title} over time; arrow keys read each month` });
}

/** When a group of unlocks happened, in words: the session, before tracking, or a day. */
function achGroupHead(gr) {
  if (gr.kind === 'tracked') {
    const s = gr.session;
    const when = s.precise ? `${fmtDate(s.started_at)}, ${fmtTime(s.started_at)}` : fmtDate(s.ended_at);
    return `<button class="ach-gh-link" data-edit-session="${s.id}">Earned during the session on ${esc(when)}</button>`;
  }
  if (gr.kind === 'history') return '<span>Before tracking <span class="muted">· during estimated history</span></span>';
  if (gr.kind === 'day') return `<span>Unlocked on ${esc(fmtDate(gr.at, { year: 'numeric', month: 'short', day: 'numeric' }))} <span class="muted">· no session matched</span></span>`;
  return '<span>Unlocked <span class="muted">· time unknown</span></span>';
}
function achRow(x, dated = false) {
  const secret = x.hidden && !x.unlocked;
  return `<div class="item ach-row${secret ? ' secret' : ''}">${achIcon(x, { size: 36, locked: !x.unlocked })}
    <div class="grow"><div class="ttl ellipsis">${secret ? `<span class="blur" aria-hidden="true">${esc(x.name || 'Hidden')}</span><span class="vh">Hidden achievement</span>` : esc(x.name || 'Achievement')}</div>
      ${x.description ? `<div class="sub">${secret ? `<span class="blur" aria-hidden="true">${esc(x.description)}</span>` : esc(x.description)}</div>` : ''}</div>
    <div class="ach-meta">${rarityText(x)}${x.points ? `<span class="tiny muted">${x.points}G</span>` : ''}${x.unlocked && x.unlocked_at ? `<span class="tiny muted">${dated ? `${fmtDate(x.unlocked_at)}, ` : ''}${fmtTime(x.unlocked_at)}</span>` : ''}</div>
    ${secret ? '<button class="btn ghost sm" data-reveal>Reveal</button>' : ''}</div>`;
}
/** Unlocked achievements in groups: by session (newest first), then those from before tracking, then the rest. */
function achGroups(items) {
  const out = []; const at = new Map();
  for (const x of items.filter((i) => i.unlocked)) {
    const k = x.session_kind === 'tracked' ? `s${x.session.id}` : x.session_kind === 'history' ? 'history' : x.unlocked_at ? `d${dayKey(x.unlocked_at)}` : 'unknown';
    if (!at.has(k)) { at.set(k, out.length); out.push({ k, kind: x.session_kind === 'tracked' ? 'tracked' : x.session_kind === 'history' ? 'history' : x.unlocked_at ? 'day' : 'unknown', session: x.session, at: x.unlocked_at, items: [] }); }
    out[at.get(k)].items.push(x);
  }
  // before tracking, then without a time, always last
  const rank = (gr) => (gr.kind === 'history' ? 1 : gr.kind === 'unknown' ? 2 : 0);
  return out.sort((a, b) => rank(a) - rank(b));
}
const ACH_SHOWN = 8; // unlocks in the timeline before "Show all"
/** The first `n` unlocks of the groups (a group may be cut short). */
const firstUnlocks = (groups, n) => { const out = []; for (const gr of groups) { if (n <= 0) break; out.push({ ...gr, total: gr.items.length, items: gr.items.slice(0, n) }); n -= gr.items.length; } return out; };
/** The achievements card: progress (count, %, gamerscore or trophy grades, completion date), the unlock timeline, the locked ones folded away. */
function achBlock(ach) {
  const sm = ach.summary;
  const groups = achGroups(ach.items);
  const locked = ach.items.filter((x) => !x.unlocked);
  const plat = sm.grades?.platinum;
  const grades = sm.grades ? ['platinum', 'gold', 'silver', 'bronze'].filter((k) => sm.grades[k] || k !== 'platinum').map((k) => `<span class="grade g-${k}" title="${k}">${sm.grades[k]}<span class="vh"> ${k}</span></span>`).join('') : '';
  const per = ach.entries.filter((e) => e.achievements?.total);
  return `<div class="card ach-card" id="g-ach"><div class="card-h"><h2>Achievements</h2>${sm.completed ? `<span class="badge good">${icon('check')}${plat ? 'Platinum' : '100%'}</span>` : ''}</div>
    <div class="ach-prog">
      <div class="ap-num"><b>${sm.unlocked.toLocaleString()}</b><span class="muted">of ${sm.total.toLocaleString()}</span></div>
      <div class="grow"><div class="meter"><i style="width:${Math.min(100, sm.percent)}%"></i></div>
        <div class="small muted ap-sub"><b class="ap-pct">${sm.percent}%</b>${sm.points_total ? ` · ${sm.points.toLocaleString()} of ${sm.points_total.toLocaleString()}G` : ''}${grades ? ` · <span class="grades">${grades}</span>` : ''}</div></div>
    </div>
    ${sm.completed_at ? `<p class="small ach-done">${icon('trophy', 'ic-16')}${plat ? 'Platinum' : 'Completed'} on ${fmtDate(sm.completed_at, { year: 'numeric', month: 'long', day: 'numeric' })}</p>` : ''}
    ${per.length > 1 ? `<div class="ach-entries">${per.map((e) => `<span class="small">${platDot(e.platform)}${esc(e.account_name || e.platform)} · ${e.achievements.unlocked}/${e.achievements.total}${e.excluded ? ' <span class="muted">(excluded)</span>' : ''}</span>`).join('')}</div>` : ''}
    ${groups.length ? `<h3 class="ach-h">Unlock timeline</h3><div class="ach-tl" id="g-ach-tl">${firstUnlocks(groups, ACH_SHOWN).map(achGroup).join('')}</div>
      ${sm.unlocked > ACH_SHOWN ? `<button class="btn sm" data-ach-more>Show all ${plural(sm.unlocked, 'unlock')}</button>` : ''}` : '<p class="small muted">Nothing unlocked yet.</p>'}
    ${locked.length ? `<details class="ach-locked"><summary><span>${plural(locked.length, 'locked achievement')}</span>${locked.some((x) => x.hidden) ? `<span class="tiny muted">${locked.filter((x) => x.hidden).length} hidden</span>` : ''}</summary><div class="list" data-locked></div></details>` : ''}
  </div>`;
}
const achGroup = (gr) => `<section class="ach-g"><div class="ach-gh">${achGroupHead(gr)}<span class="tiny muted">${gr.total ?? gr.items.length}</span></div><div class="list">${gr.items.map((x) => achRow(x, gr.kind === 'history')).join('')}</div></section>`;
function bindAch(root, ach) {
  const card = root.querySelector('#g-ach');
  if (!card) return;
  card.addEventListener('click', (e) => {
    const more = e.target.closest('[data-ach-more]');
    if (more) { card.querySelector('#g-ach-tl').innerHTML = achGroups(ach.items).map(achGroup).join(''); more.remove(); return; }
    const rv = e.target.closest('[data-reveal]');
    if (rv) {
      const row = rv.closest('.ach-row');
      row.classList.add('revealed');
      row.querySelectorAll('.blur').forEach((b) => b.removeAttribute('aria-hidden'));
      row.querySelector('.vh')?.remove();
      rv.remove();
    }
  });
  // the locked list is drawn when it is opened
  card.querySelector('.ach-locked')?.addEventListener('toggle', (e) => {
    const host = e.target.querySelector('[data-locked]');
    if (e.target.open && !host.childElementCount) host.innerHTML = ach.items.filter((x) => !x.unlocked).map((x) => achRow(x)).join('');
  });
}

async function game(view, id, stale) {
  const [g, ach, curve] = await Promise.all([
    api(`/games/${id}`),
    api(`/games/${id}/achievements`).catch(() => null),
    api(`/games/${id}/stats`).catch(() => null),
  ]);
  if (stale()) return;
  setTitle(g.title);
  const s = g.summary || { total_minutes: g.minutes || 0, tracked_minutes: 0, estimated_minutes: 0, baseline_minutes: 0, sessions: 0, avg_session_minutes: 0, longest_session_minutes: 0 };
  const pct = (m) => (s.total_minutes ? Math.max(0, Math.min(100, (m / s.total_minutes) * 100)) : 0);
  const rating = g.rating || 0;
  // the unlocks of each tracked session, for the session rows
  const bySession = new Map();
  for (const x of ach?.items || []) {
    if (!x.unlocked || x.session_kind !== 'tracked') continue;
    if (!bySession.has(x.session.id)) bySession.set(x.session.id, { count: 0, items: [] });
    const b = bySession.get(x.session.id);
    b.count++; b.items.unshift(x); // the list is newest first: unlock order
  }
  // the 10 most recent sessions; the rest are a click away on Sessions, filtered to this game
  const plays = g.sessions.filter((x) => x.kind === 'play');
  const recent = plays.slice(0, 10).map((x) => ({ ...x, achievements: bySession.get(x.id) || { count: 0, items: [] } }));
  const nSessions = Math.max(s.sessions, plays.length);
  const parts = [[s.tracked_minutes, 'tracked', 'background:var(--accent-mark)'], [s.estimated_minutes || 0, 'estimated history', null], [s.baseline_minutes, 'undated', 'background:var(--line-strong)']].filter(([m]) => m > 0);
  const series = (curve?.series || []).map((x) => ({ ...x, label: x.key.endsWith('-01') && curve.series.length > 12 ? x.key.slice(0, 4) : seriesLabel(x.key, 'month'), name: seriesName(x.key, 'month') }));
  const years = [...new Set(series.filter((x) => x.minutes > 0).map((x) => Number(x.key.slice(0, 4))))].sort((a, b) => b - a).slice(0, 6);
  const hasAch = !!(ach?.summary && ach.total);
  view.innerHTML = `
    <a href="/library" data-link class="btn ghost sm" style="margin:-4px 0 10px -6px" onclick="if(history.length>1){event.preventDefault();event.stopPropagation();history.back()}">${icon('back')}Back</a>
    <div class="hero fade-in${g.cover_url ? '' : ' hero-ph'}" style="--ph-h:${coverHue(g.title)}">
      ${g.cover_url ? `<div class="bgclip"><div class="bg" style="background-image:url('${esc(cssUrl(g.cover_url))}')"></div></div>` : ''}
      <div class="in">
        ${cover(g)}
        <div class="grow">
          <div class="row wrap" style="margin-bottom:8px">${g.platforms.map(platTag).join('')}</div>
          <h1>${esc(g.title)}</h1>
          <div class="hero-life"><span class="big">${fmtMin(s.total_minutes, { short: s.total_minutes >= 600 })}</span><span class="muted">lifetime</span></div>
          <div class="hero-line small muted">${plural(nSessions, 'session')} · ${g.last_played_at ? `played ${ago(g.last_played_at)}` : 'never played'}</div>
          ${s.total_minutes ? `<div class="hero-split">
            <div class="split-bar">${parts.map(([m, , st]) => `<i ${st ? `style="width:${pct(m)}%;${st}"` : `class="hatch-bg" style="width:${pct(m)}%"`}></i>`).join('')}</div>
            <div class="legend">${parts.length > 1 ? `<span><b>${fmtMin(s.total_minutes)}</b> =</span>` : ''}${parts.map(([m, l, st], i) => `<span>${i ? '+ ' : ''}<i class="dot${st ? '' : ' hatch-dot'}" ${st ? `style="${st}"` : ''}></i>${fmtMin(m)} ${l}</span>`).join('')}</div>
          </div>` : ''}
        </div>
      </div>
      <div class="hero-act">
        <select class="input" id="g-status-sel" aria-label="Status">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${g.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
        <div class="stars" id="g-stars" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((i) => `<button data-r="${i * 2}" class="${rating >= i * 2 ? 'on' : ''}" role="radio" aria-checked="${rating === i * 2}" aria-label="Rate ${i} of 5">${icon('star')}</button>`).join('')}</div>
        <button class="btn icon ghost${g.favorite ? ' fav-on' : ''}" id="g-fav" aria-label="Favorite" aria-pressed="${!!g.favorite}">${icon(g.favorite ? 'heartFill' : 'heart')}</button>
        <span class="grow"></span>
        <span class="pop-wrap"><button class="btn icon" id="g-more" aria-label="More actions" aria-haspopup="true" aria-expanded="false">${icon('more')}</button></span>
        <button class="btn primary" id="g-log">${icon('plus')}Log session</button>
      </div>
    </div>
    <div class="kpis k4 strip">
      ${kpi('Tracked', fmtMin(s.tracked_minutes), 'since tracking began')}
      ${kpi('Avg session', fmtMin(s.avg_session_minutes), plural(s.sessions, 'session'))}
      ${kpi('Longest', fmtMin(s.longest_session_minutes), s.longest_session_minutes ? 'tracked' : '')}
      ${kpi('First tracked', s.first_tracked_at ? fmtDate(s.first_tracked_at) : '—', s.tracking_since ? `owned since ${fmtDate(s.tracking_since)}` : '')}
    </div>
    <div class="grid grid-main game-cols">${columns()}</div>`;
  /**
   * The two columns: play on the left (curve, sessions), the game's facts on the right
   * (achievements, platforms, notes). Activity and history before tracking go where the columns
   * end closest together, from the cards' expected heights (the page is laid out once, hidden).
   */
  function columns() {
    const curveCard = series.length ? `<div class="card"><div class="card-h"><h2>Playtime over time</h2><div class="seg" id="g-curve-mode" aria-label="Show"><button data-cm="total" class="on">Running total</button><button data-cm="month">By month</button></div></div>
          <div id="g-curve">${gameCurve(series, 'total', g)}</div>
          <div class="legend"><span><i class="dot" style="background:var(--accent-mark)"></i>Tracked</span>${curve.totals.estimated_minutes ? '<span><i class="dot hatch-dot"></i>Estimated history</span>' : ''}${series.some((x) => x.sessions) ? '<span><i class="dot" style="background:var(--accent2)"></i>Sessions</span>' : ''}${series.some((x) => x.unlocked) ? '<span><i class="dot" style="background:var(--star)"></i>Unlocks</span>' : ''}</div>
          ${curve.totals.baseline_minutes ? `<p class="tiny muted" style="margin:8px 0 0">${fmtMin(curve.totals.baseline_minutes)} has no date: it counts toward lifetime, not on the curve.</p>` : ''}</div>` : '';
    const heatCard = years.length ? `<div class="card"><div class="card-h"><h2>Activity</h2>${years.length > 1 ? `<div class="seg" id="g-hm-year" aria-label="Activity year">${years.map((y, i) => `<button data-y="${y}" class="${i ? '' : 'on'}">${y}</button>`).join('')}</div>` : `<span class="tiny muted">${years[0]}</span>`}</div><div id="g-heat"><div class="ins-ph short" aria-hidden="true"></div></div></div>` : '';
    const baselines = g.sessions.filter((x) => x.kind === 'baseline' && x.source !== 'inferred');
    const sessCard = `<div class="card"><div class="card-h"><h2>Recent sessions</h2>${nSessions > recent.length ? `<a href="/sessions?game_id=${g.id}" data-link>All ${nSessions.toLocaleString()} sessions${arrow()}</a>` : ''}</div>
          <div class="list dated" id="g-sessions">${recent.length ? groupByDay(recent).map((grp) => `<div class="day-h"><span>${dayLabel(grp.day)}</span><span>${fmtMin(grp.minutes)}</span></div>${grp.items.map((x) => sessionItem(x, { showGame: false, platLabel: g.entries.length > 1, dated: true })).join('')}`).join('') : '<p class="muted">No sessions yet — they appear after a sync spots new playtime, or log one yourself.</p>'}
          ${baselines.map((x) => `<div class="item"><span class="dot" style="background:var(--line);width:10px;height:10px"></span><div class="grow"><div class="sub"><b style="color:var(--text)">${esc(plat(x.platform).label)}</b> ${esc(x.note || 'History')} · ${fmtDate(x.window_end)}</div></div><div class="amt muted">${fmtMin(x.minutes)}</div><button class="btn ghost sm icon" data-edit-session="${x.id}" aria-label="Edit history">${icon('edit')}</button></div>`).join('')}
          </div>
        </div>`;
    const platCard = `<div class="card"><div class="card-h"><h2>Platforms & accounts</h2></div>
          <div class="list">${g.entries.map((e) => `<div class="item" style="${e.excluded ? 'opacity:.55' : ''}">
              ${e.icon_url ? `<img src="${esc(e.icon_url)}" width="32" height="32" style="border-radius:8px" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : platIcon(e.platform, 32)}
              <div class="grow"><div class="ttl ellipsis">${esc(e.account_name || plat(e.platform).label)}</div>
                <div class="sub">${platDot(e.platform)}${esc(e.title !== g.title ? e.title : plat(e.platform).label)}${e.excluded ? ' · <b>excluded</b>' : ''}</div>
                <div class="sub">${e.last_played_at ? `Played ${ago(e.last_played_at)}` : ''}${e.meta?.devices?.deck ? ` · Deck ${fmtMin(e.meta.devices.deck)}` : ''}${e.play_count ? ` · ${e.play_count} launches` : ''}${e.achievements?.total ? ` · ${e.achievements.unlocked} of ${e.achievements.total} unlocked` : ''}${e.missing_since ? ` · <span style="color:var(--warn)">no longer in library since ${fmtDate(e.missing_since)}</span>` : ''}</div></div>
              <div class="amt">${fmtMin(e.playtime_min)}</div>
              <button class="btn ghost sm icon" data-entry-menu="${e.id}" aria-label="Entry options">${icon('more')}</button>
            </div>`).join('')}</div>
          ${g.entries.length > 1 ? '<p class="small muted" style="margin:8px 0 0">Owned on several platforms — totals are summed. Exclude an entry if two platforms report the same playtime.</p>' : ''}
        </div>`;
    const hist = g.entries.filter((e) => e.history);
    const histCard = hist.length ? `<div class="card"><div class="card-h"><h2>History before tracking</h2></div>
          <p class="small muted" style="margin-top:-6px">Playtime from before tracking began. Instead of landing on import day it is dated from everything the platform reports, and shown hatched in charts.</p>
          ${hist.map((e) => historyBlock(e)).join('')}</div>` : '';
    const notesCard = `<div class="card"><div class="card-h"><h2 id="g-notes-h">Notes</h2><span class="tiny muted" id="g-notes-st" aria-live="polite"></span></div>
          <textarea class="input" id="g-notes" aria-labelledby="g-notes-h" placeholder="Thoughts, progress, where you left off…">${esc(g.notes || '')}</textarea></div>`;
    // expected heights (px at 1400 wide), enough to choose a column
    const shown = hasAch ? Math.min(ACH_SHOWN, ach.summary.unlocked) : 0;
    let L = (curveCard ? 360 : 0) + 90 + Math.max(1, recent.length) * 66 + new Set(recent.map((x) => dayKey(x.ended_at || x.window_end || x.created_at))).size * 40 + baselines.length * 50;
    let R = (hasAch ? 230 + shown * 64 + (shown ? 40 : 0) + (ach.items.some((x) => !x.unlocked) ? 50 : 0) : 0) + 100 + g.entries.length * 76 + 190;
    const left = [curveCard]; const right = [hasAch ? achBlock(ach) : '', platCard];
    // Activity follows the curve, History sits above Notes, each in the shorter column
    for (const [card, h] of [[heatCard, 260], [histCard, 110 + hist.length * 230]]) {
      if (!card) continue;
      if (L <= R) { left.push(card); L += h; } else { right.push(card); R += h; }
    }
    left.push(sessCard);
    right.push(notesCard);
    return `<div class="stack">${left.join('')}</div><div class="stack">${right.join('')}</div>`;
  }
  mountCharts(view);
  bindSessionEdits(view);
  const patch = async (body, msg) => { try { await api(`/games/${id}`, { method: 'PATCH', body }); if (msg) toast(msg); } catch (e) { fail(e); } };
  /**
   * Status, rating, favourite and hidden change in place at once, are saved, and their toast can
   * take them back: Undo saves the previous value and shows it again.
   */
  const undoable = async (key, value, show, msg) => {
    const was = g[key];
    g[key] = value; show(value);
    try { await api(`/games/${id}`, { method: 'PATCH', body: { [key]: value } }); } catch (e) { g[key] = was; show(was); return fail(e); }
    undoToast(msg, async () => { await api(`/games/${id}`, { method: 'PATCH', body: { [key]: was } }); g[key] = was; show(was); });
  };
  const statusSel = $('#g-status-sel');
  const showStatus = (st) => { statusSel.value = st; };
  const setStatus = (st) => { if (st !== g.status) undoable('status', st, showStatus, `Status: ${STATUSES[st]?.label || st}`); };
  statusSel.addEventListener('change', (e) => setStatus(e.target.value));
  const stars = $$('#g-stars button');
  const showRating = (r) => stars.forEach((x) => { x.classList.toggle('on', !!r && Number(x.dataset.r) <= r); x.setAttribute('aria-checked', String(Number(x.dataset.r) === r)); });
  $('#g-stars').addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]'); if (!b) return;
    const r = Number(b.dataset.r) === (g.rating || 0) ? null : Number(b.dataset.r);
    undoable('rating', r, showRating, r ? `Rated ${r / 2} of 5` : 'Rating cleared');
  });
  const fav = $('#g-fav'); // swapped in place: no re-render, keyboard focus stays on the button
  const showFav = (v) => { fav.innerHTML = icon(v ? 'heartFill' : 'heart'); fav.classList.toggle('fav-on', !!v); fav.setAttribute('aria-pressed', String(!!v)); };
  fav.addEventListener('click', () => undoable('favorite', !g.favorite, showFav, !g.favorite ? 'Added to favorites' : 'Removed from favorites'));
  let nt;
  $('#g-notes').addEventListener('input', (e) => { $('#g-notes-st').textContent = 'Saving…'; clearTimeout(nt); nt = setTimeout(async () => { await patch({ notes: e.target.value }); $('#g-notes-st').textContent = 'Saved'; }, 600); });
  $('#g-log').addEventListener('click', () => logSessionModal(g));
  // the ⋯ menu: edit, merge, hide, block auto-merge, delete (what the old Details card held)
  const toggleItem = (id, on, label, desc) => `<button class="mitem" id="${id}" role="menuitemcheckbox" aria-checked="${!!on}"><span class="mcheck" aria-hidden="true">${icon('check')}</span><span class="grow">${label}<span class="d">${desc}</span></span></button>`;
  $('#g-more').addEventListener('click', (e) => popover(e.currentTarget, {
    title: 'Game actions',
    html: `<div role="menu" aria-label="Game actions" class="mlist">
      <button class="mitem" id="g-edit" role="menuitem">${icon('edit')}<span class="grow">Edit title & cover</span></button>
      <button class="mitem" id="g-merge" role="menuitem">${icon('merge')}<span class="grow">Merge with…</span></button>
      ${toggleItem('g-hidden', g.hidden, 'Hide from library', 'Still counts toward stats')}
      ${toggleItem('g-lock', g.merge_locked, 'Block auto-merge', 'New entries with this title stay apart')}
      <button class="mitem danger" id="g-del" role="menuitem">${icon('trash')}<span class="grow">Delete…</span></button></div>`,
    onMount(el, close) {
      const on = (sel, fn) => el.querySelector(sel).addEventListener('click', fn);
      on('#g-edit', () => { close(); editGame(); });
      on('#g-merge', () => { close(); mergeModal(g); });
      on('#g-hidden', (ev) => { const b = ev.currentTarget; undoable('hidden', !g.hidden, (v) => { b.setAttribute('aria-checked', String(!!v)); }, !g.hidden ? 'Hidden from library' : 'Visible in library'); });
      on('#g-lock', (ev) => { const b = ev.currentTarget; g.merge_locked = !g.merge_locked; b.setAttribute('aria-checked', String(!!g.merge_locked)); patch({ merge_locked: g.merge_locked }, g.merge_locked ? 'Auto-merge blocked' : 'Auto-merge allowed'); });
      on('#g-del', () => { close(); deleteGame(); });
    },
  }));
  const editGame = () => modal({
    title: 'Edit game',
    body: `<form class="stack" id="ge"><div class="field"><label>Title</label><input class="input" name="title" value="${esc(g.title)}"></div>
      <div class="field"><label>Cover image URL</label><input class="input" name="cover_url" value="${esc(g.cover_url || '')}"></div>
      ${g.entries.filter((e) => e.cover_url && e.cover_url !== g.cover_url).length ? `<div class="field"><label>Use a platform cover</label><div class="row wrap">${g.entries.filter((e) => e.cover_url).map((e) => `<button type="button" class="btn sm" data-cov="${esc(e.cover_url)}">${platDot(e.platform)}${esc(plat(e.platform).label)}</button>`).join('')}</div></div>` : ''}</form>`,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="ge-save">Save</button>',
    onMount(el, close) {
      el.querySelectorAll('[data-cov]').forEach((b) => b.addEventListener('click', () => { el.querySelector('[name=cover_url]').value = b.dataset.cov; }));
      el.querySelector('#ge-save').addEventListener('click', async () => { const f = el.querySelector('#ge'); await patch({ title: f.title.value, cover_url: f.cover_url.value }, 'Saved'); close(); rerender(); });
    },
  });
  const deleteGame = async () => {
    const synced = g.entries.some((e) => e.account_id);
    if (!(await confirmBox(synced ? 'This game comes from a synced account and will come back on the next sync. Consider hiding it instead. Delete anyway?' : 'Delete this game and all of its sessions? This cannot be undone.', { ok: 'Delete', danger: true, title: 'Delete game?' }))) return;
    try { await api(`/games/${id}${synced ? '?force=true' : ''}`, { method: 'DELETE' }); toast('Deleted'); navigate('/library', { replace: true }); } catch (e) { fail(e); }
  };
  // running total or month by month
  $('#g-curve-mode')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cm]');
    if (!b || b.classList.contains('on')) return;
    $$('#g-curve-mode button').forEach((x) => x.classList.toggle('on', x === b));
    $('#g-curve').innerHTML = gameCurve(series, b.dataset.cm, g);
    mountCharts($('#g-curve'));
  });
  // the year's activity, drawn once the page is up (it sits below the fold)
  const heatHost = $('#g-heat');
  let heatYear = years[0];
  const loadHeat = async () => {
    const y = heatYear;
    const h = await api(`/stats/heatmap?game_id=${g.id}&year=${y}`).catch(() => null);
    if (!h || !heatHost.isConnected || y !== heatYear) return;
    heatHost.innerHTML = heatmap(y, h.days, { weekStartsOn: state.settings?.week_starts_on ?? 1, estimated: h.estimated_days || {} });
    mountCharts(heatHost);
  };
  if (heatHost) {
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { io.disconnect(); loadHeat(); } }, { rootMargin: '400px' });
    io.observe(heatHost);
    $('#g-hm-year')?.addEventListener('click', (e) => { const b = e.target.closest('[data-y]'); if (!b) return; heatYear = Number(b.dataset.y); $$('#g-hm-year button').forEach((x) => x.classList.toggle('on', x === b)); loadHeat(); });
  }
  if (hasAch) bindAch(view, ach);
  view.addEventListener('click', async (ev) => {
    const ed = ev.target.closest('[data-hist-edit]');
    if (ed) return historyModal(g.entries.find((x) => x.id === Number(ed.dataset.histEdit)), rerender);
    const md = ev.target.closest('[data-hist-mode]');
    const rs = ev.target.closest('[data-hist-reset]');
    const cf = ev.target.closest('[data-hist-confirm]');
    try {
      if (cf) { await api(`/entries/${cf.dataset.histConfirm}/history`, { method: 'PATCH', body: { confirm: true } }); toast('Kept as guessed'); rerender(); }
      if (md) {
        const back = md.dataset.histMode === 'undated' ? 'auto' : 'undated';
        const set = (mode) => api(`/entries/${md.dataset.entry}/history`, { method: 'PATCH', body: { mode } });
        await set(md.dataset.histMode);
        undoToast(md.dataset.histMode === 'undated' ? 'Removed from charts' : 'Charted', () => set(back), rerender);
        rerender();
      }
      if (rs) { await api(`/entries/${rs.dataset.histReset}/history`, { method: 'PATCH', body: { reset: true } }); toast('Back to automatic dating'); rerender(); }
    } catch (err) { fail(err); }
  });
  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-entry-menu]');
    if (!b) return;
    const en = g.entries.find((x) => x.id === Number(b.dataset.entryMenu));
    modal({
      title: esc(en.account_name || plat(en.platform).label),
      body: `<div class="stack"><div class="small muted">${esc(en.title)} · ${esc(en.platform)} id <span class="mono">${esc(en.ext_id)}</span><br>First seen ${fmtDate(en.first_seen_at)} · last synced ${ago(en.last_synced_at)}</div>
        <div class="setting" style="border:0;padding:0"><div><div class="t">Exclude from totals</div><div class="d">Use when this entry duplicates playtime already counted on another platform.</div></div><label class="switch"><input type="checkbox" id="en-ex" ${en.excluded ? 'checked' : ''}><span></span></label></div>
        ${g.entries.length > 1 ? `<button class="btn" id="en-split">${icon('split')}Split into its own game</button>` : ''}
        ${en.meta?.store ? `<a class="btn ghost" href="${esc(en.meta.store)}" target="_blank" rel="noopener">Open store page${icon('external')}</a>` : ''}</div>`,
      onMount(el, close) {
        el.querySelector('#en-ex').addEventListener('change', async (ev) => {
          const ex = ev.target.checked;
          try {
            await api(`/entries/${en.id}`, { method: 'PATCH', body: { excluded: ex } });
            close();
            undoToast(ex ? 'Excluded from totals' : 'Counted in totals again', () => api(`/entries/${en.id}`, { method: 'PATCH', body: { excluded: !ex } }), rerender);
            rerender();
          } catch (err) { fail(err); }
        });
        el.querySelector('#en-split')?.addEventListener('click', async () => { const ng = await api(`/entries/${en.id}/split`, { method: 'POST' }); close(); toast('Split into a separate game'); navigate(`/game/${ng.id}`); });
      },
    });
  });
}

function historyBlock(e) {
  const h = e.history;
  const ev = h.evidence || {};
  const conf = h.confidence;
  const chips = [
    ev.first_played_at && ['First played', fmtDate(ev.first_played_at, { year: 'numeric', month: 'short', day: 'numeric' })],
    ev.last_played_at && ['Last played', fmtDate(ev.last_played_at, { year: 'numeric', month: 'short', day: 'numeric' })],
    ev.play_count && ['Launches', ev.play_count],
    ev.recent_min && ['Last 2 weeks', fmtMin(ev.recent_min)],
    ev.anchors && ['Achievement times', ev.anchors],
    ev.date_added && ['Added', fmtDate(ev.date_added, { year: 'numeric', month: 'short', day: 'numeric' })],
    ev.release_at && ['Released', fmtDate(ev.release_at, { year: 'numeric', month: 'short', day: 'numeric' })],
  ].filter(Boolean);
  return `<div class="stack" style="padding:12px 0;border-top:1px solid var(--line)" data-hist="${e.id}">
    <div class="row between"><div class="row">${platDot(e.platform)}<b>${esc(e.account_name || plat(e.platform).label)}</b></div><b>${fmtMin(h.minutes, { short: h.minutes >= 600 })}</b></div>
    ${h.mode === 'undated' ? '<div class="small muted">Not charted — counts toward lifetime only.</div>'
      : h.window ? `<div class="small">Estimated <b>${fmtDate(h.window[0], { year: 'numeric', month: 'short', day: 'numeric' })} – ${fmtDate(h.window[1], { year: 'numeric', month: 'short', day: 'numeric' })}</b> · <span class="conf-${conf}">${conf} confidence</span>${h.undated ? ` · ${fmtMin(h.undated)} undated` : ''}</div>`
      : `<div class="small muted">No dates known — counts toward lifetime only.${e.platform === 'steam' && !h.enriched ? ' Looking up achievement times…' : ''}</div>`}
    ${(h.reasons || []).length ? `<div class="tiny muted">${h.reasons.map(esc).join(' · ')}</div>` : ''}
    ${chips.length ? `<div class="evidence">${chips.map(([k, v]) => `<span class="badge">${k}: ${esc(v)}</span>`).join('')}</div>` : ''}
    <div class="row wrap">${h.window && !h.manual && h.mode !== 'undated' && conf !== 'high' ? `<button class="btn sm" data-hist-confirm="${e.id}">${icon('check')}Looks right</button>` : ''}<button class="btn sm" data-hist-edit="${e.id}">${icon('edit')}Set dates</button>
      ${h.mode === 'undated' ? `<button class="btn sm ghost" data-hist-mode="auto" data-entry="${e.id}">Chart it</button>` : `<button class="btn sm ghost" data-hist-mode="undated" data-entry="${e.id}">Don’t chart</button>`}
      ${h.manual || h.mode === 'undated' ? `<button class="btn sm ghost" data-hist-reset="${e.id}">Reset to automatic</button>` : ''}</div>
  </div>`;
}

function historyModal(e, onDone) {
  const h = e.history;
  const d = (t) => (t ? new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10) : '');
  modal({
    title: 'When did you play this?',
    body: `<p class="small muted" style="margin-top:0">${fmtMin(h.minutes)} on ${esc(plat(e.platform).label)} happened before tracking began. Set the period you played it and the hours are re-spread across it.</p>
      <div class="grid grid-2"><div class="field"><label>Started playing</label><input class="input" type="date" name="s" value="${d(h.manual?.start || h.window?.[0])}"></div>
      <div class="field"><label>Last played</label><input class="input" type="date" name="e" value="${d(h.manual?.end || h.window?.[1])}"></div></div>`,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="h-save">Save</button>',
    onMount(el, close) {
      el.querySelector('#h-save').addEventListener('click', async () => {
        const s = el.querySelector('[name=s]').value; const en = el.querySelector('[name=e]').value;
        try {
          await api(`/entries/${e.id}/history`, { method: 'PATCH', body: { first_played_at: s ? `${s}T12:00:00` : null, last_played_at: en ? `${en}T20:00:00` : null, mode: 'auto' } });
          close(); toast('History re-dated'); onDone();
        } catch (err) { fail(err); }
      });
    },
  });
}

function mergeModal(g) {
  modal({
    title: `Merge into “${esc(g.title)}”`,
    body: `<p class="small muted" style="margin-top:0">Pick games that are really the same title (e.g. PS4 + PS5 versions, Steam + Game Pass). Their platforms and sessions move here.</p>
      <div class="search">${icon('search')}<input class="input" id="mq" aria-label="Search games" placeholder="Search games" value="${esc(g.title.split(/[:\-–]/)[0].trim())}"></div><div class="list" id="mr" style="margin-top:10px"></div>`,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="m-go" disabled>Merge</button>',
    onMount(el, close) {
      const picked = new Set();
      const search = async () => {
        const r = await api(`/games?q=${encodeURIComponent(el.querySelector('#mq').value)}&limit=30&hidden=all`);
        el.querySelector('#mr').innerHTML = r.items.filter((x) => x.id !== g.id).map((x) => `<label class="item" style="cursor:pointer"><input type="checkbox" class="check" value="${x.id}" ${picked.has(x.id) ? 'checked' : ''}>${cover(x)}<div class="grow"><div class="ttl ellipsis">${esc(x.title)}</div><div class="sub">${x.platforms.map(platDot).join('')} ${fmtMin(x.minutes)}</div></div></label>`).join('') || '<p class="muted">No other games match.</p>';
      };
      let t;
      el.querySelector('#mq').addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 180); });
      el.querySelector('#mr').addEventListener('change', (e) => { const v = Number(e.target.value); e.target.checked ? picked.add(v) : picked.delete(v); el.querySelector('#m-go').disabled = !picked.size; el.querySelector('#m-go').textContent = picked.size ? `Merge ${picked.size}` : 'Merge'; });
      el.querySelector('#m-go').addEventListener('click', async () => { try { await api(`/games/${g.id}/merge`, { method: 'POST', body: { source_ids: [...picked] } }); close(); toast('Merged'); rerender(); } catch (e) { fail(e); } });
      search();
    },
  });
}

// =====================================================================
// Sessions
// =====================================================================
const PERIODS_S = [['today', 'Today', 'Today'], ['week', 'This week', 'Week'], ['month', 'This month', 'Month'], ['custom', 'Custom', 'Custom'], ['all', 'All', 'All']];
const ymd = (t) => dayKey(t);
/** A period's from / to days (YYYY-MM-DD, local), the week starting on the day set in Settings. */
function periodRange(p, custom = {}) {
  const today = new Date(); today.setHours(12, 0, 0, 0);
  if (p === 'today') return { from: ymd(today), to: ymd(today) };
  if (p === 'week') {
    const back = (today.getDay() - (state.settings?.week_starts_on ?? 1) + 7) % 7;
    return { from: ymd(today.getTime() - back * D), to: ymd(today) };
  }
  if (p === 'month') return { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1, 12)), to: ymd(today) };
  if (p === 'custom') return { from: custom.from || '', to: custom.to || '' };
  return { from: '', to: '' };
}
/** The first day of t's week (as a day timestamp), weeks starting on the day set in Settings. */
function weekOf(t) {
  const d = new Date(t); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - (state.settings?.week_starts_on ?? 1) + 7) % 7));
  return d.getTime();
}

async function sessions(view, stale) {
  const q0 = new URLSearchParams(location.search);
  const f = {
    platform: '', source: '', q: '', kind: 'play', game_id: q0.get('game_id') || '',
    period: PERIODS_S.some(([k]) => k === q0.get('period')) ? q0.get('period') : 'all', from: q0.get('from') || '', to: q0.get('to') || '',
  };
  if ((f.from || f.to) && !q0.get('period')) f.period = 'custom';
  let cursor = null; let all = []; let total = 0; let totalMin = 0; let selecting = false; let lastPick = null; const sel = new Set();
  const lt = await api('/stats/lifetime');
  if (stale()) return;
  const chip = (attr, value, label, title = '') => `<button class="chip" ${attr}="${value}"${title ? ` title="${title}"` : ''}>${label}</button>`;
  view.innerHTML = `
    <div class="page-h"><div><h1>Sessions</h1><p id="s-count" aria-live="polite">&nbsp;</p></div>
      <div class="row"><button class="btn" id="s-select">${icon('check')}Select</button><button class="btn primary desk-only" id="s-log">${icon('plus')}Log session</button></div></div>
    <div class="toolbar">
      <div class="row wrap s-row1">
        <div class="search grow">${icon('search')}<input class="input" id="s-q" type="search" placeholder="Filter by game" aria-label="Filter sessions by game"></div>
        <select class="input mob-only" id="s-period-sel" aria-label="Period" style="width:auto">${PERIODS_S.map(([k, l]) => `<option value="${k}" ${f.period === k ? 'selected' : ''}>${l}</option>`).join('')}</select><div class="seg desk-only" id="s-period" aria-label="Period">${PERIODS_S.map(([k, l, sh]) => `<button data-period="${k}" class="${f.period === k ? 'on' : ''}"><span class="lg">${l}</span><span class="sm">${sh}</span></button>`).join('')}</div>
      </div>
      <div class="row wrap s-custom ${f.period === 'custom' ? '' : 'hide'}" id="s-custom">
        <label class="small row" style="gap:6px">From <input class="input sm" type="date" id="s-from" value="${esc(f.from)}"></label>
        <label class="small row" style="gap:6px">To <input class="input sm" type="date" id="s-to" value="${esc(f.to)}"></label>
      </div>
      <div class="chips" id="s-chips" role="group" aria-label="Filters">
        <button class="chip on" data-p="">All platforms</button>
        ${lt.platforms.map((p) => `<button class="chip" data-p="${esc(p.platform)}">${platDot(p.platform)}${esc(plat(p.platform).label)}</button>`).join('')}
        <span class="chip-sep" aria-hidden="true"></span>
        ${chip('data-src', 'manual', 'Logged by me')}${chip('data-src', 'sync', 'From platforms')}${chip('data-src', 'import', 'Imported')}
        ${chip('data-kind', 'baseline', 'Pre-tracking history', 'Playtime filed as history: it counts toward lifetime, not in stats')}
      </div>
    </div>
    <div id="s-bulk" class="card bulk-bar hide"><div class="row wrap"><b id="s-bulk-n">0 selected</b><span class="tiny muted desk-only">Shift-click to select a range</span><span class="grow"></span>
      <button class="btn sm" data-bulk="baseline" title="Still counts toward lifetime">Exclude from stats</button><button class="btn sm" data-bulk="play" title="Counts toward lifetime either way">Include in stats</button><button class="btn sm danger" data-bulk="delete">${icon('trash')}Delete</button><button class="btn sm ghost" id="s-bulk-x">Done</button></div></div>
    <div class="card" style="padding-top:0"><div class="list" id="s-list"></div><div id="s-more" class="center" style="padding:14px"></div></div>
    <button class="fab" id="fab-log" aria-label="Log session">${icon('plus')}</button>`;
  const list = $('#s-list');
  const dayMin = new Map(); // minutes shown in each day header
  const weeks = new Map(); // week -> { minutes, n } shown in its subtotal row
  const range = () => periodRange(f.period, f);
  // a week subtotal row ahead of each week, once the period is longer than a week
  const spansWeeks = () => { const r = range(); return !r.from || !r.to || (new Date(`${r.to}T12:00`) - new Date(`${r.from}T12:00`)) / D >= 7; };
  const weekText = (w) => `Week of ${fmtDate(w)} · ${plural(weeks.get(w).n, 'session')} · ${fmtMin(weeks.get(w).minutes)}`;
  const dayHead = (grp) => `<div class="day-h" data-day="${grp.day}">${selecting ? `<input type="checkbox" class="check" data-day-sel="${grp.day}" aria-label="Select every session of ${esc(dayLabel(grp.day))}">` : ''}<span class="grow">${dayLabel(grp.day)}</span><span>${fmtMin(grp.minutes)}</span></div>`;
  const rows = (items) => items.map((s) => sessionItem(s, { selectable: selecting, selected: sel.has(s.id) })).join('');
  const html = (groups) => {
    let out = '';
    for (const grp of groups) {
      const w = weekOf(grp.day);
      if (spansWeeks() && !list.querySelector(`.week-h[data-week="${w}"]`) && !out.includes(`data-week="${w}"`)) out += `<div class="week-h" data-week="${w}">${weekText(w)}</div>`;
      out += dayHead(grp) + rows(grp.items);
    }
    return out;
  };
  const count = (items) => { for (const s of items) { const w = weekOf(s.ended_at || s.window_end || s.created_at); const x = weeks.get(w) || { minutes: 0, n: 0 }; x.minutes += s.minutes; x.n++; weeks.set(w, x); } };
  const draw = () => {
    const groups = groupByDay(all);
    dayMin.clear(); weeks.clear(); count(all);
    for (const grp of groups) dayMin.set(grp.day, grp.minutes);
    list.innerHTML = '';
    list.innerHTML = all.length ? html(groups)
      : f.kind === 'baseline' ? emptyState('history', 'No pre-tracking history', 'Playtime from before tracking began, and sessions you exclude from stats, show up here.')
        : f.period !== 'all' || f.q || f.platform || f.source ? emptyState('sessions', 'No sessions in this view', 'Nothing matches this period and these filters.', '<button class="btn" data-s-reset>Show all sessions</button>')
          : emptyState('sessions', 'No sessions yet', 'They appear after a sync spots new playtime — or log one yourself.', `<button class="btn primary" data-s-log>${icon('plus')}Log session</button>`);
    drawFoot();
  };
  // the next page is appended, not redrawn: the cost stays flat at thousands of rows
  const drawMore = (items) => {
    count(items);
    for (const w of new Set(items.map((s) => weekOf(s.ended_at || s.window_end || s.created_at)))) { const h = list.querySelector(`.week-h[data-week="${w}"]`); if (h) h.textContent = weekText(w); }
    for (const grp of groupByDay(items)) {
      const head = dayMin.has(grp.day) && list.querySelector(`.day-h[data-day="${grp.day}"]`); // the last day continues
      dayMin.set(grp.day, (dayMin.get(grp.day) || 0) + grp.minutes);
      if (head) { head.lastElementChild.textContent = fmtMin(dayMin.get(grp.day)); list.insertAdjacentHTML('beforeend', rows(grp.items)); } else list.insertAdjacentHTML('beforeend', html([grp]));
    }
    drawFoot();
  };
  const periodName = () => {
    if (f.period === 'custom') { const r = range(); return r.from || r.to ? `${r.from ? fmtDate(new Date(`${r.from}T12:00`)) : '…'} – ${r.to ? fmtDate(new Date(`${r.to}T12:00`)) : 'today'}` : 'All time'; }
    return PERIODS_S.find(([k]) => k === f.period)[1].replace(/^All$/, 'All time');
  };
  const drawFoot = () => {
    $('#s-more').innerHTML = cursor && all.length < total ? '<span class="tiny dim">Loading more…</span>' : (all.length > 20 ? '<span class="tiny dim">That’s everything</span>' : '');
    $('#s-count').innerHTML = `${esc(periodName())} · ${plural(total, 'session')} · ${fmtMin(totalMin, { short: totalMin >= 6000 })}${f.game_id && all[0] ? ` · ${esc(all[0].title)} <a href="/sessions" data-link class="link">show all games</a>` : ''}`;
    $('#s-bulk-n').textContent = `${sel.size} selected`;
    // after the new rows have painted: a short list asks for the next page at once
    requestAnimationFrame(() => setTimeout(checkMore));
  };
  let seq = 0; let loading = false;
  const load = async (reset = true) => {
    // only the latest request may draw (fast filter clicks / typing overlap)
    const my = ++seq;
    const p = new URLSearchParams({ limit: '150', kind: f.kind });
    if (!reset && cursor) p.set('before', cursor);
    const r0 = range();
    if (r0.from) p.set('from', r0.from);
    if (r0.to) p.set('to', r0.to);
    if (f.platform) p.set('platform', f.platform);
    if (f.source) p.set('source', f.source);
    if (f.q) p.set('q', f.q);
    if (f.game_id) p.set('game_id', f.game_id);
    loading = true;
    let r;
    try { r = await api(`/sessions?${p}`); } finally { if (my === seq) loading = false; }
    if (my !== seq || stale()) return;
    const more = !reset && all.length;
    all = (reset ? [] : all).concat(r.items); total = r.total; totalMin = r.total_minutes; cursor = r.next;
    if (more) drawMore(r.items); else draw();
  };
  // the next page loads as the end of the list comes near
  const checkMore = () => {
    const el = $('#s-more');
    if (!loading && cursor && all.length < total && el && !view.hidden && el.getBoundingClientRect().top < innerHeight + 600) load(false);
  };
  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) checkMore(); }, { rootMargin: '600px' });
  io.observe($('#s-more'));
  const syncUrl = () => {
    const p = new URLSearchParams();
    if (f.game_id) p.set('game_id', f.game_id);
    if (f.period !== 'all') p.set('period', f.period);
    if (f.period === 'custom') { if (f.from) p.set('from', f.from); if (f.to) p.set('to', f.to); }
    history.replaceState({}, '', `/sessions${p.toString() ? `?${p}` : ''}`);
  };
  let t;
  $('#s-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 200); });
  // a segment on wide screens, a select on a phone; both stay in step
  const setPeriod = (k) => {
    f.period = k;
    $$('#s-period button').forEach((x) => x.classList.toggle('on', x.dataset.period === k));
    $('#s-period-sel').value = k;
    $('#s-custom').classList.toggle('hide', f.period !== 'custom');
    if (f.period === 'custom' && !f.from && !f.to) { const w = periodRange('month'); f.from = w.from; f.to = w.to; $('#s-from').value = f.from; $('#s-to').value = f.to; }
    syncUrl(); load();
  };
  $('#s-period').addEventListener('click', (e) => { const b = e.target.closest('[data-period]'); if (b) setPeriod(b.dataset.period); });
  $('#s-period-sel').addEventListener('change', (e) => setPeriod(e.target.value));
  for (const [id, k] of [['#s-from', 'from'], ['#s-to', 'to']]) $(id).addEventListener('change', (e) => { f[k] = e.target.value; syncUrl(); load(); });
  $('#s-chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    if ('p' in c.dataset) { f.platform = c.dataset.p; $$('[data-p]', view).forEach((x) => x.classList.toggle('on', x === c)); }
    if (c.dataset.src) { f.source = f.source === c.dataset.src ? '' : c.dataset.src; $$('[data-src]', view).forEach((x) => x.classList.toggle('on', x.dataset.src === f.source)); }
    if (c.dataset.kind) { f.kind = f.kind === 'baseline' ? 'play' : 'baseline'; c.classList.toggle('on', f.kind === 'baseline'); }
    load();
  });
  view.addEventListener('click', (e) => {
    if (e.target.closest('[data-s-log]')) logSessionModal(null, () => load());
    if (e.target.closest('[data-s-reset]')) {
      Object.assign(f, { q: '', platform: '', source: '' });
      $('#s-q').value = '';
      $$('#s-chips .chip').forEach((x) => x.classList.toggle('on', x.dataset.p === '' || (x.dataset.kind && f.kind === 'baseline')));
      setPeriod('all');
    }
  });
  const toggleSelect = (on) => { selecting = on; sel.clear(); lastPick = null; $('#s-bulk').classList.toggle('hide', !on); draw(); };
  $('#s-select').addEventListener('click', () => toggleSelect(!selecting));
  $('#s-bulk-x').addEventListener('click', () => toggleSelect(false));
  const mark = (id, on) => {
    if (on) sel.add(id); else sel.delete(id);
    const box = list.querySelector(`[data-sel="${id}"]`);
    if (box) { box.checked = on; box.closest('.item').classList.toggle('sel', on); }
  };
  const dayBoxes = () => list.querySelectorAll('[data-day-sel]').forEach((b) => {
    const ids = all.filter((s) => groupByDay([s])[0].day === Number(b.dataset.daySel)).map((s) => s.id);
    b.checked = ids.length > 0 && ids.every((x) => sel.has(x));
    b.indeterminate = !b.checked && ids.some((x) => sel.has(x));
  });
  // shift-click: everything between the last ticked row and this one takes this one's state
  list.addEventListener('click', (e) => {
    const box = e.target.closest('[data-sel]');
    if (!box) return;
    const id = Number(box.dataset.sel);
    if (e.shiftKey && lastPick != null) {
      const ids = all.map((s) => s.id);
      const [a, b] = [ids.indexOf(lastPick), ids.indexOf(id)].sort((x, y) => x - y);
      if (a >= 0 && b >= 0) for (const x of ids.slice(a, b + 1)) mark(x, box.checked);
    }
    lastPick = id;
  });
  list.addEventListener('change', (e) => {
    const day = e.target.dataset.daySel;
    if (day) {
      for (const s of all) if (groupByDay([s])[0].day === Number(day)) mark(s.id, e.target.checked);
    } else {
      const id = Number(e.target.dataset.sel); if (!id) return;
      mark(id, e.target.checked);
    }
    dayBoxes();
    $('#s-bulk-n').textContent = `${sel.size} selected`;
  });
  $('#s-bulk').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-bulk]'); if (!b || !sel.size) return;
    const action = b.dataset.bulk;
    const ids = [...sel];
    const picked = all.filter((x) => sel.has(x.id));
    const n = plural(ids.length, 'session');
    // undo: a move to or from history by the opposite move; a delete by logging manual sessions again
    // and counting synced ones again. Imported sessions cannot come back the same, so deleting them asks first.
    const restorable = picked.every((x) => x.source === 'manual' || (x.source === 'sync' && x.kind === 'play'));
    if (action === 'delete' && !restorable && !(await confirmBox(`Delete ${n}? Synced sessions are moved to history instead, since their playtime comes from the platform. Imported sessions cannot be restored.`, { ok: 'Delete', danger: true, title: `Delete ${n}?` }))) return;
    try {
      await api('/sessions/bulk', { method: 'POST', body: { ids, action } });
      toggleSelect(false); load();
      if (action === 'delete') {
        const msg = picked.some((x) => x.source !== 'manual') ? `Removed ${n}` : `Deleted ${n}`;
        if (!restorable) return toast(msg);
        undoToast(msg, async () => {
          for (const x of picked) {
            if (x.source === 'manual') await restoreSession(x);
            else await api(`/sessions/${x.id}`, { method: 'PATCH', body: { kind: 'play', note: x.note || '' } });
          }
        }, () => load());
      } else {
        const from = action === 'baseline' ? 'play' : 'baseline';
        const msg = action === 'baseline' ? `Excluded ${n} from stats` : `Included ${n} in stats`;
        if (picked.every((x) => x.kind === from)) undoToast(msg, () => api('/sessions/bulk', { method: 'POST', body: { ids, action: from } }), () => load());
        else toast(msg);
      }
    } catch (err) { fail(err); }
  });
  bindSessionEdits(view, () => load());
  $('#s-log').addEventListener('click', () => logSessionModal(null, () => load()));
  $('#fab-log').addEventListener('click', () => logSessionModal(null, () => load()));
  await load();
}

// =====================================================================
// Stats
// =====================================================================
async function stats(view, stale) {
  const q = new URLSearchParams(location.search);
  let range = q.get('range') || '30d';
  let platform = q.get('platform') || '';
  let estimates = q.get('estimates') || state.settings?.stats_estimates || 'include';
  const [years, lt] = await Promise.all([api('/stats/years'), api('/stats/lifetime')]);
  if (stale()) return;
  let heatYear = years[0];
  if (!lt.total_minutes) {
    // nothing played at all: no zero KPIs or blank charts
    view.innerHTML = `<div class="page-h"><div><h1>Stats</h1><p>Playtime, sessions and streaks, once there is play to count.</p></div></div>
      <div class="card">${emptyState('stats', 'No play to chart yet', lt.games ? 'Your library is in, but nothing has been played or dated yet. Sessions appear after a sync spots new playtime — or log one yourself.' : 'Connect Steam, Xbox or PlayStation and Vestigo picks up your library — and every hour you’ve already played.', `${lt.games ? '' : `<a class="btn primary" href="/accounts?add=1" data-link>${icon('plus')}Connect an account</a>`}<button class="btn${lt.games ? ' primary' : ''}" id="st-log">${icon('clock')}Log a session</button>`)}</div>`;
    $('#st-log').addEventListener('click', () => logSessionModal());
    return;
  }
  view.innerHTML = `
    <div class="page-h"><div><h1>Stats</h1><p title="Tracked = observed between syncs. Estimated = playtime from before tracking, dated from first/last played, achievements and release dates. Undated = no dates available (lifetime only).">Lifetime ${fmtHours(lt.total_minutes)}h · ${fmtHours(lt.tracked_minutes)}h tracked · ${fmtHours(lt.estimated_minutes || 0)}h estimated history · ${fmtHours(lt.baseline_minutes)}h undated</p></div>
      <div class="row wrap"><a class="btn" href="/insights" data-link>${icon('insights')}Insights</a><a class="btn" href="/wrapped/${years[0]}" data-link>${icon('trail')}${years[0]} in review</a></div></div>
    <div class="toolbar"><div class="row wrap">
      <div class="row" style="gap:8px">
        <div class="seg" id="st-range" aria-label="Range">${[['7d', '7 days', '7d'], ['30d', '30 days', '30d'], ['90d', '90 days', '90d'], ['365d', '12 months', '12m']].map(([v, l, sh]) => `<button data-r="${v}" class="${range === v ? 'on' : ''}" title="Last ${l}"><span class="lg">${l}</span><span class="sm">${sh}</span></button>`).join('')}</div>
        <select class="input" id="st-year" aria-label="Year" style="width:auto"><option value="">Year…</option>${[...years.map((y) => [`year:${y}`, String(y)]), ['all', 'All time']].map(([v, l]) => `<option value="${v}" ${range === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <label class="row small" style="gap:8px;cursor:pointer" title="Include playtime from before tracking began, dated by inference (hatched in charts)"><span class="switch"><input type="checkbox" id="st-est" ${estimates !== 'exclude' ? 'checked' : ''}><span></span></span>Estimated history</label>
      <select class="input" id="st-plat" style="width:auto" aria-label="Platform"><option value="">All platforms</option>${lt.platforms.map((p) => `<option value="${esc(p.platform)}" ${platform === p.platform ? 'selected' : ''}>${esc(plat(p.platform).label)}</option>`).join('')}</select>
    </div></div>
    <div id="st-body"></div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Activity</h2><div class="seg" id="hm-year" aria-label="Activity year">${years.map((y) => `<button data-y="${y}" class="${y === heatYear ? 'on' : ''}">${y}</button>`).join('')}</div></div><div id="hm"></div></div>`;
  const body = $('#st-body');
  const load = async () => {
    const p = new URLSearchParams({ range, estimates });
    if (platform) p.set('platform', platform);
    history.replaceState({}, '', `/stats?${p}`);
    const s = await api(`/stats?${p}`);
    const maxWd = Math.max(1, ...s.weekday);
    const order = [1, 2, 3, 4, 5, 6, 0];
    const hasHours = s.hours.some((h) => h > 0);
    if (!s.total_minutes) {
      body.innerHTML = `<div class="card">${emptyState('stats', 'Nothing played in this range', `${esc(s.range.label)}${platform ? ` on ${esc(plat(platform).label)}` : ''}${estimates === 'exclude' ? ', tracked play only' : ''}: no sessions and no dated history.`, `<button class="btn" data-r-all>Show all time</button><button class="btn" data-st-log>${icon('clock')}Log a session</button>`)}</div>`;
      body.querySelector('[data-r-all]').addEventListener('click', () => { range = 'all'; $$('#st-range button').forEach((x) => x.classList.remove('on')); $('#st-year').value = 'all'; load(); });
      body.querySelector('[data-st-log]').addEventListener('click', () => logSessionModal());
      return;
    }
    body.innerHTML = `
      <div class="kpis fade-in">
        ${kpi('Played', hoursVal(s.total_minutes), s.estimated_minutes ? `${fmtHours(s.tracked_minutes)}h tracked + ${fmtHours(s.estimated_minutes)}h estimated` : s.range.label, sparkline(s.series.map((x) => x.minutes)), 'feature')}
        ${kpi('Sessions', s.sessions, `avg ${fmtMin(s.avg_session_minutes)}`)}
        ${kpi('Games', s.games_played, `${s.days_played} days played`)}
        ${kpi('Daily avg', fmtMin(s.avg_per_day_minutes), s.busiest_day ? `best ${fmtDate(new Date(`${s.busiest_day.day}T12:00`).getTime())} · ${fmtMin(s.busiest_day.minutes)}` : '')}
        ${kpi('Streak', `${s.streaks.current}<small>d</small>`, `longest ${s.streaks.longest} days`)}
      </div>
      <div class="card" style="margin-top:16px"><div class="card-h"><h2>Playtime per ${s.range.group}</h2></div>${barChart(stackedSeries(s), { size: 'page', title: `Playtime per ${s.range.group}, ${s.range.label.toLowerCase()}` })}${platformLegend(s.platforms, estimatedLegend(s))}</div>
      <div class="grid grid-3" style="margin-top:16px">
        <div class="card"><div class="card-h"><h2>Top games</h2></div>${s.top_games.length ? topList(s.top_games, { coverFn: (g) => cover(g), limit: 10 }) : '<p class="muted">No play in this range.</p>'}</div>
        <div class="card"><div class="card-h"><h2>Platforms</h2></div>
          ${s.platforms.length ? `<div class="donut-wrap">${donut(s.platforms.map((p) => ({ label: plat(p.platform).label, value: p.minutes, color: plat(p.platform).color })), { label: `${fmtHours(s.total_minutes)}h`, sub: 'played', title: 'Playtime by platform' })}
          <div class="col" style="gap:8px;min-width:0">${s.platforms.map((p) => `<div class="row small"><span class="dot" style="background:${plat(p.platform).color}"></span><span class="grow ellipsis">${esc(plat(p.platform).label)}</span><b>${Math.round((p.minutes / Math.max(1, s.total_minutes)) * 100)}%</b></div>`).join('')}</div></div>` : '<p class="muted">—</p>'}
          ${s.longest_session ? `<div style="margin-top:18px" class="small muted">Longest session</div><a href="/game/${s.longest_session.game_id}" data-link><b>${fmtMin(s.longest_session.minutes)}</b> · ${esc(s.longest_session.title)}</a>` : ''}
        </div>
        <div class="card"><div class="card-h"><h2>By weekday</h2></div>
          ${order.map((d) => `<div class="row small" style="margin:7px 0"><span style="width:34px" class="muted">${WD[d]}</span><div class="grow" style="height:8px;border-radius:9px;background:var(--bg2);overflow:hidden"><i style="display:block;height:100%;width:${(s.weekday[d] / maxWd) * 100}%;background:var(--accent2);border-radius:9px"></i></div><span style="width:56px;text-align:right">${fmtMin(s.weekday[d], { short: true })}</span></div>`).join('')}
          ${hasHours ? `<div class="card-h" style="margin-top:18px;margin-bottom:6px"><h3>Time of day</h3><span class="tiny dim">exact sessions only</span></div>${barChart(s.hours.map((m, h) => ({ label: h % 6 === 0 ? hourLabel(h) : '', name: `${h}:00`, value: m, tip: `${h}:00 – ${h + 1}:00: ${fmtMin(m)}` })), { size: 'small', color: 'var(--accent2)', labelEvery: 1, maxBar: 14, title: 'Exact sessions by time of day' })}` : '<p class="tiny dim" style="margin-top:14px">Sync more often (or log sessions manually) to unlock time-of-day stats.</p>'}
        </div>
      </div>`;
    mountCharts(body);
  };
  const loadHeat = async () => {
    const h = await api(`/stats/heatmap?year=${heatYear}&estimates=${estimates}`);
    $('#hm').innerHTML = heatmap(heatYear, h.days, { weekStartsOn: state.settings?.week_starts_on ?? 1, estimated: h.estimated_days || {} });
    mountCharts($('#hm'));
  };
  $('#st-range').addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (!b) return; range = b.dataset.r; $$('#st-range button').forEach((x) => x.classList.toggle('on', x === b)); $('#st-year').value = ''; load(); });
  $('#st-year').addEventListener('change', (e) => { if (!e.target.value) return; range = e.target.value; $$('#st-range button').forEach((x) => x.classList.remove('on')); load(); });
  $('#st-plat').addEventListener('change', (e) => { platform = e.target.value; load(); });
  $('#st-est').addEventListener('change', (e) => { estimates = e.target.checked ? 'include' : 'exclude'; load(); loadHeat(); });
  $('#hm-year').addEventListener('click', (e) => { const b = e.target.closest('[data-y]'); if (!b) return; heatYear = Number(b.dataset.y); $$('#hm-year button').forEach((x) => x.classList.toggle('on', x === b)); loadHeat(); });
  await Promise.all([load(), loadHeat()]);
}

async function wrapped(view, year, stale) {
  const est = new URLSearchParams(location.search).get('estimates') === 'exclude' ? 'exclude' : 'include';
  const y = Number(year);
  const opt = (u) => api(u).catch(() => null);
  const [w, years, ach, tl, pc, rec] = await Promise.all([
    api(`/stats/year/${y}?estimates=${est}`), opt('/stats/years'),
    opt(`/stats/achievements?range=year:${y}&limit=5`), opt(`/stats/timeline?range=year:${y}&group=month&estimates=${est}`),
    opt(`/stats/punchcard?range=year:${y}`), opt(`/stats/records?range=year:${y}&estimates=${est}`),
  ]);
  if (stale()) return;
  const ys = (years || [y]).slice().sort((a, b) => a - b);
  const i = ys.indexOf(y);
  const prev = i > 0 ? ys[i - 1] : i < 0 ? ys.filter((x) => x < y).pop() : null;
  const next = i >= 0 && i < ys.length - 1 ? ys[i + 1] : i < 0 ? ys.find((x) => x > y) : null;
  const q = est === 'exclude' ? '?estimates=exclude' : '';
  const step = (to, dir) => (to ? `<a class="btn icon ghost" href="/wrapped/${to}${q}" data-link aria-label="${to} in review" title="${to}">${icon(dir === 'prev' ? 'back' : 'chevR')}</a>` : `<span class="btn icon ghost" aria-hidden="true" style="visibility:hidden">${icon('back')}</span>`);
  const top = w.top_games[0];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const months12 = MONTHS.map((m) => w.months.find((x) => x.month === m) || { month: m, minutes: 0 }); // the year so far: the rest are empty
  const maxM = Math.max(1, ...months12.map((m) => m.minutes));
  const L = rec?.longest_session || null;
  const busyDay = pc?.busiest_weekday;
  const tod = rec?.highlights?.find((h) => h.id === 'time_of_day');
  const parts = [w.tracked_minutes && `${fmtHours(w.tracked_minutes)}h tracked`, w.estimated_minutes && `${fmtHours(w.estimated_minutes)}h estimated history`].filter(Boolean);
  const rarest = ach?.rarest?.[0];
  const head = `<div class="wr-top"><a href="/stats" data-link class="btn ghost sm" onclick="if(history.length>1){event.preventDefault();event.stopPropagation();history.back()}">${icon('back')}Back</a></div>
    <div class="wr-head">
      <span class="brand-mark wr-mark">${MARK}</span>
      <div class="grow"><h1>Your ${y} trail</h1>
        <p>${w.total_minutes ? `The trail you left in ${y}: <b>${fmtHours(w.total_minutes)}h</b>${parts.length > 1 ? ` · ${parts.join(' + ')}` : parts.length ? ` · ${parts[0]}` : ''}.` : `Nothing recorded for ${y} yet.`}</p></div>
      <div class="wr-ctl">
        <nav class="row wr-years" aria-label="Year">${step(prev, 'prev')}<span class="wr-y" aria-current="page">${y}</span>${step(next, 'next')}</nav>
        <label class="row small" style="gap:8px;cursor:pointer" title="Playtime from before tracking began, dated by inference"><span class="switch"><input type="checkbox" id="wr-est" ${est === 'include' ? 'checked' : ''}><span></span></span>Estimated history</label>
      </div>
    </div>`;
  if (!w.total_minutes) {
    view.innerHTML = `<div class="wr">${head}<div class="card">${emptyState('trail', `No tracks in ${y}`, est === 'exclude' ? `No tracked play in ${y}. Turn estimated history on to see play dated from before tracking began.` : `Nothing is dated in ${y} — neither tracked sessions nor history from before tracking. Dating old playtime can fill the trail in.`, `<a class="btn primary" href="/history" data-link>${icon('history')}Improve history</a>`)}</div></div>`;
    bindWrapped();
    return;
  }
  const L1 = (m) => new Date(2024, ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m), 15);
  view.innerHTML = `<div class="wr">${head}
    <div class="wrapped fade-in">
      <div class="wcard g1"><div class="muted">You played</div><div class="big">${fmtHours(w.total_minutes)} hours</div><div class="muted">${w.sessions ? `across ${plural(w.sessions, 'tracked session')} on ${plural(w.days_played, 'day')}` : 'before tracking began'}${w.estimated_minutes ? ` · ${fmtHours(w.estimated_minutes)}h estimated from your history` : ''}</div></div>
      ${top ? `<a class="wcard g2" href="/game/${top.game_id}" data-link style="display:flex;gap:16px;align-items:center">${cover(top, '', 'width:90px;')}<div style="min-width:0"><div class="muted">Game of the year</div><div class="wr-gotm">${esc(top.title)}</div><div class="muted">${fmtMin(top.minutes)}${top.sessions ? ` · ${plural(top.sessions, 'session')}` : ''}</div></div></a>` : ''}
      <div class="wcard g3"><div class="muted">Longest streak</div><div class="big">${plural(w.longest_streak, 'day')}</div><div class="muted">${w.busiest_day ? `Biggest day: ${fmtDate(new Date(`${w.busiest_day.day}T12:00`).getTime(), { month: 'long', day: 'numeric' })} (${fmtMin(w.busiest_day.minutes)})` : ''}</div></div>
      <div class="wcard"><div class="muted">Games played</div><div class="big">${w.games_played}</div><div class="muted">${w.new_games} started fresh this year · ${w.completed} completed</div></div>
      <div class="wcard"><div class="muted">Best month</div><div class="big">${w.best_month ? L1(w.best_month.month).toLocaleDateString(undefined, { month: 'long' }) : '—'}</div><div class="muted">${w.best_month ? fmtMin(w.best_month.minutes) : ''}</div>
        <div class="wr-months" aria-hidden="true">${months12.map((m) => `<div title="${m.month}: ${fmtMin(m.minutes)}"><i style="height:${m.minutes ? Math.max(4, (m.minutes / maxM) * 46) : 0}px" class="${m.month === w.best_month?.month ? 'best' : ''}"></i><span>${L1(m.month).toLocaleDateString(undefined, { month: 'narrow' })}</span></div>`).join('')}</div></div>
      <div class="wcard"><div class="muted">Favourite time</div><div class="big wr-mid">${busyDay ? `${dayName(busyDay.weekday, 'long')}s` : ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][w.weekday.indexOf(Math.max(...w.weekday))]}</div><div class="muted">${tod ? `${tod.value}% of timed play in the ${esc(tod.part)} (${hourLabel(tod.from_hour)}–${hourLabel(tod.to_hour % 24)})` : pc?.busiest_hour ? `Busiest hour ${hourLabel(pc.busiest_hour.hour)}–${hourLabel((pc.busiest_hour.hour + 1) % 24)}` : 'No sessions with exact times this year'}</div></div>
      ${L ? `<a class="wcard" href="/game/${L.game_id}" data-link><div class="muted">Longest session</div><div class="big">${fmtMin(L.minutes)}</div><div class="muted">${esc(L.title)} · ${fmtDate(new Date(`${L.day}T12:00`).getTime(), { month: 'long', day: 'numeric' })}</div></a>` : ''}
      ${w.platforms?.length ? `<div class="wcard"><div class="muted">Played on</div><div class="big wr-mid">${esc(plat(w.platforms[0].platform).label)}</div><div class="muted">${Math.round((w.platforms[0].minutes / Math.max(1, w.total_minutes)) * 100)}% of the year</div>
        <div class="split-bar" style="margin-top:14px" aria-hidden="true">${w.platforms.map((p) => `<i style="width:${(p.minutes / Math.max(1, w.total_minutes)) * 100}%;background:${plat(p.platform).color}"></i>`).join('')}</div>
        <div class="legend">${w.platforms.slice(0, 4).map((p) => `<span><i class="dot" style="background:${plat(p.platform).color}"></i>${esc(plat(p.platform).label)} ${fmtHours(p.minutes)}h</span>`).join('')}</div></div>` : ''}
      ${ach && (ach.unlocked || ach.completed_count) ? `<div class="wcard wr-ach"><div class="muted">Achievements</div><div class="big">${ach.unlocked.toLocaleString()}</div><div class="muted">unlocked${ach.points ? ` · ${ach.points.toLocaleString()}G` : ''}${ach.grades?.platinum ? ` · ${plural(ach.grades.platinum, 'platinum')}` : ''} · ${plural(ach.completed_count, 'game')} completed</div>
        ${rarest ? `<div class="wr-rare">${achIcon(rarest, { size: 30 })}<div style="min-width:0"><div class="ellipsis"><b>${esc(rarest.name || 'Hidden achievement')}</b></div><div class="small muted">${esc(rarest.title)} · the rarest, ${fmtRarity(rarest.rarity ?? 0)} of players</div></div></div>` : ''}</div>` : ''}
    </div>
    ${tl?.eras?.length ? `<div class="card" style="margin-top:16px"><div class="card-h"><h2>The eras of ${y}</h2><span class="tiny muted">the most played game of each month</span></div>${eraStrip(tl)}</div>` : ''}
    ${ach?.completed?.length ? `<div class="card" style="margin-top:16px"><div class="card-h"><h2>Completed in ${y}</h2></div><div class="list">${ach.completed.map((x) => `<a class="item" href="/game/${x.game_id}" data-link>${cover(x)}<div class="grow"><div class="ttl ellipsis">${esc(x.title)}</div><div class="sub">${platDot(x.platform)}${x.platinum ? 'Platinum' : `${x.unlocked} of ${x.total}`} · ${fmtDate(x.completed_at, { month: 'long', day: 'numeric' })}</div></div><span class="badge good">${x.platinum ? 'Platinum' : '100%'}</span></a>`).join('')}</div></div>` : ''}
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-h"><h2>Top 10</h2></div>${topList(w.top_games, { coverFn: (g) => cover(g), limit: 10 })}</div>
      <div class="card"><div class="card-h"><h2>New this year</h2></div><div class="list">${w.new_game_list.map((g) => `<a class="item" href="/game/${g.game_id}" data-link>${cover(g)}<div class="grow ttl ellipsis">${esc(g.title)}</div><span class="small muted">${fmtDate(g.first)}</span></a>`).join('') || '<p class="muted">—</p>'}</div></div>
    </div></div>`;
  bindWrapped();
  function bindWrapped() {
    $('#wr-est').addEventListener('change', (e) => navigate(`/wrapped/${y}${e.target.checked ? '' : '?estimates=exclude'}`, { replace: true }));
  }
}

// =====================================================================
// Duplicates
// =====================================================================
async function duplicates(view, stale) {
  const d = await api('/duplicates');
  if (stale()) return;
  // a basis lets the pair wrap on a phone instead of squeezing both cards to nothing
  const gameCard = (g) => `<a class="row" href="/game/${g.id}" data-link style="min-width:0;flex:1 1 150px">${cover(g, '', 'width:46px;')}<div style="min-width:0"><div class="ttl ellipsis" style="font-weight:650">${esc(g.title)}</div><div class="small muted row" style="gap:5px">${(g.platforms || []).map(platDot).join('')}${fmtMin(g.minutes)}</div></div></a>`;
  view.innerHTML = `
    <div class="page-h"><div><h1>Duplicates</h1><p>Keep one game per title and make sure nothing is counted twice.</p></div></div>
    <div class="stack">
      <div class="card"><div class="card-h"><h2>Possible double counting <span class="badge ${d.counts.double_counted ? 'warn' : ''}">${d.counts.double_counted.toLocaleString()}</span></h2></div>
        <p class="small muted" style="margin-top:-6px">The same game is counted from two sources that probably report the same playtime — e.g. an imported spreadsheet plus the live Steam account, or two accounts sharing a library.</p>
        <div class="list">${d.double_counted.map((x) => `<div class="item" style="flex-wrap:wrap">
          <a href="/game/${x.game.id}" data-link>${cover(x.game)}</a>
          <div class="grow"><a class="ttl" href="/game/${x.game.id}" data-link>${esc(x.game.title)}</a><div class="sub">${esc(x.reason)}</div>
            <div class="sub">${x.entries.map((e) => `${platDot(e.platform)}${esc(e.account_name || plat(e.platform).label)} ${fmtMin(e.playtime_min)}`).join(' &nbsp;·&nbsp; ')}</div></div>
          <div class="row"><button class="btn sm primary" data-exclude="${x.suggest_exclude}">Exclude ${esc((x.entries.find((e) => e.id === x.suggest_exclude)?.account_name) || plat(x.entries.find((e) => e.id === x.suggest_exclude)?.platform).label)}</button><button class="btn sm ghost" data-dismiss="${esc(x.key)}">Ignore</button></div></div>`).join('') || `<p class="muted row" style="gap:8px">${icon('check', 'ic-inline')}Nothing is counted twice.</p>`}</div>
      </div>
      <div class="card"><div class="card-h"><h2>Merge suggestions <span class="badge ${d.counts.suggestions ? 'accent' : ''}">${d.counts.suggestions.toLocaleString()}</span></h2>${d.suggestions.length > 1 ? '<button class="btn sm" id="merge-all">Merge all ≥ 95%</button>' : ''}</div>
        <p class="small muted" style="margin-top:-6px">Similar titles that weren’t grouped automatically (editions, subtitles, platform tags).${d.counts.suggestions > d.suggestions.length ? ` Showing the ${d.suggestions.length} strongest — resolve some and more appear.` : ''}</p>
        <div class="list">${d.suggestions.map((x) => `<div class="item" style="flex-wrap:wrap;gap:14px">
          ${gameCard(x.games[0])}<span class="badge">${Math.round(x.score * 100)}%</span>${gameCard(x.games[1])}
          <div class="row"><button class="btn sm primary" data-merge="${x.games[0].id}:${x.games[1].id}">${icon('merge')}Merge</button><button class="btn sm ghost" data-dismiss="${esc(x.key)}">Not the same</button></div></div>`).join('') || '<p class="muted">No suggestions.</p>'}</div>
      </div>
      <div class="card"><div class="card-h"><h2>Owned on multiple platforms <span class="badge">${d.counts.cross_platform.toLocaleString()}</span></h2></div>
        ${d.counts.cross_platform > d.cross_platform.length ? `<p class="small muted" style="margin-top:-6px">Showing the first ${d.cross_platform.length}.</p>` : ''}
        <div class="list">${d.cross_platform.map((x) => `<a class="item" href="/game/${x.game.id}" data-link>${cover(x.game)}<div class="grow"><div class="ttl ellipsis">${esc(x.game.title)}</div><div class="sub">${x.entries.map((e) => `<span style="${e.excluded ? 'text-decoration:line-through;opacity:.6' : ''}">${platDot(e.platform)} ${esc(e.account_name || plat(e.platform).label)} ${fmtMin(e.playtime_min)}</span>`).join(' &nbsp;')}</div></div></a>`).join('') || '<p class="muted">No games are grouped across platforms yet.</p>'}</div>
      </div>
    </div>`;
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-merge],[data-dismiss],[data-exclude],#merge-all');
    if (!b) return;
    try {
      if (b.dataset.merge) {
        const [a, c] = b.dataset.merge.split(':').map(Number);
        const ga = d.suggestions.flatMap((x) => x.games).find((g) => g.id === a);
        const gc = d.suggestions.flatMap((x) => x.games).find((g) => g.id === c);
        const [target, src] = (gc.minutes > ga.minutes) ? [c, a] : [a, c];
        await api(`/games/${target}/merge`, { method: 'POST', body: { source_ids: [src] } });
        toast('Merged');
      } else if (b.dataset.dismiss) {
        await api('/duplicates/dismiss', { method: 'POST', body: { key: b.dataset.dismiss } });
      } else if (b.dataset.exclude) {
        const en = b.dataset.exclude;
        await api(`/entries/${en}`, { method: 'PATCH', body: { excluded: true } });
        undoToast('Excluded from totals', () => api(`/entries/${en}`, { method: 'PATCH', body: { excluded: false } }), rerender);
      } else if (b.id === 'merge-all') {
        const strong = d.suggestions.filter((s) => s.score >= 0.95);
        if (!(await confirmBox(`Merge the ${plural(strong.length, 'pair')} that match at 95% or more? Each pair becomes one game; this cannot be undone in one step.`, { ok: 'Merge all', title: `Merge ${plural(strong.length, 'pair')}?` }))) return;
        const done = new Set();
        let n = 0;
        for (const x of strong) {
          const [a, c] = x.games;
          if (done.has(a.id) || done.has(c.id)) continue;
          const [target, src] = c.minutes > a.minutes ? [c.id, a.id] : [a.id, c.id];
          await api(`/games/${target}/merge`, { method: 'POST', body: { source_ids: [src] } });
          done.add(src); n++;
        }
        toast(`Merged ${n} pair${n === 1 ? '' : 's'}`);
      }
      rerender();
    } catch (err) { fail(err); }
  });
}

// =====================================================================
// Accounts
// =====================================================================
const SCHED_MODES = [['daily', 'Daily'], ['days', 'Every X days'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['hours', 'Every X hours'], ['hourly', 'Hourly'], ['off', 'Manual only']];

function scheduleFields(s, prefix = '') {
  const mode = s.schedule_mode || 'daily';
  return `<div class="field"><label>Frequency</label><select class="input" name="${prefix}schedule_mode">${SCHED_MODES.map(([v, l]) => `<option value="${v}" ${mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="grid grid-2">
      <div class="field" data-when="days hours"><label>Every</label><input class="input" type="number" min="1" max="365" name="${prefix}schedule_every" value="${s.schedule_every ?? 2}"></div>
      <div class="field" data-when="weekly"><label>Weekday</label><select class="input" name="${prefix}schedule_weekday">${WD.map((d, i) => `<option value="${i}" ${Number(s.schedule_weekday) === i ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
      <div class="field" data-when="monthly"><label>Day of month</label><input class="input" type="number" min="1" max="28" name="${prefix}schedule_monthday" value="${s.schedule_monthday ?? 1}"></div>
      <div class="field" data-when="daily days weekly monthly"><label>Time</label><input class="input" type="time" name="${prefix}schedule_time" value="${esc(s.schedule_time || '04:00')}"></div>
    </div>`;
}

function bindScheduleFields(root, prefix = '') {
  const sel = root.querySelector(`[name=${prefix}schedule_mode]`);
  if (!sel) return;
  const upd = () => root.querySelectorAll('[data-when]').forEach((el) => { el.style.display = el.dataset.when.split(' ').includes(sel.value) ? '' : 'none'; });
  sel.addEventListener('change', upd); upd();
}

function readSchedule(root, prefix = '') {
  const v = (k) => root.querySelector(`[name=${prefix}${k}]`)?.value;
  return { schedule_mode: v('schedule_mode'), schedule_every: Number(v('schedule_every')), schedule_weekday: Number(v('schedule_weekday')), schedule_monthday: Number(v('schedule_monthday')), schedule_time: v('schedule_time') };
}

function capabilityTable(info) {
  const c = info.capabilities || {};
  const rows = [
    ['Lifetime playtime', c.lifetime], ['Recent playtime', c.recent], ['Last played', c.last_played], ['First played', c.first_played],
    ['Launch count', c.play_count], ['Devices', c.per_device], ['Live presence', c.presence], ['History dating', c.history_anchors], ['Rate limits', c.rate_limit],
  ];
  return `<div class="scroll-x" style="margin-top:8px"><table class="tbl cap-table">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v ? esc(v) : '<span class="dim">not available</span>'}</td></tr>`).join('')}</table></div>
    ${(c.limitations || []).length ? `<div class="small" style="margin-top:8px"><b>Limitations</b><ul style="margin:6px 0 0;padding-left:18px" class="muted">${c.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>` : ''}`;
}

async function accountModal(platforms, existing = null) {
  const pick = (p) => {
    const info = platforms.find((x) => x.id === p);
    const a = existing || { config: {}, name: info.label, enabled: true, schedule: null };
    modal({
      title: existing ? `Edit ${esc(a.name)}` : `Connect ${esc(info.label)}`,
      body: `<form class="stack" id="acc-f" autocomplete="off">
        <p class="small muted" style="margin:0">${esc(info.notes)}</p>
        <div class="field"><label>Display name</label><input class="input" name="name" value="${esc(a.name)}"></div>
        ${info.fields.map((f) => `<div class="field"><label>${esc(f.label)}${f.required ? '' : ' <span class="dim">(optional)</span>'}</label>
          ${f.type === 'select' ? `<select class="input" name="cfg_${f.key}">${f.options.map((o) => `<option value="${esc(o)}" ${(a.config[f.key] ?? f.options[0]) === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
            : `<input class="input" name="cfg_${f.key}" type="${f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}" value="${esc(a.config[f.key] ?? '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" spellcheck="false">`}
          ${f.help ? `<div class="help">${esc(f.help).replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')}</div>` : ''}</div>`).join('')}
        ${info.push ? `<div class="card small" style="padding:12px">Push totals with <code>POST /api/v1/accounts/${existing ? existing.id : ':id'}/report</code> — see the <a href="/api" data-link class="link">API page</a>.</div>` : `
        <div class="setting" style="padding:0;border:0"><div><div class="t">Custom schedule</div><div class="d">Override the global sync schedule for this account</div></div><label class="switch"><input type="checkbox" id="acc-own" ${a.schedule ? 'checked' : ''}><span></span></label></div>
        <div id="acc-sched" class="stack ${a.schedule ? '' : 'hide'}">${scheduleFields(a.schedule || state.settings || {}, 'a_')}</div>`}
        <div id="acc-test-r" class="small"></div>
        <details><summary class="small muted" style="cursor:pointer">What ${esc(info.label)} provides &amp; its limits</summary>${capabilityTable(info)}</details>
      </form>`,
      foot: `${existing ? `<button class="btn danger" id="acc-del" aria-label="Unlink account" title="Unlink account">${icon('trash')}</button>` : ''}<span class="grow"></span>${info.push ? '' : '<button class="btn" id="acc-test">Test</button>'}<button class="btn primary" id="acc-save">${existing ? 'Save' : 'Connect & import'}</button>`,
      onMount(el, close) {
        bindScheduleFields(el, 'a_');
        el.querySelector('#acc-own')?.addEventListener('change', (e) => el.querySelector('#acc-sched').classList.toggle('hide', !e.target.checked));
        const collect = () => {
          const f = el.querySelector('#acc-f');
          const config = {};
          for (const fl of info.fields) config[fl.key] = f[`cfg_${fl.key}`].value.trim();
          const own = el.querySelector('#acc-own')?.checked;
          return { platform: p, name: f.name.value.trim() || info.label, config, schedule: own ? readSchedule(el, 'a_') : null };
        };
        el.querySelector('#acc-test')?.addEventListener('click', async (ev) => {
          const b = ev.currentTarget; b.disabled = true; b.textContent = 'Testing…';
          const out = el.querySelector('#acc-test-r');
          try {
            const body = collect();
            if (existing && Object.values(body.config).some((v) => String(v).startsWith('••'))) { out.innerHTML = '<span class="muted">Re-enter secrets to test, or just Save and Sync.</span>'; return; }
            const r = await api('/accounts/test', { method: 'POST', body });
            out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--good)"><b style="color:var(--good)">✓ Connected</b> — ${r.games} games, ${r.played} played, ${fmtHours(r.minutes)}h total.
              <div class="muted">${r.with_dates} of ${r.games} titles have play dates for dating your history${r.account_created_at ? ` · account created ${fmtDate(r.account_created_at, { year: 'numeric', month: 'short' })}` : ''}${r.presence ? ` · presence: ${esc(r.presence)}` : ''} · ${r.api_calls} API calls</div>
              ${r.sample?.length ? `<div class="muted">e.g. ${r.sample.map(esc).join(', ')}</div>` : ''}${r.warning ? `<div style="color:var(--warn)">${esc(r.warning)}</div>` : ''}</div>`;
          } catch (e) { out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--bad);color:var(--bad)">${esc(e.message)}</div>`; } finally { b.disabled = false; b.textContent = 'Test'; }
        });
        el.querySelector('#acc-save').addEventListener('click', async () => {
          const body = collect();
          try {
            if (existing) {
              await api(`/accounts/${existing.id}`, { method: 'PATCH', body });
              toast('Account saved');
            } else {
              await api('/accounts', { method: 'POST', body });
              toast(info.push ? 'Account created' : 'Connected — importing your library…');
              syncStarted();
              setTimeout(() => watchSync(), 1000);
            }
            close(); rerender();
          } catch (e) { fail(e); }
        });
        el.querySelector('#acc-del')?.addEventListener('click', async () => {
          if (!(await confirmBox(`Unlink ${esc(a.name)}? All games, snapshots and sessions from this account will be deleted. This cannot be undone.`, { ok: 'Unlink & delete', danger: true, title: 'Unlink account?' }))) return;
          try { await api(`/accounts/${existing.id}`, { method: 'DELETE' }); close(); toast('Account removed'); rerender(); } catch (e) { fail(e); }
        });
      },
    });
  };
  if (existing) return pick(existing.platform);
  modal({
    title: 'Connect an account',
    body: `<div class="plat-pick">${platforms.map((p) => `<button data-p="${p.id}">${platIcon(p.id, 38)}<div><b>${esc(p.label)}</b><div class="tiny muted">${p.push ? 'Push via API' : 'Automatic sync'}</div></div></button>`).join('')}</div>
      <p class="small muted">Nintendo, Epic, GOG, emulators? Use a <b>Custom</b> account with the push API, or add games manually and log sessions.</p>`,
    onMount(el, close) { el.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => { close(); pick(b.dataset.p); })); },
  });
}

async function accounts(view, stale) {
  const [accs, platforms, syncs] = await Promise.all([api('/accounts'), api('/platforms'), api('/syncs?limit=40')]);
  if (stale()) return;
  view.innerHTML = `
    <div class="page-h"><div><h1>Accounts</h1><p>Global schedule: ${esc(state.settings?.schedule_label || '')} · <a href="/settings" data-link class="link">change</a></p></div>
      <div class="row"><button class="btn" data-action="sync-all">${icon('sync')}<span class="lbl">Sync all</span></button><button class="btn primary" id="acc-add">${icon('plus')}Connect</button></div></div>
    ${accs.length ? `<div class="grid grid-2">${accs.map((a) => `<div class="card acct">
      <div class="row">${platIcon(a.platform, 44)}
        <div class="grow"><h2 class="ellipsis">${esc(a.name)}</h2><div class="small muted">${esc(plat(a.platform).label)} · ${a.push ? 'API push' : esc(a.schedule_label)}${a.schedule ? ' <span class="badge">custom</span>' : ''}</div></div>
        ${a.syncing ? '<span class="badge accent pulse">Syncing</span>' : a.last_status === 'error' ? '<span class="badge bad">Error</span>' : a.last_status === 'warning' ? '<span class="badge warn">Warning</span>' : !a.enabled ? '<span class="badge">Paused</span>' : a.last_sync_at ? '<span class="badge good">OK</span>' : '<span class="badge">New</span>'}</div>
      ${a.last_error ? `<div class="small" style="color:${a.last_status === 'error' ? 'var(--bad)' : 'var(--warn)'}">${esc(a.last_error)}</div>` : ''}
      ${a.history_model ? `<div class="small muted" title="How ${esc(plat(a.platform).label)} reports history and how Vestigo interprets it">Totals update ${esc(a.history_model.update)} · last played = ${esc(a.history_model.last_played)}${a.history_model.counters.length ? ` · ${esc(a.history_model.counters.join(', '))}` : ''}</div>` : ''}
      ${a.presence ? `<div class="small muted row" style="gap:6px">${a.presence.enabled ? (a.presence.error ? `<span style="color:var(--warn)">Presence: ${esc(a.presence.error)}</span>` : `<span class="live-dot" style="animation:none;background:${a.presence.last_poll ? 'var(--good)' : 'var(--dim)'}"></span>Live presence every ${Math.round(a.presence.interval_sec / 60) || 1} min${a.presence.last_poll ? ` · checked ${ago(a.presence.last_poll)}` : ''}`) : 'Live presence off'}</div>` : ''}
      ${a.hourly_limit ? `<div class="small muted">API this hour: ${a.api_usage_hour.calls}/${a.hourly_limit}<div class="meter" style="margin-top:4px"><i class="${a.api_usage_hour.calls > a.hourly_limit * 0.8 ? 'hot' : ''}" style="width:${Math.min(100, (a.api_usage_hour.calls / a.hourly_limit) * 100)}%"></i></div></div>` : ''}
      <div class="meta"><div><b>${a.games ?? 0}</b><span>games</span></div><div><b>${fmtHours(a.minutes ?? 0)}h</b><span>lifetime</span></div><div><b>${a.last_sync_at ? ago(a.last_sync_at) : 'never'}</b><span>${a.push ? 'last report' : a.next_sync_at && a.enabled ? `next ${ago(a.next_sync_at)}` : 'last sync'}</span></div></div>
      <div class="row wrap">
        ${a.push ? '' : `<button class="btn sm${a.syncing ? ' loading' : ''}" data-sync="${a.id}" ${a.syncing ? 'disabled' : ''}>${icon('sync')}${a.syncing ? 'Syncing…' : 'Sync now'}</button>`}
        <button class="btn sm ghost" data-edit="${a.id}">${icon('edit')}Edit</button>
        <button class="btn sm ghost" data-toggle="${a.id}">${a.enabled ? 'Pause' : 'Resume'}</button>
        <a class="btn sm ghost" href="/library?platform=${a.platform}" data-link>Games</a>
      </div></div>`).join('')}</div>`
    : `<div class="card">${emptyState('accounts', 'No accounts yet', 'Connect Steam, Xbox or PlayStation. The first sync imports your library and existing playtime as history; later syncs turn new playtime into sessions.', `<button class="btn primary" id="acc-add2">${icon('plus')}Connect an account</button>`)}</div>`}
    <details class="card" style="margin-top:16px"><summary style="cursor:pointer"><h2 style="display:inline">What each platform reports</h2> <span class="small muted">— and how Vestigo uses it</span></summary>
      <div class="grid grid-2" style="margin-top:14px">${platforms.map((p) => `<div><div class="row" style="margin-bottom:6px"><span class="dot" style="background:${plat(p.id).color};width:10px;height:10px"></span><h3>${esc(p.label)}</h3></div><p class="small muted" style="margin:0 0 6px">${esc(p.notes)}</p>${p.history_model ? `<div class="small" style="margin-bottom:6px"><b>Reporting model:</b> totals update ${esc(p.history_model.update)}; last played = ${esc(p.history_model.last_played)}${p.history_model.counters.length ? `; extra counters: ${esc(p.history_model.counters.join(', '))}` : ''}${p.history_model.grouping ? `; versions grouped by ${esc(p.history_model.grouping)}` : ''}</div>` : ''}${capabilityTable(p)}</div>`).join('')}</div>
    </details>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Sync history</h2></div>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>When</th><th>Account</th><th>Result</th><th>Games</th><th>Sessions</th><th>Played</th><th>History</th></tr></thead><tbody>
      ${syncs.map((s) => `<tr><td class="nowrap">${fmtDate(s.started_at)} ${fmtTime(s.started_at)}<div class="tiny dim">${esc(s.trigger)}${s.initial ? ' · initial import' : ''}</div></td>
        <td class="nowrap">${platDot(s.platform || 'custom')} ${esc(s.account_name || '—')}</td>
        <td>${s.status === 'ok' ? '<span class="badge good">ok</span>' : s.status === 'running' ? '<span class="badge accent pulse">running</span>' : `<span class="badge ${s.status === 'warning' ? 'warn' : 'bad'}">${esc(s.status)}</span>`}${s.error ? `<div class="tiny muted" style="max-width:260px">${esc(s.error)}</div>` : ''}</td>
        <td>${s.games_seen}${s.games_new ? ` <span class="tiny muted">(+${s.games_new})</span>` : ''}${s.details?.api ? `<div class="tiny dim">${s.details.api.calls} calls${s.details.api.rate_limited ? ` · ${s.details.api.rate_limited} rate-limited` : ''} · ${((s.duration_ms || 0) / 1000).toFixed(1)}s</div>` : ''}</td><td>${s.sessions_created ? `<a href="/sessions" data-link class="link">${s.sessions_created}</a>` : 0}</td><td>${fmtMin(s.minutes_added)}</td><td class="muted">${s.baseline_minutes ? fmtMin(s.baseline_minutes, { short: true }) : '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No syncs yet.</td></tr>'}
      </tbody></table></div></div>`;
  $('#acc-add')?.addEventListener('click', () => accountModal(platforms));
  $('#acc-add2')?.addEventListener('click', () => accountModal(platforms));
  if (new URLSearchParams(location.search).get('add')) { history.replaceState({}, '', '/accounts'); accountModal(platforms); }
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sync],[data-edit],[data-toggle]');
    if (!b) return;
    try {
      if (b.dataset.sync) { await api(`/accounts/${b.dataset.sync}/sync`, { method: 'POST' }); toast('Sync started'); syncStarted(); setTimeout(() => { rerender(); watchSync(); }, 500); }
      if (b.dataset.edit) accountModal(platforms, accs.find((a) => a.id === Number(b.dataset.edit)));
      if (b.dataset.toggle) {
        const a = accs.find((x) => x.id === Number(b.dataset.toggle));
        const set = (enabled) => api(`/accounts/${a.id}`, { method: 'PATCH', body: { enabled } });
        await set(!a.enabled);
        undoToast(`${a.name} ${a.enabled ? 'paused' : 'resumed'}`, () => set(a.enabled), rerender);
        rerender();
      }
    } catch (err) { fail(err); }
  });
}

// =====================================================================
// Settings
// =====================================================================
const ACCENTS = [['#7656ff', 'Violet (default)'], ['#22d3ee', 'Cyan'], ['#34d399', 'Mint'], ['#f472b6', 'Rose'], ['#fb923c', 'Ember'], ['#facc15', 'Gold'], ['#ef4444', 'Red'], ['#60a5fa', 'Sky']];
function segSetting(key, title, opts, s, desc = '') {
  return `<div class="setting"><div><div class="t">${title}</div>${desc ? `<div class="d">${desc}</div>` : ''}</div><div class="seg" data-seg="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(s[key]) === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>`;
}

/** The "Install app" row: an Install button when the browser offers one, else how (or why not). */
function installRow() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const d = !window.isSecureContext ? 'Install and offline need HTTPS, e.g. through your reverse proxy.'
    : standalone ? 'Installed: Vestigo opens in its own window, and pages you opened work offline.'
      : state.installPrompt ? 'Its own window and icon, and pages you opened work offline.'
        : 'Use your browser’s Install or Add to Home Screen option. Pages you opened work offline.';
  return `<div class="setting" id="install"><div><div class="t">Install app</div><div class="d">${d}</div></div>${window.isSecureContext && !standalone && state.installPrompt ? `<button class="btn sm" id="inst-go">${icon('download')}Install</button>` : ''}</div>`;
}

/** A "Saved" tick beside a settings control for 1.5s; the live line says what was saved. */
function savedTick(at, what) {
  const row = at?.closest('.setting');
  const host = row?.querySelector('.t') || at?.closest('.field')?.querySelector('label') || (at?.matches('button') ? at.parentElement : at);
  if (!host) return;
  host.querySelector('.saved')?.remove();
  host.insertAdjacentHTML('beforeend', `<span class="saved" aria-hidden="true">${icon('check')}Saved</span>`);
  const tick = host.lastElementChild;
  const st = $('#set-st');
  if (st) st.textContent = `${what || row?.querySelector('.t')?.firstChild?.textContent?.trim() || 'Setting'} saved`;
  setTimeout(() => tick.classList.add('gone'), 1500);
  setTimeout(() => tick.remove(), 1900);
}

async function settings(view, stale) {
  const [s, tokens, auth] = await Promise.all([api('/settings'), api('/tokens'), api('/auth/status')]);
  if (stale()) return;
  const sw = (key, title, desc) => `<div class="setting"><div><div class="t">${title}</div><div class="d">${desc}</div></div><label class="switch"><input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''} aria-label="${esc(title)}"><span></span></label></div>`;
  const accent = accentOf(s);
  view.innerHTML = `
    <div class="page-h"><div><h1>Settings</h1></div><span class="vh" role="status" id="set-st"></span></div>
    <div class="grid grid-2">
      <div class="stack">
        <div class="card" id="appearance"><div class="card-h"><h2>Appearance</h2><span class="tiny muted">saved for every device</span></div>
          ${segSetting('theme', 'Theme', [['dark', 'Dark'], ['black', 'Black'], ['light', 'Light'], ['auto', 'Auto']], s, 'Black is pure black for OLED screens')}
          <div class="setting"><div><div class="t" id="accent-t">Accent</div></div><div class="row wrap" role="group" aria-labelledby="accent-t">${ACCENTS.map(([c, name]) => `<button class="swatch" data-accent="${c}" style="--c:${c}" aria-label="${name}" title="${name}" aria-pressed="${accent === c}"></button>`).join('')}
            <input type="color" class="swatch" id="accent-custom" value="${esc(accent)}" title="Custom color" aria-label="Custom accent color"></div></div>
          ${segSetting('ui_density', 'Density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], s, 'Compact fits more on screen')}
          ${segSetting('time_format', 'Time format', [['hm', '1h 5m'], ['decimal', '1.1h']], s)}
          <div class="setting"><div><div class="t">Start page</div><div class="d">What opens when you launch Vestigo</div></div><select class="input" data-str="start_page" style="width:auto">${[['home', 'Home'], ['library', 'Library'], ['sessions', 'Sessions'], ['stats', 'Stats']].map(([v, l]) => `<option value="${v}" ${s.start_page === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          ${installRow()}
          <h3 style="margin:16px 0 2px">Library</h3>
          ${segSetting('library_view', 'Default view', [['grid', 'Covers'], ['list', 'List']], s)}
          ${segSetting('cover_size', 'Cover size', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']], s)}
          ${segSetting('cover_titles', 'Titles on covers', [['auto', 'No art'], ['always', 'Always'], ['never', 'Never']], s, '“No art” only labels games without a cover image')}
          <div class="setting"><div class="t">Default sort</div><select class="input" data-str="default_library_sort" style="width:auto">${[['recent', 'Recently played'], ['playtime', 'Most played'], ['title', 'A–Z'], ['trending', 'Trending'], ['added', 'Recently added'], ['rating', 'Top rated']].map(([v, l]) => `<option value="${v}" ${s.default_library_sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          ${sw('library_hide_unplayed', 'Hide never-played games', 'Owned games you have never launched stay out of the library unless you ask for them')}
          <h3 style="margin:16px 0 8px" id="lay-h">Home sections</h3>
          <div id="set-layout"></div>
        </div>
        <div class="card" id="schedule"><div class="card-h"><h2>Sync schedule</h2><span class="badge accent" id="sched-label">${esc(s.schedule_label)}</span></div>
          <p class="small muted" style="margin-top:-6px">How often Vestigo snapshots your playtime. Shorter intervals = more precise sessions; the difference between two snapshots becomes a session. Accounts can override this.</p>
          <form class="stack" id="sched-f">${scheduleFields(s)}</form>
          <div class="row" style="margin-top:14px"><button class="btn primary" id="sched-save">Save schedule</button></div>
        </div>
        <div class="card" id="detection"><div class="card-h"><h2>Session detection</h2></div>
          <div class="setting"><div><div class="t">Minimum session</div><div class="d">Smaller deltas accumulate until they reach this many minutes</div></div><input class="input" type="number" min="0" max="120" data-num="min_session_minutes" value="${s.min_session_minutes}" style="width:90px"></div>
          <div class="setting"><div><div class="t">Wall-clock tolerance</div><div class="d">If a platform reports more playtime than time elapsed since the last sync (+ this many minutes), the excess is filed as history</div></div><input class="input" type="number" min="0" max="600" data-num="max_overage_minutes" value="${s.max_overage_minutes}" style="width:90px"></div>
          ${sw('use_recent_on_import', 'Use Steam “last 2 weeks” on import', 'On a first import, Steam’s two-week playtime becomes a real session instead of history')}
          ${sw('history_learn', 'Learn my play pattern', 'Games tracked from first session to last teach how you spread play over a game; pre-tracking history is dated the same way')}
          ${sw('auto_merge_titles', 'Auto-group same titles', 'Same game on Steam/Xbox/PSN becomes one library entry (editions & platform tags ignored)')}
          <div class="setting"><div><div class="t">Week starts on</div></div><select class="input" data-num="week_starts_on" style="width:auto"><option value="1" ${s.week_starts_on === 1 ? 'selected' : ''}>Monday</option><option value="0" ${s.week_starts_on === 0 ? 'selected' : ''}>Sunday</option></select></div>
        </div>
      </div>
      <div class="stack">
        <div class="card" id="import"><div class="card-h"><h2>Import</h2></div>
          <p class="small muted" style="margin-top:-6px">Bring history from spreadsheets, other trackers, Switch, etc. CSV columns: <code>title</code>, <code>platform</code>, <code>playtime_hours</code> or <code>playtime_minutes</code>, <code>last_played</code>, <code>status</code>, <code>rating</code>, <code>notes</code>. JSON may include per-game <code>sessions</code>. Totals without sessions become <b>history</b> — counted in lifetime, never as a burst in your charts.</p>
          <label class="btn" style="cursor:pointer">${icon('upload')}Choose CSV / JSON / GameTrack .zip<input type="file" id="imp-file" class="vh" accept=".csv,.json,.txt,.zip,text/csv,application/json,application/zip"></label>
          <p class="tiny muted" style="margin:8px 0 0">GameTrack: in GameTrack choose Settings › Export, then pick the .zip here. Unlock times date your synced games' history; hours no account here tracks are added as history; nothing is counted twice.</p>
          <details style="margin-top:12px"><summary class="small muted" style="cursor:pointer">…or paste</summary><textarea class="input mono" id="imp-text" aria-label="CSV or JSON to import" placeholder="title,platform,playtime_hours,status&#10;Hades,switch,42,completed" style="margin-top:8px"></textarea><button class="btn sm" id="imp-go" style="margin-top:8px">Import pasted data</button></details>
          <div id="imp-r" class="small" style="margin-top:10px" aria-live="polite"></div>
        </div>
        <div class="card" id="export"><div class="card-h"><h2>Export & backup</h2></div>
          <div class="row wrap"><a class="btn" href="/api/v1/export" download>${icon('download')}JSON</a><a class="btn" href="/api/v1/export?format=csv" download>${icon('download')}CSV</a><a class="btn" href="/api/v1/backup" download>${icon('download')}SQLite backup</a></div>
          <p class="small muted">Everything is stored in the container’s <code>/data</code> volume — on Unraid, map it to a folder under <code>/mnt/user/appdata</code>. <a href="/system" data-link class="link">System</a> shows the database file in use.</p>
        </div>
        <div class="card" id="notifications"><div class="card-h"><h2>Notifications</h2></div>
          <div class="field"><label>Webhook URL</label><input class="input" data-str="webhook_url" value="${esc(s.webhook_url)}" placeholder="https://discord.com/api/webhooks/…"><div class="help">Discord and Slack get a formatted message; anything else gets JSON. Works with ntfy, Gotify bridges, Home Assistant, n8n…</div></div>
          <div class="setting"><div class="t">Send when</div><select class="input" data-str="webhook_on" style="width:auto"><option value="sessions" ${s.webhook_on === 'sessions' ? 'selected' : ''}>New sessions or errors</option><option value="always" ${s.webhook_on === 'always' ? 'selected' : ''}>Every sync</option><option value="errors" ${s.webhook_on === 'errors' ? 'selected' : ''}>Errors only</option></select></div>
        </div>
        <div class="card" id="security"><div class="card-h"><h2>Security</h2></div>
          ${auth.password_source === 'env' ? `<p class="small muted">Password is set with <code>${esc(auth.password_env || 'VESTIGO_PASSWORD')}</code> and can’t be changed here.</p>` : `
          <form class="stack" id="pw-f">${auth.auth_enabled ? '<div class="field"><label>Current password</label><input class="input" type="password" name="current" autocomplete="current-password"></div>' : '<p class="small muted" style="margin:0">No password set — anyone on your network can open Vestigo. Set one before exposing it through a reverse proxy.</p>'}
            <div class="field"><label>${auth.auth_enabled ? 'New password (empty = remove)' : 'Password'}</label><input class="input" type="password" name="password" autocomplete="new-password"></div>
            <div><button class="btn">${auth.auth_enabled ? 'Update password' : 'Set password'}</button></div></form>`}
        </div>
        <div class="card" id="tokens"><div class="card-h"><h2>API tokens</h2><button class="btn sm" id="tok-new">${icon('key')}New token</button></div>
          <div class="list">${tokens.map((t) => `<div class="item"><div class="grow"><div class="ttl">${esc(t.name)}</div><div class="sub"><span class="mono">${esc(t.prefix)}…</span> · created ${fmtDate(t.created_at)} · ${t.last_used_at ? `used ${ago(t.last_used_at)}` : 'never used'}</div></div><button class="btn sm ghost danger" data-revoke="${t.id}">Revoke</button></div>`).join('') || '<p class="small muted">Tokens let scripts, Home Assistant, Homepage widgets or Playnite call the API. <a href="/api" data-link class="link">API docs</a></p>'}</div>
        </div>
      </div>
    </div>`;
  bindScheduleFields(view);
  $('#inst-go')?.addEventListener('click', async () => {
    const p = state.installPrompt;
    if (!p) return;
    p.prompt();
    const { outcome } = await p.userChoice.catch(() => ({}));
    if (outcome === 'accepted') { state.installPrompt = null; rerender(); }
  });
  // a change is confirmed by a "Saved" tick beside its control (and the #set-st live line), not a toast
  const save = async (patch, at, what) => {
    try { const r = await api('/settings', { method: 'PUT', body: patch }); state.settings = { ...state.settings, ...r }; $('#sched-label').textContent = r.schedule_label; applyTheme(state.settings); savedTick(at, what); return r; } catch (e) { fail(e); }
  };
  $('#sched-save').addEventListener('click', (e) => save(readSchedule(view), e.currentTarget, 'Sync schedule'));
  $$('[data-set]', view).forEach((el) => el.addEventListener('change', () => save({ [el.dataset.set]: el.checked }, el)));
  $$('[data-num]', view).forEach((el) => el.addEventListener('change', () => save({ [el.dataset.num]: Number(el.value) }, el)));
  $$('[data-str]', view).forEach((el) => el.addEventListener('change', () => save({ [el.dataset.str]: el.value }, el)));
  $$('[data-seg]', view).forEach((g) => g.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    $$('button', g).forEach((x) => x.classList.toggle('on', x === b));
    const r = await save({ [g.dataset.seg]: b.dataset.v }, g);
    if (r) applyTheme(state.settings);
  }));
  const setAccent = async (c) => {
    $$('[data-accent]', view).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.accent === c)));
    $('#accent-custom').value = c;
    const r = await save({ accent: c }, $('#accent-t'), 'Accent');
    if (r) applyTheme(state.settings);
  };
  $$('[data-accent]', view).forEach((b) => b.addEventListener('click', () => setAccent(b.dataset.accent)));
  $('#accent-custom').addEventListener('input', (e) => paintAccent(e.target.value)); // live preview, with its readable ink
  $('#accent-custom').addEventListener('change', (e) => setAccent(e.target.value));
  let layoutTimer;
  layoutEditor($('#set-layout'), parseLayout(s.dashboard_layout), (v) => { clearTimeout(layoutTimer); layoutTimer = setTimeout(() => save({ dashboard_layout: v }, $('#lay-h'), 'Home sections'), 400); });
  // Imports preview first (dry run: nothing changes), then apply on confirm.
  const li = (cond, html) => (cond ? `<li>${html}</li>` : '');
  const fileSummary = (r) => `<ul class="small" style="margin:6px 0 0;padding-left:18px">
      ${li(r.merged_synced, `${r.merged_synced} game${r.merged_synced === 1 ? '' : 's'} your synced accounts already track: their totals stay${r.synced_updated ? `, the file adds dates and details${r.sessions_restored ? ` and ${r.sessions_restored} exact past sessions (replacing estimates)` : ''}` : ''}`)}
      ${li(r.entries_created, `${r.entries_created} new game${r.entries_created === 1 ? '' : 's'} / entries`)}
      ${li(r.entries_updated, `${r.entries_updated} existing manual or imported entr${r.entries_updated === 1 ? 'y' : 'ies'} joined (totals only grow, never shrink)`)}
      ${li(r.sessions, `${r.sessions} sessions (${fmtMin(r.tracked_minutes)})`)}
      ${li(r.baseline_minutes, `${fmtHours(r.baseline_minutes)}h added as history, dated from the file`)}
      ${li(r.details_filled, `${r.details_filled} games get a status, rating or notes they did not have (yours are never replaced)`)}
      ${li(r.skipped, `<span class="muted">${r.skipped} rows skipped (no title or unreadable)</span>`)}
      ${r.unchanged && !r.entries_created && !r.entries_updated && !r.synced_updated ? '<li>Nothing new — everything in this file is already here.</li>' : ''}
    </ul>`;
  const gameTrackSummary = (r) => {
    const i = r.import || {};
    return `<ul class="small" style="margin:6px 0 0;padding-left:18px">
      ${li(true, `${r.gametrack_games.toLocaleString()} GameTrack games read`)}
      ${li(r.anchors, `${r.anchors.toLocaleString()} achievement / trophy times date history${r.anchored_entries ? ` of ${r.anchored_entries} synced games` : ''}`)}
      ${li(r.imported_titles, `${r.imported_titles} games with playtime no account here tracks: ${fmtHours(i.baseline_minutes || 0)}h added as history`)}
      ${li(r.skipped_synced, `${r.skipped_synced} games skipped: already counted by your synced accounts`)}
      ${li(r.statuses || r.ratings || r.covers, `${r.statuses} statuses, ${r.ratings} ratings, ${r.covers} covers filled in where empty`)}
      ${li(r.wishlist_added, `${r.wishlist_added} wish-listed games added`)}
      ${li(r.skipped_no_playtime, `<span class="muted">${r.skipped_no_playtime} collection games without playtime left out</span>`)}
    </ul>`;
  };
  const previewThenApply = async ({ label, send, summary }) => {
    const out = $('#imp-r');
    out.innerHTML = `<span class="pulse muted">Checking ${esc(label)}…</span>`;
    try {
      const p = await send(true);
      out.innerHTML = `<div class="card" style="padding:12px"><b>Preview: ${esc(label)}</b>${summary(p)}
        <div class="small muted" style="margin-top:6px">Nothing has changed yet. Imports join your library: they fill gaps and add history, never replace what you set.</div>
        <div class="row" style="margin-top:10px"><button class="btn primary sm" id="imp-apply">${icon('check')}Import</button><button class="btn sm ghost" id="imp-cancel">Cancel</button></div></div>`;
      $('#imp-cancel').addEventListener('click', () => { out.innerHTML = ''; });
      $('#imp-apply').addEventListener('click', async () => {
        out.innerHTML = '<span class="pulse muted">Importing…</span>';
        try {
          const r = await send(false);
          out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--good)"><b style="color:var(--good)">✓ Imported ${esc(label)}</b>${summary(r)}<div class="muted small" style="margin-top:6px">Importing the same file again changes nothing.</div></div>`;
        } catch (e) { out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--bad);color:var(--bad)">${esc(e.message)}</div>`; }
      });
    } catch (e) { out.innerHTML = `<div class="card" style="padding:12px;border-color:var(--bad);color:var(--bad)">${esc(e.message)}</div>`; }
  };
  const doImport = (text, name = '') => {
    let body; let headers = {};
    const isJson = name.endsWith('.json') || /^\s*[[{]/.test(text);
    try { body = isJson ? JSON.parse(text) : text; } catch { $('#imp-r').innerHTML = '<div class="card" style="padding:12px;border-color:var(--bad);color:var(--bad)">That file is not valid JSON</div>'; return; }
    if (!isJson) headers = { 'Content-Type': 'text/csv' };
    return previewThenApply({ label: name || 'pasted data', send: (dry) => api(`/import${dry ? '?dry_run=true' : ''}`, { method: 'POST', body, headers }), summary: fileSummary });
  };
  const doGameTrack = (file) => previewThenApply({
    label: file.name, summary: gameTrackSummary,
    send: (dry) => api(`/import/gametrack${dry ? '?dry_run=true' : ''}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/zip' } }),
  });
  $('#imp-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f && /\.zip$/i.test(f.name)) doGameTrack(f);
    else if (f) doImport(await f.text(), f.name.toLowerCase());
    e.target.value = '';
  });
  $('#imp-go').addEventListener('click', () => { const t = $('#imp-text').value; if (t.trim()) doImport(t); });
  $('#pw-f')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api('/auth/password', { method: 'PUT', body: { current: e.target.current?.value, password: e.target.password.value } }); state.authEnabled = r.auth_enabled; toast(r.auth_enabled ? 'Password saved' : 'Password removed'); rerender(); } catch (err) { fail(err); }
  });
  $('#tok-new').addEventListener('click', () => modal({
    title: 'New API token',
    body: '<div class="field"><label>Name</label><input class="input" id="tok-name" placeholder="Home Assistant"></div><div id="tok-out"></div>',
    foot: '<button class="btn" data-close>Close</button><button class="btn primary" id="tok-go">Create</button>',
    onMount(el) {
      el.querySelector('#tok-go').addEventListener('click', async (ev) => {
        try {
          const r = await api('/tokens', { method: 'POST', body: { name: el.querySelector('#tok-name').value || 'API token' } });
          ev.target.remove();
          el.querySelector('#tok-out').innerHTML = `<p class="small muted">Copy it now — it won’t be shown again.</p><pre class="code" style="white-space:pre-wrap;word-break:break-all">${esc(r.token)}</pre><button class="btn sm" id="tok-copy">Copy</button>`;
          el.querySelector('#tok-copy').addEventListener('click', () => navigator.clipboard?.writeText(r.token).then(() => toast('Copied')));
          el.querySelector('[data-close]').addEventListener('click', () => rerender(), { once: true });
        } catch (e) { fail(e); }
      });
    },
  }));
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke]');
    if (!b) return;
    if (!(await confirmBox('Anything using this token will stop working. This cannot be undone.', { ok: 'Revoke', danger: true, title: 'Revoke token?' }))) return;
    await api(`/tokens/${b.dataset.revoke}`, { method: 'DELETE' }); rerender();
  });
  if (/^#(appearance|schedule|detection|import|export|notifications|security|tokens)$/.test(location.hash)) setTimeout(() => $(location.hash)?.scrollIntoView({ behavior: scrollMotion() }), 100);
}

// =====================================================================
// API docs
// =====================================================================
async function apidocs(view, stale) {
  const res = await fetch('/api/openapi.json');
  const spec = await res.json();
  if (stale()) return;
  const origin = location.origin;
  const groups = {};
  for (const [p, ops] of Object.entries(spec.paths)) for (const [m, op] of Object.entries(ops)) (groups[op.tags[0]] ||= []).push({ p, m, op });
  view.innerHTML = `
    <div class="page-h"><div><h1>API</h1><p>Everything in the UI is available over a JSON REST API. <a href="/api/openapi.json" target="_blank" class="link">OpenAPI spec${icon('external', 'ic-inline')}</a></p></div></div>
    <div class="grid grid-2">
      <div class="card"><h2>Authentication</h2><p class="small muted">Create a token under Settings › API tokens and send it as a header (or <code>?api_key=</code> for simple widgets). Without a UI password the API is open on your LAN.</p>
        <pre class="code">curl -H "Authorization: Bearer vg_…" ${esc(origin)}/api/v1/widget</pre></div>
      <div class="card"><h2>Push playtime (custom accounts)</h2><p class="small muted">Send lifetime totals from Playnite, a Switch spreadsheet or a script. Vestigo diffs them like any other sync.</p>
        <pre class="code">curl -X POST ${esc(origin)}/api/v1/accounts/ID/report \\
  -H "Authorization: Bearer vg_…" -H "Content-Type: application/json" \\
  -d '{"games":[{"id":"zelda-totk","title":"Zelda: TotK","playtime_minutes":5230}]}'</pre></div>
      <div class="card"><h2>Log a session</h2><pre class="code">curl -X POST ${esc(origin)}/api/v1/sessions -H "Authorization: Bearer vg_…" \\
  -H "Content-Type: application/json" -d '{"game_id":12,"minutes":45,"note":"Chapter 3"}'</pre></div>
      <div class="card"><h2>Dashboards</h2><p class="small muted"><code>GET /api/v1/widget</code> returns flat numbers for Homepage / Homarr / Home Assistant REST sensors. Prometheus metrics live at <code>/metrics</code>.</p>
        <pre class="code">- Vestigo:
    widget:
      type: customapi
      url: ${esc(origin)}/api/v1/widget?api_key=vg_…
      mappings:
        - field: week_hours
          label: This week
          suffix: h</pre></div>
    </div>
    <div class="card" style="margin-top:16px">${Object.entries(groups).map(([tag, ops]) => `<h2 style="margin:18px 0 8px;text-transform:capitalize">${esc(tag)}</h2>
      <div class="scroll-x"><table class="tbl api-table">${ops.map(({ p, m, op }) => `<tr><td style="width:70px"><span class="method m-${m}">${m.toUpperCase()}</span></td><td><span class="mono">${esc(p)}</span><div class="small muted">${esc(op.summary)}</div>
        ${op.parameters.filter((x) => x.in === 'query').length ? `<div class="tiny dim">query: ${op.parameters.filter((x) => x.in === 'query').map((x) => `<code>${esc(x.name)}</code>${x.description ? ` ${esc(x.description)}` : ''}`).join(' · ')}</div>` : ''}
        ${op.requestBody ? `<div class="tiny dim">body: <code>${esc(op.requestBody.content['application/json'].schema.description)}</code></div>` : ''}</td></tr>`).join('')}</table></div>`).join('')}</div>`;
}

// =====================================================================
// System: health, error log, API usage, diagnostics
// =====================================================================
async function system(view, stale) {
  const [sys, logs] = await Promise.all([api('/system'), api('/logs?level=error,warn&limit=200')]);
  if (stale()) return;
  const mb = (b) => `${(b / 1048576).toFixed(b > 1e8 ? 0 : 1)} MB`;
  const up = (sec) => (sec > 86400 ? `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h` : sec > 3600 ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m` : `${Math.floor(sec / 60)}m`);
  const health = sys.errors_24h ? ['bad', `${sys.errors_24h} error${sys.errors_24h > 1 ? 's' : ''} in 24h`] : sys.warnings_24h ? ['warn', `${sys.warnings_24h} warning${sys.warnings_24h > 1 ? 's' : ''} in 24h`] : ['good', 'Healthy'];
  view.innerHTML = `
    <div class="page-h"><div><h1>System</h1><p>Vestigo ${esc(sys.version)} · Node ${esc(sys.node)} · up ${up(sys.uptime_s)} · TZ ${esc(sys.tz)}${sys.tz_env ? '' : ' <span style="color:var(--warn)">(TZ not set)</span>'}</p></div>
      <div class="row"><span class="badge ${health[0]}" style="height:30px;padding:0 12px">${health[1]}</span><button class="btn" id="sys-dl">${icon('download')}Diagnostics</button></div></div>
    <div class="kpis">
      ${kpi('Errors (24h)', sys.errors_24h, `${sys.warnings_24h} warnings`)}
      ${kpi('Requests', sys.http?.requests?.toLocaleString() || 0, `${sys.http?.errors || 0} failed · ${sys.http?.slow || 0} slow`)}
      ${kpi('Database', mb(sys.db_bytes), `${sys.counts.sessions_tracked.toLocaleString()} sessions`)}
      ${kpi('Memory', `${sys.memory_mb}<small>MB</small>`, `heap ${sys.heap_mb} MB`)}
      ${kpi('Library', sys.counts.games.toLocaleString(), `${sys.counts.entries.toLocaleString()} entries`)}
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Accounts &amp; API usage</h2><a href="/accounts" data-link>Manage${arrow()}</a></div>
      <div class="scroll-x"><table class="tbl"><thead><tr><th>Account</th><th>Last sync</th><th>Next</th><th>API calls (1h / 24h)</th><th>Rate limited</th><th>Reporting model</th><th>Presence</th><th>History dating</th></tr></thead><tbody>
      ${sys.accounts.map((a) => `<tr>
        <td class="nowrap">${platDot(a.platform)} <b>${esc(a.name)}</b>${a.last_status === 'error' ? `<div class="tiny" style="color:var(--bad);max-width:260px;white-space:normal">${esc(a.last_error || '')}</div>` : ''}${a.failed_syncs_7d ? `<div class="tiny muted">${a.failed_syncs_7d} failed syncs in 7 days</div>` : ''}</td>
        <td class="nowrap">${a.last_sync ? `<span class="badge ${a.last_sync.status === 'ok' ? 'good' : a.last_sync.status === 'warning' ? 'warn' : 'bad'}">${esc(a.last_sync.status)}</span> ${ago(a.last_sync.started_at)}<div class="tiny dim">${esc(a.last_sync.trigger)} · ${((a.last_sync.duration_ms || 0) / 1000).toFixed(1)}s</div>` : 'never'}</td>
        <td class="nowrap">${a.push ? 'push' : a.next_sync_at ? ago(a.next_sync_at) : '—'}</td>
        <td class="nowrap">${a.api_usage_hour.calls}${a.hourly_limit ? ` / ${a.hourly_limit}` : ''} · ${a.api_usage_24h.calls}${a.api_usage_24h.errors ? `<div class="tiny" style="color:var(--warn)">${a.api_usage_24h.errors} failed</div>` : ''}
          ${a.api_quota?.remaining != null ? `<div class="tiny dim">service reports ${a.api_quota.remaining} left${a.api_quota.resetAt ? ` · resets ${fmtTime(a.api_quota.resetAt)}` : ''}</div>` : ''}
          ${a.api_quota?.blockedUntil > Date.now() ? `<div class="tiny" style="color:var(--warn)">paused until ${fmtTime(a.api_quota.blockedUntil)}</div>` : ''}</td>
        <td>${a.api_usage_24h.rate_limited ? `<span class="badge warn">${a.api_usage_24h.rate_limited}</span>` : '—'}</td>
        <td class="small" style="min-width:180px">${a.history_model ? `${esc(a.history_model.update)}<div class="tiny dim">last played = ${esc(a.history_model.last_played)}</div>` : '—'}</td>
        <td class="nowrap small">${a.presence ? (a.presence.enabled ? (a.presence.error ? `<span style="color:var(--warn)">${esc(a.presence.error)}</span>` : a.presence.last_poll ? `ok · ${ago(a.presence.last_poll)}` : 'waiting') : 'off') : '—'}</td>
        <td class="small">${!a.can_enrich ? '<span class="muted">from platform dates</span>' : a.enrichment_pending ? `${a.enrichment_pending} titles queued` : 'up to date'}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No accounts.</td></tr>'}
      </tbody></table></div>
      <div class="row wrap" style="margin-top:12px"><button class="btn sm" id="sys-reinfer">Re-date all history</button><a class="btn sm ghost" href="/history" data-link>Improve history${icon('arrowR')}</a>${sys.accounts.filter((a) => a.enrichment_pending && a.can_enrich).map((a) => `<button class="btn sm ghost" data-enrich="${a.id}">Fetch history dates for ${esc(a.name)}</button>`).join('')}</div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Error log</h2><div class="row wrap">
        <div class="seg" id="log-lvl" aria-label="Show"><button data-l="error,warn" class="on">Errors &amp; warnings</button><button data-l="error">Errors</button><button data-l="warn">Warnings</button></div>
        <button class="btn sm ghost" id="log-clear">${icon('trash')}Clear</button></div></div>
      <div class="search" style="margin-bottom:10px">${icon('search')}<input class="input" id="log-q" aria-label="Filter log" placeholder="Filter messages (account, game, error…)"></div>
      <div id="log-list"></div>
    </div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><div class="card-h"><h2>Recent console output</h2><span class="tiny muted">same as docker logs</span></div><div class="console">${sys.console.map(esc).join('\n') || 'Nothing yet.'}</div></div>
      <div class="card"><div class="card-h"><h2>Storage</h2></div>
        <div class="scroll-x"><table class="tbl cap-table">${[['Database file', sys.data_dir || 'in-memory'], ['Size (incl. WAL)', mb(sys.db_bytes)], ['Tracked sessions', sys.counts.sessions_tracked.toLocaleString()], ['Estimated history chunks', sys.counts.sessions_estimated.toLocaleString()], ['Rollup rows', sys.counts.rollup_rows.toLocaleString()], ['Pending rollups', sys.counts.rollup_queue], ['Snapshots', sys.counts.snapshots.toLocaleString()], ['Presence spans', sys.counts.presence_spans.toLocaleString()], ['Stored log entries', sys.counts.logs.toLocaleString()], ['Running as uid', sys.uid ?? '—'], ['UI password', sys.auth_enabled ? 'on' : 'off']].map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('')}</table></div>
        <p class="tiny muted">Logs are also written to stdout (Unraid: container › Logs). Set <code>LOG_LEVEL=debug</code>, <code>LOG_FORMAT=json</code> or <code>VESTIGO_LOG_FILE=/data/vestigo.log</code> for more.</p></div>
    </div>`;
  let level = 'error,warn'; let q = '';
  const drawLogs = (items) => {
    $('#log-list').innerHTML = items.length ? items.map((l) => `<details class="log-row"><summary><span class="lvl lvl-${l.level}">${l.level}</span><span class="tiny muted nowrap">${fmtDate(l.time)} ${fmtTime(l.time)}</span><span class="tiny dim nowrap">${esc(l.source)}</span><span class="grow small" style="word-break:break-word">${esc(l.message)}</span></summary>
      ${l.context ? `<pre class="code">${esc(JSON.stringify(l.context, null, 2))}</pre>` : ''}${l.stack ? `<pre class="code">${esc(l.stack)}</pre>` : ''}</details>`).join('')
      : `<div class="empty" style="padding:24px"><div class="em-ic">${icon('check')}</div><h2>All clear</h2><p>No ${level === 'warn' ? 'warnings' : 'errors'} logged.</p></div>`;
  };
  drawLogs(logs.items);
  const reload = async () => drawLogs((await api(`/logs?level=${level}&limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`)).items);
  $('#log-lvl').addEventListener('click', (e) => { const b = e.target.closest('[data-l]'); if (!b) return; level = b.dataset.l; $$('#log-lvl button').forEach((x) => x.classList.toggle('on', x === b)); reload(); });
  let t;
  $('#log-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { q = e.target.value.trim(); reload(); }, 250); });
  $('#log-clear').addEventListener('click', async () => { if (await confirmBox('Every stored log entry will be deleted. This cannot be undone.', { ok: 'Clear', danger: true, title: 'Clear the log?' })) { await api('/logs', { method: 'DELETE' }); rerender(); } });
  $('#sys-reinfer').addEventListener('click', async () => { try { const r = await api('/history/reinfer', { method: 'POST' }); toast(`Re-dated history for ${r.entries} titles`); } catch (e) { fail(e); } });
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-enrich]');
    if (!b) return;
    try { await api(`/accounts/${b.dataset.enrich}/enrich`, { method: 'POST' }); toast('Fetching achievement times / release dates in the background'); } catch (err) { fail(err); }
  });
  $('#sys-dl').addEventListener('click', async () => {
    const [d, l, syncs] = await Promise.all([api('/system'), api('/logs?limit=1000'), api('/syncs?limit=200')]);
    const blob = new Blob([JSON.stringify({ generated_at: new Date().toISOString(), system: d, logs: l.items, syncs }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `vestigo-diagnostics-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  });
}

// =====================================================================
// Improve history: answer "when did you play this?" for the least certain games
// =====================================================================
const PERIODS = [['year', 'Whole year', 0, 11], ['q1', 'Jan – Mar', 0, 2], ['q2', 'Apr – Jun', 3, 5], ['q3', 'Jul – Sep', 6, 8], ['q4', 'Oct – Dec', 9, 11],
  ...['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => [`m${i}`, m, i, i])];

async function historyPage(view, stale) {
  const [rev, accts] = await Promise.all([api('/history/review?limit=30'), api('/accounts')]);
  if (stale()) return;
  const steam = (accts.items || accts).filter((a) => a.platform === 'steam');
  const m = rev.meter;
  const all = Object.values(m).reduce((a, x) => a + x, 0) || 1;
  const seg = [['high', 'var(--good)', 'High confidence'], ['manual', 'var(--accent-mark)', 'Set by you'], ['medium', 'var(--warn)', 'Medium'], ['low', 'var(--bad)', 'Low'], ['undated', 'var(--line)', 'Undated']];
  const sure = Math.round(((m.high + m.manual + m.medium * 0.5) / all) * 100);
  const yearOpts = (it) => {
    const hi = new Date(Math.min(Date.now(), it.evidence.tracking_start || Date.now())).getFullYear();
    const lo = Math.max(2003, it.evidence.release_at ? new Date(it.evidence.release_at).getFullYear() : hi - 20);
    const guess = it.window ? new Date((it.window[0] + it.window[1]) / 2).getFullYear() : hi;
    const out = [];
    for (let y = hi; y >= lo; y--) out.push(`<option value="${y}" ${y === guess ? 'selected' : ''}>${y}</option>`);
    return out.join('');
  };
  const row = (it) => `<div class="item hist-row" data-entry="${it.entry_id}" style="align-items:flex-start;padding:14px 4px">
      ${cover({ title: it.title, cover_url: it.cover_url }, 'sm')}
      <div class="grow stack" style="gap:6px;min-width:0">
        <div class="row between wrap"><a class="ttl" href="/game/${it.game_id}" data-link>${esc(it.title)}</a><b class="nowrap">${fmtMin(it.minutes, { short: it.minutes >= 600 })}</b></div>
        <div class="tiny muted">${platDot(it.platform)} ${esc(it.account_name || plat(it.platform).label)} · ${it.window
          ? `now guessed <b>${fmtDate(it.window[0], { year: 'numeric', month: 'short' })} – ${fmtDate(it.window[1], { year: 'numeric', month: 'short' })}</b> <span class="conf-${it.confidence}">(${it.confidence})</span>`
          : 'no dates known'}${it.undated ? ` · ${fmtMin(it.undated)} undated` : ''}${it.evidence.last_played_at ? ` · last played ${fmtDate(it.evidence.last_played_at, { year: 'numeric', month: 'short', day: 'numeric' })}` : ''}</div>
        ${it.window ? `<div class="row wrap" style="gap:6px"><button class="btn sm" data-confirm>${icon('check')}Looks right</button><span class="tiny muted">or correct it:</span></div>` : ''}
        <div class="row wrap" style="gap:6px"><span class="small">Mostly played in</span>
          <select class="input sm" name="y" style="width:auto" aria-label="Year">${yearOpts(it)}</select>
          <select class="input sm" name="p" style="width:auto" aria-label="Period">${PERIODS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
          <label class="small row" style="gap:4px"><input type="checkbox" name="span"> until</label>
          <select class="input sm hide" name="y2" style="width:auto" aria-label="Until year">${yearOpts(it)}</select>
          <button class="btn sm primary" data-answer>${icon('check')}Save</button>
          <button class="btn sm ghost" data-undated>Don’t chart</button>
          <button class="btn sm ghost" data-skip>Skip</button></div>
      </div></div>`;
  view.innerHTML = `
    <div class="page-h"><div><h1>Improve history</h1><p>Platforms only report lifetime totals, so play from before tracking is dated from whatever evidence exists. Answer roughly when you played the least certain games — one click each.</p></div></div>
    <div class="card"><div class="card-h"><h2>How well your history is dated</h2><b class="nowrap">${sure}% solid</b></div>
      <div class="meter" style="height:12px;display:flex">${seg.map(([k, c]) => (m[k] ? `<i style="width:${(m[k] / all) * 100}%;background:${c}" title="${k}"></i>` : '')).join('')}</div>
      <div class="row wrap" style="margin-top:10px;gap:14px">${seg.map(([k, c, l]) => `<span class="tiny"><span class="dot" style="background:${c}"></span> ${l} ${fmtHours(m[k], 0)}h</span>`).join('')}</div>
      <p class="tiny muted" style="margin-bottom:0">${rev.style ? `Dating uses your own play pattern, learned from ${rev.style.games} games tracked from start to finish.` : 'Once a few games have been tracked from first session to last, Vestigo learns how you spread play over a game and dates history the same way.'}</p></div>
    ${steam.length ? `<div class="card" style="margin-top:16px"><div class="card-h"><h2>Steam purchase dates</h2><a class="small link" href="https://store.steampowered.com/account/licenses/" target="_blank" rel="noopener">Open your licenses page${icon('external', 'ic-inline')}</a></div>
      <p class="small muted" style="margin-top:0">Steam never shares when you got a game, but its licenses page lists it. Select the whole table there (Ctrl+A works), copy, and paste it here — every matched game gets a start date for its history.</p>
      <div class="field"><textarea class="input" id="lic-text" aria-label="Steam licenses table" rows="4" style="height:auto;padding:10px 12px;font-family:var(--mono, monospace);font-size:12.5px" placeholder="20 Nov, 2015	Counter-Strike: Global Offensive	Steam Store"></textarea></div>
      <div class="row wrap" style="margin-top:10px">${steam.length > 1 ? `<select class="input sm" id="lic-acc" style="width:auto" aria-label="Steam account">${steam.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>` : `<input type="hidden" id="lic-acc" value="${steam[0].id}">`}
        <button class="btn primary sm" id="lic-go">Import purchase dates</button><span class="tiny muted" id="lic-res"></span></div></div>` : ''}
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Least certain first</h2><span class="tiny muted">${rev.total} games · ${fmtHours(rev.uncertain_minutes, 0)}h uncertain</span></div>
      <div id="hist-list">${rev.items.map(row).join('') || `<div class="empty" style="padding:24px"><div class="em-ic">${icon('check')}</div><h2>Nothing left to answer</h2><p>All pre-tracking history is dated from solid evidence or by you.</p></div>`}</div>
      ${rev.total > rev.items.length ? '<button class="btn sm ghost" id="hist-more" style="margin-top:10px">Show more</button>' : ''}</div>`;
  let offset = rev.items.length;
  const done = (el, msg) => { el.style.opacity = '.45'; el.querySelectorAll('button,select,input').forEach((x) => { x.disabled = true; }); if (msg) toast(msg); };
  view.addEventListener('change', (e) => {
    if (e.target.name === 'span') e.target.closest('.hist-row').querySelector('[name=y2]').classList.toggle('hide', !e.target.checked);
  });
  view.addEventListener('click', async (e) => {
    const el = e.target.closest('.hist-row');
    if (el && e.target.closest('[data-skip]')) { el.remove(); return; }
    if (el && e.target.closest('[data-confirm]')) {
      try { await api(`/entries/${el.dataset.entry}/history`, { method: 'PATCH', body: { confirm: true } }); done(el, 'Kept as guessed'); } catch (err) { fail(err); }
      return;
    }
    if (el && e.target.closest('[data-undated]')) {
      try { await api(`/entries/${el.dataset.entry}/history`, { method: 'PATCH', body: { mode: 'undated' } }); done(el, 'Kept out of charts'); } catch (err) { fail(err); }
      return;
    }
    if (el && e.target.closest('[data-answer]')) {
      const y = Number(el.querySelector('[name=y]').value);
      const [, , m0, m1] = PERIODS.find(([k]) => k === el.querySelector('[name=p]').value);
      const y2 = el.querySelector('[name=span]').checked ? Math.max(y, Number(el.querySelector('[name=y2]').value)) : y;
      const start = new Date(y, m0, 1, 12);
      const end = new Date(Math.min(Date.now(), new Date(y2, m1 + 1, 0, 20).getTime()));
      try {
        await api(`/entries/${el.dataset.entry}/history`, { method: 'PATCH', body: { first_played_at: start.toISOString(), last_played_at: end.toISOString(), mode: 'auto' } });
        done(el, `Re-dated to ${fmtDate(start, { year: 'numeric', month: 'short' })} – ${fmtDate(end, { year: 'numeric', month: 'short' })}`);
      } catch (err) { fail(err); }
      return;
    }
    if (e.target.closest('#hist-more')) {
      const more = await api(`/history/review?limit=30&offset=${offset}`);
      offset += more.items.length;
      $('#hist-list').insertAdjacentHTML('beforeend', more.items.map(row).join(''));
      if (offset >= more.total || !more.items.length) e.target.closest('#hist-more').remove();
      return;
    }
    if (e.target.closest('#lic-go')) {
      const text = $('#lic-text').value.trim();
      if (!text) return toast('Paste the licenses table first', { bad: true });
      const url = (dry) => `/accounts/${$('#lic-acc').value}/licenses${dry ? '?dry_run=true' : ''}`;
      try {
        const p = await api(url(true), { method: 'POST', body: { text } });
        $('#lic-res').innerHTML = `Preview: ${p.licenses} licenses · ${p.matched} games matched · ${p.history_redated} would be re-dated${p.unmatched ? ` · ${p.unmatched} not in library (bundles, DLC, removed)` : ''} <button class="btn sm primary" id="lic-apply">Apply</button>`;
        $('#lic-apply').addEventListener('click', async () => {
          try {
            const r = await api(url(false), { method: 'POST', body: { text } });
            $('#lic-res').textContent = `${r.licenses} licenses read · ${r.matched} games matched · ${r.history_redated} re-dated`;
            toast(`Purchase dates added to ${r.matched} games`);
          } catch (err) { fail(err); }
        });
      } catch (err) { fail(err); }
    }
  });
}

// =====================================================================
// More (mobile)
// =====================================================================
const MORE_DESC = {
  '/insights': 'When, what and how you play', '/duplicates': 'Merge editions, fix double counting', '/history': 'Date play from before tracking', '/accounts': 'Steam, Xbox, PlayStation, custom',
  '/settings': 'Schedule, import/export, security', '/system': 'Error log, API usage, diagnostics', '/api': 'Tokens, push endpoint, docs',
};
/** The phone's More tab: the sidebar's groups (minus the tabs), Year in review on top, and what needs a look counted on each row. */
async function more(view, stale) {
  const accs = await api('/accounts').catch(() => []);
  if (stale()) return;
  const paused = accs.filter((a) => !a.enabled).length;
  const counts = {
    '/duplicates': '<span class="badge accent hide" data-count="dupes"></span>',
    '/system': '<span class="badge bad hide" data-count="errors"></span>',
  };
  // Accounts says how many and how many are paused instead of describing itself
  const desc = { ...MORE_DESC, ...(accs.length ? { '/accounts': `${plural(accs.length, 'account')}${paused ? ` · ${paused} paused` : ''}` } : {}) };
  const items = navItems().filter((n) => !n.tab);
  const year = items.find((n) => n.path === '/wrapped');
  const row = (n) => `<a class="item more-row" href="${n.href}" data-link><span class="mi">${icon(n.icon, 'ic-18')}</span><span class="grow"><span class="ttl">${n.label}</span><span class="sub">${desc[n.path] || ''}</span></span>${counts[n.path] || ''}${icon('chevR', 'ic-16 chev')}</a>`;
  view.innerHTML = `<div class="page-h"><h1>More</h1></div>
    <a class="more-feature" href="${year.href}" data-link><span class="mi">${icon('trail', 'ic-18')}</span><span class="grow"><span class="ttl">Year in review</span><span class="sub">The trail you left in ${state.latestYear}</span></span>${icon('chevR', 'ic-16 chev')}</a>
    ${NAV_GROUPS.map((g) => [g, items.filter((n) => n.group === g && n !== year)]).filter(([, list]) => list.length).map(([g, list], i) => `<section class="more-sec" aria-labelledby="mg-${i}"><h2 class="nav-group" id="mg-${i}">${g}</h2><div class="card pad-0">${list.map(row).join('')}</div></section>`).join('')}
    ${state.authEnabled ? `<button class="btn" style="margin-top:16px;width:100%" data-action="logout">${icon('logout')}Log out</button>` : ''}`;
  applyBadges();
}

export const pages = { dashboard, library, game, sessions, stats, insights, wrapped, duplicates, accounts, settings, apidocs, more, system, history: historyPage };
