// Franchises: the series in your library, the big ones with every entry in release order (the ones
// you don't own too) grouped into the series' eras, the remakes, remasters and re-releases linked to
// the games they are versions of, what to play next, the order you played them in, and - where the
// story is told out of order - the story order.
import { esc, fmtMin, fmtDate, platDot, icon, api, plural, setTitle, coverHue, monogram } from '../app.js';
import { emptyState } from './shared.js';

const KIND = { spinoff: 'Spin-off', remake: 'Remake', remaster: 'Remaster', rerelease: 'Re-release', collection: 'Collection', hub: 'App', other: 'Also in the series' };
const ADDON = { test: 'Beta', bonus: 'Bonus content' };
/** " (2019)" after a title, unless the title already ends with its year. */
const yr = (x) => (x.year && !String(x.title).endsWith(`(${x.year})`) ? ` (${x.year})` : '');
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
      ${f.era_count > 1 && f.your_era ? `<div class="tiny muted ellipsis">Your era: ${esc(f.your_era.name)} (${years(f.your_era.from, f.your_era.to)})</div>` : ''}
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

/** How an entry stands when it stands through another version: "Played as Resident Evil 2 (2019)", "In The Master Chief Collection". */
function viaLabel(it) {
  const v = it.via;
  const [label] = STATE[it.state] || STATE.missing;
  if (v.kind === 'collection') return `In ${v.title}`;
  const name = v.title === it.title ? `the ${v.year ?? ''} ${(KIND[v.kind] || 'version').toLowerCase()}`.replace(/\s+/g, ' ') : v.title;
  return it.state === 'owned' ? `Owned as ${name}` : `${label} as ${name}`;
}

/** What a version is a version of, and an original's versions: links where they are in your library. */
function versionsLine(it) {
  const link = (x) => (x.game_id ? `<a class="link-plain" href="/game/${x.game_id}" data-link>${esc(x.title)}</a>` : esc(x.title));
  const out = [];
  if (it.of?.length) {
    const what = it.kind === 'collection' ? 'Holds' : `${KIND[it.kind] || 'Version'} of`;
    const list = it.of.slice(0, 4).map((o) => `${esc(o.title)}${yr(o)}`).join(', ');
    out.push(`${what} ${list}${it.of.length > 4 ? ` and ${it.of.length - 4} more` : ''}${it.partial ? ', in parts' : ''}`);
  }
  const vs = (it.versions || []).filter((v) => v.kind !== 'collection');
  if (vs.length) out.push(`Also as ${vs.slice(0, 3).map((v) => `${link(v)}${yr(v)}`).join(', ')}${vs.length > 3 ? ` and ${vs.length - 3} more` : ''}`);
  return out.length ? `<div class="fr-versions">${out.join(' · ')}</div>` : '';
}

