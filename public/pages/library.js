import { $, $$, esc, fmtMin, fmtHours, ago, plat, platDot, STATUSES, cover, icon, api, fail, modal, navigate, state, tagItem, splitTags } from '../app.js';
import { emptyState, saveSettings } from './shared.js';

// =====================================================================
// Library
// =====================================================================
const LIB_FLAGS = [['favorite', 'Favorites'], ['recent', 'Played in the last 2 weeks'], ['multi', 'On several platforms']];
function libState() {
  const q = new URLSearchParams(location.search);
  const list = (k) => (q.get(k) || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    q: q.get('q') || '', platform: list('platform'), status: list('status'),
    // IGDB tags, kind:name, | apart (names hold commas)
    tag: splitTags(q.get('tag')).map((t) => { const i = t.indexOf(':'); return i > 0 ? tagItem(t.slice(0, i), t.slice(i + 1)) : t; }),
    // one account at a time: GET /games takes a single account_id
    account: q.get('account_id') || '',
    sort: q.get('sort') || state.settings?.default_library_sort || 'recent', // the URL keeps any other sort
    view: state.settings?.library_view || 'grid',
    // "hide never-played" setting: show played games unless a filter in the URL says otherwise
    played: q.get('played') ?? (state.settings?.library_hide_unplayed ? 'true' : ''), hidden: q.get('hidden') || '',
    ...Object.fromEntries(LIB_FLAGS.map(([k]) => [k, q.get(k) === 'true'])),
  };
}

