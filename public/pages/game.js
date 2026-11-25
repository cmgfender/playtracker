import {
  $, $$, esc, fmtMin, ago, fmtDate, fmtTime, dayLabel, plat, platDot, platTag, platIcon, STATUSES, cover, icon, api, toast,
  undoToast, fail, modal, confirmBox, navigate, rerender, state, plural, setTitle, coverHue, tagHref,
} from '../app.js';
import { barChart, heatmap, mountCharts, curveChart, BASIS_FILL } from '../charts.js';
import { arrow, seriesLabel, seriesName, kpi, sessionItem, groupByDay, rarityText, achIcon, logSessionModal, bindSessionEdits, dayKey, BASIS } from './shared.js';
import { whenDialog, conflictList } from './when.js';
import { franchiseCard } from './franchises.js';

// =====================================================================
// Game detail
// =====================================================================
// a URL safe inside CSS url('...'): quotes, parentheses, backslashes and newlines percent-encoded
const cssUrl = (u) => String(u).replace(/['"()\\\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

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
    // tracked live solid; imported sessions and each kind of history in its own pattern
    const parts = (x) => (x.by_basis ? BASIS.map(([k, l]) => [k, l, x.by_basis[k] || 0]) : [['estimated', 'Estimated history', x.estimated || 0]]).filter(([, , m]) => m > 0);
    return barChart(series.slice(-36).map((x) => ({ label: x.label, name: x.name, value: x.minutes, tip: `${x.name}: ${x.minutes ? fmtMin(x.minutes) : 'no play'}${parts(x).length ? ` (${parts(x).map(([, l, m]) => `${fmtMin(m)} ${l.toLowerCase()}`).join(', ')})` : ''}${x.sessions ? ` · ${plural(x.sessions, 'session')}` : ''}${x.unlocked ? ` · ${x.unlocked} unlocked` : ''}`,
      stack: [{ key: 'tracked', value: x.by_basis ? x.by_basis.tracked : x.tracked, color: 'var(--accent-mark)' }, ...parts(x).map(([k, , m]) => ({ key: k, value: m, color: BASIS_FILL[k] }))] })), { size: 'page', title: `${g.title}, playtime by month` });
  }
  return curveChart({ series }, { title: `${g.title}, playtime over time`, keys: `${g.title} over time; arrow keys read each month` });
}