function item(it, i, { showYear = true } = {}) {
  const g = it.game;
  const [label, cls] = it.via ? [viaLabel(it), (STATE[it.state] || STATE.missing)[1]] : STATE[it.state] || STATE.missing;
  const thumb = g?.cover_url ? `<img class="fr-thumb" src="${esc(g.cover_url)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    : `<span class="fr-thumb ph" style="--ph-h:${coverHue(it.title)}">${esc(monogram(it.title))}</span>`;
  const href = g ? `/game/${g.id}` : it.via?.game_id ? `/game/${it.via.game_id}` : null;
  const title = href ? `<a class="ttl link-plain" href="${href}" data-link>${esc(it.title)}</a>` : `<span class="ttl">${esc(it.title)}</span>`;
  const addons = (it.addons || []).map((a) => `<a class="badge" href="/game/${a.id}" data-link title="${esc(a.title)}">${ADDON[a.kind] || 'Extra'}${a.minutes ? ` · ${fmtMin(a.minutes, { short: true })}` : ''}</a>`).join('');
  return `<li class="fr-item s-${it.state}${it.kind !== 'main' ? ` k-${it.kind}` : ''}">
    <span class="fr-year">${showYear ? it.year ?? '' : `${i + 1}`}</span>${thumb}
    <div class="grow" style="min-width:0">
      <div class="row wrap" style="gap:6px">${title}${KIND[it.kind] ? `<span class="badge">${KIND[it.kind]}</span>` : ''}${addons}</div>
      <div class="sub">${g?.platforms?.length ? `${g.platforms.map(platDot).join('')} ` : ''}${g?.first_day ? `played ${years(fmtDate(new Date(`${g.first_day}T12:00`).getTime(), MON), g.last_day && g.last_day.slice(0, 7) !== g.first_day.slice(0, 7) ? fmtDate(new Date(`${g.last_day}T12:00`).getTime(), MON) : '')}` : ''}${!showYear && it.year ? `${g?.first_day ? ' · ' : ''}released ${it.year}` : ''}${it.note ? `${g?.first_day ? ' · ' : ''}${esc(it.note)}` : ''}</div>
      ${versionsLine(it)}
    </div>
    <div class="fr-right">${g?.minutes ? `<b>${fmtMin(g.minutes, { short: g.minutes >= 600 })}</b>` : ''}<span class="badge ${cls}">${esc(label)}</span></div></li>`;
}

/** An era: its years, what defines it, how much of it you have played. */
function eraLine(x) {
  const m = x.main;
  return [m.total ? `${m.played} of ${plural(m.total, 'main game')} played` : '', x.minutes ? fmtMin(x.minutes, { short: x.minutes >= 600 }) : ''].filter(Boolean).join(' · ');
}

function erasCard(f) {
  if ((f.eras || []).length < 2) return '';
  return `<div class="card" style="margin-top:16px"><div class="card-h"><h2>Eras</h2><span class="tiny muted">${plural(f.eras.length, 'era')}${f.your_era ? ` · most played: ${esc(f.your_era.name)}` : ''}</span></div>
    <div class="fr-eras">${f.eras.map((x) => {
      const pct = x.main.total ? Math.round((x.main.played / x.main.total) * 100) : null;
      return `<button class="fr-era${f.your_era?.index === x.index ? ' mine' : ''}" data-era="${x.index}">
        <span class="row between" style="gap:8px"><span class="nm">${esc(x.name)}</span><span class="yr">${years(x.from, x.to)}</span></span>
        <span class="nt">${esc(x.note || '')}</span>
        <span class="tiny muted">${eraLine(x) || 'None of it played yet'}</span>
        ${pct != null ? `<span class="ms-bar" role="img" aria-label="${pct}% of its main games played"><i style="width:${pct}%;background:var(--accent-mark)"></i></span>` : ''}</button>`;
    }).join('')}</div></div>`;
}

export async function franchise(view, key, stale) {
  let name = key;
  try { name = decodeURIComponent(key); } catch { /* a malformed %-escape: the key as it is */ }
  const f = await api(`/franchises/${encodeURIComponent(name)}`);
  if (stale()) return;
  setTitle(f.name);
  const m = f.mainline;
  const q = new URLSearchParams(location.search);
  const st = { order: ['release', 'story', 'yours'].includes(q.get('order')) ? q.get('order') : 'release', main: q.get('show') === 'main' };
  const n = f.next;
  const nextSub = n ? (n.via ? `In ${esc(n.via)}, which you own` : n.owned ? 'In your library' : n.play_as ? `Not in your library · also as ${esc(n.play_as.title)}${yr(n.play_as)}, its ${(KIND[n.play_as.kind] || 'version').toLowerCase()}` : 'Not in your library') : '';
  const next = n ? `<div class="card fr-next"><div class="eyebrow">${n.earlier ? 'Nothing comes after your latest · the closest before it' : 'Next in release order'}</div>
      <div class="row wrap between" style="gap:10px"><div><div class="fr-next-t">${n.game_id ? `<a class="link-plain" href="/game/${n.game_id}" data-link>${esc(n.title)}</a>` : esc(n.title)} <span class="muted">(${n.year})</span></div>
        <div class="small muted">${nextSub}</div></div>
        ${n.game_id ? `<a class="btn sm" href="/game/${n.game_id}" data-link>Open${icon('arrowR', 'ic-inline')}</a>` : ''}</div></div>` : '';
  const order = f.your_order;
  view.innerHTML = `<a href="/franchises" data-link class="btn ghost sm" style="margin:-4px 0 10px -6px">${icon('back')}Franchises</a>
    <div class="page-h"><div><h1>${esc(f.name)}</h1><p>${[f.games ? plural(f.games, 'game') + ' of yours' : 'None in your library yet', f.minutes ? fmtMin(f.minutes, { short: f.minutes >= 600 }) : '', played(f) ? `played ${played(f)}` : '', f.released?.from ? `released ${years(f.released.from, f.released.to)}` : ''].filter(Boolean).join(' · ')}</p></div></div>
    ${m ? `<div class="kpis k4 strip" style="margin-bottom:16px">
      <div class="kpi"><div class="label">Main games</div><div class="value">${m.total}</div><div class="sub">in release order below</div></div>
      <div class="kpi"><div class="label">Owned</div><div class="value">${m.owned}</div><div class="sub">${m.total - m.owned ? `${m.total - m.owned} not in your library` : 'every one'}</div></div>
      <div class="kpi"><div class="label">Played</div><div class="value">${m.played}</div><div class="sub">${Math.round((m.played / (m.total || 1)) * 100)}% of the main games, in any version</div></div>
      <div class="kpi"><div class="label">Finished</div><div class="value">${m.finished}</div><div class="sub">completed or beaten</div></div></div>` : ''}
    ${next}
    ${erasCard(f)}
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>${st.order === 'story' ? 'In story order' : st.order === 'yours' ? 'In the order you played them' : 'In release order'}</h2>
      <div class="row wrap" style="gap:8px">${f.curated ? `<div class="seg" aria-label="Which games"><button data-main="0" class="${st.main ? '' : 'on'}">Everything</button><button data-main="1" class="${st.main ? 'on' : ''}">Main games</button></div>` : ''}
        <div class="seg" aria-label="Order"><button data-order="release" class="${st.order === 'release' ? 'on' : ''}">Release</button>${f.story ? `<button data-order="story" class="${st.order === 'story' ? 'on' : ''}">Story</button>` : ''}${order.games.length > 1 ? `<button data-order="yours" class="${st.order === 'yours' ? 'on' : ''}">Yours</button>` : ''}</div></div></div>
      <div id="fr-note"></div><ol class="fr-list" id="fr-items"></ol></div>`;
  const eraHead = (x) => `<li class="fr-era-h" id="fr-era-${x.index}"><div><b>${esc(x.name)}</b> <span class="muted small">${years(x.from, x.to)}</span></div><div class="small muted">${eraLine(x)}</div><div class="fr-era-n small muted">${esc(x.note || '')}</div></li>`;
  const paint = () => {
    let list = f.items;
    if (st.order === 'story' && f.story) list = f.story.map((k) => f.items.find((it) => it.key === k)).filter(Boolean);
    if (st.order === 'yours') list = order.games.map((g) => f.items.find((it) => it.game?.id === g.id)).filter(Boolean);
    if (st.main) list = list.filter((it) => it.kind === 'main');
    // in release order, each era starts with its heading; a remaster placed with the games it
    // remasters closes its era (release order within each era)
    const byEra = st.order === 'release' && (f.eras || []).length > 1;
    if (byEra) list = [...list].sort((x, y) => (x.era ?? f.eras.length) - (y.era ?? f.eras.length));
    let era = null;
    view.querySelector('#fr-items').innerHTML = list.map((it, i) => {
      const head = byEra && it.era != null && it.era !== era ? eraHead(f.eras[it.era]) : '';
      if (byEra && it.era != null) era = it.era;
      return head + item(it, i, { showYear: st.order === 'release' });
    }).join('') || '<li class="muted" style="padding:10px 0">Nothing here.</li>';
    view.querySelector('#fr-note').innerHTML = st.order === 'yours' && order.pairs ? `<p class="small muted" style="margin-top:0">${order.in_release_order === order.pairs ? 'You played them in the order they came out.' : `${order.in_release_order} of ${order.pairs} times, the next one you started came out after the one before.`}</p>`
      : st.order === 'story' ? '<p class="small muted" style="margin-top:0">The order the story takes place in, which is not the order the games came out.</p>' : '';
    view.querySelectorAll('[data-order]').forEach((b) => b.classList.toggle('on', b.dataset.order === st.order));
    view.querySelectorAll('[data-main]').forEach((b) => b.classList.toggle('on', (b.dataset.main === '1') === st.main));
  };
  paint();
  const remember = () => {
    const u = new URL(location.href);
    st.order !== 'release' ? u.searchParams.set('order', st.order) : u.searchParams.delete('order');
    st.main ? u.searchParams.set('show', 'main') : u.searchParams.delete('show');
    history.replaceState(history.state, '', u);
  };
  view.addEventListener('click', (e) => {
    const era = e.target.closest('[data-era]');
    if (era) {
      // an era: its games in release order
      if (st.order !== 'release') { st.order = 'release'; remember(); paint(); }
      view.querySelector(`#fr-era-${era.dataset.era}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      return;
    }
    const o = e.target.closest('[data-order]'); const mm = e.target.closest('[data-main]');
    if (!o && !mm) return;
    if (o) st.order = o.dataset.order;
    if (mm) st.main = mm.dataset.main === '1';
    remember();
    paint();
  });
}

