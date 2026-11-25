// Milestones: your career, year by year, as badges - the round numbers of everything you have played,
// with the day each was reached as precisely as the evidence allows: the day for tracked play and
// achievement unlocks, "around March 2015" or "in 2015" for estimated history, "date unknown" for
// what only undated history reaches. What is coming up first; the highlights or everything; a
// category at a time.
import { esc, fmtDate, icon, api, plural } from '../app.js';
import { emptyState } from './shared.js';

export const CATS = [
  ['playtime', 'Playtime', 'clock'], ['library', 'Library', 'library'], ['genres', 'Genres', 'grid'], ['series', 'Series', 'merge'],
  ['achievements', 'Achievements', 'trophy'], ['career', 'Career', 'trail'], ['habits', 'Habits', 'flame'],
];
const CAT = Object.fromEntries(CATS.map(([k, l, ic], i) => [k, { label: l, icon: ic, i }]));

/** When it was reached, as precisely as it is known. */
export function whenReached(x, { short = false } = {}) {
  if (!x.day) return 'Date unknown';
  const t = new Date(`${x.day}T12:00`).getTime();
  if (x.precision === 'year') return `In ${x.day.slice(0, 4)}`;
  if (x.precision === 'month') return `Around ${fmtDate(t, { month: short ? 'short' : 'long', year: 'numeric' })}`;
  return fmtDate(t, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The big figure on a badge: "1,000h", "50,000G", "10 yrs", "1st". */
function figure(x) {
  const v = x.value;
  if (/hours$/.test(x.kind) || x.kind === 'long_session') return `${v.toLocaleString()}<small>h</small>`;
  if (x.kind === 'gamerscore') return `${v >= 100000 ? `${v / 1000}k` : v.toLocaleString()}<small>G</small>`;
  if (['series_years', 'career_years', 'retro'].includes(x.kind)) return `${v}<small>${v === 1 ? 'yr' : 'yrs'}</small>`;
  if (v === 1) return '1<small>st</small>';
  if (['games', 'platforms', 'genres', 'series'].includes(x.kind) && x.subject) { const t = v % 100; return `${v.toLocaleString()}<small>${t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][v % 10] || 'th'}</small>`; }
  return v.toLocaleString();
}

/** A milestone's words, its game a link. */
function words(x) {
  const t = esc(x.text);
  return x.game_id && x.title ? t.replace(esc(x.title), () => `<a class="link" href="/game/${x.game_id}" data-link>${esc(x.title)}</a>`) : t;
}

const HOW = { estimated: 'from estimated history', unlock: 'an achievement unlock', platform: 'the platform’s first played date', tracked: '', undated: 'from history with no date' };

export function badge(x) {
  const c = CAT[x.category] || CAT.playtime;
  return `<div class="ms-badge${x.basis === 'estimated' ? ' est' : ''}${x.day ? '' : ' nodate'}" style="--mc:var(--era-${[0, 2, 3, 6, 1, 9, 5][c.i]})">
    <div class="ms-top"><span class="ms-ic" title="${c.label}">${icon(c.icon)}</span><span class="ms-fig">${figure(x)}</span></div>
    <div class="ms-t">${words(x)}</div>
    ${x.detail ? `<div class="tiny muted">${esc(x.detail)}</div>` : ''}
    ${x.category === 'series' && x.subject ? `<a class="tiny link" href="/legend/series/${encodeURIComponent(x.subject)}" data-link>Its story in Legends</a>` : ''}
    <div class="ms-when"><span>${esc(whenReached(x))}</span>${HOW[x.basis] ? `<span class="tiny muted" title="How the day is known">${HOW[x.basis]}</span>` : ''}</div>
  </div>`;
}

function comingTile(x) {
  const c = CAT[x.category] || CAT.playtime;
  const unit = /hours$/.test(x.kind) ? 'h' : '';
  return `<div class="ms-next" style="--mc:var(--era-${[0, 2, 3, 6, 1, 9, 5][c.i]})">
    <div class="row between" style="gap:8px"><span class="ms-t">${words(x)}</span><span class="ms-ic sm">${icon(c.icon)}</span></div>
    <div class="ms-bar" role="img" aria-label="${x.percent}% of the way"><i style="width:${x.percent}%"></i></div>
    <div class="tiny muted">${Math.floor(x.current).toLocaleString()}${unit} of ${x.target.toLocaleString()}${unit} · ${x.percent}%</div></div>`;
}

export async function milestonesPage(view, stale) {
  const q = new URLSearchParams(location.search);
  const st = { cat: CAT[q.get('category')] ? q.get('category') : '', every: q.get('show') === 'all' };
  const m = await api('/stats/milestones?all=true&limit=1000');
  if (stale()) return;
  const firstYear = m.first_day ? m.first_day.slice(0, 4) : null;
  view.innerHTML = `<div class="page-h"><div><h1>Milestones</h1><p>${m.total ? `${plural(m.total, 'milestone')} in a career that goes back to ${firstYear ? `${m.first_precision === 'day' ? '' : 'about '}${firstYear}` : 'before tracking'}` : 'The round numbers of your gaming life, from the first game on'}</p></div></div>
    <div id="ms-page"></div>`;
  const host = view.querySelector('#ms-page');
  if (!m.total && !m.coming.some((x) => x.current > 0)) {
    host.innerHTML = `<div class="card">${emptyState('trophy', 'No milestones yet', 'Connect Steam, Xbox or PlayStation (or add a game with the hours you played): every hour, game and achievement of your history counts, from the first one on.')}</div>`;
    return;
  }
  const paint = () => {
    const list = m.reached.filter((x) => (!st.cat || x.category === st.cat) && (st.every || x.notable));
    const years = new Map();
    for (const x of list) { const y = x.day ? x.day.slice(0, 4) : 'unknown'; if (!years.has(y)) years.set(y, []); years.get(y).push(x); }
    const coming = m.coming.filter((x) => x.current > 0 && (!st.cat || x.category === st.cat)).slice(0, 8);
    host.innerHTML = `<div class="row wrap between" style="gap:10px;margin-bottom:14px">
        <div class="chips" role="group" aria-label="Category"><button class="chip${st.cat ? '' : ' on'}" data-cat="" aria-pressed="${!st.cat}">All <span class="dim">${m.total}</span></button>${CATS.filter(([k]) => m.categories[k]).map(([k, l]) => `<button class="chip${st.cat === k ? ' on' : ''}" data-cat="${k}" aria-pressed="${st.cat === k}">${l} <span class="dim">${m.categories[k]}</span></button>`).join('')}</div>
        <div class="seg" aria-label="Show"><button data-every="0" class="${st.every ? '' : 'on'}">Highlights</button><button data-every="1" class="${st.every ? 'on' : ''}">Everything</button></div></div>
      ${coming.length ? `<div class="card" id="ms-next"><div class="card-h"><h2>Coming up</h2><span class="tiny muted">nearest first</span></div><div class="ms-next-grid">${coming.map(comingTile).join('')}</div></div>` : ''}
      ${list.length ? [...years].map(([y, xs]) => `<section class="ms-year" data-year="${y}"><div class="ms-yh"><h2>${y === 'unknown' ? 'Date unknown' : y}</h2><span class="tiny muted">${plural(xs.length, 'milestone')}${y !== 'unknown' && xs.every((x) => x.basis === 'estimated') ? ' · estimated history' : ''}</span></div>
          <div class="ms-grid">${xs.map(badge).join('')}</div></section>`).join('')
        : `<div class="card"><p class="muted" style="margin:0">Nothing here yet${st.every ? '' : ': the highlights are the highest rungs of each kind, and Everything shows the rest'}.</p></div>`}
      <p class="tiny muted">Dated from tracked play, achievement unlocks and the platforms’ dates to the day; from estimated history to the month or the year it most likely was (shown hatched). Streaks, days and sessions count tracked play only.</p>`;
  };
  paint();
  host.addEventListener('click', (e) => {
    const c = e.target.closest('[data-cat]');
    const v = e.target.closest('[data-every]');
    if (!c && !v) return;
    if (c) st.cat = c.dataset.cat;
    if (v) st.every = v.dataset.every === '1';
    const u = new URL(location.href);
    st.cat ? u.searchParams.set('category', st.cat) : u.searchParams.delete('category');
    st.every ? u.searchParams.set('show', 'all') : u.searchParams.delete('show');
    history.replaceState(history.state, '', u);
    paint();
  });
}