/** Legend entries for the kinds of history on a game's curve (its last cumulative point has them all). */
function curveKinds(series) {
  const last = series.at(-1)?.cumulative_by_basis;
  if (!last) return series.some((x) => x.cumulative_estimated) ? '<span><i class="dot hatch-dot"></i>Estimated history</span>' : '';
  return BASIS.filter(([k]) => last[k] > 0).map(([k, label, why]) => `<span title="${esc(why)}"><i class="dot basis-${k}"></i>${label}</span>`).join('');
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

export async function game(view, id, stale) {
  // what is drawn below Notes is asked for with the page's own data, not after it is up
  const below = Promise.all([api(`/stats/records?range=all&game_id=${id}`).catch(() => null), import('../insights.js'), api(`/games/${id}/forecast`).catch(() => null)]);
  below.catch(() => {});
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
  // hours assumed for copies their platform reports no time for: a part of their own, never "estimated history"
  const assumedMin = Math.min(s.estimated_minutes || 0, g.entries.filter((e) => isAssumed(e) && !e.excluded).reduce((a, e) => a + e.playtime_min, 0));
  const parts = [[s.tracked_minutes, 'tracked', 'background:var(--accent-mark)'], [(s.estimated_minutes || 0) - assumedMin, 'estimated history', null, 'hatch'], [assumedMin, 'assumed', null, 'basis-assumed'],
    [s.baseline_minutes, 'undated', 'background:var(--line-strong)']].filter(([m]) => m > 0);
  const relLine = releaseLine(g.franchise);
  const series = (curve?.series || []).map((x) => ({ ...x, label: x.key.endsWith('-01') && curve.series.length > 12 ? x.key.slice(0, 4) : seriesLabel(x.key, 'month'), major: x.key.endsWith('-01') && curve.series.length > 36, name: seriesName(x.key, 'month') }));
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
          ${relLine ? `<div class="hero-rel small" id="g-release">${relLine}</div>` : ''}
          <div class="hero-life"><span class="big">${fmtMin(s.total_minutes, { short: s.total_minutes >= 600 })}</span><span class="muted">lifetime</span></div>
          <div class="hero-line small muted">${plural(nSessions, 'session')} · ${g.last_played_at ? `played ${ago(g.last_played_at)}` : s.total_minutes ? 'no tracked play yet' : 'never played'}</div>
          ${s.total_minutes ? `<div class="hero-split">
            <div class="split-bar">${parts.map(([m, , st, cls]) => `<i ${st ? `style="width:${pct(m)}%;${st}"` : `class="${cls === 'hatch' ? 'hatch-bg' : cls}" style="width:${pct(m)}%"`}></i>`).join('')}</div>
            <div class="legend">${parts.length > 1 ? `<span><b>${fmtMin(s.total_minutes)}</b> =</span>` : ''}${parts.map(([m, l, st, cls], i) => `<span>${i ? '+ ' : ''}<i class="dot${st ? '' : cls === 'hatch' ? ' hatch-dot' : ` ${cls}`}" ${st ? `style="${st}"` : ''}></i>${fmtMin(m)} ${l}</span>`).join('')}</div>
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
    <div class="grid grid-main game-cols">${columns()}</div>
    ${fixPanel(g)}`;
  /** The two columns and where each one's last card ends; null where they are stacked (a narrow screen). */
  function columnEnds() {
    const [L, R] = $$('.game-cols > .stack', view);
    if (!L || !R || !L.offsetWidth || L.getBoundingClientRect().top !== R.getBoundingClientRect().top) return null;
    const end = (col) => (col.lastElementChild ? col.lastElementChild.getBoundingClientRect().bottom - col.getBoundingClientRect().top : 0);
    return { L, R, end };
  }
  /**
   * Evens the columns once they are drawn: a long About or achievement list left the narrow column
   * 600px longer than the wide one on most games. A card that can sit in either column (About,
   * where the time comes from, Notes) moves under the shorter one while that brings the two
   * ends closer; the curve, activity, sessions and achievements stay where they are looked for.
   */
  function balance() {
    // a page is drawn hidden and shown when it is ready: measured as it is shown, before it is painted
    if (view.hidden) {
      const shown = new MutationObserver(() => { if (!view.hidden) { shown.disconnect(); balance(); } });
      shown.observe(view, { attributes: true, attributeFilter: ['hidden'] });
      return;
    }
    const cols = columnEnds();
    if (!cols) return;
    const { L, R, end } = cols;
    const gap = () => end(R) - end(L);
    for (let i = 0; i < 4; i++) {
      const g0 = gap();
      if (Math.abs(g0) < 160) return;
      const [from, to] = g0 > 0 ? [R, L] : [L, R];
      let best = null;
      for (const card of [...from.children].filter((c) => c.matches('#g-about, #g-sources, [data-either]'))) {
        const next = card.nextSibling;
        to.append(card);
        const g1 = Math.abs(gap());
        from.insertBefore(card, next);
        if (g1 < Math.abs(g0) - 60 && (!best || g1 < best.g1)) best = { card, g1 };
      }
      if (!best) return;
      to.append(best.card);
    }
  }
  /**
   * The two columns: play on the left (curve, sessions), the game's facts on the right
   * (achievements, platforms, notes). Activity and history before tracking go where the columns
   * end closest together, from the cards' expected heights; balance() then measures what was drawn.
   */
  function columns() {
    const curveCard = series.length ? `<div class="card"><div class="card-h"><h2>Playtime over time</h2><div class="seg" id="g-curve-mode" aria-label="Show"><button data-cm="total" class="on">Running total</button><button data-cm="month">By month</button></div></div>
          <div id="g-curve">${gameCurve(series, 'total', g)}</div>
          <div class="legend"><span><i class="dot" style="background:var(--accent-mark)"></i>Tracked</span>${curveKinds(series)}${series.some((x) => x.sessions) ? '<span><i class="dot" style="background:var(--accent2)"></i>Sessions</span>' : ''}${series.some((x) => x.unlocked) ? '<span><i class="dot" style="background:var(--star)"></i>Unlocks</span>' : ''}</div>
          ${curve.totals.baseline_minutes ? `<p class="tiny muted" style="margin:8px 0 0">${fmtMin(curve.totals.baseline_minutes)} has no date: it counts toward lifetime, not on the curve.</p>` : ''}</div>` : '';
    const heatCard = years.length ? `<div class="card"><div class="card-h"><h2>Activity</h2>${years.length > 1 ? `<div class="seg" id="g-hm-year" aria-label="Activity year">${years.map((y, i) => `<button data-y="${y}" class="${i ? '' : 'on'}">${y}</button>`).join('')}</div>` : `<span class="tiny muted">${years[0]}</span>`}</div><div id="g-heat"><div class="ins-ph short" aria-hidden="true"></div></div></div>` : '';
    const baselines = g.sessions.filter((x) => x.kind === 'baseline' && x.source !== 'inferred');
    // a game added by hand with no hours from before it was added (an N64 game played in 1998)
    const handNoPast = g.entries.find((e) => e.account_id == null && e.platform === 'manual' && !e.history);
    const sessCard = `<div class="card"><div class="card-h"><h2>Recent sessions</h2>${nSessions > recent.length ? `<a href="/sessions?game_id=${g.id}" data-link>All ${nSessions.toLocaleString()} sessions${arrow()}</a>` : ''}</div>
          <div class="list dated" id="g-sessions">${recent.length ? groupByDay(recent).map((grp) => `<div class="day-h"><span>${dayLabel(grp.day)}</span><span>${fmtMin(grp.minutes)}</span></div>${grp.items.map((x) => sessionItem(x, { showGame: false, platLabel: g.entries.length > 1, dated: true })).join('')}`).join('') : `<p class="muted">No sessions yet — they appear after a sync spots new playtime, or log one yourself.${handNoPast ? ` <button class="link linkbtn" data-hist-past="${handNoPast.id}">Played it before? Add those hours</button>` : ''}</p>`}
          ${baselines.map((x) => `<div class="item"><span class="dot" style="background:var(--line);width:10px;height:10px"></span><div class="grow"><div class="sub"><b style="color:var(--text)">${esc(plat(x.platform).label)}</b> ${esc(x.note || 'History')} · ${fmtDate(x.window_end)}</div></div><div class="amt muted">${fmtMin(x.minutes)}</div><button class="btn ghost sm icon" data-edit-session="${x.id}" aria-label="Edit history">${icon('edit')}</button></div>`).join('')}
          </div>
        </div>`;
    const platCard = sourcesCard(g);
    const notesCard = `<div class="card" data-either><div class="card-h"><h2 id="g-notes-h">Notes</h2><span class="tiny muted" id="g-notes-st" aria-live="polite"></span></div>
          <textarea class="input" id="g-notes" aria-labelledby="g-notes-h" placeholder="Thoughts, progress, where you left off…">${esc(g.notes || '')}</textarea></div>`;
    // expected heights (px at 1400 wide), enough to choose a column
    const shown = hasAch ? Math.min(ACH_SHOWN, ach.summary.unlocked) : 0;
    let L = (curveCard ? 360 : 0) + 90 + Math.max(1, recent.length) * 66 + new Set(recent.map((x) => dayKey(x.ended_at || x.window_end || x.created_at))).size * 40 + baselines.length * 50;
    let R = (hasAch ? 230 + shown * 64 + (shown ? 40 : 0) + (ach.items.some((x) => !x.unlocked) ? 50 : 0) : 0) + 190;
    const srcH = 130 + g.entries.length * 92 + g.entries.filter((e) => e.history).length * 50;
    const about = aboutCard(g);
    if (about) R += 240;
    // its franchise: where it stands, the entries either side
    const seriesCard = franchiseCard(g.franchise);
    if (seriesCard) R += 150;
    const left = [curveCard]; const right = [seriesCard, about, hasAch ? achBlock(ach) : ''];
    // Activity follows the curve, in the shorter column
    for (const [card, h] of [[heatCard, 260], [platCard, srcH]]) {
      if (!card) continue;
      if (L <= R) { left.push(card); L += h; } else { right.push(card); R += h; }
    }
    left.push(sessCard);
    right.push(notesCard);
    return `<div class="stack">${left.join('')}</div><div class="stack">${right.join('')}</div>`;
  }
  mountCharts(view);
  balance();
  bindSessionEdits(view);
  $('#g-meta-fix')?.addEventListener('click', () => metaModal(g));
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
  // Below Notes (whichever column balance() left it in), drawn once the page is up so nothing above them moves: when the game will be finished
  // at the pace it is played, and "How you play it" - the patterns of its tracked days (what
  // Insights shows for a range; days with play out of all days since says little for one game).
  below.then(([r, ins, fc]) => {
    const lines = (r?.patterns || []).filter((h) => h.id !== 'days_played' && h.id !== 'trend').map(ins.pattern).filter(Boolean);
    const notes = $('#g-notes')?.closest('.card');
    if (stale() || !notes || $('#g-patterns') || $('#g-forecast')) return;
    const cards = [];
    if (fc?.available) cards.push(forecastCard(fc));
    if (lines.length) cards.push(`<div class="card" id="g-patterns"><div class="card-h"><h2>How you play it</h2><span class="tiny muted">tracked play</span></div><ul class="hl">${lines.map((x) => `<li>${x}</li>`).join('')}</ul></div>`);
    if (cards.length) notes.insertAdjacentHTML('afterend', cards.join(''));
  }).catch(() => { /* the page stands without them */ });
  let nt;
  $('#g-notes').addEventListener('input', (e) => { $('#g-notes-st').textContent = 'Saving…'; clearTimeout(nt); nt = setTimeout(async () => {
    // "Saved" only when it was: a failed save says so, and the next keystroke tries again
    let ok = true;
    try { await api(`/games/${id}`, { method: 'PATCH', body: { notes: e.target.value } }); } catch (err) { ok = false; fail(err); }
    const st = $('#g-notes-st'); if (st) st.textContent = ok ? 'Saved' : 'Not saved';
  }, 600); });
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
    body: `<form class="stack" id="ge"><div class="field"><label>Title</label><input class="input" name="title" maxlength="300" value="${esc(g.title)}"></div>
      <div class="field"><label>Cover image URL</label><input class="input" name="cover_url" maxlength="2000" value="${esc(g.cover_url || '')}"></div>
      ${g.entries.filter((e) => e.cover_url && e.cover_url !== g.cover_url).length ? `<div class="field"><label>Use a platform cover</label><div class="row wrap">${g.entries.filter((e) => e.cover_url).map((e) => `<button type="button" class="btn sm" data-cov="${esc(e.cover_url)}">${platDot(e.platform)}${esc(plat(e.platform).label)}</button>`).join('')}</div></div>` : ''}</form>`,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="ge-save">Save</button>',
    onMount(el, close) {
      el.querySelectorAll('[data-cov]').forEach((b) => b.addEventListener('click', () => { el.querySelector('[name=cover_url]').value = b.dataset.cov; }));
      el.querySelector('#ge-save').addEventListener('click', async () => {
        const f = el.querySelector('#ge');
        if (!f.title.value.trim()) return toast('Enter a title', { bad: true });
        // a save that fails leaves the dialog open, with what was typed
        try { await api(`/games/${id}`, { method: 'PATCH', body: { title: f.title.value, cover_url: f.cover_url.value } }); } catch (e) { return fail(e); }
        toast('Saved'); close(); rerender();
      });
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
    const past = ev.target.closest('[data-hist-past]');
    if (past) return whenDialog(Number(past.dataset.histPast), { entry: g.entries.find((x) => x.id === Number(past.dataset.histPast)), game: g, onDone: rerender });
    const ed = ev.target.closest('[data-hist-edit]');
    if (ed) return whenDialog(Number(ed.dataset.histEdit), { entry: g.entries.find((x) => x.id === Number(ed.dataset.histEdit)), game: g, onDone: rerender });
    const md = ev.target.closest('[data-hist-mode]');
    const rs = ev.target.closest('[data-hist-reset]');
    const cf = ev.target.closest('[data-hist-confirm]');
    const ak = ev.target.closest('[data-hist-ack]');
    const jump = ev.target.closest('#g-fix-jump');
    if (jump) { ev.preventDefault(); const fix = $('#g-fix'); fix.scrollIntoView({ behavior: 'smooth', block: 'start' }); fix.querySelector('button')?.focus({ preventScroll: true }); return undefined; }
    const fx = ev.target.closest('[data-fix]');
    if (fx) return fx.dataset.fix === 'edit' ? editGame() : fx.dataset.fix === 'merge' ? mergeModal(g) : metaModal(g);
    const ax = ev.target.closest('[data-assumed-ex]');
    if (ax) {
      const ex = ax.dataset.on === '1';
      const set = (v) => api(`/entries/${ax.dataset.assumedEx}`, { method: 'PATCH', body: { excluded: v } });
      try { await set(ex); undoToast(ex ? 'Assumed hours left out of this game' : 'Assumed hours counted again', () => set(!ex), rerender); rerender(); } catch (err) { fail(err); }
      return undefined;
    }
    try {
      if (cf) { await api(`/entries/${cf.dataset.histConfirm}/history`, { method: 'PATCH', body: { confirm: true } }); toast('Kept as guessed'); rerender(); }
      if (ak) { await api(`/entries/${ak.dataset.histAck}/history`, { method: 'PATCH', body: { acknowledge: true } }); toast('Your dates are kept'); rerender(); }
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
        ${en.account_id == null && en.platform === 'manual' ? `<button class="btn" id="en-past">${icon('history')}${en.history ? 'Hours played before you added it' : 'Add hours played before you added it'}</button>` : ''}
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
        el.querySelector('#en-past')?.addEventListener('click', () => { close(); whenDialog(en.id, { entry: en, game: g, onDone: rerender }); });
        el.querySelector('#en-split')?.addEventListener('click', async () => {
          // a split that fails says why and leaves the dialog open
          let ng;
          try { ng = await api(`/entries/${en.id}/split`, { method: 'POST' }); } catch (e) { return fail(e); }
          close(); toast('Split into a separate game'); navigate(`/game/${ng.id}`);
        });
      },
    });
  });
}

