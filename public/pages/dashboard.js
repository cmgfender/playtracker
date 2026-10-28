import {
  $, esc, fmtMin, fmtHours, ago, fmtDate, fmtTime, plat, platDot, platIcon, STATUSES, cover, icon, api, toast, fail, modal,
  rerender, state, plural, MARK, tagline,
} from '../app.js';
import { barChart, sparkline, heatmap, topList, platformLegend, mountCharts } from '../charts.js';
import { mountSuggest } from '../suggest.js';
import { arrow, stackedSeries, estimatedLegend, kpi, hoursVal, sessionItem, logSessionModal, bindSessionEdits, H, D, dayKey, saveSettings } from './shared.js';
import { accountModal } from './accounts.js';

// =====================================================================
// Dashboard
// =====================================================================
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
export async function dashboard(view, stale) {
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
    suggest: () => '<div class="card sg" id="dash-suggest" role="region" aria-labelledby="sg-h"></div>',
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
  if ($('#dash-suggest')) mountSuggest($('#dash-suggest'), { platforms: d.lifetime.platforms.map((x) => x.platform) });
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
  suggest: { label: 'What should I play?', desc: 'A pick for the time you have' },
  chart: { label: 'Last 30 days', desc: 'Daily chart', half: true },
  top: { label: 'Top this month', desc: 'Most played games', half: true },
  recent: { label: 'Recent sessions', desc: '', half: true },
  accounts: { label: 'Accounts', desc: 'Sync status', half: true },
  heatmap: { label: 'Year heatmap', desc: 'Every day of this year' },
  backlog: { label: 'Up next', desc: 'Games marked Playing or Backlog' },
};
const DEFAULT_LAYOUT = 'kpis,live,jump,suggest,chart,top,recent,accounts,-heatmap,-backlog';

export function parseLayout(str) {
  const out = String(str || DEFAULT_LAYOUT).split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => ({ key: x.replace(/^-/, ''), on: !x.startsWith('-') })).filter((x) => DASH_SECTIONS[x.key]);
  for (const k of Object.keys(DASH_SECTIONS)) if (!out.some((x) => x.key === k)) out.push({ key: k, on: false });
  return out;
}
const layoutString = (list) => list.map((x) => (x.on ? x.key : `-${x.key}`)).join(',');

/** Show/hide and reorder home sections; calls onChange(layoutString) on every edit. */
export function layoutEditor(host, layout, onChange) {
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
