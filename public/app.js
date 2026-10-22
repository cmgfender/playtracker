import { pages } from './pages.js';

// ---------- tiny helpers ----------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtMin(m, { short = false } = {}) {
  m = Math.round(Number(m) || 0);
  if (m < 60) return `${m}m`;
  if (state.settings?.time_format === 'decimal') {
    const h = m / 60;
    return short || h >= 100 ? `${Math.round(h).toLocaleString()}h` : `${h.toFixed(1).replace(/\.0$/, '')}h`;
  }
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (short || h >= 100) return `${h.toLocaleString()}h`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

export function fmtHours(m, digits = 1) {
  const h = (Number(m) || 0) / 60;
  return h >= 100 ? Math.round(h).toLocaleString() : h.toFixed(h >= 10 ? 0 : digits).replace(/\.0$/, '');
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
export function ago(t) {
  if (!t) return 'never';
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const units = [['year', 31536e6], ['month', 2592e6], ['week', 6048e5], ['day', 864e5], ['hour', 36e5], ['minute', 6e4]];
  for (const [u, ms] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), u);
  return diff > 0 ? 'in a moment' : 'just now';
}

export function fmtDate(t, opts = { month: 'short', day: 'numeric' }) {
  if (!t) return '—';
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? opts : { ...opts, year: 'numeric' });
}

export function fmtTime(t) {
  return t ? new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}

export function dayLabel(t) {
  const d = new Date(t); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7 && diff > 0) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return fmtDate(t, { weekday: 'short', month: 'short', day: 'numeric' });
}

export const PLATFORMS = {
  steam: { label: 'Steam', color: 'var(--steam)', hex: '#66c0f4', short: 'S' },
  xbox: { label: 'Xbox', color: 'var(--xbox)', hex: '#3fbf3f', short: 'X' },
  psn: { label: 'PlayStation', color: 'var(--psn)', hex: '#3b82f6', short: 'P' },
  custom: { label: 'Custom', color: 'var(--custom)', hex: '#f59e0b', short: 'C' },
  manual: { label: 'Manual', color: 'var(--manual)', hex: '#c084fc', short: 'M' },
  import: { label: 'Imported', color: 'var(--import)', hex: '#94a3b8', short: 'I' },
};
export function plat(p) {
  if (PLATFORMS[p]) return PLATFORMS[p];
  let h = 0; for (const c of String(p)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return { label: String(p).replace(/^\w/, (c) => c.toUpperCase()), color: `hsl(${h} 70% 60%)`, hex: `hsl(${h} 70% 60%)`, short: String(p)[0]?.toUpperCase() || '?' };
}
export const platDot = (p) => `<span class="dot" style="background:${plat(p).color}" title="${esc(plat(p).label)}"></span>`;
export const platTag = (p) => `<span class="plat">${platDot(p)}${esc(plat(p).label)}</span>`;

export const STATUSES = {
  unset: { label: 'No status', cls: '' },
  playing: { label: 'Playing', cls: 'accent' },
  backlog: { label: 'Backlog', cls: '' },
  paused: { label: 'Paused', cls: 'warn' },
  beaten: { label: 'Beaten', cls: 'good' },
  completed: { label: 'Completed', cls: 'good' },
  dropped: { label: 'Dropped', cls: 'bad' },
  wishlist: { label: 'Wishlist', cls: '' },
};

function hue(s) { let h = 0; for (const c of String(s)) h = (h * 33 + c.charCodeAt(0)) % 360; return h; }

export function cover(g, cls = '', style = '') {
  const title = g.title || '';
  const h = hue(title);
  const initials = title.length > 28 ? title.split(/\s+/).slice(0, 4).join(' ') : title;
  const img = g.cover_url ? `<img loading="lazy" decoding="async" src="${esc(g.cover_url)}" alt="" onload="this.classList.add('ok')" onerror="this.remove()">` : '';
  return `<div class="cover ${cls}" style="${style}background:linear-gradient(150deg,hsl(${h} 55% 38%),hsl(${(h + 50) % 360} 60% 22%))"><div class="ph"><span class="full">${esc(initials)}</span><span class="ini">${esc(title.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase())}</span></div>${img}</div>`;
}

// ---------- icons (inline, stroke-based) ----------
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  library: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  sessions: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  accounts: '<path d="M16 11a4 4 0 1 0-8 0M3 21a9 9 0 0 1 18 0"/><circle cx="12" cy="7" r="4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  dupes: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  sync: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="currentColor"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-6.4 0-10-7-10-7a18.4 18.4 0 0 1 5.1-5.9M9.9 4.2A9.7 9.7 0 0 1 12 4c6.4 0 10 7 10 7a18.5 18.5 0 0 1-2.2 3.2M1 1l22 22"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  merge: '<path d="M6 3v6a6 6 0 0 0 6 6h6M18 21v-6M6 21v-6"/><circle cx="18" cy="15" r="0"/><path d="m15 12 3 3-3 3"/>',
  split: '<path d="M16 3h5v5M8 3H3v5M21 3l-7.5 7.5M3 3l7.5 7.5M12 22v-8"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  gift: '<path d="M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.3.3 1.6 1.4 2.8 2.5 2.8z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  pad: '<path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><rect x="2" y="6" width="20" height="12" rx="6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
};
export function icon(name, cls = '') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