// ---------------------------------------------------------------------
// What the page knows, and where it is fixed. "Where your time comes from" only shows: every copy
// of the game, the release it is, and what its hours rest on (tracked, history from before
// tracking, hours assumed). "Fix this game" below the columns holds every correction, and nothing else.
// ---------------------------------------------------------------------
const DAYF = { year: 'numeric', month: 'short', day: 'numeric' };
/** Hours assumed for a copy its platform reports no time for (services/assumed.js). */
const isAssumed = (e) => e.account_id == null && String(e.ext_id || '').startsWith('assumed:');
const byHandEntry = (e) => e.account_id == null && e.platform === 'manual';
const entryName = (e) => (isAssumed(e) ? `Assumed hours · ${plat(e.platform).label}` : e.account_name || (byHandEntry(e) ? e.meta?.played_on || 'Added by hand' : plat(e.platform).label));
const RELEASE = { main: 'The original', remake: 'The remake', remaster: 'The remaster', rerelease: 'A re-release', collection: 'A collection', spinoff: 'A spin-off' };
const TYPICAL = { complete: 'to complete it', extra: 'with extras', main: 'for the main story' };

/** Under the title: which release this game is (a remake of what, the original of what you also own, two releases in one). */
function releaseLine(fr) {
  if (!fr) return '';
  const yr = (x) => (x.year ? ` (${x.year})` : '');
  const link = (x) => (x.game_id ? `<a class="link" href="/game/${x.game_id}" data-link>${esc(x.title)}</a>${yr(x)}` : `${esc(x.title)}${yr(x)}`);
  if (fr.parts?.length > 1) return `Two releases in one game: ${fr.parts.map((x) => `${(RELEASE[x.kind] || 'A version').toLowerCase()}${yr(x)}`).join(' and ')}. Each keeps its own time below.`;
  if (fr.version_of?.length) return `${RELEASE[fr.kind] || 'A version'}${fr.year ? `, ${fr.year},` : ''} of ${fr.version_of.map(link).join(' and ')}`;
  const also = (fr.versions || []).filter((v) => v.kind !== 'collection' && v.game_id);
  if (also.length) return `The original${fr.year ? `, ${fr.year}` : ''}. Also yours as ${also.map(link).join(', ')}`;
  return '';
}

