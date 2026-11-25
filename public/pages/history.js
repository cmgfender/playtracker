import { $, esc, fmtMin, fmtHours, fmtDate, plat, platDot, cover, icon, api, toast, fail, rerender } from '../app.js';
import { periodPicker, periodChange, readPeriod, evidenceLine, whenDialog, conflictList } from './when.js';

// =====================================================================
// Improve history: answer "when did you play this?" for the least certain games, with what is
// known about each beside it; and a second look at your dates that the evidence disagrees with
// =====================================================================
export async function historyPage(view, stale) {
  const [rev, accts] = await Promise.all([api('/history/review?limit=30'), api('/accounts')]);
  if (stale()) return;
  const steam = (accts.items || accts).filter((a) => a.platform === 'steam');
  const m = rev.meter;
  const all = Object.values(m).reduce((a, x) => a + x, 0) || 1;
  const seg = [['high', 'var(--good)', 'High confidence'], ['manual', 'var(--accent-mark)', 'Set by you'], ['medium', 'var(--warn)', 'Medium'], ['low', 'var(--bad)', 'Low'], ['undated', 'var(--line)', 'Undated']];
  const sure = Math.round(((m.high + m.manual + m.medium * 0.5) / all) * 100);
  // years from the oldest evidence (release, first unlock, first played...) to tracking start;
  // with none, 25 years back (and never later than 1970: an old console's games go back that far)
  const years = (it) => {
    const hi = new Date(Math.min(Date.now(), it.evidence.tracking_start || Date.now())).getFullYear();
    const marks = (it.marks || []).filter((x) => x.key !== 'tracking' && x.key !== 'first_tracked').map((x) => new Date(x.at).getFullYear());
    const lo = Math.max(1970, Math.min(hi, marks.length ? Math.min(...marks) : hi - 25));
    const at = (k) => it.marks?.find((x) => x.key === k)?.at;
    const hint = it.window ? (it.window[0] + it.window[1]) / 2 : at('first_unlock') ?? at('first_played') ?? at('last_played');
    return { hi, lo, guess: hint ? Math.min(hi, Math.max(lo, new Date(hint).getFullYear())) : hi };
  };
  const row = (it) => {
    const ev = evidenceLine(it);
    return `<div class="item hist-row" data-entry="${it.entry_id}" data-period style="align-items:flex-start;padding:14px 4px">
      ${cover({ title: it.title, cover_url: it.cover_url }, 'sm')}
      <div class="grow stack" style="gap:6px;min-width:0">
        <div class="row between wrap"><a class="ttl" href="/game/${it.game_id}" data-link>${esc(it.title)}</a><b class="nowrap">${fmtMin(it.minutes, { short: it.minutes >= 600 })}</b></div>
        <div class="tiny muted">${platDot(it.platform)} ${esc(it.account_name || plat(it.platform).label)} · ${it.window
          ? `now guessed <b>${fmtDate(it.window[0], { year: 'numeric', month: 'short' })} – ${fmtDate(it.window[1], { year: 'numeric', month: 'short' })}</b> <span class="conf-${it.confidence}">(${it.confidence})</span>`
          : 'no dates known'}${it.undated ? ` · ${fmtMin(it.undated)} undated` : ''}</div>
        ${ev ? `<div class="tiny">${esc(ev)}</div>` : ''}
        ${it.enrich_pending ? '<div class="tiny" style="color:var(--warn-ink)">Achievement times are still being read: the guess may move.</div>'
          : it.window ? `<div class="row wrap" style="gap:6px"><button class="btn sm" data-confirm>${icon('check')}Looks right</button><span class="tiny muted">or correct it:</span></div>` : ''}
        <div class="row wrap" style="gap:6px">${periodPicker(years(it))}
          <button class="btn sm primary" data-answer>${icon('check')}Save</button>
          <button class="btn sm ghost" data-exact>${icon('edit')}Exact dates…</button>
          <button class="btn sm ghost" data-undated>Don’t chart</button>
          <button class="btn sm ghost" data-skip>Skip</button></div>
      </div></div>`;
  };
  // your dates (or estimates you confirmed) that the evidence disagrees with
  const checkRow = (it) => `<div class="item hist-check" data-entry="${it.entry_id}" style="align-items:flex-start;padding:14px 4px">
      ${cover({ title: it.title, cover_url: it.cover_url }, 'sm')}
      <div class="grow stack" style="gap:6px;min-width:0">
        <div class="row between wrap"><a class="ttl" href="/game/${it.game_id}" data-link>${esc(it.title)}</a><b class="nowrap">${fmtMin(it.minutes, { short: it.minutes >= 600 })}</b></div>
        <div class="tiny muted">${platDot(it.platform)} ${esc(it.account_name || plat(it.platform).label)} · ${it.manual.confirmed ? 'you confirmed' : 'you set'} <b>${it.manual.start ? fmtDate(it.manual.start, { year: 'numeric', month: 'short' }) : '…'} – ${it.manual.end ? fmtDate(it.manual.end, { year: 'numeric', month: 'short' }) : '…'}</b></div>
        ${evidenceLine(it) ? `<div class="tiny">${esc(evidenceLine(it))}</div>` : ''}
        ${conflictList(it.conflicts)}
        <div class="row wrap" style="gap:6px"><button class="btn sm primary" data-exact>${icon('edit')}Check dates</button>
          <button class="btn sm ghost" data-auto>Let Vestigo date it</button>
          <button class="btn sm ghost" data-keep>Keep mine</button></div>
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
    ${rev.check?.length ? `<div class="card" style="margin-top:16px" id="hist-check"><div class="card-h"><h2>Check your dates</h2><span class="tiny muted">${rev.check.length} game${rev.check.length === 1 ? '' : 's'}</span></div>
      <p class="small muted" style="margin-top:-6px">Dates you set (or estimates you confirmed) that achievements or the platform's own dates disagree with. Check them against what is known, let Vestigo date them from the evidence, or keep yours.</p>
      ${rev.check.map(checkRow).join('')}</div>` : ''}
    <div class="card" style="margin-top:16px"><div class="card-h"><h2>Least certain first</h2><span class="tiny muted">${rev.total} games · ${fmtHours(rev.uncertain_minutes, 0)}h uncertain</span></div>
      <div id="hist-list">${rev.items.map(row).join('') || `<div class="empty" style="padding:24px"><div class="em-ic">${icon('check')}</div><h2>Nothing left to answer</h2><p>All pre-tracking history is dated from solid evidence or by you.</p></div>`}</div>
      ${rev.total > rev.items.length ? '<button class="btn sm ghost" id="hist-more" style="margin-top:10px">Show more</button>' : ''}</div>`;
  let offset = rev.items.length;
  const done = (el, msg) => { el.style.opacity = '.45'; el.querySelectorAll('button,select,input').forEach((x) => { x.disabled = true; }); if (msg) toast(msg); };
  view.addEventListener('change', periodChange);
  view.addEventListener('click', async (e) => {
    const ck = e.target.closest('.hist-check');
    if (ck && e.target.closest('[data-exact]')) return whenDialog(Number(ck.dataset.entry), { onDone: rerender });
    if (ck && e.target.closest('[data-auto]')) {
      try { await api(`/entries/${ck.dataset.entry}/history`, { method: 'PATCH', body: { reset: true } }); done(ck, 'Dated from the evidence'); } catch (err) { fail(err); }
      return undefined;
    }
    if (ck && e.target.closest('[data-keep]')) {
      try { await api(`/entries/${ck.dataset.entry}/history`, { method: 'PATCH', body: { acknowledge: true } }); done(ck, 'Your dates are kept'); } catch (err) { fail(err); }
      return undefined;
    }
    const el = e.target.closest('.hist-row');
    if (el && e.target.closest('[data-skip]')) { el.remove(); return undefined; }
    if (el && e.target.closest('[data-exact]')) return whenDialog(Number(el.dataset.entry), { onDone: () => done(el) });
    if (el && e.target.closest('[data-confirm]')) {
      try { await api(`/entries/${el.dataset.entry}/history`, { method: 'PATCH', body: { confirm: true } }); done(el, 'Kept as guessed'); } catch (err) { fail(err); }
      return;
    }
    if (el && e.target.closest('[data-undated]')) {
      try { await api(`/entries/${el.dataset.entry}/history`, { method: 'PATCH', body: { mode: 'undated' } }); done(el, 'Kept out of charts'); } catch (err) { fail(err); }
      return;
    }
    if (el && e.target.closest('[data-answer]')) {
      // a period: spread evenly over it (coarse), not front-loaded on its first day
      const [start, end] = readPeriod(el);
      try {
        await api(`/entries/${el.dataset.entry}/history`, { method: 'PATCH', body: { first_played_at: new Date(start).toISOString(), last_played_at: new Date(end).toISOString(), coarse: true, mode: 'auto' } });
        done(el, `Re-dated to ${fmtDate(start, { year: 'numeric', month: 'short' })} – ${fmtDate(end, { year: 'numeric', month: 'short' })}`);
      } catch (err) { fail(err); }
      return undefined;
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