// ---------- API client ----------
export async function api(path, { method = 'GET', body, raw = false, headers = {} } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (body !== undefined) {
    if (typeof body === 'string') { opts.body = body; opts.headers['Content-Type'] ||= 'text/csv'; } else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(`/api/v1${path}`, opts);
  if (res.status === 401 && !path.startsWith('/auth')) { state.needLogin = true; render(); throw new Error('Login required'); }
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

// ---------- toasts / modals ----------
export function toast(msg, { bad = false, ms = 3200 } = {}) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, ms);
}
export const fail = (e) => toast(e?.message || String(e), { bad: true, ms: 5000 });

export function modal({ title, body, foot = '', onMount, wide = false }) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" ${wide ? 'style="width:min(820px,100%)"' : ''}>
    <div class="mh"><h2>${title}</h2><button class="btn ghost icon" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="mb">${body}</div>${foot ? `<div class="mf">${foot}</div>` : ''}</div>`;
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(ov);
  const m = ov.querySelector('.modal');
  onMount?.(m, close);
  setTimeout(() => m.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea')?.focus({ preventScroll: true }), 50);
  return { el: m, close };
}

export function confirmBox(message, { ok = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: 'Are you sure?',
      body: `<p class="muted" style="margin:0">${message}</p>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" data-ok>${esc(ok)}</button>`,
      onMount: (el, close) => el.querySelector('[data-ok]').addEventListener('click', () => { done = true; close(); resolve(true); }),
    });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(document.body, { childList: true });
  });
}

// ---------- state / routing ----------
export const state = { needLogin: false, authEnabled: false, settings: null, syncing: false, view: null };

const NAV = [
  { path: '/', label: 'Home', icon: 'home', tab: true },
  { path: '/library', label: 'Library', icon: 'library', tab: true },
  { path: '/sessions', label: 'Sessions', icon: 'sessions', tab: true },
  { path: '/stats', label: 'Stats', icon: 'stats', tab: true },
  { path: '/duplicates', label: 'Duplicates', icon: 'dupes' },
  { path: '/history', label: 'Improve history', icon: 'clock' },
  { path: '/accounts', label: 'Accounts', icon: 'accounts' },
  { path: '/system', label: 'System', icon: 'info' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
  { path: '/api', label: 'API', icon: 'code' },
];

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
  route();
  window.scrollTo({ top: 0 });
}

function current() {
  return location.pathname.replace(/\/+$/, '') || '/';
}