/** What a copy's hours are, in one line: tracked, from before tracking, assumed, or none reported. */
function hoursLine(e, g) {
  const a = e.meta?.assumed;
  if (isAssumed(e)) {
    return `<i class="dot basis-assumed" aria-hidden="true"></i>${a?.floor ? 'A guess: you marked it finished, so its typical main story (IGDB)'
      : a ? `A guess: ${a.unlocked} of ${a.total} achievements × ${fmtMin(a.typical_minutes)} typical ${TYPICAL[a.typical] || ''} (IGDB)` : 'A guess from its achievements'}`;
  }
  const h = e.history;
  const tracked = Math.max(0, e.playtime_min - (h?.minutes || 0));
  const t = tracked ? `<i class="dot" style="background:var(--accent-mark)" aria-hidden="true"></i>${fmtMin(tracked)} tracked` : '';
  if (h) return `${t}${t ? ' + ' : ''}<i class="dot hatch-dot" aria-hidden="true"></i>${fmtMin(h.minutes)} from before tracking`;
  if (!e.playtime_min && e.account_id != null && e.achievements?.unlocked) {
    return g.entries.some((x) => isAssumed(x) && x.meta?.assumed?.source_entry === e.id) ? `${esc(plat(e.platform).label)} reports no playtime for it: its hours are assumed, below`
      : `${esc(plat(e.platform).label)} reports no playtime for it`;
  }
  return t;
}

