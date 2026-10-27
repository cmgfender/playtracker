// "What should I play?": one picker for the Home card and the dialog (command palette, P).
// A main pick with its reasons and two alternates for the time and mood chosen; Pick again draws
// the next ones without repeating, Not now snoozes a game for a week, Never leaves it out for good
// (both undone from the toast or from "Set aside").
import { $, esc, fmtMin, plural, platDot, plat, STATUSES, cover, icon, api, toast, fail, modal, navigate } from './app.js';
import { logSessionModal } from './pages.js';

const LS = 'vg-suggest'; // this device's last time / mood / platform choice
export const TIMES = [[15, '15m', '15 minutes'], [30, '30m', '30 minutes'], [60, '1h', '1 hour'], [120, '2h', '2 hours'], ['long', 'Long', 'A long session']];
export const MODES = [['auto', 'Best match'], ['quick', 'Quick fix'], ['keep', 'Keep going'], ['finish', 'Finish something'], ['new', 'Start something new'], ['rediscover', 'Rediscover'], ['surprise', 'Surprise me']];
const SNOOZE_DAYS = 7;

function prefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch { /* private mode */ }
  return {
    minutes: TIMES.some(([v]) => String(v) === String(p.minutes)) ? p.minutes : 60,
    mode: MODES.some(([v]) => v === p.mode) ? p.mode : 'auto',
    platform: typeof p.platform === 'string' ? p.platform : '',
    chase: !!p.chase,
  };
}
function savePrefs(p) { try { localStorage.setItem(LS, JSON.stringify(p)); } catch { /* private mode */ } }

// Home's round in progress, kept across re-renders of the page (seed, games already shown, the answer)
let homeRound = null;
const roundKey = (p) => `${p.minutes}|${p.mode}|${p.platform}|${p.chase}`;

/** A typical length as said aloud: to the nearest 5 minutes from half an hour up. */
export const about = (m) => fmtMin(m >= 30 ? Math.round(m / 5) * 5 : m);

/** Platform, status, typical session and achievements of a pick, for its meta line. */
function metaLine(p) {
  const parts = [];
  if (p.platforms.length) parts.push(`<span class="sg-plats">${p.platforms.map((x) => `<span>${platDot(x)}${esc(plat(x).label)}</span>`).join('')}</span>`);
  if (p.status !== 'unset' && STATUSES[p.status]) parts.push(`<span class="badge ${STATUSES[p.status].cls}">${esc(STATUSES[p.status].label)}</span>`);
  if (p.typical_session_source === 'game' && !p.reasons.some((r) => r.id === 'fit' || r.id === 'fit_long')) parts.push(`<span>about ${about(p.typical_session_minutes)} a session</span>`);
  if (p.achievements?.total) parts.push(`<span title="Achievements">${icon('trophy', 'ic-inline')} ${p.achievements.unlocked}/${p.achievements.total}<span class="vh"> achievements</span></span>`);
  return parts.join('');
}

const skeleton = '<div class="sg-main sg-skel" aria-hidden="true"><div class="cover skel"></div><div class="grow"><div class="skel" style="height:20px;width:55%"></div><div class="skel" style="height:13px;width:80%;margin-top:12px"></div><div class="skel" style="height:13px;width:70%;margin-top:8px"></div></div></div>';

/**
 * Mount the picker in `host`. card: Home's card (with its heading); otherwise the dialog body.
 * platforms: the library's platform keys (a filter shows when there are several).
 */
