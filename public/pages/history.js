import { $, esc, fmtMin, fmtHours, fmtDate, plat, platDot, cover, icon, api, toast, fail } from '../app.js';

// =====================================================================
// Improve history: answer "when did you play this?" for the least certain games
// =====================================================================
const PERIODS = [['year', 'Whole year', 0, 11], ['q1', 'Jan – Mar', 0, 2], ['q2', 'Apr – Jun', 3, 5], ['q3', 'Jul – Sep', 6, 8], ['q4', 'Oct – Dec', 9, 11],
  ...['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => [`m${i}`, m, i, i])];

export async function historyPage(view, stale) {
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