/** The game page's card: where the game stands in its franchise and its era, what it is a version of, and the entries either side. */
export function franchiseCard(fr) {
  if (!fr) return '';
  const ref = (x, dir) => (x ? `<div class="fr-nb"><span class="tiny muted">${dir}</span>${x.game_id ? `<a class="link" href="/game/${x.game_id}" data-link>${esc(x.title)}</a>` : `<span>${esc(x.title)}</span>`} <span class="tiny muted">${x.year ?? ''}${x.game_id ? '' : ' · not in your library'}</span></div>` : '');
  const kind = fr.addon ? `${ADDON[fr.addon] || 'Extra'} of ${fr.title}` : fr.position ? `${ordinal(fr.position)} of ${plural(fr.of, 'main game')}` : `${KIND[fr.kind] || 'part of the series'}`;
  const version = fr.version_of?.length ? `${KIND[fr.kind] || 'Version'} of ${fr.version_of.map((o) => `${esc(o.title)}${yr(o)}`).join(' and ')}`
    : fr.holds?.length ? `Holds ${plural(fr.holds.length, 'game')} of the series` : '';
  const also = (fr.versions || []).filter((v) => v.kind !== 'collection' && v.game_id);
  return `<div class="card" id="g-franchise"><div class="card-h"><h2>${esc(fr.name)}</h2><a class="small" href="/franchise/${encodeURIComponent(fr.id)}" data-link>The whole series${icon('arrowR', 'ic-inline')}</a></div>
    <p class="small" style="margin-top:-4px">${kind}${fr.year ? `, released ${fr.year}` : ''}${fr.mainline ? ` · you have played ${fr.mainline.played} of ${fr.mainline.total}` : ''}</p>
    ${version || fr.era && fr.eras > 1 ? `<p class="small muted" style="margin-top:-6px">${[version, fr.era && fr.eras > 1 ? `${esc(fr.era.name)}${/\bera$/i.test(fr.era.name) ? '' : ' era'} (${years(fr.era.from, fr.era.to)})` : ''].filter(Boolean).join(' · ')}</p>` : ''}
    ${also.length ? `<p class="small muted" style="margin-top:-6px">Also yours as ${also.map((v) => `<a class="link" href="/game/${v.game_id}" data-link>${esc(v.title)}</a>`).join(', ')}</p>` : ''}
    <div class="fr-nbs">${ref(fr.prev, 'Before it')}${ref(fr.next, 'After it')}</div></div>`;
}
const ordinal = (x) => { const t = x % 100; return `${x}${t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][x % 10] || 'th'}`; };