/** When a copy's history (or assumed hours) is dated to, and how surely. */
function datedLine(e) {
  const h = e.history;
  if (!h) return '';
  if (h.mode === 'undated') return 'Not charted: counts toward lifetime only';
  if (!h.window) return `No dates known: counts toward lifetime only${h.enrich_pending ? ' · looking up achievement times…' : ''}`;
  const mine = h.manual && !h.manual.confirmed ? h.manual : null;
  const from = mine?.start ?? h.window[0]; const to = mine?.end ?? h.window[1];
  return `${h.manual?.confirmed ? 'Confirmed' : h.manual ? 'Set to' : isAssumed(e) ? 'Dated by your unlocks to' : 'Estimated'} <b>${fmtDate(from, DAYF)} – ${fmtDate(to, DAYF)}</b> · <span class="conf-${h.confidence}">${h.confidence} confidence</span>${h.undated ? ` · ${fmtMin(h.undated)} undated` : ''}`;
}

/** Every date a copy's history can be told from, as chips. */
function evidenceChips(h) {
  const ev = h.evidence || {};
  return [
    ...(h.marks || []).filter((m) => m.key !== 'tracking' && m.key !== 'account')
      .map((m) => [m.key === 'last_unlock' ? 'Last achievement' : m.label, `${fmtDate(m.at, DAYF)}${m.key === 'release_igdb' ? ' (IGDB)' : ''}`]),
    ev.play_count && ['Launches', ev.play_count],
    ev.recent_min && ['Last 2 weeks', fmtMin(ev.recent_min)],
    h.unlocks_before && ['Achievements before tracking', h.unlocks_before],
  ].filter(Boolean);
}

