// Franchises: the series in your library, the big ones with every entry in release order (the ones
// you don't own too), what to play next, the order you played them in, and - where the story is
// told out of order - the story order.
import { esc, fmtMin, fmtDate, platDot, icon, api, plural, setTitle, coverHue, monogram } from '../app.js';
import { emptyState } from './shared.js';

const KIND = { spinoff: 'Spin-off', remake: 'Remake', remaster: 'Remaster', collection: 'Collection', other: 'Also in the series' };
const STATE = {
  finished: ['Finished', 'good'], playing: ['Playing', 'accent'], played: ['Played', ''], dropped: ['Dropped', 'bad'], owned: ['In your library', ''], missing: ['Not in your library', ''],
};
const MON = { year: 'numeric', month: 'short' };
const years = (a, b) => (a && b && a !== b ? `${a}–${b}` : a || b || '');
const played = (f) => years(f.first_day?.slice(0, 4), f.last_day?.slice(0, 4));

/** Up to four covers of the franchise's games, most played first. */
function covers(f) {
  const c = f.covers.slice(0, 4);
  if (!c.length) return `<div class="fr-covers ph" style="--ph-h:${coverHue(f.name)}"><span>${esc(monogram(f.name))}</span></div>`;
  return `<div class="fr-covers n${c.length}">${c.map((u) => `<img src="${esc(u)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`).join('')}</div>`;
}

function card(f) {
  const m = f.mainline;
  const pct = m && m.total ? Math.round((m.played / m.total) * 100) : null;
  return `<a class="card fr-card" href="/franchise/${encodeURIComponent(f.id)}" data-link>
    ${covers(f)}
    <div class="fr-body">
      <div class="row between" style="gap:8px"><span class="ttl">${esc(f.name)}</span><b class="nowrap">${f.minutes ? fmtMin(f.minutes, { short: f.minutes >= 600 }) : ''}</b></div>
      <div class="sub">${m ? `${m.played} of ${plural(m.total, 'main game')} played` : plural(f.games, 'game')}${played(f) ? ` · played ${played(f)}` : ''}</div>
      ${pct != null ? `<div class="ms-bar" role="img" aria-label="${pct}% of the main games played"><i style="width:${pct}%;background:var(--accent-mark)"></i></div>` : ''}
      ${f.next ? `<div class="tiny muted ellipsis">Next: ${esc(f.next.title)} (${f.next.year})</div>` : ''}
    </div></a>`;
}

export async function franchises(view, stale) {
  const r = await api('/franchises');
  if (stale()) return;
  view.innerHTML = `<div class="page-h"><div><h1>Franchises</h1><p>${r.total ? `${plural(r.total, 'series', 'series')} in your library · ${r.curated} of the big ones, with every entry in the order it came out` : 'The series your games belong to'}</p></div></div>
    <div id="fr-host"></div>`;
  const host = view.querySelector('#fr-host');
  if (!r.total) {
    host.innerHTML = `<div class="card">${emptyState('grid', 'No series yet', 'Franchises show up as soon as your library holds a game of one: the big ones (Halo, Final Fantasy, Resident Evil…) with every entry in release order, the rest from IGDB and the titles.')}</div>`;
    return;
  }
  const st = { q: '', only: '' };
  const paint = () => {
    const want = st.q.toLowerCase();
    const list = r.items.filter((f) => (!want || f.name.toLowerCase().includes(want)) && (!st.only || (st.only === 'curated') === f.curated));
    host.querySelector('#fr-list').innerHTML = list.length ? list.map(card).join('') : '<p class="muted">No series match.</p>';
  };
  host.innerHTML = `<div class="row wrap between" style="gap:10px;margin-bottom:14px">
      <div class="search grow" style="max-width:360px">${icon('search')}<input class="input" id="fr-q" placeholder="Search series" aria-label="Search series"></div>
      <div class="seg" aria-label="Show"><button data-only="" class="on">All</button><button data-only="curated">The big ones</button><button data-only="other">Others</button></div></div>
    <div class="fr-grid" id="fr-list"></div>`;
  paint();
  host.querySelector('#fr-q').addEventListener('input', (e) => { st.q = e.target.value; paint(); });
  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-only]');
    if (!b) return;
    st.only = b.dataset.only;
    host.querySelectorAll('[data-only]').forEach((x) => x.classList.toggle('on', x === b));
    paint();
  });
}

