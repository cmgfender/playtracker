import { $, $$, esc, fmtMin, fmtDate, dayLabel, plat, platDot, icon, api, toast, undoToast, fail, confirmBox, state, plural } from '../app.js';
import { sessionItem, groupByDay, emptyState, logSessionModal, restoreSession, bindSessionEdits, D, dayKey } from './shared.js';

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

export async function sessions(view, stale) {
  const q0 = new URLSearchParams(location.search);
  const f = {
    platform: q0.get('platform') || '', source: '', q: '', kind: 'play', game_id: q0.get('game_id') || '',
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
        <button class="chip${f.platform ? '' : ' on'}" data-p="">All platforms</button>
        ${lt.platforms.map((p) => `<button class="chip${f.platform === p.platform ? ' on' : ''}" data-p="${esc(p.platform)}">${platDot(p.platform)}${esc(plat(p.platform).label)}</button>`).join('')}
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