/** One copy of the game, as "Where your time comes from" shows it: nothing to press. */
function sourceRow(e, g) {
  const h = e.history;
  const chips = h ? evidenceChips(h) : [];
  const facts = [e.last_played_at ? `Played ${ago(e.last_played_at)}` : '', e.meta?.devices?.deck ? `Deck ${fmtMin(e.meta.devices.deck)}` : '', e.play_count ? `${e.play_count} launch${e.play_count === 1 ? '' : 'es'}` : '',
    e.achievements?.total ? `${e.achievements.unlocked} of ${e.achievements.total} unlocked` : '',
    e.missing_since ? `<span style="color:var(--warn)">no longer in library since ${fmtDate(e.missing_since)}</span>` : ''].filter(Boolean).join(' · ');
  const what = hoursLine(e, g);
  const dated = datedLine(e);
  return `<div class="item src" style="${e.excluded ? 'opacity:.55' : ''}" data-src="${e.id}">
      ${isAssumed(e) ? '<span class="src-ic basis-assumed" aria-hidden="true"></span>' : e.icon_url ? `<img src="${esc(e.icon_url)}" width="32" height="32" style="border-radius:8px" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : platIcon(e.platform, 32)}
      <div class="grow"><div class="ttl ellipsis">${esc(entryName(e))}</div>
        <div class="sub">${platDot(e.platform)}${esc(e.title !== g.title ? e.title : plat(e.platform).label)}${e.meta?.played_on && !byHandEntry(e) ? ` · ${esc(e.meta.played_on)}` : ''}${e.excluded ? ' · <b>excluded from totals</b>' : ''}</div>
        ${what ? `<div class="sub src-line src-what">${what}</div>` : ''}
        ${dated ? `<div class="sub src-line">${dated}</div>` : ''}
        ${h && !isAssumed(e) && (h.reasons || []).length ? `<div class="tiny muted">${h.reasons.map(esc).join(' · ')}</div>` : ''}
        ${facts ? `<div class="sub">${facts}</div>` : ''}
        ${chips.length ? `<details class="src-ev"><summary class="tiny muted">What the dates go by</summary><div class="evidence">${chips.map(([k, v]) => `<span class="badge">${k}: ${esc(v)}</span>`).join('')}</div></details>` : ''}</div>
      <div class="amt">${fmtMin(e.playtime_min)}</div>
    </div>`;
}

/** "Where your time comes from": the copies, under the release each is when the game holds two. */
function sourcesCard(g) {
  const parts = g.franchise?.parts?.length > 1 ? g.franchise.parts : null;
  const warn = g.entries.some((e) => e.history?.conflicts?.length && !e.history.acknowledged && e.history.mode !== 'undated');
  let rows;
  if (parts) {
    const placed = new Set(parts.flatMap((x) => x.entries));
    const loose = g.entries.filter((e) => !placed.has(e.id));
    rows = parts.map((x) => `<div class="src-rel"><span><b>${esc(x.title)}</b>${x.year ? ` <span class="muted">${x.year}</span>` : ''} <span class="badge g-release">${esc((RELEASE[x.kind] || 'A version').replace(/^(The|A) /, ''))}</span></span>
        <span class="small muted">${x.state === 'finished' ? 'finished · ' : x.state === 'playing' ? 'playing · ' : ''}${x.minutes ? fmtMin(x.minutes) : x.state === 'owned' ? 'not played' : 'no time on record'}</span></div>
      ${g.entries.filter((e) => x.entries.includes(e.id)).map((e) => sourceRow(e, g)).join('')}`).join('') + loose.map((e) => sourceRow(e, g)).join('');
  } else rows = g.entries.map((e) => sourceRow(e, g)).join('');
  const kinds = [g.entries.some((e) => e.history && !isAssumed(e)) && '<span title="Hours the platform reported from before Vestigo was watching: the hours are real, their dates are estimated"><i class="dot hatch-dot"></i>From before tracking: real hours, estimated dates</span>',
    g.entries.some(isAssumed) && '<span title="The platform reports no playtime for this game: the hours are a guess from its achievements, the dates come from the unlocks"><i class="dot basis-assumed"></i>Assumed: guessed hours</span>'].filter(Boolean);
  return `<div class="card" id="g-sources"><div class="card-h"><h2>Where your time comes from</h2><a class="btn sm ${warn ? '' : 'ghost'}" href="#g-fix" id="g-fix-jump">${warn ? `${icon('info')}Dates to check` : `Fix${icon('arrowR', 'ic-inline')}`}</a></div>
      <div class="list">${rows}</div>
      ${kinds.length ? `<div class="legend" style="margin-top:10px">${g.summary?.tracked_minutes ? '<span><i class="dot" style="background:var(--accent-mark)"></i>Tracked: measured</span>' : ''}${kinds.join('')}</div>` : ''}
      ${parts ? `<p class="small muted" style="margin:8px 0 0">Totals are summed; the series counts each release played, with its own time.</p>`
        : g.entries.filter((e) => !isAssumed(e)).length > 1 ? '<p class="small muted" style="margin:8px 0 0">Owned on several platforms: totals are summed.</p>' : ''}
    </div>`;
}

/** "Fix this game": every correction, as a question and the buttons that answer it. */
function fixPanel(g) {
  const row = (q, sub, buttons, extra = '', attrs = '') => `<div class="fix-row" ${attrs}><div class="grow"><div class="t">${q}</div>${sub ? `<div class="d">${sub}</div>` : ''}${extra}</div><div class="row wrap fix-btns">${buttons}</div></div>`;
  const rows = [];
  // the dates of history from before tracking
  for (const e of g.entries.filter((x) => x.history && !isAssumed(x))) {
    const h = e.history;
    const warn = h.conflicts?.length && !h.acknowledged && h.mode !== 'undated';
    rows.push(row(`When did you play the ${fmtMin(h.minutes, { short: h.minutes >= 600 })} from before tracking?`, `${esc(entryName(e))} · ${datedLine(e)}`,
      `${h.window && !h.manual && h.mode !== 'undated' && h.confidence !== 'high' && !h.enrich_pending ? `<button class="btn sm" data-hist-confirm="${e.id}">${icon('check')}Looks right</button>` : ''}<button class="btn sm${warn ? ' primary' : ''}" data-hist-edit="${e.id}">${icon('edit')}${warn ? 'Check dates' : 'Set dates'}</button>
      ${warn ? `<button class="btn sm ghost" data-hist-ack="${e.id}">Keep my dates</button>` : ''}
      ${h.mode === 'undated' ? `<button class="btn sm ghost" data-hist-mode="auto" data-entry="${e.id}">Chart it</button>` : `<button class="btn sm ghost" data-hist-mode="undated" data-entry="${e.id}">Don’t chart</button>`}
      ${(h.manual && !byHandEntry(e)) || h.mode === 'undated' ? `<button class="btn sm ghost" data-hist-reset="${e.id}">Reset to automatic</button>` : ''}`, warn ? conflictList(h.conflicts) : '', `data-hist="${e.id}"`));
  }
  // hours assumed for a copy with no playtime
  for (const e of g.entries.filter(isAssumed)) {
    rows.push(row(`Are the ${fmtMin(e.playtime_min, { short: e.playtime_min >= 600 })} assumed for ${esc(plat(e.platform).label)} wrong?`,
      'They are a guess from its achievements. Leave them out of this game, or say when you played. If you know the real hours, log them by hand and the guess goes away. To stop assuming hours for every game: <a class="link" href="/settings#assumed" data-link>Settings</a>.',
      `${e.history ? `<button class="btn sm" data-hist-edit="${e.id}">${icon('edit')}Set dates</button>` : ''}<button class="btn sm ghost" data-assumed-ex="${e.id}" data-on="${e.excluded ? 0 : 1}">${e.excluded ? 'Count them again' : 'Don’t count them'}</button>`, '', `data-hist="${e.id}"`));
  }
  // each copy: counted twice, in the wrong game
  for (const e of g.entries.filter((x) => !isAssumed(x))) {
    rows.push(row(`${esc(entryName(e))}${e.title !== g.title ? `: ${esc(e.title)}` : ''}`,
      `${fmtMin(e.playtime_min)}${e.last_played_at ? ` · played ${ago(e.last_played_at)}` : ''}${e.excluded ? ' · excluded from totals' : ''}. Counted twice, or a different game${g.franchise?.parts?.length > 1 ? ' or release' : ''}${byHandEntry(e) ? ', or hours missing from before you added it' : ''}?`,
      `<button class="btn sm" data-entry-menu="${e.id}" aria-label="Entry options">${icon('more')}Options</button>`));
  }
  // the game itself
  rows.push(row('The game itself', 'Its title or cover, the same game listed twice, or the wrong details from IGDB.',
    `<button class="btn sm" data-fix="edit">${icon('edit')}Title & cover</button><button class="btn sm" data-fix="merge">${icon('merge')}Merge with…</button>${g.meta || g.igdb ? `<button class="btn sm" data-fix="meta">IGDB match</button>` : ''}`));
  return `<section class="card fix-card" id="g-fix" aria-labelledby="g-fix-h"><div class="card-h"><h2 id="g-fix-h">${icon('edit', 'ic-inline')}Fix this game</h2></div>
      <p class="small muted" style="margin-top:-6px">Everything above is what Vestigo knows. Here is where you correct it; if the page looks right, there is nothing to do.</p>
      ${rows.join('')}</section>`;
}

/** GET /games/:id/forecast as a card: how long until the game is finished, and what that rests on. */
function forecastCard(f) {
  const span = f.text.match(/^(.*?) to finish/)?.[1];
  const lead = f.state === 'playing' ? `<b>${esc(span)}</b> to finish at this pace, around ${fmtDate(new Date(`${f.finish_day}T12:00`).getTime(), { month: 'short', day: 'numeric' })}.`
    : f.state === 'idle' ? `<b>${fmtMin(f.remaining_minutes)}</b> left. Not played in the last four weeks.`
      : `<b>Past</b> the ${f.personal_pace ? 'length expected at your pace' : 'typical length'}.`;
  const length = f.personal_pace ? `${fmtMin(f.expected_minutes)} at your pace (${f.pace_ratio}× the typical ${fmtMin(f.typical_minutes)})` : `the typical ${fmtMin(f.typical_minutes)}`;
  return `<div class="card" id="g-forecast"><div class="card-h"><h2>Finish forecast</h2><span class="tiny muted">${f.basis === 'main' ? 'main story' : 'main + extras'}</span></div>
    <p class="ins-lead">${lead}</p>
    <div class="split-bar" role="img" aria-label="${f.percent}% of the expected length played"><i style="width:${f.percent}%;background:var(--accent-mark)"></i></div>
    <p class="small muted" style="margin:8px 0 0">${fmtMin(f.played_minutes)} of ${length}${f.state === 'playing' ? ` · ${fmtMin(f.weekly_minutes)} a week lately` : ''}</p></div>`;
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

// ---------- IGDB metadata ----------
const BY = { steam: 'its Steam id', title: 'its title', manual: 'you', import: 'the app you imported it from' };
const tagLink = (kind, name) => `<a class="chip" href="${tagHref(kind, name)}" data-link>${esc(name)}</a>`;
const hrs = (m) => fmtMin(m, { short: m >= 600 });

/** About: genres and the rest of the IGDB record, the typical time to beat against yours. Nothing without IGDB. */
function aboutCard(g) {
  const m = g.meta;
  if (!m) return '';
  if (!m.igdb_id) {
    return `<div class="card" id="g-about"><div class="card-h"><h2>About</h2></div><p class="small muted" style="margin:0">${m.matched_by === 'manual' ? 'You said IGDB has no entry for this game.' : 'IGDB has no game with this title.'} <button class="link linkbtn" id="g-meta-fix">Find it on IGDB</button></p></div>`;
  }
  const people = [
    m.developers.length && ['Developer', m.developers.slice(0, 2).map((n) => `<a class="link" href="${tagHref('developer', n)}" data-link>${esc(n)}</a>`).join(', ')],
    m.publishers.length && m.publishers.join() !== m.developers.join() && ['Publisher', m.publishers.slice(0, 2).map(esc).join(', ')],
    m.franchises.length && ['Series', m.franchises.slice(0, 2).map((n) => `<a class="link" href="${tagHref('franchise', n)}" data-link>${esc(n)}</a>`).join(', ')],
    // (IGDB's date is a calendar day at midnight UTC: shown as that day wherever you are)
    m.release_date && ['Released', fmtDate(m.release_date, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })],
    m.rating != null && ['IGDB rating', `${Math.round(m.rating)}<span class="tiny muted"> / 100${m.rating_count ? ` · ${m.rating_count.toLocaleString()} ratings` : ''}</span>`],
  ].filter(Boolean);
  const t = m.time_to_beat;
  // (a game holding two releases: IGDB's times are for the release the game is matched to, so against its time only)
  const own = g.franchise?.parts?.find((p) => p.main);
  const mine = own ? own.minutes : g.summary?.total_minutes || g.minutes || 0;
  let ttb = '';
  if (t) {
    const marks = [['Main story', t.main], ['Main + extras', t.extra], ['Everything', t.complete]].filter(([, v]) => v);
    const max = Math.max(mine, ...marks.map(([, v]) => v));
    const ref = t.main || t.extra || t.complete;
    const say = !mine ? '' : mine >= (t.complete || Infinity) ? 'more than a completionist run' : mine >= ref ? `${(mine / ref).toFixed(1)}× the ${t.main ? 'main story' : 'typical time'}` : `about ${hrs(ref - mine)} short of the ${t.main ? 'main story' : 'typical time'}`;
    ttb = `<h3 class="ach-h">Time to beat</h3>
      <div class="ttb">${marks.map(([l, v]) => `<div class="mrow"><span class="ml">${l}</span><span class="mbar"><i style="width:${(v / max) * 100}%;background:var(--accent2)"></i></span><span class="mv">${hrs(v)}</span></div>`).join('')}
      ${mine ? `<div class="mrow"><span class="ml"><b>You</b></span><span class="mbar"><i style="width:${(mine / max) * 100}%;background:var(--accent-mark)"></i></span><span class="mv"><b>${hrs(mine)}</b></span></div>` : ''}</div>
      ${say ? `<p class="tiny muted" style="margin:4px 0 0">You have played ${say}, by IGDB’s typical times${own ? ` (the ${own.year} release only)` : ''}.</p>` : ''}`;
  }
  const chips = [...m.genres.map((n) => tagLink('genre', n)), ...m.perspectives.map((n) => tagLink('perspective', n)), ...m.modes.map((n) => tagLink('mode', n))];
  return `<div class="card" id="g-about"><div class="card-h"><h2>About</h2>${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">IGDB ${icon('external', 'ic-inline')}</a>` : ''}</div>
    ${chips.length ? `<div class="chips" style="margin-bottom:10px">${chips.join('')}</div>` : ''}
    ${people.length ? `<dl class="kv">${people.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
    ${m.themes.length ? `<p class="tiny muted" style="margin:8px 0 0">${m.themes.slice(0, 6).map(esc).join(' · ')}</p>` : ''}
    ${ttb}
    ${m.summary ? `<details style="margin-top:10px"><summary class="small muted" style="cursor:pointer">Summary</summary><p class="small" style="margin:6px 0 0">${esc(m.summary)}</p></details>` : ''}
    <p class="tiny muted" style="margin:12px 0 0">From IGDB${m.name && m.name !== g.title ? ` as “${esc(m.name)}”` : ''}, matched by ${BY[m.matched_by] || m.matched_by}. <button class="link linkbtn" id="g-meta-fix">Wrong game?</button></p></div>`;
}

/** Pick the IGDB game by hand, say there is none, or go back to matching automatically. */
function metaModal(g) {
  const m = modal({
    title: 'Match on IGDB',
    body: `<form class="row" id="mm-f" style="gap:8px"><input class="input grow" id="mm-q" value="${esc(g.title)}" aria-label="Title to search for"><button class="btn">${icon('search')}Search</button></form>
      <div class="list" id="mm-r" style="margin-top:10px" aria-live="polite"></div>`,
    foot: `${g.meta?.locked ? '<button class="btn ghost" id="mm-auto">Match automatically</button>' : ''}<button class="btn ghost" id="mm-none">It isn’t on IGDB</button><span class="grow"></span><button class="btn" data-close>Cancel</button>`,
    onMount(el) {
      const out = el.querySelector('#mm-r');
      let seq = 0; // the latest search wins: the one run on opening must not replace yours
      const search = async () => {
        const my = ++seq;
        out.innerHTML = '<p class="small muted pulse">Searching IGDB…</p>';
        try {
          const r = await api(`/igdb/search?q=${encodeURIComponent(el.querySelector('#mm-q').value)}`);
          if (my !== seq || !el.isConnected) return;
          out.innerHTML = r.length ? r.map((x) => `<div class="item"><div class="grow"><div class="ttl ellipsis">${esc(x.name)}</div><div class="sub">${x.year || 'year unknown'}${x.main ? '' : ' · DLC, bundle or other edition'}${x.id === g.meta?.igdb_id ? ' · matched now' : ''}</div></div><button class="btn sm" data-pick="${x.id}">Use this</button></div>`).join('') : '<p class="small muted">Nothing found: try another spelling.</p>';
        } catch (e) { if (my === seq && el.isConnected) out.innerHTML = `<p class="small" style="color:var(--bad-ink)">${esc(e.message)}</p>`; }
      };
      const set = async (body, msg) => { try { await api(`/games/${g.id}/meta`, body); m.close(); toast(msg); rerender(); } catch (e) { fail(e); } };
      el.querySelector('#mm-f').addEventListener('submit', (e) => { e.preventDefault(); search(); });
      out.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) set({ method: 'PUT', body: { igdb_id: Number(b.dataset.pick) } }, 'Matched'); });
      el.querySelector('#mm-none').addEventListener('click', () => set({ method: 'PUT', body: { igdb_id: null } }, 'Marked as not on IGDB'));
      el.querySelector('#mm-auto')?.addEventListener('click', () => set({ method: 'DELETE' }, 'It will be matched again shortly'));
      search();
    },
  });
}
