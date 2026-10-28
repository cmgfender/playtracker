import { esc, fmtMin, plat, platDot, cover, icon, api, toast, undoToast, fail, confirmBox, rerender, plural } from '../app.js';

// =====================================================================
// Duplicates
// =====================================================================
export async function duplicates(view, stale) {
  const d = await api('/duplicates');
  if (stale()) return;
  // a basis lets the pair wrap on a phone instead of squeezing both cards to nothing
  const gameCard = (g) => `<a class="row" href="/game/${g.id}" data-link style="min-width:0;flex:1 1 150px">${cover(g, '', 'width:46px;')}<div style="min-width:0"><div class="ttl ellipsis" style="font-weight:650">${esc(g.title)}</div><div class="small muted row" style="gap:5px">${(g.platforms || []).map(platDot).join('')}${fmtMin(g.minutes)}</div></div></a>`;
  view.innerHTML = `
    <div class="page-h"><div><h1>Duplicates</h1><p>Keep one game per title and make sure nothing is counted twice.</p></div></div>
    <div class="stack">
      <div class="card"><div class="card-h"><h2>Possible double counting <span class="badge ${d.counts.double_counted ? 'warn' : ''}">${d.counts.double_counted.toLocaleString()}</span></h2></div>
        <p class="small muted" style="margin-top:-6px">The same game is counted from two sources that probably report the same playtime — e.g. an imported spreadsheet plus the live Steam account, or two accounts sharing a library.</p>
        <div class="list">${d.double_counted.map((x) => `<div class="item" style="flex-wrap:wrap">
          <a href="/game/${x.game.id}" data-link>${cover(x.game)}</a>
          <div class="grow"><a class="ttl" href="/game/${x.game.id}" data-link>${esc(x.game.title)}</a><div class="sub">${esc(x.reason)}</div>
            <div class="sub">${x.entries.map((e) => `${platDot(e.platform)}${esc(e.account_name || plat(e.platform).label)} ${fmtMin(e.playtime_min)}`).join(' &nbsp;·&nbsp; ')}</div></div>
          <div class="row"><button class="btn sm primary" data-exclude="${x.suggest_exclude}">Exclude ${esc((x.entries.find((e) => e.id === x.suggest_exclude)?.account_name) || plat(x.entries.find((e) => e.id === x.suggest_exclude)?.platform).label)}</button><button class="btn sm ghost" data-dismiss="${esc(x.key)}">Ignore</button></div></div>`).join('') || `<p class="muted row" style="gap:8px">${icon('check', 'ic-inline')}Nothing is counted twice.</p>`}</div>
      </div>
      <div class="card"><div class="card-h"><h2>Merge suggestions <span class="badge ${d.counts.suggestions ? 'accent' : ''}">${d.counts.suggestions.toLocaleString()}</span></h2>${d.suggestions.length > 1 ? '<button class="btn sm" id="merge-all">Merge all ≥ 95%</button>' : ''}</div>
        <p class="small muted" style="margin-top:-6px">Similar titles that weren’t grouped automatically (editions, subtitles, platform tags).${d.counts.suggestions > d.suggestions.length ? ` Showing the ${d.suggestions.length} strongest — resolve some and more appear.` : ''}</p>
        <div class="list">${d.suggestions.map((x) => `<div class="item" style="flex-wrap:wrap;gap:14px">
          ${gameCard(x.games[0])}<span class="badge">${Math.round(x.score * 100)}%</span>${gameCard(x.games[1])}
          <div class="row"><button class="btn sm primary" data-merge="${x.games[0].id}:${x.games[1].id}">${icon('merge')}Merge</button><button class="btn sm ghost" data-dismiss="${esc(x.key)}">Not the same</button></div></div>`).join('') || '<p class="muted">No suggestions.</p>'}</div>
      </div>
      <div class="card"><div class="card-h"><h2>Owned on multiple platforms <span class="badge">${d.counts.cross_platform.toLocaleString()}</span></h2></div>
        ${d.counts.cross_platform > d.cross_platform.length ? `<p class="small muted" style="margin-top:-6px">Showing the first ${d.cross_platform.length}.</p>` : ''}
        <div class="list">${d.cross_platform.map((x) => `<a class="item" href="/game/${x.game.id}" data-link>${cover(x.game)}<div class="grow"><div class="ttl ellipsis">${esc(x.game.title)}</div><div class="sub">${x.entries.map((e) => `<span style="${e.excluded ? 'text-decoration:line-through;opacity:.6' : ''}">${platDot(e.platform)} ${esc(e.account_name || plat(e.platform).label)} ${fmtMin(e.playtime_min)}</span>`).join(' &nbsp;')}</div></div></a>`).join('') || '<p class="muted">No games are grouped across platforms yet.</p>'}</div>
      </div>
    </div>`;
  view.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-merge],[data-dismiss],[data-exclude],#merge-all');
    if (!b) return;
    try {
      if (b.dataset.merge) {
        const [a, c] = b.dataset.merge.split(':').map(Number);
        const ga = d.suggestions.flatMap((x) => x.games).find((g) => g.id === a);
        const gc = d.suggestions.flatMap((x) => x.games).find((g) => g.id === c);
        const [target, src] = (gc.minutes > ga.minutes) ? [c, a] : [a, c];
        await api(`/games/${target}/merge`, { method: 'POST', body: { source_ids: [src] } });
        toast('Merged');
      } else if (b.dataset.dismiss) {
        await api('/duplicates/dismiss', { method: 'POST', body: { key: b.dataset.dismiss } });
      } else if (b.dataset.exclude) {
        const en = b.dataset.exclude;
        await api(`/entries/${en}`, { method: 'PATCH', body: { excluded: true } });
        undoToast('Excluded from totals', () => api(`/entries/${en}`, { method: 'PATCH', body: { excluded: false } }), rerender);
      } else if (b.id === 'merge-all') {
        const strong = d.suggestions.filter((s) => s.score >= 0.95);
        if (!(await confirmBox(`Merge the ${plural(strong.length, 'pair')} that match at 95% or more? Each pair becomes one game; this cannot be undone in one step.`, { ok: 'Merge all', title: `Merge ${plural(strong.length, 'pair')}?` }))) return;
        const done = new Set();
        let n = 0;
        for (const x of strong) {
          const [a, c] = x.games;
          if (done.has(a.id) || done.has(c.id)) continue;
          const [target, src] = c.minutes > a.minutes ? [c.id, a.id] : [a.id, c.id];
          await api(`/games/${target}/merge`, { method: 'POST', body: { source_ids: [src] } });
          done.add(src); n++;
        }
        toast(`Merged ${n} pair${n === 1 ? '' : 's'}`);
      }
      rerender();
    } catch (err) { fail(err); }
  });
}