export async function library(view, stale) {
  const st = libState();
  const [platforms, accounts, tags] = await Promise.all([api('/stats/lifetime'), api('/accounts').catch(() => []), api('/tags').catch(() => [])]);
  if (stale()) return;
  const platList = platforms.platforms.map((p) => p.platform);
  const playedDef = state.settings?.library_hide_unplayed ? 'true' : '';
  // the Genre menu and the release sort appear once IGDB has tagged games
  const TAG_MENU = [['genre', 'Genre'], ['mode', 'Mode'], ['perspective', 'Perspective'], ['theme', 'Theme']];
  const tagList = (kind) => tags.filter((t) => t.kind === kind);
  const hasTags = TAG_MENU.some(([k]) => tagList(k).length) || st.tag.length;
  const sortOpts = [['recent', 'Recently played'], ['trending', 'Trending (2 wks)'], ['playtime', 'Most played'], ['title', 'A–Z'], ['added', 'Recently added'], ['rating', 'Top rated'], ...(hasTags || st.sort === 'released' ? [['released', 'Release date']] : [])];
  view.innerHTML = `
    <div class="page-h"><div><h1>Library</h1><p id="lib-count">&nbsp;</p></div>
      <div class="row"><button class="btn desk-only" id="lib-add">${icon('plus')}Add game</button></div></div>
    <div class="toolbar lib-tb">
      <div class="row lib-row1">
        <div class="search grow">${icon('search')}<input class="input" id="lib-q" type="search" placeholder="Search ${platforms.games.toLocaleString()} games…" value="${esc(st.q)}" aria-label="Search library"></div>
        <select class="input" id="lib-sort" style="width:auto" aria-label="Sort by">${sortOpts.map(([v, l]) => `<option value="${v}" ${st.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <div class="seg desk-only" aria-label="View"><button data-view="grid" class="${st.view === 'grid' ? 'on' : ''}" aria-label="Covers">${icon('grid', 'ic-16')}</button><button data-view="list" class="${st.view === 'list' ? 'on' : ''}" aria-label="List">${icon('list', 'ic-16')}</button></div>
        <button class="btn icon mob-only" id="lib-view-t" aria-label="${st.view === 'grid' ? 'Show as a list' : 'Show as covers'}">${icon(st.view === 'grid' ? 'list' : 'grid')}</button>
      </div>
      <div class="lib-row2" id="lib-filters" role="group" aria-label="Filters">
        <button class="fbtn" data-menu="platform" aria-expanded="false" aria-haspopup="true"></button>
        <button class="fbtn" data-menu="status" aria-expanded="false" aria-haspopup="true"></button>
        ${hasTags ? '<button class="fbtn" data-menu="tag" aria-expanded="false" aria-haspopup="true"></button>' : ''}
        <button class="fbtn" data-menu="more" aria-expanded="false" aria-haspopup="true"></button>
        <span class="pills" id="lib-pills"></span>
      </div>
    </div>
    <div id="lib-items"></div>
    <div id="lib-more" style="height:40px"></div>
    <button class="fab" id="fab-add" aria-label="Add game">${icon('plus')}</button>`;

  // Server-side paging: only one page of games is ever in memory/DOM per scroll step,
  // so 50k-game libraries stay smooth on phones.
  const PAGE = 120;
  let total = 0; let loaded = 0; let maxMin = 1; let loading = false; let seq = 0;
  const box = $('#lib-items');
  const render = (items) => {
    const host = box.firstElementChild;
    host.insertAdjacentHTML('beforeend', items.map((g) => st.view === 'grid'
      ? `<a class="tile" href="/game/${g.id}" data-link><div style="position:relative">${cover(g)}<div class="flags">${g.favorite ? `<span class="badge" title="Favorite">${icon('heartFill')}</span>` : '<span></span>'}${g.status !== 'unset' ? `<span class="badge">${STATUSES[g.status]?.label || g.status}</span>` : ''}</div>${g.minutes ? `<div class="bar"><i style="width:${Math.max(3, Math.sqrt(g.minutes / maxMin) * 100)}%"></i></div>` : ''}</div>
          <div class="t">${esc(g.title)}</div><div class="m">${g.platforms.filter((p) => p !== 'manual' || g.platforms.length === 1).map(platDot).join('')}<span>${g.minutes ? fmtMin(g.minutes, { short: g.minutes >= 600 }) : 'Unplayed'}</span>${g.entry_count > 1 ? `<span class="dim">· ${g.entry_count}×</span>` : ''}</div></a>`
      : `<a class="li" href="/game/${g.id}" data-link>${cover(g)}<div class="grow"><div class="ellipsis" style="font-weight:620">${esc(g.title)}</div><div class="small muted row" style="gap:6px">${g.platforms.map(platDot).join('')}${g.last_played_at ? `Played ${ago(g.last_played_at)}` : 'Never played'}${g.status !== 'unset' ? ` · ${STATUSES[g.status]?.label}` : ''}</div></div><div class="amt" style="font-weight:700">${fmtMin(g.minutes, { short: g.minutes >= 600 })}</div></a>`).join(''));
  };
  /** The filters as query parameters (the same names in the page URL and in GET /games). */
  const filterParams = () => {
    const p = new URLSearchParams();
    if (st.q) p.set('q', st.q);
    if (st.platform.length) p.set('platform', st.platform.join(','));
    if (st.status.length) p.set('status', st.status.join(','));
    if (st.tag.length) p.set('tag', st.tag.join('|')); // items already escaped (tagItem)
    if (st.account) p.set('account_id', st.account);
    for (const [k] of LIB_FLAGS) if (st[k]) p.set(k, 'true');
    if (st.hidden) p.set('hidden', st.hidden);
    return p;
  };
  const params = (offset) => {
    const p = filterParams();
    p.set('limit', String(PAGE)); p.set('offset', String(offset)); p.set('sort', st.sort);
    if (st.played) p.set('played', st.played);
    return p;
  };
  const more = async () => {
    if (loading || loaded >= total) return;
    loading = true;
    const my = seq;
    try {
      const r = await api(`/games?${params(loaded)}`);
      if (my !== seq || stale()) return;
      loaded += r.items.length;
      render(r.items);
      if (!r.items.length) total = loaded;
    } finally { loading = false; }
    checkMore();
  };
  const load = async () => {
    const my = ++seq;
    loading = true;
    let r;
    try { r = await api(`/games?${params(0)}`); } finally { loading = false; }
    if (my !== seq || stale()) return;
    total = r.total; loaded = r.items.length; maxMin = Math.max(1, r.max_minutes || 1);
    $('#lib-count').textContent = `${r.total.toLocaleString()} game${r.total === 1 ? '' : 's'} · ${fmtHours(r.total_minutes)}h total`;
    if (!r.items.length) {
      box.innerHTML = platforms.games
        ? emptyState('search', 'Nothing matches', `No game in your library fits ${activeCount() ? 'these filters' : 'this search'}${st.q ? ` and “${esc(st.q)}”` : ''}.`, `<button class="btn primary" data-clear>${icon('x')}Clear filters</button>`)
        : emptyState('library', 'No tracks yet', 'Connect Steam, Xbox or PlayStation and Vestigo picks up your library — and every hour you’ve already played.', `<a class="btn primary" href="/accounts?add=1" data-link>${icon('plus')}Connect an account</a><a class="btn" href="/settings#import" data-link>${icon('upload')}Import CSV / JSON</a>`);
      return;
    }
    box.innerHTML = st.view === 'grid' ? '<div class="lib-grid"></div>' : '<div class="card pad-0 lib-list"></div>';
    render(r.items);
    checkMore();
  };
  // keep loading while the sentinel is on screen (tall screens / fast scrolling)
  const checkMore = () => {
    const el = $('#lib-more');
    // a view still being prepared has no layout yet: the observer takes over once it shows
    if (el && !view.hidden && el.getBoundingClientRect().top < window.innerHeight + 800) more();
  };
  const sync = () => {
    if (stale()) return; // a search typed just before leaving the page
    const p = filterParams();
    // the URL only records a played filter that differs from the default
    if (st.played !== playedDef) p.set('played', st.played);
    if (st.sort !== (state.settings?.default_library_sort || 'recent')) p.set('sort', st.sort);
    history.replaceState({}, '', `/library${p.toString() ? `?${p}` : ''}`);
    drawFilters();
    load();
  };

  // ---- filter menus: Platform (platforms + one account), Status, More; pills for what is on
  const accName = (id) => accounts.find((a) => String(a.id) === String(id))?.name || `Account ${id}`;
  const statusCount = (k) => platforms.status?.[k] || 0;
  const MORE = [...LIB_FLAGS, ['never', 'Never played'], ...(playedDef ? [['unplayed', 'Include never-played']] : []), ['hidden-all', 'Include hidden'], ['hidden-only', 'Only hidden']];
  const moreOn = (k) => (k === 'never' ? st.played === 'false' : k === 'unplayed' ? st.played === '' : k === 'hidden-all' ? st.hidden === 'all' : k === 'hidden-only' ? st.hidden === 'only' : st[k]);
  const counts = () => ({ platform: st.platform.length + (st.account ? 1 : 0), status: st.status.length, tag: st.tag.length, more: MORE.filter(([k]) => moreOn(k)).length });
  const tagName = (t) => t.slice(t.indexOf(':') + 1);
  const activeCount = () => Object.values(counts()).reduce((a, b) => a + b, 0);
  const check = (name, value, on, label, extra = '', type = 'checkbox') => `<label class="opt"><input type="${type}" class="check${type === 'radio' ? ' radio' : ''}" name="${name}" value="${esc(value)}" ${on ? 'checked' : ''}><span class="grow">${label}</span>${extra}</label>`;
  const menuBody = (kind) => {
    if (kind === 'platform') {
      return `<fieldset><legend>Platforms</legend>${platList.map((p) => check('platform', p, st.platform.includes(p), `${platDot(p)}${esc(plat(p).label)}`, `<span class="tiny muted">${platforms.platforms.find((x) => x.platform === p)?.games ?? ''}</span>`)).join('')}</fieldset>
        ${accounts.length > 1 ? `<fieldset><legend>Account</legend>${check('account', '', !st.account, 'Any account', '', 'radio')}${accounts.map((a) => check('account', a.id, String(st.account) === String(a.id), `${platDot(a.platform)}${esc(a.name)}`, `<span class="tiny muted">${a.games ?? ''}</span>`, 'radio')).join('')}</fieldset>` : ''}`;
    }
    if (kind === 'tag') {
      // a kind's names: any of them; several kinds: all of them (as GET /games reads tag=)
      return TAG_MENU.filter(([k]) => tagList(k).length).map(([k, l]) => `<fieldset><legend>${l}</legend>${tagList(k).slice(0, k === 'theme' ? 12 : 30).map((t) => check('tag', tagItem(k, t.name), st.tag.includes(tagItem(k, t.name)), esc(t.name), `<span class="tiny muted">${t.games}</span>`)).join('')}</fieldset>`).join('')
        || '<p class="small muted">No genres yet: IGDB is still matching your games.</p>';
    }
    if (kind === 'status') return `<fieldset><legend>Status</legend>${Object.entries(STATUSES).map(([k, v]) => check('status', k, st.status.includes(k), esc(v.label), `<span class="tiny muted">${statusCount(k)}</span>`)).join('')}</fieldset>`;
    return `<fieldset><legend>Show</legend>${MORE.map(([k, l]) => check('more', k, moreOn(k), l)).join('')}</fieldset>`;
  };
  const LABELS = { platform: 'Platform', status: 'Status', tag: 'Genre', more: 'More' };
  const drawFilters = () => {
    const c = counts();
    for (const b of $$('[data-menu]', view)) {
      const k = b.dataset.menu;
      b.classList.toggle('on', !!c[k]);
      b.innerHTML = `${LABELS[k]}${c[k] ? ` <span class="fcount">· ${c[k]}</span>` : ''}${icon('chevD', 'ic-14')}`;
      b.setAttribute('aria-label', `${LABELS[k]} filter${c[k] ? `, ${c[k]} on` : ''}`);
    }
    const pills = [
      ...st.platform.map((p) => [`platform:${p}`, `${platDot(p)}${esc(plat(p).label)}`]),
      ...(st.account ? [[`account:${st.account}`, esc(accName(st.account))]] : []),
      ...st.status.map((s) => [`status:${s}`, esc(STATUSES[s]?.label || s)]),
      ...st.tag.map((t) => [`tag:${t}`, esc(tagName(t))]),
      ...MORE.filter(([k]) => moreOn(k)).map(([k, l]) => [`more:${k}`, esc(l)]),
    ];
    $('#lib-pills').innerHTML = pills.map(([k, l]) => `<button class="pill" data-rm="${esc(k)}" aria-label="Remove filter: ${esc(l.replace(/<[^>]+>/g, ''))}">${l}${icon('x', 'ic-14')}</button>`).join('')
      + (pills.length ? '<button class="pill-clear" data-clear>Clear all</button>' : '');
  };
  const apply = (name, value, on) => {
    if (name === 'platform' || name === 'status' || name === 'tag') st[name] = on ? [...new Set([...st[name], value])] : st[name].filter((x) => x !== value);
    else if (name === 'account') st.account = on ? value : '';
    else if (value === 'never') st.played = on ? 'false' : playedDef;
    else if (value === 'unplayed') st.played = on ? '' : playedDef;
    else if (value === 'hidden-all') st.hidden = on ? 'all' : (st.hidden === 'all' ? '' : st.hidden);
    else if (value === 'hidden-only') st.hidden = on ? 'only' : (st.hidden === 'only' ? '' : st.hidden);
    else st[value] = on;
    sync();
  };
  const clearAll = () => {
    Object.assign(st, { platform: [], status: [], tag: [], account: '', played: playedDef, hidden: '', ...Object.fromEntries(LIB_FLAGS.map(([k]) => [k, false])) });
    sync();
  };
  let menu = null; // the open popover: { el, btn, close }
  const closeMenu = (focus = false) => {
    if (!menu) return;
    const m = menu; menu = null;
    m.btn.setAttribute('aria-expanded', 'false');
    m.close();
    if (focus) m.btn.focus();
  };
  const bindMenu = (root, kind) => {
    root.addEventListener('change', (e) => {
      const i = e.target;
      if (!i.matches('input')) return;
      apply(i.name, i.value, i.checked);
      // a radio-like pair (never / include never-played, include / only hidden) shows what is on now
      root.querySelector('.fbody').innerHTML = menuBody(kind);
      root.querySelector(`input[name="${CSS.escape(i.name)}"][value="${CSS.escape(i.value)}"]`)?.focus();
    });
  };
  const openMenu = (btn) => {
    const kind = btn.dataset.menu;
    if (menu?.btn === btn) return closeMenu(true);
    closeMenu();
    btn.setAttribute('aria-expanded', 'true');
    if (matchMedia('(max-width: 600px)').matches) {
      // a phone: the menu is a sheet
      const m = modal({ title: `${LABELS[kind]} filters`, body: `<div class="fmenu sheet"><div class="fbody">${menuBody(kind)}</div></div>`, foot: '<button class="btn ghost" data-clear-menu>Clear</button><span class="grow"></span><button class="btn primary" data-close>Done</button>',
        onMount(el) {
          bindMenu(el, kind);
          el.querySelector('[data-clear-menu]').addEventListener('click', () => {
            if (kind === 'platform') Object.assign(st, { platform: [], account: '' });
            else if (kind === 'status') st.status = [];
            else if (kind === 'tag') st.tag = [];
            else Object.assign(st, { played: playedDef, hidden: '', ...Object.fromEntries(LIB_FLAGS.map(([k]) => [k, false])) });
            sync();
            el.querySelector('.fbody').innerHTML = menuBody(kind);
          });
        } });
      const obs = new MutationObserver(() => { if (!m.el.isConnected) { obs.disconnect(); if (menu?.el === m.el) { menu = null; btn.setAttribute('aria-expanded', 'false'); } } });
      obs.observe(document.body, { childList: true });
      menu = { el: m.el, btn, close: m.close };
      return;
    }
    const el = document.createElement('div');
    el.className = 'fmenu card';
    el.id = `lib-menu-${kind}`;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', `${LABELS[kind]} filters`);
    el.innerHTML = `<div class="fbody">${menuBody(kind)}</div>`;
    btn.setAttribute('aria-controls', el.id);
    btn.after(el);
    el.style.left = `${btn.offsetLeft}px`;
    el.style.top = `${btn.offsetTop + btn.offsetHeight + 6}px`;
    // keep the card on screen: shift it left when it would leave the right edge
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth - 8) el.style.left = `${Math.max(0, btn.offsetLeft - (r.right - (innerWidth - 8)))}px`;
    bindMenu(el, kind);
    el.querySelector('input')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); } };
    const onDown = (e) => { if (!el.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeMenu(); };
    const onFocus = (e) => { if (!el.contains(e.target) && e.target !== btn) closeMenu(); };
    el.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('focusin', onFocus);
    menu = { el, btn, close: () => { el.remove(); document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('focusin', onFocus); } };
  };
  $('#lib-filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-menu]');
    if (b) return openMenu(b);
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      const [name, ...v] = rm.dataset.rm.split(':');
      const value = v.join(':');
      apply(name === 'more' ? 'more' : name, value, false);
      ($('#lib-pills [data-rm]') || $('#lib-filters [data-menu="more"]'))?.focus();
    }
  });
  // "Clear all" by the pills keeps the search; the no-match state's "Clear filters" clears it too
  view.addEventListener('click', (e) => {
    const c = e.target.closest('[data-clear]');
    if (!c) return;
    if (!c.matches('.pill-clear')) { st.q = ''; $('#lib-q').value = ''; }
    clearAll();
    $('#lib-q').focus();
  });
  drawFilters();
  let t;
  $('#lib-q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value.trim(); sync(); }, 180); });
  $('#lib-sort').addEventListener('change', (e) => { st.sort = e.target.value; sync(); });
  const setView = (v) => {
    st.view = v;
    $$('[data-view]', view).forEach((x) => x.classList.toggle('on', x.dataset.view === v));
    const tb = $('#lib-view-t');
    tb.innerHTML = icon(v === 'grid' ? 'list' : 'grid');
    tb.setAttribute('aria-label', v === 'grid' ? 'Show as a list' : 'Show as covers');
    sync();
    if (state.settings?.library_view !== st.view) saveSettings({ library_view: st.view }).catch(() => {}); // remembered on every device
  };
  $$('[data-view]', view).forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#lib-view-t').addEventListener('click', () => setView(st.view === 'grid' ? 'list' : 'grid'));
  const addGame = () => modal({
    title: 'Add a game',
    body: `<form class="stack" id="ag"><div class="field"><label>Title</label><input class="input" name="title" required placeholder="The Legend of Zelda: Tears of the Kingdom"></div>
      <div class="field"><label>Cover image URL <span class="dim">(optional)</span></label><input class="input" name="cover_url" placeholder="https://…"></div>
      <div class="field"><label>Status</label><select class="input" name="status">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select></div>
      <p class="small muted" style="margin:0">Manual games are perfect for Switch, retro or anything without an API. Log sessions on the game page.</p></form>`,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="ag-save">Add game</button>',
    onMount(el, close) {
      el.querySelector('#ag-save').addEventListener('click', async () => {
        const f = el.querySelector('#ag');
        if (!f.title.value.trim()) return;
        try { const g = await api('/games', { method: 'POST', body: { title: f.title.value, cover_url: f.cover_url.value, status: f.status.value } }); close(); navigate(`/game/${g.id}`); } catch (e) { fail(e); }
      });
    },
  });
  $('#lib-add').addEventListener('click', addGame);
  $('#fab-add').addEventListener('click', addGame);
  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) more(); }, { rootMargin: '800px' });
  io.observe($('#lib-more'));
  await load();
}