export function mountSuggest(host, { card = true, platforms = [], close = null } = {}) {
  let p = prefs();
  let seq = 0;
  const hid = card ? 'sg-h' : null;
  host.innerHTML = `${card ? `<div class="card-h"><h2 id="${hid}">What should I play?</h2><span class="tiny muted sg-count" data-sg-count></span></div>` : ''}
    <div class="sg-ctl">
      <div class="seg sg-time" aria-label="Time you have">${TIMES.map(([v, l, full]) => `<button type="button" data-sg-min="${v}" class="${String(p.minutes) === String(v) ? 'on' : ''}" aria-label="${full}">${l}</button>`).join('')}</div>
      <select class="input sg-sel" data-sg-mode aria-label="Mood">${MODES.map(([v, l]) => `<option value="${v}" ${p.mode === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      ${platforms.length > 1 ? `<select class="input sg-sel" data-sg-plat aria-label="Platform"><option value="">All platforms</option>${platforms.map((x) => `<option value="${esc(x)}" ${p.platform === x ? 'selected' : ''}>${esc(plat(x).label)}</option>`).join('')}</select>` : ''}
      <button type="button" class="chip${p.chase ? ' on' : ''}" data-sg-chase ${p.mode === 'finish' ? '' : 'hidden'} title="Also beaten games that have achievements left">Include beaten</button>
    </div>
    <div class="sg-body" data-sg-body aria-busy="true">${skeleton}</div>
    <div class="vh" aria-live="polite" data-sg-live></div>`;
  if (p.platform && !platforms.includes(p.platform)) p.platform = '';
  const body = host.querySelector('[data-sg-body]');
  const live = host.querySelector('[data-sg-live]');
  const say = (t) => { live.textContent = ''; requestAnimationFrame(() => { live.textContent = t; }); };

  const fresh = () => ({ key: roundKey(p), seed: null, seen: [], data: null, order: null });
  let round = card && homeRound?.key === roundKey(p) ? homeRound : fresh();
  if (card) homeRound = round;

  async function load({ announce = false, again = false } = {}) {
    const my = ++seq;
    body.setAttribute('aria-busy', 'true');
    const q = { mode: p.mode, count: '3' };
    if (p.minutes != null) q.minutes = String(p.minutes);
    if (p.platform) q.platform = p.platform;
    if (p.chase && p.mode === 'finish') q.chase = 'true';
    if (round.seed != null) q.seed = String(round.seed);
    if (round.seen.length) q.exclude = round.seen.join(',');
    try {
      let d = await api(`/suggest?${new URLSearchParams(q)}`);
      // every match has been shown: start over from the best ones
      if (!d.picks.length && round.seen.length) {
        round.seen = [];
        delete q.exclude;
        d = await api(`/suggest?${new URLSearchParams(q)}`);
        if (again && d.picks.length) toast('That was every match: starting over');
      }
      if (my !== seq || !host.isConnected) return;
      round.seed = d.seed;
      round.data = d;
      round.order = d.picks.map((_, i) => i);
      draw();
      if (announce) say(d.picks.length ? `Suggested: ${d.picks[0].title}${d.picks.length > 1 ? `, or ${d.picks.slice(1).map((x) => x.title).join(' or ')}` : ''}` : 'Nothing to suggest');
    } catch (e) {
      if (my !== seq || !host.isConnected) return;
      body.removeAttribute('aria-busy');
      body.innerHTML = `<p class="muted small" style="margin:0">Suggestions did not load: ${esc(e.message)}. <button class="link linkbtn" data-sg-act="retry">Try again</button></p>`;
    }
  }

  function draw() {
    const d = round.data;
    const picks = round.order.map((i) => d.picks[i]);
    const keep = focusKey();
    body.removeAttribute('aria-busy');
    const count = host.querySelector('[data-sg-count]');
    if (count) count.textContent = d.considered ? `${plural(d.considered, 'game')} considered` : '';
    const setAside = d.excluded_counts.snoozed + d.excluded_counts.never;
    const foot = `<p class="sg-foot tiny muted"><span>What is installed is unknown, so picks come from every game you own${p.platform ? ` on ${esc(plat(p.platform).label)}` : ''}.</span>${setAside ? ` <button class="link linkbtn" data-sg-act="manage">${plural(setAside, 'game')} set aside</button>` : ''}</p>`;
    if (!picks.length) {
      const ex = d.excluded_counts;
      const why = [ex.platform && `${plural(ex.platform, 'game')} on other platforms`, setAside && `${plural(setAside, 'game')} set aside`, ex.completed + ex.dropped + ex.beaten && `${plural(ex.completed + ex.dropped + ex.beaten, 'game')} finished or dropped`].filter(Boolean);
      body.innerHTML = `<div class="sg-empty"><p class="small" style="margin:0"><b>Nothing to suggest with these choices.</b>${why.length ? ` Left out: ${why.join(', ')}.` : ' Add games or connect an account, and picks appear here.'}</p></div>${foot}`;
      return;
    }
    const [m, ...alts] = picks;
    const label = MODES.find(([v]) => v === d.mode)?.[1] || d.mode;
    // an alternate's line: what sets it apart (the time fit and the status say little next to the main pick)
    const line = (a) => (a.reasons.find((r) => !['fit', 'fit_long', 'status'].includes(r.id)) || a.reasons[0])?.text || '';
    body.innerHTML = `${m.mode_match ? '' : `<p class="small muted sg-nomatch">Nothing in your library fits “${esc(label)}” yet; this is the closest.</p>`}
      <div class="sg-main">
        <a class="sg-cover" href="/game/${m.game_id}" data-link tabindex="-1" aria-hidden="true">${cover(m)}</a>
        <div class="sg-info">
          <h3 class="sg-title"><a href="/game/${m.game_id}" data-link>${esc(m.title)}</a></h3>
          <div class="sg-meta small muted">${metaLine(m)}</div>
          <ul class="sg-why">${m.reasons.map((r) => `<li class="${r.id === 'fit_long' ? 'neg' : ''}" data-r="${esc(r.id)}">${icon(r.id === 'fit_long' ? 'info' : 'check', 'ic-16')}<span>${esc(r.text)}</span></li>`).join('')}</ul>
        </div>
        <div class="sg-act">
          <div class="sg-act-go">
            ${m.launch_url ? `<a class="btn primary" href="${esc(m.launch_url)}" data-sg-act="play" aria-label="Play on Steam">${icon('play')}Play</a>` : ''}
            <button type="button" class="btn${m.launch_url ? '' : ' primary'}" data-sg-act="log">${icon('clock')}Log session</button>
          </div>
          <div class="sg-act-more">
            <button type="button" class="btn" data-sg-act="again">${icon('shuffle')}Pick again</button>
            <button type="button" class="btn ghost" data-sg-act="snooze" title="Leave it out for ${SNOOZE_DAYS} days">${icon('moon')}Not now</button>
            <button type="button" class="btn ghost" data-sg-act="never" title="Never suggest this game">${icon('ban')}Never</button>
          </div>
        </div>
      </div>
      ${alts.length ? `<div class="sg-alts"><div class="eyebrow" id="sg-or-${hid || 'd'}">Or try</div><ul class="sg-alt-list" aria-labelledby="sg-or-${hid || 'd'}">${alts.map((a, i) => `<li><button type="button" class="sg-alt" data-sg-swap="${i + 1}" aria-label="Show ${esc(a.title)}: ${esc(line(a))}">
        ${cover(a)}<span class="grow"><span class="ttl ellipsis">${esc(a.title)}</span><span class="sub">${esc(line(a))}</span></span>${icon('chevR', 'ic-16')}</button></li>`).join('')}</ul></div>` : ''}
      ${foot}`;
    restoreFocus(keep);
  }

  // focus survives a redraw: the same action, or the same alternate slot
  function focusKey() {
    const a = document.activeElement;
    if (!a || !body.contains(a)) return null;
    for (const k of ['data-sg-act', 'data-sg-swap']) if (a.hasAttribute(k)) return `[${k}="${a.getAttribute(k)}"]`;
    return null;
  }
  function restoreFocus(sel) {
    if (!sel) return;
    (body.querySelector(sel) || body.querySelector('[data-sg-act="again"]'))?.focus({ preventScroll: true });
  }

  const main = () => round.data?.picks[round.order?.[0]];
  async function feedback(action, game) {
    try {
      await api('/suggest/feedback', { method: 'POST', body: { game_id: game.game_id, action, ...(action === 'snooze' ? { days: SNOOZE_DAYS } : {}) } });
      toast(action === 'snooze' ? `Not now: ${game.title} is left out for ${SNOOZE_DAYS} days` : `${game.title} will not be suggested again`, {
        action: { label: 'Undo', run: async () => { try { await api('/suggest/feedback', { method: 'POST', body: { game_id: game.game_id, action: 'reset' } }); toast('Undone'); if (host.isConnected) load({ announce: true }); } catch (e) { fail(e); } } },
      });
      await load({ announce: true });
    } catch (e) { fail(e); }
  }

  host.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-sg-min], [data-sg-chase], [data-sg-act], [data-sg-swap], a[data-link]');
    if (!t || !host.contains(t)) return;
    if (t.matches('a[data-link]')) { if (close) { e.preventDefault(); close(); navigate(t.getAttribute('href')); } return; }
    if (t.dataset.sgMin) {
      host.querySelectorAll('[data-sg-min]').forEach((b) => b.classList.toggle('on', b === t));
      p.minutes = t.dataset.sgMin === 'long' ? 'long' : Number(t.dataset.sgMin);
      return changed();
    }
    if (t.matches('[data-sg-chase]')) { t.classList.toggle('on'); p.chase = t.classList.contains('on'); return changed(); }
    if (t.dataset.sgSwap) {
      const i = Number(t.dataset.sgSwap);
      [round.order[0], round.order[i]] = [round.order[i], round.order[0]];
      draw();
      say(`Showing ${main().title}`);
      return;
    }
    const act = t.dataset.sgAct;
    const m = main();
    if (act === 'retry') return load();
    if (act === 'manage') return manageModal(() => host.isConnected && load({ announce: true }));
    if (!m) return;
    if (act === 'again') {
      round.seen.push(...round.data.picks.map((x) => x.game_id));
      round.seed += 1;
      return load({ announce: true, again: true });
    }
    if (act === 'snooze' || act === 'never') return feedback(act, m);
    if (act === 'log') {
      close?.();
      const minutes = p.minutes === 'long' ? 240 : p.minutes ?? m.typical_session_minutes;
      return logSessionModal({ id: m.game_id, title: m.title, cover_url: m.cover_url }, undefined, { minutes });
    }
    if (act === 'play') toast(`Opening ${m.title} in Steam`);
  });
  host.addEventListener('change', (e) => {
    if (e.target.matches('[data-sg-mode]')) {
      p.mode = e.target.value;
      host.querySelector('[data-sg-chase]').hidden = p.mode !== 'finish';
      changed();
    } else if (e.target.matches('[data-sg-plat]')) { p.platform = e.target.value; changed(); }
  });
  function changed() {
    savePrefs(p);
    round = fresh();
    if (card) homeRound = round;
    load({ announce: true });
  }

  if (round.data && round.seed != null) { draw(); load(); } else load();
}

/** The picker in a dialog: from the command palette, the P key, or anywhere Home's card is hidden. */
export async function suggestModal() {
  const lt = await api('/stats/lifetime').catch(() => null);
  modal({
    title: 'What should I play?',
    wide: true,
    cls: 'sg-dialog',
    body: '<div class="sg sg-in-dialog"></div>',
    onMount(el, close) { mountSuggest(el.querySelector('.sg'), { card: false, platforms: (lt?.platforms || []).map((x) => x.platform), close }); },
  });
}

/** Games snoozed or never suggested, each with a way back. */
async function manageModal(onChange) {
  let list;
  try { list = await api('/suggest/feedback'); } catch (e) { return fail(e); }
  const row = (f) => `<div class="item" data-fb="${f.game_id}">${cover(f, '', 'width:36px')}<div class="grow"><div class="ttl ellipsis">${esc(f.title)}</div><div class="sub">${f.action === 'never' ? 'Never suggested' : `Not now, until ${new Date(f.until).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}</div></div><button type="button" class="btn sm" data-fb-reset="${f.game_id}" aria-label="Suggest ${esc(f.title)} again">Allow again</button></div>`;
  modal({
    title: 'Set aside',
    body: list.items.length ? `<p class="small muted" style="margin:0 0 10px">Games left out of “What should I play?”.</p><div class="list">${list.items.map(row).join('')}</div>` : '<p class="muted" style="margin:0">Nothing is set aside.</p>',
    onMount(el) {
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-fb-reset]');
        if (!b) return;
        try {
          await api('/suggest/feedback', { method: 'POST', body: { game_id: Number(b.dataset.fbReset), action: 'reset' } });
          const r = b.closest('[data-fb]');
          toast(`${r.querySelector('.ttl').textContent} can be suggested again`);
          (r.nextElementSibling?.querySelector('button') || r.previousElementSibling?.querySelector('button') || el.querySelector('.mh h2'))?.focus();
          r.remove();
          if (!el.querySelector('[data-fb]')) el.querySelector('.mb').innerHTML = '<p class="muted" style="margin:0">Nothing is set aside.</p>';
          onChange?.();
        } catch (err) { fail(err); }
      });
    },
  });
}
