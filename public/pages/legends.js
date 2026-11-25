// Legends: the stories in your career. Insights digs for findings and Milestones hands out badges;
// a legend follows one thread - a series, a maker, a console generation, a trend, a platform, an
// era of your own - from where it began to where it stands.
import { esc, fmtMin, fmtDate, plat, platDot, icon, api, plural, setTitle, cover, coverHue, monogram, navigate, modal, toast, fail, confirmBox } from '../app.js';
import { barChart, mountCharts, BASIS_FILL } from '../charts.js';
import { emptyState, prose } from './shared.js';
import { franchiseBody } from './franchises.js';

const KIND = { series: 'Series', maker: 'Maker', generation: 'Console generation', trend: 'Trend', platform: 'Platform', era: 'Your era', career: 'Career' };
const hours = (m) => fmtMin(m, { short: m >= 600 });
const span = (a, b) => (a && b && a !== b ? `${a}–${b}` : a || b || '');
const href = (c) => `/legend/${c.kind}/${encodeURIComponent(c.id)}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayTime = (k) => new Date(`${k}T12:00`).getTime();
const monthYear = (k) => fmtDate(dayTime(k), { month: 'long', year: 'numeric' });
const platName = (c) => (c.kind === 'platform' ? plat(c.id).label : c.name);

// an era's games: the ones with time in it, and what was unlocked then (often all an older console left)
const eraGames = (c) => [c.played || !c.unlocks ? plural(c.played, 'game') : null,
  c.unlocks ? `${c.unlocks.toLocaleString()} ${c.unlocks === 1 ? 'achievement' : 'achievements'} in ${plural(c.unlock_games, 'game')}` : null].filter(Boolean).join(' · ');

/** A legend's card: up to three covers, its name, what it is, and how much of your time is in it. */
function card(c) {
  const covers = (c.covers || []).slice(0, 3);
  const art = covers.length ? `<div class="fr-covers n${covers.length}">${covers.map((u) => `<img src="${esc(u)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`).join('')}</div>`
    : `<div class="fr-covers ph" style="--ph-h:${coverHue(c.name)}"><span>${esc(monogram(platName(c)))}</span></div>`;
  const when = c.kind === 'era' ? `${monthYear(c.from_day)} – ${c.to_day ? monthYear(c.to_day) : 'today'}` : c.tagline || '';
  return `<a class="card fr-card lg-card" href="${href(c)}" data-link>
    ${art}
    <div class="fr-body">
      <div class="row between" style="gap:8px"><span class="ttl">${esc(platName(c))}</span><b class="nowrap">${c.minutes ? hours(c.minutes) : ''}</b></div>
      ${when ? `<div class="tiny muted lg-tag">${esc(when)}</div>` : ''}
      <div class="sub">${c.kind === 'series' && c.mainline ? `${c.mainline.played} of ${plural(c.mainline.total, 'main game')} played` : c.kind === 'era' ? eraGames(c) : plural(c.games, 'game')}${c.kind !== 'era' && span(c.from, c.to) ? ` · played ${span(c.from, c.to)}` : ''}</div>
      ${c.top ? `<div class="tiny muted ellipsis">Most of all: ${esc(c.top)}</div>` : c.your_era ? `<div class="tiny muted ellipsis">Your era: ${esc(c.your_era)}</div>` : ''}
    </div></a>`;
}

const section = (id, title, line, body, action = '') => `<section class="lg-sec" id="lg-${id}"><div class="row wrap between lg-h"><div><h2>${title}</h2><p class="small muted">${line}</p></div>${action}</div>${body}</section>`;

export async function legendsPage(view, stale) {
  const l = await api('/legends');
  if (stale()) return;
  const c = l.career;
  const grid = (cards) => `<div class="fr-grid">${cards.map(card).join('')}</div>`;
  const eras = l.eras.length ? `<div class="fr-grid">${l.eras.map(card).join('')}</div>`
    : `<div class="card lg-empty"><p><b>Name a stretch of your life</b> - college, a first job, the year in another city - and see what you played in it: the games that defined it, what was new, how it ended.</p>
        <button class="btn primary" data-era-add>${icon('plus')}Add an era</button></div>`;
  view.innerHTML = `<div class="page-h"><div><h1>Legends</h1><p>The stories in your career: the series you followed, the people who made them, the consoles and crazes you lived through, and the eras of your own life.</p></div></div>
    ${c.games ? `<a class="card lg-career" href="/legend/career/all" data-link><div class="eyebrow">Your career</div>
      <div class="lg-career-t">${c.minutes ? hours(c.minutes) : 'No play yet'} <span class="muted">across ${plural(c.games, 'game')}${span(c.from, c.to) ? `, ${span(c.from, c.to)}` : ''}</span></div>
      <div class="small muted">${c.top ? `${esc(c.top)} most of all · ` : ''}Read the whole story${icon('arrowR', 'ic-inline')}</div></a>`
    : `<div class="card">${emptyState('trail', 'No legends yet', 'They appear with your library: connect an account or add a game, and the series, makers and console generations in it each get a story.', `<a class="btn primary" href="/accounts?add=1" data-link>${icon('plus')}Connect an account</a>`)}</div>`}
    ${c.games ? section('eras', 'Your eras', 'Stretches of your life, and what you played in them', eras, l.eras.length ? `<button class="btn sm" data-era-add>${icon('plus')}Add an era</button>` : '') : ''}
    ${l.series.length ? section('series', 'Series', 'The franchises you followed, each with its timeline and the games you have not played yet', grid(l.series),
      `<a class="btn sm ghost" href="/legends/series" data-link>${l.series_total > l.series.length ? `All ${l.series_total} series` : 'All series'}${icon('arrowR', 'ic-inline')}</a>`) : ''}
    ${l.generations.length ? section('generations', 'Console generations', 'The games of each hardware era, whenever you got to them', grid(l.generations)) : ''}
    ${l.trends.length ? section('trends', 'Trends', 'The things games were into for a while, and whether you were there', grid(l.trends)) : ''}
    ${l.makers.length ? section('makers', 'Makers', 'The studios and publishers behind what you play', grid(l.makers)) : ''}
    ${l.platforms.length > 1 ? section('platforms', 'Platforms', 'Where you played', grid(l.platforms)) : ''}`;
  view.addEventListener('click', (e) => { if (e.target.closest('[data-era-add]')) eraModal(); });
}

/** Hours by year (or by month, for a short era): estimated history hatched, the game that led in the tip. */
function timeChart(l) {
  const byMonth = !!l.months;
  const rows = byMonth ? l.months : l.years;
  if (!rows.some((r) => r.minutes > 0)) return '';
  const items = rows.map((r) => {
    const name = byMonth ? monthYear(`${r.key}-01`) : String(r.year);
    const short = byMonth ? fmtDate(dayTime(`${r.key}-01`), { month: 'short' }) + (r.key.endsWith('-01') || r === rows[0] ? ` ’${r.key.slice(2, 4)}` : '') : String(r.year);
    const tracked = Math.max(0, r.minutes - r.estimated);
    return { label: short, name, value: r.minutes, tip: `${name}: ${fmtMin(r.minutes)}${r.estimated ? ` (${fmtMin(r.estimated)} dated from history)` : ''}${r.top ? ` · ${r.top.title} led` : ''}`,
      stack: [{ key: 'tracked', value: tracked, color: 'var(--accent-mark)' }, { key: 'estimated', value: r.estimated, color: BASIS_FILL.estimated }] };
  });
  const title = `${l.name}, hours by ${byMonth ? 'month' : 'year'}`;
  return `<div class="card" style="margin-top:16px"><div class="card-h"><h2>${byMonth ? 'Month by month' : 'Year by year'}</h2><span class="tiny muted">${rows.some((r) => r.estimated) ? 'hatched: dated from history before tracking' : ''}</span></div>
    ${barChart(items, { size: 'page', title })}</div>`;
}

function gameRow(g) {
  const played = g.first_day ? span(g.first_day.slice(0, 4), g.last_day?.slice(0, 4)) : '';
  return `<a class="item" href="/game/${g.id}" data-link>${cover(g)}<div class="grow"><div class="ttl ellipsis">${esc(g.title)}</div>
    <div class="sub">${(g.platforms || []).map(platDot).join('')}${played ? `played ${played}` : g.minutes ? 'not dated yet' : 'not played yet'}${g.release_year ? ` · released ${g.release_year}` : ''}</div></div>
    <div class="amt">${g.minutes ? hours(g.minutes) : ''}</div></a>`;
}

export async function legendPage(view, kind, id, stale) {
  let key = id;
  try { key = decodeURIComponent(id); } catch { /* a malformed %-escape: the id as it is */ }
  const l = await api(`/legends/${kind}/${encodeURIComponent(key)}`);
  if (stale()) return;
  const name = kind === 'platform' ? plat(l.id).label : l.name;
  setTitle(name);
  const t = l.totals;
  const era = l.era;
  const back = kind === 'series' ? ['/legends/series', 'Series'] : ['/legends', 'Legends'];
  const SHOWN = 12;
  const what = kind === 'era' ? `${monthYear(l.window.from)} – ${era.to ? monthYear(l.window.to) : 'today'}`
    : kind === 'generation' ? l.generation.short : kind === 'trend' ? (l.peak.to ? `At its height ${l.peak.from}–${l.peak.to}` : `Since ${l.peak.from}`) : '';
  view.innerHTML = `<a href="${back[0]}" data-link class="btn ghost sm" style="margin:-4px 0 10px -6px">${icon('back')}${back[1]}</a>
    <div class="page-h"><div><div class="eyebrow">${KIND[kind]}${what ? ` · ${esc(what)}` : ''}</div><h1>${esc(name)}</h1>${l.tagline ? `<p>${esc(l.tagline)}</p>` : ''}</div>
      ${kind === 'era' ? `<div class="row"><button class="btn sm" id="lg-edit">${icon('edit')}Edit</button><button class="btn sm ghost" id="lg-del">${icon('trash')}Remove</button></div>` : ''}</div>
    <div class="kpis k4 strip">
      <div class="kpi"><div class="label">Played</div><div class="value">${t.minutes ? hours(t.minutes) : '0h'}</div><div class="sub">${t.undated ? `${hours(t.undated)} of it not dated yet` : kind === 'era' ? 'in this era' : 'history included'}</div></div>
      <div class="kpi"><div class="label">Games</div><div class="value">${kind === 'era' ? t.played : t.games}</div><div class="sub">${kind === 'era' ? 'played in it' : t.played === t.games ? 'all of them played' : `${t.played} played`}</div></div>
      <div class="kpi"><div class="label">${kind === 'era' ? 'Series' : 'Years'}</div><div class="value">${kind === 'era' ? t.series : t.active_years}</div><div class="sub">${kind === 'era' ? 'you were in' : t.first_day ? `${span(t.first_day.slice(0, 4), t.last_day.slice(0, 4))}` : 'no dated play yet'}</div></div>
      <div class="kpi"><div class="label">${kind === 'era' ? 'Badges' : 'Finished'}</div><div class="value">${kind === 'era' ? (l.milestones || []).length : t.finished ?? 0}</div><div class="sub">${kind === 'era' ? 'milestones reached in it' : 'completed or beaten'}</div></div>
    </div>
    <div class="card lg-story" style="margin-top:16px"><div class="card-h"><h2>The story</h2></div>
      ${l.chapters.length ? l.chapters.map((c) => `<div class="lg-ch" data-ch="${c.id}"><h3>${esc(c.title)}</h3><p>${prose(c.parts)}</p></div>`).join('')
    : `<p class="muted">${kind === 'era' ? 'Nothing you played is dated to this era yet. History from before tracking fills in as its dates are set (Improve history).' : 'There is nothing to tell yet: none of it has been played.'}</p>`}</div>
    ${timeChart(l)}
    ${kind === 'era' && l.milestones?.length ? `<div class="card" style="margin-top:16px"><div class="card-h"><h2>Milestones reached in it</h2><a class="small" href="/milestones" data-link>All milestones${icon('arrowR', 'ic-inline')}</a></div>
      <div class="list two-col">${l.milestones.map((m) => `<div class="item"><span class="mi">${icon('trophy', 'ic-16')}</span><div class="grow"><div class="ttl">${esc(m.text)}</div><div class="sub">${esc(m.precision === 'day' ? fmtDate(dayTime(m.day), { year: 'numeric', month: 'short', day: 'numeric' }) : monthYear(m.day))}</div></div></div>`).join('')}</div></div>` : ''}
    ${l.games.length ? `<div class="card" style="margin-top:16px"><div class="card-h"><h2>${kind === 'era' ? 'What you played' : 'The games'}</h2><span class="tiny muted">most played first</span></div>
      <div class="list" id="lg-games">${l.games.slice(0, SHOWN).map(gameRow).join('')}</div>
      ${l.games.length > SHOWN ? `<button class="btn sm ghost" id="lg-more" style="margin-top:10px">Show all ${l.games.length}</button>` : ''}</div>` : ''}
    ${kind !== 'series' && (l.series.length > 1 || l.platforms.length > 1) ? `<div class="grid grid-2" style="margin-top:16px">
      ${l.series.length > 1 ? `<div class="card"><div class="card-h"><h2>The series in it</h2></div><div class="list">${l.series.slice(0, 8).map((s) => `<a class="item" href="/legend/series/${encodeURIComponent(s.id)}" data-link><div class="grow"><div class="ttl ellipsis">${esc(s.name)}</div><div class="sub">${plural(s.games, 'game')}</div></div><div class="amt">${hours(s.minutes)}</div></a>`).join('')}</div></div>` : ''}
      ${l.platforms.length > 1 ? `<div class="card"><div class="card-h"><h2>Where you played it</h2></div><div class="list">${l.platforms.map((p) => `<a class="item" href="/legend/platform/${encodeURIComponent(p.platform)}" data-link>${platDot(p.platform)}<div class="grow"><div class="ttl">${esc(plat(p.platform).label)}</div><div class="sub">${plural(p.games, 'game')}</div></div><div class="amt">${p.minutes ? hours(p.minutes) : ''}</div></a>`).join('')}</div></div>` : ''}</div>` : ''}
    ${kind === 'series' ? '<h2 class="lg-sub">The series, game by game</h2><div id="lg-series"></div>' : ''}`;
  mountCharts(view);
  if (kind === 'series') franchiseBody(view.querySelector('#lg-series'), l.series_detail);
  view.querySelector('#lg-more')?.addEventListener('click', (e) => { view.querySelector('#lg-games').innerHTML = l.games.map(gameRow).join(''); e.target.remove(); });
  view.querySelector('#lg-edit')?.addEventListener('click', () => eraModal(era));
  view.querySelector('#lg-del')?.addEventListener('click', async () => {
    if (!await confirmBox('Only the era goes: your games and play stay as they are.', { ok: 'Remove', danger: true, title: `Remove the era "${era.name}"?` })) return;
    try { await api(`/legends/eras/${era.id}`, { method: 'DELETE' }); toast('Era removed'); navigate('/legends'); } catch (err) { fail(err); }
  });
}

/** Add an era of your own, or change one: a name and the months it ran from and to. */
export function eraModal(era = null) {
  const now = new Date();
  const part = (d, i) => (d ? Number(d.split('-')[i]) : null);
  const years = (sel) => { let o = ''; for (let y = now.getFullYear(); y >= 1970; y--) o += `<option value="${y}" ${y === sel ? 'selected' : ''}>${y}</option>`; return o; };
  const months = (sel) => MONTHS.map((m, i) => `<option value="${i + 1}" ${i + 1 === sel ? 'selected' : ''}>${m}</option>`).join('');
  const ongoing = era ? !era.to : false;
  modal({
    title: era ? 'Edit era' : 'Add an era',
    body: `<form class="stack" id="era-f" autocomplete="off">
      <div class="field"><label for="era-name">Name</label><input class="input" id="era-name" name="name" maxlength="60" required placeholder="College, high school, the Seattle years…" value="${esc(era?.name || '')}"></div>
      <div class="grid grid-2">
        <div class="field"><label for="era-fm">From</label><div class="row" style="gap:6px"><select class="input" id="era-fm" name="fm" aria-label="From month">${months(part(era?.from, 1) || 9)}</select><select class="input" name="fy" aria-label="From year">${years(part(era?.from, 0) || now.getFullYear() - 4)}</select></div></div>
        <div class="field"><label for="era-tm">To</label><div class="row" style="gap:6px" id="era-to"><select class="input" id="era-tm" name="tm" aria-label="To month" ${ongoing ? 'disabled' : ''}>${months(part(era?.to, 1) || 6)}</select><select class="input" name="ty" aria-label="To year" ${ongoing ? 'disabled' : ''}>${years(part(era?.to, 0) || now.getFullYear())}</select></div>
          <label class="small row" style="gap:6px;margin-top:6px"><input type="checkbox" name="ongoing" ${ongoing ? 'checked' : ''}> Still going</label></div>
      </div>
      <div class="field"><label for="era-note">A line about it <span class="dim">(optional)</span></label><input class="input" id="era-note" name="note" maxlength="200" placeholder="Dorm room, a shared Xbox 360" value="${esc(era?.note || '')}"></div>
      <p class="tiny muted" style="margin:0">Its story is told from what you played between those months, history from before tracking included where it has dates.</p>
    </form>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="era-save">${era ? 'Save' : 'Add era'}</button>`,
    onMount(el, close) {
      const f = el.querySelector('#era-f');
      f.ongoing.addEventListener('change', () => { f.tm.disabled = f.ty.disabled = f.ongoing.checked; });
      let saving = false;
      const save = async () => {
        if (saving) return;
        const name = f.name.value.trim();
        if (!name) { toast('Give the era a name', { bad: true }); f.name.focus(); return; }
        const pad = (n) => String(n).padStart(2, '0');
        const body = { name, from: `${f.fy.value}-${pad(f.fm.value)}`, to: f.ongoing.checked ? '' : `${f.ty.value}-${pad(f.tm.value)}`, note: f.note.value.trim() };
        if (body.to && body.to < body.from) { toast('An era ends after it begins', { bad: true }); return; }
        saving = true;
        try {
          const e = await api(era ? `/legends/eras/${era.id}` : '/legends/eras', { method: era ? 'PATCH' : 'POST', body });
          close();
          toast(era ? 'Era saved' : 'Era added');
          navigate(`/legend/era/${e.id}`, { replace: !!era });
        } catch (err) { saving = false; fail(err); }
      };
      el.querySelector('#era-save').addEventListener('click', save);
      f.addEventListener('submit', (e) => { e.preventDefault(); save(); });
    },
  });
}