function shell() {
  const p = current();
  const active = (n) => (n.path === '/' ? p === '/' : p.startsWith(n.path) || (n.path === '/library' && p.startsWith('/game')));
  const moreActive = !NAV.filter((n) => n.tab).some(active);
  return `<div class="shell">
    <aside class="side">
      <a class="brand" href="/" data-link><span class="brand-mark">${icon('pad')}</span>PlayTracker</a>
      ${NAV.map((n) => `<a class="nav-link ${active(n) ? 'active' : ''}" href="${n.path}" data-link>${icon(n.icon)}${n.label}${n.path === '/duplicates' ? '<span class="badge accent hide" id="dupe-badge"></span>' : n.path === '/system' ? '<span class="badge bad hide" id="err-badge"></span>' : ''}</a>`).join('')}
      <div class="side-foot col">
        <button class="btn" data-action="sync-all" id="sync-all-btn">${icon('sync')}Sync all</button>
        ${state.authEnabled ? `<button class="btn ghost sm" data-action="logout">${icon('logout')}Log out</button>` : ''}
      </div>
    </aside>
    <header class="topbar">
      <a class="brand grow" href="/" data-link><span class="brand-mark">${icon('pad')}</span>PlayTracker</a>
      <button class="btn icon ghost" data-action="sync-all" aria-label="Sync all">${icon('sync')}</button>
    </header>
    <main class="main" id="view"></main>
    <nav class="tabbar">
      ${NAV.filter((n) => n.tab).map((n) => `<a href="${n.path}" data-link class="${active(n) ? 'active' : ''}">${icon(n.icon)}${n.label}</a>`).join('')}
      <a href="/more" data-link class="${moreActive ? 'active' : ''}">${icon('more')}More</a>
    </nav>
  </div>`;
}

const ROUTES = [
  [/^\/$/, 'dashboard'],
  [/^\/library$/, 'library'],
  [/^\/game\/(\d+)$/, 'game'],
  [/^\/sessions$/, 'sessions'],
  [/^\/stats$/, 'stats'],
  [/^\/wrapped\/(\d{4})$/, 'wrapped'],
  [/^\/duplicates$/, 'duplicates'],
  [/^\/accounts$/, 'accounts'],
  [/^\/settings$/, 'settings'],
  [/^\/api$/, 'apidocs'],
  [/^\/system$/, 'system'],
  [/^\/history$/, 'history'],
  [/^\/more$/, 'more'],
];