function item(it, i, { showYear = true } = {}) {
  const g = it.game;
  const [label, cls] = it.via ? [`In ${it.via.title}`, ''] : STATE[it.state] || STATE.missing;
  const thumb = g?.cover_url ? `<img class="fr-thumb" src="${esc(g.cover_url)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    : `<span class="fr-thumb ph" style="--ph-h:${coverHue(it.title)}">${esc(monogram(it.title))}</span>`;
  const title = g ? `<a class="ttl link-plain" href="/game/${g.id}" data-link>${esc(it.title)}</a>` : it.via ? `<a class="ttl link-plain" href="/game/${it.via.game_id}" data-link>${esc(it.title)}</a>` : `<span class="ttl">${esc(it.title)}</span>`;
  return `<li class="fr-item s-${it.state}${it.kind !== 'main' ? ` k-${it.kind}` : ''}">
    <span class="fr-year">${showYear ? it.year ?? '' : `${i + 1}`}</span>${thumb}
    <div class="grow" style="min-width:0">
      <div class="row wrap" style="gap:6px">${title}${KIND[it.kind] ? `<span class="badge">${KIND[it.kind]}</span>` : ''}</div>
      <div class="sub">${g?.platforms?.length ? `${g.platforms.map(platDot).join('')} ` : ''}${g?.first_day ? `played ${years(fmtDate(new Date(`${g.first_day}T12:00`).getTime(), MON), g.last_day && g.last_day.slice(0, 7) !== g.first_day.slice(0, 7) ? fmtDate(new Date(`${g.last_day}T12:00`).getTime(), MON) : '')}` : ''}${!showYear && it.year ? `${g?.first_day ? ' · ' : ''}released ${it.year}` : ''}</div>
    </div>
    <div class="fr-right">${g?.minutes ? `<b>${fmtMin(g.minutes, { short: g.minutes >= 600 })}</b>` : ''}<span class="badge ${cls}">${esc(label)}</span></div></li>`;
}

export async function franchise(view, key, stale) {
  const f = await api(`/franchises/${encodeURIComponent(decodeURIComponent(key))}`);
  if (stale()) return;
  setTitle(f.name);
  const m = f.mainline;
  const q = new URLSearchParams(location.search);
  const st = { order: ['release', 'story', 'yours'].includes(q.get('order')) ? q.get('order') : 'release', main: q.get('show') === 'main' };
  const next = f.next ? `<div class="card fr-next"><div class="eyebrow">${f.next.earlier ? 'Nothing comes after your latest · the closest before it' : 'Next in release order'}</div>
      <div class="row wrap between" style="gap:10px"><div><div class="fr-next-t">${f.next.game_id ? `<a class="link-plain" href="/game/${f.next.game_id}" data-link>${esc(f.next.title)}</a>` : esc(f.next.title)} <span class="muted">(${f.next.year})</span></div>
        <div class="small muted">${f.next.via ? `In ${esc(f.next.via)}, which you own` : f.next.owned ? 'In your library' : 'Not in your library'}</div></div>
        ${f.next.game_id ? `<a class="btn sm" href="/game/${f.next.game_id}" data-link>Open${icon('arrowR', 'ic-inline')}</a>` : ''}</div></div>` : '';
  const order = f.your_order;
  view.innerHTML = `<a href="/franchises" data-link class="btn ghost sm" style="margin:-4px 0 10px -6px">${icon('back')}Franchises</a>
    <div class="page-h"><div><h1>${esc(f.name)}</h1><p>${[f.games ? plural(f.games, 'game') + ' of yours' : 'None in your library yet', f.minutes ? fmtMin(f.minutes, { short: f.minutes >= 600 }) : '', played(f) ? `played ${played(f)}` : '', f.released?.from ? `released ${years(f.released.from, f.released.to)}` : ''].filter(Boolean).join(' · ')}</p></div></div>
    ${m ? `<div class="kpis k4 strip" style="margin-bottom:16px">
      <div class="kpi"><div class="label">Main games</div><div class="value">${m.total}</div><div class="sub">in release order below</div></div>
      <div class="kpi"><div class="label">Owned</div><div class="value">${m.owned}</div><div class="sub">${m.total - m.owned ? `${m.total - m.owned} not in your library` : 'every one'}</div></div>
      <div class="kpi"><div class="label">Played</div><div class="value">${m.played}</div><div class="sub">${Math.round((m.played / (m.total || 1)) * 100)}% of the main games</div></div>
      <div class="kpi"><div class="label">Finished</div><div class="value">${m.finished}</div><div class="sub">completed or beaten</div></div></div>` : ''}
    ${next}
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>${st.order === 'story' ? 'In story order' : st.order === 'yours' ? 'In the order you played them' : 'In release order'}</h2>
      <div class="row wrap" style="gap:8px">${f.curated ? `<div class="seg" aria-label="Which games"><button data-main="0" class="${st.main ? '' : 'on'}">Everything</button><button data-main="1" class="${st.main ? 'on' : ''}">Main games</button></div>` : ''}
        <div class="seg" aria-label="Order"><button data-order="release" class="${st.order === 'release' ? 'on' : ''}">Release</button>${f.story ? `<button data-order="story" class="${st.order === 'story' ? 'on' : ''}">Story</button>` : ''}${order.games.length > 1 ? `<button data-order="yours" class="${st.order === 'yours' ? 'on' : ''}">Yours</button>` : ''}</div></div></div>
      <div id="fr-note"></div><ol class="fr-list" id="fr-items"></ol></div>`;
  const paint = () => {
    let list = f.items;
    if (st.order === 'story' && f.story) list = f.story.map((k) => f.items.find((it) => it.key === k)).filter(Boolean);
    if (st.order === 'yours') list = order.games.map((g) => f.items.find((it) => it.game?.id === g.id)).filter(Boolean);
    if (st.main) list = list.filter((it) => it.kind === 'main');
    view.querySelector('#fr-items').innerHTML = list.map((it, i) => item(it, i, { showYear: st.order === 'release' })).join('') || '<li class="muted" style="padding:10px 0">Nothing here.</li>';
    view.querySelector('#fr-note').innerHTML = st.order === 'yours' && order.pairs ? `<p class="small muted" style="margin-top:0">${order.in_release_order === order.pairs ? 'You played them in the order they came out.' : `${order.in_release_order} of ${order.pairs} times, the next one you started came out after the one before.`}</p>`
      : st.order === 'story' ? '<p class="small muted" style="margin-top:0">The order the story takes place in, which is not the order the games came out.</p>' : '';
    view.querySelectorAll('[data-order]').forEach((b) => b.classList.toggle('on', b.dataset.order === st.order));
    view.querySelectorAll('[data-main]').forEach((b) => b.classList.toggle('on', (b.dataset.main === '1') === st.main));
  };
  paint();
  view.addEventListener('click', (e) => {
    const o = e.target.closest('[data-order]'); const mm = e.target.closest('[data-main]');
    if (!o && !mm) return;
    if (o) st.order = o.dataset.order;
    if (mm) st.main = mm.dataset.main === '1';
    const u = new URL(location.href);
    st.order !== 'release' ? u.searchParams.set('order', st.order) : u.searchParams.delete('order');
    st.main ? u.searchParams.set('show', 'main') : u.searchParams.delete('show');
    history.replaceState(history.state, '', u);
    paint();
  });
}

/** The game page's card: where the game stands in its franchise, the entries either side. */
export function franchiseCard(fr) {
  if (!fr) return '';
  const ref = (x, dir) => (x ? `<div class="fr-nb"><span class="tiny muted">${dir}</span>${x.game_id ? `<a class="link" href="/game/${x.game_id}" data-link>${esc(x.title)}</a>` : `<span>${esc(x.title)}</span>`} <span class="tiny muted">${x.year ?? ''}${x.game_id ? '' : ' · not in your library'}</span></div>` : '');
  const where = fr.position ? `${ordinal(fr.position)} of ${plural(fr.of, 'main game')}` : `${KIND[fr.kind] || 'part of the series'}`;
  return `<div class="card" id="g-franchise"><div class="card-h"><h2>${esc(fr.name)}</h2><a class="small" href="/franchise/${encodeURIComponent(fr.id)}" data-link>The whole series${icon('arrowR', 'ic-inline')}</a></div>
    <p class="small" style="margin-top:-4px">${where}${fr.year ? `, released ${fr.year}` : ''}${fr.mainline ? ` · you have played ${fr.mainline.played} of ${fr.mainline.total}` : ''}</p>
    <div class="fr-nbs">${ref(fr.prev, 'Before it')}${ref(fr.next, 'After it')}</div></div>`;
}
const ordinal = (x) => { const t = x % 100; return `${x}${t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][x % 10] || 'th'}`; };