let renderSeq = 0;
export async function route() {
  if (state.needLogin) return render();
  const p = current();
  $('#app').innerHTML = shell();
  applyBadges();
  const view = $('#view');
  const seq = ++renderSeq;
  for (const [re, name] of ROUTES) {
    const m = re.exec(p);
    if (!m) continue;
    state.view = name;
    view.innerHTML = `<div class="skel" style="height:34px;width:200px;margin-bottom:22px"></div><div class="kpis">${'<div class="skel" style="height:96px"></div>'.repeat(5)}</div><div class="skel" style="height:260px;margin-top:16px"></div>`;
    try {
      await pages[name](view, ...m.slice(1), () => seq !== renderSeq);
    } catch (e) {
      if (seq !== renderSeq) return;
      if (state.needLogin) return;
      view.innerHTML = `<div class="empty"><div class="em-ic">${icon('info')}</div><h2>Something went wrong</h2><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
    }
    return;
  }
  view.innerHTML = `<div class="empty"><h2>Not found</h2><a class="btn" href="/" data-link>Go home</a></div>`;
}

export function rerender() {
  const y = window.scrollY;
  return route().then(() => window.scrollTo({ top: y }));
}

function render() {
  if (state.needLogin) {
    $('#app').innerHTML = `<div class="login"><form class="card stack" id="login-form">
      <div class="brand" style="padding:0;justify-content:center"><span class="brand-mark">${icon('pad')}</span>PlayTracker</div>
      <div class="field"><label>Password</label><input class="input" type="password" name="password" autocomplete="current-password" required autofocus></div>
      <button class="btn primary" style="width:100%">Sign in</button></form></div>`;
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/auth/login', { method: 'POST', body: { password: e.target.password.value } });
        state.needLogin = false;
        await boot();
      } catch (err) { fail(err); }
    });
    return;
  }
  route();
}

// ---------- sync polling ----------
let pollTimer = null;
export async function watchSync({ refresh = true } = {}) {
  clearTimeout(pollTimer);
  const accounts = await api('/accounts').catch(() => []);
  const running = accounts.some((a) => a.syncing);
  $$('[data-action="sync-all"]').forEach((b) => b.classList.toggle('loading', running));
  if (running) {
    state.syncing = true;
    pollTimer = setTimeout(() => watchSync({ refresh }), 2000);
  } else if (state.syncing) {
    state.syncing = false;
    const errs = accounts.filter((a) => a.last_status === 'error');
    if (errs.length) toast(`Sync failed: ${errs[0].name} — ${errs[0].last_error}`, { bad: true, ms: 7000 });
    else toast('Sync complete');
    refreshDupeBadge();
    if (refresh) rerender();
  }
  return accounts;
}

async function syncAll() {
  try {
    const r = await api('/sync', { method: 'POST' });
    if (!r.started) { toast('No accounts to sync — connect one first'); return navigate('/accounts'); }
    toast(`Syncing ${r.started} account${r.started > 1 ? 's' : ''}…`);
    state.syncing = true;
    setTimeout(() => watchSync(), 800);
  } catch (e) { fail(e); }
}

function applyBadges() {
  const set = (sel, n) => { const b = $(sel); if (b) { b.textContent = n > 999 ? '999+' : n; b.classList.toggle('hide', !n); } };
  set('#dupe-badge', state.badges?.dupes || 0);
  set('#err-badge', state.badges?.errors || 0);
}

async function refreshDupeBadge() {
  state.badges ||= {};
  try { state.badges.errors = (await api('/logs?level=error&limit=1')).counts_24h?.error || 0; } catch { /* ignore */ }
  try { const d = await api('/duplicates?summary=true'); state.badges.dupes = d.counts.suggestions + d.counts.double_counted; } catch { /* ignore */ }
  applyBadges();
}

// ---------- global events ----------
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && a.target !== '_blank') {
    e.preventDefault();
    if (a.getAttribute('href') !== location.pathname + location.search) navigate(a.getAttribute('href'));
    return;
  }
  const act = e.target.closest('[data-action]');
  if (!act) return;
  if (act.dataset.action === 'sync-all') syncAll();
  if (act.dataset.action === 'logout') api('/auth/logout', { method: 'POST' }).then(() => { state.needLogin = true; render(); });
});
window.addEventListener('popstate', () => route());

export function applyTheme(s) {
  const root = document.documentElement;
  const theme = s.theme === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : s.theme;
  root.dataset.theme = theme;
  root.dataset.density = s.ui_density || 'comfortable';
  root.dataset.covers = s.cover_size || 'm';
  root.dataset.coverTitles = s.cover_titles || 'auto';
  if (s.accent) root.style.setProperty('--accent', s.accent);
  document.querySelector('meta[name=theme-color]').content = theme === 'light' ? '#f4f5f9' : theme === 'black' ? '#000000' : '#0b0d12';
  try {
    localStorage.setItem('pt-theme', theme); localStorage.setItem('pt-accent', s.accent || '');
    localStorage.setItem('pt-ui', JSON.stringify({ density: root.dataset.density, covers: root.dataset.covers, coverTitles: root.dataset.coverTitles }));
  } catch { /* private mode */ }
}

async function boot() {
  const st = await api('/auth/status').catch(() => ({ auth_enabled: false, authenticated: true }));
  state.authEnabled = st.auth_enabled;
  if (!st.authenticated) { state.needLogin = true; return render(); }
  state.settings = await api('/settings').catch(() => ({}));
  applyTheme(state.settings);
  // follow the theme when it is 'auto' and the system switches
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (state.settings?.theme === 'auto') applyTheme(state.settings); });
  // start page (only when opening the app at its root)
  const start = { library: '/library', sessions: '/sessions', stats: '/stats' }[state.settings.start_page];
  let started = false;
  try { started = !!sessionStorage.getItem('pt-started'); sessionStorage.setItem('pt-started', '1'); } catch { /* ignore */ }
  if (start && current() === '/' && !started) history.replaceState({}, '', start);
  await route();
  watchSync({ refresh: true });
  refreshDupeBadge();
}

if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') {
  navigator.serviceWorker?.register('/sw.js').catch(() => {});
}
boot();
