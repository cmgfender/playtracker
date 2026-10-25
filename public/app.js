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

/** "1 session", "3 sessions" (or a custom plural: plural(n, 'entry', 'entries')). */
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

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

// colours are theme tokens (app.css): the light theme darkens them to stay readable on white
export const PLATFORMS = {
  steam: { label: 'Steam', color: 'var(--steam)', short: 'S' },
  xbox: { label: 'Xbox', color: 'var(--xbox)', short: 'X' },
  psn: { label: 'PlayStation', color: 'var(--psn)', short: 'P' },
  custom: { label: 'Custom', color: 'var(--custom)', short: 'C' },
  manual: { label: 'Manual', color: 'var(--manual)', short: 'M' },
  import: { label: 'Imported', color: 'var(--import)', short: 'I' },
};
export function plat(p) {
  if (PLATFORMS[p]) return PLATFORMS[p];
  let h = 0; for (const c of String(p)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return { label: String(p).replace(/^\w/, (c) => c.toUpperCase()), color: `hsl(${h} 70% 60%)`, short: String(p)[0]?.toUpperCase() || '?' };
}
export const platDot = (p) => `<span class="dot" style="background:${plat(p).color}" title="${esc(plat(p).label)}"></span>`;
export const platTag = (p) => `<span class="plat">${platDot(p)}${esc(plat(p).label)}</span>`;
/** Account chip: the platform's letter on a tint of its colour, never white text on a solid fill. */
export const platIcon = (p, size = 34) => `<span class="plat-ic" style="--pc:${plat(p).color};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px" title="${esc(plat(p).label)}" aria-hidden="true">${esc(plat(p).short)}</span>`;

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

/** A title's placeholder hue (0-359): the same game always gets the same colours. */
export function coverHue(s) { let h = 0; for (const c of String(s)) h = (h * 33 + c.charCodeAt(0)) % 360; return h; }

const SMALL_WORDS = new Set(['of', 'the', 'a', 'an']);
/** Two initials from the significant words: "God of War" -> "GW", "Baldur's Gate 3" -> "BG". */
export function monogram(title) {
  const words = String(title || '').replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
  const sig = words.filter((w) => !SMALL_WORDS.has(w.toLowerCase()));
  return (sig.length ? sig : words).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

/** Cover art, or a tinted placeholder (colours from app.css, per theme) with the title and a monogram. */
export function cover(g, cls = '', style = '') {
  const title = g.title || '';
  const full = title.length > 28 ? title.split(/\s+/).slice(0, 4).join(' ') : title;
  const img = g.cover_url ? `<img loading="lazy" decoding="async" src="${esc(g.cover_url)}" alt="" onload="this.classList.add('ok')" onerror="this.remove()">` : '';
  return `<div class="cover ${cls}" style="--ph-h:${coverHue(title)};${style}"><div class="ph"><span class="full">${esc(full)}</span><span class="ini">${esc(monogram(title))}</span></div>${img}</div>`;
}

// ---------- icons (inline, stroke-based) ----------
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  library: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  // a stopwatch; `history` (Improve history) is a clock running backwards and `clock` a plain one
  sessions: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5M10 2h4M12 2v3"/>',
  history: '<path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  accounts: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  system: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  dupes: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  sync: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="currentColor"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>',
  heartFill: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z" fill="currentColor"/>',
  arrowR: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
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
  // the brand mark's dashed V as a regular stroke-2 icon (the mark itself is too heavy beside other icons)
  trail: '<path d="M3.8 3.6 5.9 7.7M7.7 11.2l2 4M14.3 15.2l2-4M18.1 7.7l2.1-4.1"/><circle cx="12" cy="19.5" r="1.8" fill="currentColor"/>',
  external: '<path d="M7 17 17 7M8 7h9v9"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3.3.3 1.6 1.4 2.8 2.5 2.8z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  offline: '<path d="M2 2l20 20M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 4.2-2.4M19 12.9a10 10 0 0 0-2.3-1.6M1.4 9a15 15 0 0 1 4.5-2.9M22.6 9A15 15 0 0 0 10.7 5.1M12 20h.01"/>',
};
export function icon(name, cls = '') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

// ---------- brand ----------
export const APP = 'Vestigo';
/** The Vestigo mark: a V walked in steps that meet at a dot; the oldest steps fade. Not an icon(): it has its own stroke. */
export const MARK = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='4.2' stroke-linecap='round' aria-hidden='true'><path d='M4.06 4.16 5.53 7.01' opacity='.55'/><path d='M7.96 11.72 9.43 14.56' opacity='.8'/><path d='M14.57 14.56 16.04 11.72M18.47 7.01 19.94 4.16'/><circle cx='12' cy='19.54' r='2.4' fill='currentColor' stroke='none'/></svg>";
const TAGLINE = 'Every session leaves a trace.';

/** Tile + wordmark. `sub` adds the "Media tracker" line (sidebar); `stacked` is the centred login / first-run lockup. */
export function brand({ sub = false, stacked = false, link = true, cls = '' } = {}) {
  const inner = `<span class="brand-mark">${MARK}</span><span class="brand-word">${APP}${sub ? '<small>Media tracker</small>' : ''}</span>`;
  const c = `brand${stacked ? ' brand-stack' : ''}${cls ? ` ${cls}` : ''}`;
  return link ? `<a class="${c}" href="/" data-link aria-label="${APP} home">${inner}</a>` : `<div class="${c}">${inner}</div>`;
}
export const tagline = () => `<p class="tagline">${TAGLINE}</p>`;

/** Tab / history title: "Vestigo" alone, or "<page> · Vestigo". */
export function setTitle(page = '') {
  document.title = page ? `${page} · ${APP}` : APP;
}

// ---------- API client ----------
export async function api(path, { method = 'GET', body, raw = false, headers = {} } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (body !== undefined) {
    if (typeof body === 'string') { opts.body = body; opts.headers['Content-Type'] ||= 'text/csv'; } else if (body instanceof Blob || body instanceof ArrayBuffer) { opts.body = body; } else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(`/api/v1${path}`, opts);
  if (res.status === 401 && !path.startsWith('/auth')) { state.needLogin = true; render(); throw new Error('Login required'); }
  // the service worker answers from its cache when the server is out of reach, and says from when
  const cached = res.headers.get('X-Vestigo-Offline');
  if (cached) setOffline(Number(cached) || Date.now());
  else if (state.offline && res.status !== 503) setOffline(null);
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error === 'offline' ? 'Offline: this page has not been saved for offline use' : data.error || `HTTP ${res.status}`), { status: res.status, data, offline: data.error === 'offline' });
  return data;
}

// ---------- toasts / modals ----------
/**
 * A toast: #toasts is a polite live region, so it is announced; errors are repeated in the #alerts
 * region (role=alert). `action` adds a button ({ label, run }), e.g. Undo; such a toast stays 6s, an
 * error 10s with a close button, `ms: Infinity` until closed. Pointing at it or focusing it pauses the timer.
 */
export function toast(msg, { action = null, bad = false, ms } = {}) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  const text = document.createElement('span');
  text.className = 'toast-msg';
  text.textContent = msg;
  el.append(text);
  let timer = null;
  let left = ms ?? (bad ? 10000 : action ? 6000 : 3200);
  let since = 0;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    // keyboard focus on the toast goes back into the page instead of to <body>
    if (el.contains(document.activeElement)) ($('.overlay .modal') || $('#view h1') || $('#view'))?.focus({ preventScroll: true });
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  };
  const start = () => { if (Number.isFinite(left)) { since = Date.now(); timer = setTimeout(dismiss, left); } };
  const pause = () => { if (timer) { clearTimeout(timer); timer = null; left = Math.max(1500, left - (Date.now() - since)); } };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-act';
    b.textContent = action.label;
    b.addEventListener('click', () => { dismiss(); action.run(); });
    el.append(b);
  }
  if (bad) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'toast-x';
    x.setAttribute('aria-label', 'Dismiss');
    x.innerHTML = icon('x');
    x.addEventListener('click', dismiss);
    el.append(x);
  }
  el.addEventListener('pointerenter', pause);
  el.addEventListener('focusin', pause);
  el.addEventListener('pointerleave', () => { if (!timer && !el.contains(document.activeElement)) start(); });
  el.addEventListener('focusout', (e) => { if (!timer && !el.contains(e.relatedTarget) && !el.matches(':hover')) start(); });
  $('#toasts').append(el);
  if (bad) {
    // the same text twice in a row is still announced: clear first, fill on the next frame
    const al = $('#alerts');
    if (al) { al.textContent = ''; requestAnimationFrame(() => { al.textContent = msg; }); }
  }
  start();
  return { el, dismiss };
}
export const fail = (e) => toast(e?.message || String(e), { bad: true });

/** Undo toast: `msg` with an Undo button that runs `undo` and then `after` (e.g. a reload of the list). */
export function undoToast(msg, undo, after = () => {}) {
  return toast(msg, { action: { label: 'Undo', run: async () => { try { await undo(); toast('Undone'); after(); } catch (e) { fail(e); } } } });
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const visible = (el) => (el.checkVisibility ? el.checkVisibility() : !!el.getClientRects().length);
let modalSeq = 0;

/**
 * A dialog (a bottom sheet on a phone). The page behind is inert and does not scroll, Tab stays
 * inside, Escape closes the top dialog only, and focus returns to what opened it. It focuses its
 * first field, but on a touch screen its title (no keyboard popping up) unless `autofocus`.
 */
export function modal({ title, body, foot = '', onMount, wide = false, autofocus = false }) {
  const opener = document.activeElement;
  const hid = `mh-${++modalSeq}`;
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="${hid}" ${wide ? 'style="width:min(820px,100%)"' : ''}>
    <div class="mh"><h2 id="${hid}" tabindex="-1">${title}</h2><button class="btn ghost icon" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="mb">${body}</div>${foot ? `<div class="mf">${foot}</div>` : ''}</div>`;
  const m = ov.querySelector('.modal');
  const top = () => [...document.querySelectorAll('.overlay')].pop() === ov;
  const close = () => {
    if (!ov.isConnected) return;
    ov.remove();
    document.removeEventListener('keydown', onKey);
    if (!$('.overlay')) { $('#app').inert = false; document.documentElement.style.overflow = ''; }
    // back to the opener; if a re-render took it, to the page heading
    const back = opener?.isConnected && opener !== document.body ? opener : ($('.overlay .modal') || $('#view h1'));
    back?.focus({ preventScroll: true });
  };
  const onKey = (e) => {
    if (!top()) return;
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...m.querySelectorAll(FOCUSABLE)].filter(visible);
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0]; const last = f[f.length - 1];
    const a = document.activeElement;
    if (!m.contains(a)) { if (!a?.closest('#toasts')) { e.preventDefault(); first.focus(); } return; }
    if (e.shiftKey && (a === first || !f.includes(a))) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
  };
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(ov);
  $('#app').inert = true;
  document.documentElement.style.overflow = 'hidden';
  onMount?.(m, close);
  a11y(m);
  const field = m.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea');
  const h2 = m.querySelector(`#${hid}`);
  h2.focus({ preventScroll: true }); // at once: the opener is inert now
  if (field && (autofocus || !matchMedia('(pointer: coarse)').matches)) setTimeout(() => { if (document.activeElement === h2) field.focus({ preventScroll: true }); }, 50);
  return { el: m, close };
}

export function confirmBox(message, { ok = 'Confirm', danger = false, title = 'Are you sure?' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: esc(title),
      body: `<p class="muted" style="margin:0">${message}</p>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" data-ok>${esc(ok)}</button>`,
      onMount: (el, close) => el.querySelector('[data-ok]').addEventListener('click', () => { done = true; close(); resolve(true); }),
    });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el)) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(document.body, { childList: true });
  });
}

// ---------- labels and toggle states ----------
let uidSeq = 0;
const uid = (el, prefix) => el.id || (el.id = `${prefix}-${++uidSeq}`);

/** Every `.field > label` names the field's first control; a settings row's title names the row's control. */
export function linkLabels(root) {
  for (const l of root.querySelectorAll('.field > label:not([for])')) {
    const c = l.parentElement.querySelector('input:not([type=hidden]), select, textarea');
    if (c && !c.closest('label')) l.htmlFor = uid(c, 'f');
  }
  for (const row of root.querySelectorAll('.setting')) {
    const t = row.querySelector('.t');
    if (!t) continue;
    for (const c of row.querySelectorAll('input:not([type=hidden]), select, textarea, .seg')) {
      if (c.hasAttribute('aria-label') || c.hasAttribute('aria-labelledby') || c.closest('[role=group]')) continue;
      c.setAttribute('aria-labelledby', uid(t, 'st'));
    }
  }
}

// chips are toggle buttons (aria-pressed), segments radio groups (aria-checked); the state follows `.on`
const TOGGLE = '.chip:not([data-quick]), .seg > button';
const syncToggle = (b) => b.setAttribute(b.matches('.chip') ? 'aria-pressed' : 'aria-checked', String(b.classList.contains('on')));
function toggleStates(root) {
  for (const s of root.querySelectorAll('.seg')) s.setAttribute('role', 'radiogroup');
  for (const b of root.querySelectorAll(TOGGLE)) { if (b.matches('.seg > button')) b.setAttribute('role', 'radio'); syncToggle(b); }
}
new MutationObserver((list) => { for (const m of list) if (m.target.matches?.(TOGGLE)) syncToggle(m.target); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ['class'], subtree: true });
/** Labels and toggle states of everything in `root` (a page or a dialog). */
export function a11y(root) { linkLabels(root); toggleStates(root); }

// arrow keys move along a segmented control, like a radio group
document.addEventListener('keydown', (e) => {
  const b = e.target.closest?.('.seg > [role=radio]');
  if (!b || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const all = [...b.parentElement.children].filter((x) => x.matches('button:not([disabled])') && visible(x));
  const next = all[(all.indexOf(b) + (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1) + all.length) % all.length];
  e.preventDefault();
  next.focus();
  next.click();
});

// ---------- state / routing ----------
export const state = { needLogin: false, authEnabled: false, settings: null, syncing: false, syncNames: [], view: null, offline: null, badges: {}, latestYear: new Date().getFullYear(), installPrompt: null };

/**
 * The navigation, in its groups. `path` is the prefix that marks an entry current (Year in review
 * is current for every year); `href` can follow the data. Insights joins the Track group.
 */
const NAV = [
  { path: '/', label: 'Home', icon: 'home', tab: true, group: 'Track' },
  { path: '/library', label: 'Library', icon: 'library', tab: true, group: 'Track' },
  { path: '/sessions', label: 'Sessions', icon: 'sessions', tab: true, group: 'Track' },
  { path: '/stats', label: 'Stats', icon: 'stats', tab: true, group: 'Track' },
  { path: '/wrapped', href: () => `/wrapped/${state.latestYear}`, label: 'Year in review', icon: 'trail', group: 'Track' },
  { path: '/duplicates', label: 'Duplicates', icon: 'dupes', group: 'Tidy up', badge: 'dupes' },
  { path: '/history', label: 'Improve history', icon: 'history', group: 'Tidy up' },
  { path: '/accounts', label: 'Accounts', icon: 'accounts', group: 'Setup' },
  { path: '/settings', label: 'Settings', icon: 'settings', group: 'Setup' },
  { path: '/system', label: 'System', icon: 'system', group: 'Advanced', badge: 'errors' },
  { path: '/api', label: 'API', icon: 'code', group: 'Advanced' },
];
export const NAV_GROUPS = ['Track', 'Tidy up', 'Setup', 'Advanced'];
/** The navigation entries with their current links (the More page lists them too). */
export const navItems = () => NAV.map((n) => ({ ...n, href: typeof n.href === 'function' ? n.href() : n.path }));

/** Go to `path`; focus moves to the new page's heading (`focus: false` leaves it, e.g. a redirect on launch). */
export function navigate(path, { replace = false, focus = true } = {}) {
  if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
  route({ focus });
  window.scrollTo({ top: 0 });
}

function current() {
  return location.pathname.replace(/\/+$/, '') || '/';
}

const navActive = (p, path) => (path === '/' ? p === '/' : path === '/more' ? !NAV.filter((n) => n.tab).some((n) => navActive(p, n.path)) : p.startsWith(path) || (path === '/library' && p.startsWith('/game')));

/** Move the highlight in the sidebar and tab bar (the shell stays: rebuilding it would drop focus and the leaving view). */
function markNav(p) {
  $$('.side-nav a, .tabbar a').forEach((a) => {
    const on = navActive(p, a.dataset.nav);
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

function shell() {
  const p = current();
  const items = navItems();
  const link = (n, cls, inner) => {
    const on = navActive(p, n.path);
    return `<a class="${cls}${on ? ' active' : ''}" href="${n.href}" data-link data-nav="${n.path}"${on ? ' aria-current="page"' : ''}>${inner}</a>`;
  };
  const badge = (n) => (n.badge ? `<span class="badge ${n.badge === 'errors' ? 'bad' : 'accent'} hide" id="${n.badge === 'errors' ? 'err-badge' : 'dupe-badge'}"></span>` : '');
  // the skip link comes first, so the first Tab offers it; #view takes focus from script (tabindex -1)
  return `<div class="shell">
    <a class="skip" href="#view">Skip to content</a>
    <aside class="side">
      ${brand({ sub: true })}
      <nav class="side-nav" aria-label="Main">
        ${NAV_GROUPS.map((g, i) => `<div class="nav-sec" role="group" aria-labelledby="ng-${i}"><div class="nav-group" id="ng-${i}">${g}</div>
          ${items.filter((n) => n.group === g).map((n) => link(n, 'nav-link', `${icon(n.icon)}${n.label}${badge(n)}`)).join('')}</div>`).join('')}
      </nav>
      <div class="side-foot col">
        <button class="btn" data-action="sync-all" id="sync-all-btn">${icon('sync')}<span class="lbl">Sync all</span></button>
      </div>
    </aside>
    <header class="topbar">
      ${brand({ cls: 'grow' })}
      <button class="btn icon ghost" data-action="sync-all" aria-label="Sync all" title="Sync all">${icon('sync')}</button>
    </header>
    <div class="offline-bar" id="offline-bar" role="status"></div>
    <main class="main" id="view" tabindex="-1"></main>
    <nav class="tabbar" aria-label="Tabs">
      ${items.filter((n) => n.tab).map((n) => link(n, '', `${icon(n.icon)}${n.label}`)).join('')}
      ${link({ path: '/more', href: '/more' }, 'tab-more', `${icon('more')}<span>More</span><span class="pip hide" aria-hidden="true"></span>`)}
    </nav>
  </div>`;
}

/**
 * What the shell shows of the session, updated in place (the shell is built once per sign-in, so
 * focus, the sync spinner and the sidebar's scroll survive every navigation and a password change).
 */
function syncShell() {
  const foot = $('#app .side-foot');
  const out = foot?.querySelector('[data-action="logout"]');
  if (state.authEnabled && !out) foot.insertAdjacentHTML('beforeend', `<button class="btn ghost sm" data-action="logout">${icon('logout')}Log out</button>`);
  if (!state.authEnabled) out?.remove();
}

// tab titles; game and wrapped pages set their own once they know the title / year
const PAGE_TITLES = {
  dashboard: '', library: 'Library', game: '', sessions: 'Sessions', stats: 'Stats', duplicates: 'Duplicates', history: 'Improve history',
  accounts: 'Accounts', settings: 'Settings', apidocs: 'API', system: 'System', more: 'More',
};

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

// Route skeletons, shaped like the page they stand in for; aria-hidden, and #view is aria-busy meanwhile.
const sk = (h, style = '') => `<div class="skel" style="height:${h}px;${style}"></div>`;
const SK_HEAD = sk(34, 'width:200px;margin-bottom:22px');
const SKELETONS = {
  library: () => `${SK_HEAD}${sk(40, 'margin-bottom:16px')}<div class="lib-grid">${'<div><div class="skel" style="aspect-ratio:2/3"></div></div>'.repeat(12)}</div>`,
  sessions: () => `${SK_HEAD}<div class="col" style="gap:8px">${sk(56).repeat(8)}</div>`,
  game: () => `${sk(200, 'margin-bottom:18px;border-radius:22px')}<div class="grid grid-main">${sk(320)}${sk(240)}</div>`,
  settings: () => `${SK_HEAD}<div class="grid grid-2">${sk(220).repeat(4)}</div>`,
  default: () => `${SK_HEAD}<div class="kpis">${sk(96).repeat(5)}</div>${sk(260, 'margin-top:16px')}`,
};
SKELETONS.system = SKELETONS.sessions;
SKELETONS.accounts = SKELETONS.settings;
const skeleton = (name) => `<div aria-hidden="true">${(SKELETONS[name] || SKELETONS.default)()}</div>`;

/**
 * A fresh, hidden #view for the next page. The one on screen stays (dimmed after a moment, inert, its
 * ids dropped so the new page's lookups only find its own nodes) until the new page has rendered; a
 * view that never showed (an earlier navigation still loading) is thrown away.
 */
function beginView() {
  const prev = $('#view');
  if (prev?.hidden) prev.remove();
  else if (prev) {
    prev.removeAttribute('id');
    prev.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    prev.inert = true;
    prev.setAttribute('aria-hidden', 'true');
    prev.classList.add('leaving');
  }
  const view = document.createElement('main');
  view.className = 'main';
  view.id = 'view';
  view.tabIndex = -1;
  view.hidden = true;
  view.setAttribute('aria-busy', 'true');
  $('#app .tabbar').before(view);
  return view;
}
function showView(view) {
  if (!view.isConnected) return;
  $$('#app .main.leaving').forEach((v) => v.remove());
  view.hidden = false;
}

/** After a link or Back: the new page's heading takes focus, so a screen reader starts there and Tab goes on from it. */
function focusPage(view) {
  const h = view.querySelector('h1');
  if (h) h.tabIndex = -1;
  (h || view).focus({ preventScroll: true });
}

const offlineState = () => `<div class="empty"><div class="em-ic">${icon('offline')}</div><h2>You’re offline</h2>
  <p style="max-width:440px;margin:0 auto 16px">This page has not been saved for offline use yet. Pages you opened while online keep showing their last data.</p>
  <button class="btn" data-action="retry">Retry</button></div>`;

let renderSeq = 0;
/** Render the current URL into a new #view. `focus`: move focus to its heading (links and Back, not the first load). */
export async function route({ focus = false } = {}) {
  if (state.needLogin) return render();
  const p = current();
  if (!$('#app .shell')) {
    $('#app').innerHTML = shell();
    applyBadges();
    paintOffline();
  } else markNav(p);
  syncShell();
  paintSync($('#app .shell'));
  const view = beginView();
  const seq = ++renderSeq;
  const stale = () => seq !== renderSeq;
  for (const [re, name] of ROUTES) {
    const m = re.exec(p);
    if (!m) continue;
    state.view = name;
    setTitle(name === 'wrapped' ? `${m[1]} in review` : PAGE_TITLES[name]);
    // a page that answers within 150ms replaces the old one directly: no skeleton flash
    const timer = setTimeout(() => {
      if (stale()) return;
      if (!view.firstElementChild) view.innerHTML = skeleton(name);
      showView(view);
    }, 150);
    try {
      await pages[name](view, ...m.slice(1), stale);
    } catch (e) {
      if (stale() || state.needLogin) { clearTimeout(timer); return; }
      view.innerHTML = e.offline || (e instanceof TypeError && !navigator.onLine) ? offlineState()
        : `<div class="empty"><div class="em-ic">${icon('info')}</div><h2>Something went wrong</h2><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
    }
    clearTimeout(timer);
    if (stale()) return;
    showView(view);
    view.removeAttribute('aria-busy');
    afterRender(view);
    if (focus) focusPage(view);
    return;
  }
  state.view = null;
  setTitle('Not found');
  view.innerHTML = `<div class="empty"><h2>Not found</h2><a class="btn" href="/" data-link>Go home</a></div>`;
  showView(view);
  view.removeAttribute('aria-busy');
  if (focus) focusPage(view);
}

// ---------- page chrome: sticky offsets, sideways scrollers ----------
// day headers and the bulk bar stick below the toolbar: --toolbar-h follows its height
const toolbarRO = typeof ResizeObserver === 'function'
  ? new ResizeObserver((es) => es.forEach((e) => e.target.closest('.main')?.style.setProperty('--toolbar-h', `${e.target.offsetHeight}px`))) : null;
/** .more-r fades the right edge of a chip / segment row while more of it is off to the right. */
const scrollHint = (el) => el.classList.toggle('more-r', el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
/** Centre the chosen chip / segment in its row and mark rows that scroll on. */
export function scrollHints(root) {
  for (const el of root.querySelectorAll('.chips, .seg')) {
    const on = el.querySelector('.on');
    if (on && el.scrollWidth > el.clientWidth) {
      const a = el.getBoundingClientRect();
      const b = on.getBoundingClientRect();
      el.scrollLeft += b.left - a.left - (el.clientWidth - b.width) / 2;
    }
    scrollHint(el);
  }
}
document.addEventListener('scroll', (e) => { if (e.target instanceof Element && e.target.matches('.chips, .seg')) scrollHint(e.target); }, true);
window.addEventListener('resize', () => $$('#view .chips, #view .seg').forEach(scrollHint));

function afterRender(view) {
  toolbarRO?.disconnect();
  const tb = view.querySelector(':scope > .toolbar');
  if (tb && toolbarRO) toolbarRO.observe(tb);
  scrollHints(view);
  a11y(view);
  paintSync(view);
}

/** Where focus is in the page, as a selector that finds the same control in a re-rendered page. */
function focusKey(el) {
  if (!el || el === document.body || !el.closest('#view')) return null;
  if (el.id) return { sel: `#${CSS.escape(el.id)}` };
  const data = [...el.attributes].filter((a) => a.name.startsWith('data-') || a.name === 'name' || a.name === 'href');
  if (data.length) return { sel: `${el.tagName.toLowerCase()}${data.map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join('')}` };
  return { sel: el.tagName.toLowerCase(), text: el.textContent.trim() };
}

/** Render the current page again in place: scroll position and keyboard focus stay where they were. */
export function rerender() {
  const y = window.scrollY;
  const key = focusKey(document.activeElement);
  return route().then(() => {
    window.scrollTo({ top: y });
    if (!key || document.activeElement?.closest('.overlay')) return;
    const view = $('#view');
    const same = [...view.querySelectorAll(key.sel)].find((x) => key.text === undefined || x.textContent.trim() === key.text);
    if (same) same.focus({ preventScroll: true }); else focusPage(view);
  });
}

function render() {
  if (state.needLogin) {
    // signed out: nothing of the session keeps running behind the login form
    clearTimeout(pollTimer);
    state.syncing = false;
    state.badges = {};
    $$('.overlay').forEach((o) => o.remove());
    $('#app').inert = false;
    document.documentElement.style.overflow = '';
    setTitle('Sign in');
    $('#app').innerHTML = `<div class="login"><form class="card stack" id="login-form">
      <div class="login-head">${brand({ stacked: true, link: false })}${tagline()}</div>
      <div class="field"><label>Password</label><input class="input" type="password" name="password" autocomplete="current-password" required autofocus></div>
      <button class="btn primary" style="width:100%">Sign in</button></form></div>`;
    linkLabels($('#app'));
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/auth/login', { method: 'POST', body: { password: e.target.password.value } });
        state.needLogin = false;
        await boot({ focus: true });
      } catch (err) { fail(err); }
    });
    return;
  }
  route();
}

// ---------- offline ----------
/** Offline since `t` (the time of the cached data shown), or back online (null). */
function setOffline(t) {
  const next = t ? Math.min(state.offline || t, t) : null;
  if (next === state.offline) return;
  state.offline = next;
  paintOffline();
}
function paintOffline() {
  document.documentElement.classList.toggle('is-offline', !!state.offline);
  const bar = $('#offline-bar');
  if (!bar) return;
  const t = state.offline;
  const when = t && new Date(t).toDateString() !== new Date().toDateString() ? `${fmtDate(t)} ${fmtTime(t)}` : fmtTime(t);
  bar.innerHTML = t ? `${icon('offline')}<span class="grow">Offline · showing data from ${esc(when)}</span><button class="btn sm ghost" data-action="retry">Retry</button>` : '';
}
window.addEventListener('online', () => { if (!state.needLogin && $('#app .shell')) rerender(); });

// ---------- sync polling ----------
const syncLabel = () => {
  const n = state.syncNames;
  return n.length ? `Syncing ${n.length > 2 ? `${n.slice(0, 2).join(', ')} +${n.length - 2}` : n.join(', ')}…` : 'Syncing…';
};
/** Spinner plus a "Syncing Steam, Xbox…" label and aria-busy; with reduced motion the spinner stands still. */
export function busy(b, on, label = 'Syncing…') {
  b.classList.toggle('loading', on);
  if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
  const lbl = b.querySelector('.lbl');
  if (lbl) {
    lbl.dataset.idle ??= lbl.textContent;
    lbl.textContent = on ? label : lbl.dataset.idle;
  } else if (b.hasAttribute('aria-label')) { // icon-only (phone top bar)
    b.dataset.idle ??= b.getAttribute('aria-label');
    b.setAttribute('aria-label', on ? label : b.dataset.idle);
    b.title = b.getAttribute('aria-label');
  }
}
/** Every "Sync all" button in `root` shows the sync state (pages call this for buttons they add). */
export function paintSync(root = document) {
  if (!root) return;
  for (const b of root.querySelectorAll('[data-action="sync-all"]')) if (state.syncing || b.classList.contains('loading')) busy(b, state.syncing, syncLabel());
}

let pollTimer = null;
let syncSince = 0;
/** A sync was just started (here or by a page): the buttons say so and the summary counts from now. */
export function syncStarted() {
  state.syncing = true;
  syncSince ||= Date.now();
  paintSync();
}

export async function watchSync({ refresh = true } = {}) {
  clearTimeout(pollTimer);
  const accounts = await api('/accounts').catch(() => null);
  if (!accounts) {
    if (state.syncing && !state.needLogin) pollTimer = setTimeout(() => watchSync({ refresh }), 5000);
    return [];
  }
  const running = accounts.filter((a) => a.syncing);
  if (running.length) {
    syncSince ||= Date.now();
    state.syncing = true;
    state.syncNames = running.map((a) => a.name);
    paintSync();
    pollTimer = setTimeout(() => watchSync({ refresh }), 2000);
  } else if (state.syncing) {
    state.syncing = false;
    state.syncNames = [];
    $$('[data-action="sync-all"]').forEach((b) => busy(b, false));
    await syncDone(accounts, refresh);
  }
  return accounts;
}

/**
 * A sync finished. Home and Accounts (pages about the sync) re-render, unless a dialog is open or a
 * field has focus; anywhere else the page stays exactly as it is (scroll, loaded items, what you
 * typed) and a toast sums the sync up.
 */
async function syncDone(accounts, refresh) {
  const since = (syncSince || Date.now()) - 3000;
  syncSince = 0;
  refreshDupeBadge();
  const runs = (await api(`/syncs?limit=${Math.max(1, accounts.length)}`).catch(() => [])).filter((s) => s.started_at >= since);
  const inPlace = ['dashboard', 'accounts'].includes(state.view) && !$('.overlay') && !document.activeElement?.matches('input, textarea, select');
  const failed = runs.filter((s) => s.status === 'error');
  if (failed.length) {
    const a = accounts.find((x) => x.id === failed[0].account_id);
    toast(`${a?.name || failed[0].account_name || 'Sync'} sync failed${failed[0].error ? ` — ${failed[0].error}` : ''}`, { bad: true, ms: Infinity, action: { label: 'Fix', run: () => navigate('/accounts') } });
  } else {
    const n = runs.reduce((t, s) => t + (s.sessions_created || 0), 0);
    const min = runs.reduce((t, s) => t + (s.minutes_added || 0), 0);
    const show = { label: 'Show', run: () => (state.view === 'dashboard' ? rerender() : navigate('/sessions')) };
    toast(n ? `Sync complete · ${plural(n, 'new session')} (${fmtMin(min)})` : 'Sync complete · no new play', n && !inPlace ? { action: show } : {});
  }
  if (refresh && inPlace) rerender();
}

async function syncAll() {
  try {
    const r = await api('/sync', { method: 'POST' });
    if (!r.started) { toast('No accounts to sync — connect one first', { action: { label: 'Add account', run: () => navigate('/accounts?add=1') } }); return; }
    toast(`Syncing ${plural(r.started, 'account')}…`);
    syncStarted();
    setTimeout(() => watchSync(), 800);
  } catch (e) { fail(e); }
}

/** Sidebar badges, the phone More tab's dot and name, and the counts on the More page. */
export function applyBadges() {
  const b = state.badges || {};
  const show = (n) => (n > 999 ? '999+' : String(n || 0));
  for (const [sel, n] of [['#dupe-badge', b.dupes], ['#err-badge', b.errors], ['[data-count="dupes"]', b.dupes], ['[data-count="errors"]', b.errors]]) {
    for (const el of $$(sel)) { el.textContent = show(n); el.classList.toggle('hide', !n); }
  }
  const more = $('.tabbar [data-nav="/more"]');
  if (!more) return;
  const parts = [b.errors && plural(b.errors, 'error'), b.dupes && plural(b.dupes, 'duplicate')].filter(Boolean);
  const pip = more.querySelector('.pip');
  pip.classList.toggle('hide', !parts.length);
  pip.classList.toggle('bad', !!b.errors);
  if (parts.length) more.setAttribute('aria-label', `More, ${parts.join(', ')}`); else more.removeAttribute('aria-label');
}

async function refreshDupeBadge() {
  state.badges ||= {};
  try { state.badges.errors = (await api('/logs?level=error&limit=1')).counts_24h?.error || 0; } catch { /* ignore */ }
  try { const d = await api('/duplicates?summary=true'); state.badges.dupes = d.counts.suggestions + d.counts.double_counted; } catch { /* ignore */ }
  applyBadges();
}

/** Year in review points at the latest year with play. */
async function refreshYear() {
  try {
    const y = (await api('/stats/years'))[0];
    if (!y || y === state.latestYear) return;
    state.latestYear = y;
    $$('[data-nav="/wrapped"]').forEach((a) => a.setAttribute('href', `/wrapped/${y}`));
  } catch { /* ignore */ }
}

// ---------- global events ----------
document.addEventListener('click', (e) => {
  // the skip link moves focus without navigating: following #view would fire popstate and rebuild the shell
  if (e.target.closest('a.skip')) { e.preventDefault(); $('#view')?.focus(); return; }
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && a.target !== '_blank') {
    e.preventDefault();
    if (a.getAttribute('href') !== location.pathname + location.search) navigate(a.getAttribute('href'));
    return;
  }
  const act = e.target.closest('[data-action]');
  if (!act) return;
  if (act.dataset.action === 'sync-all') syncAll();
  if (act.dataset.action === 'retry') rerender();
  if (act.dataset.action === 'logout') api('/auth/logout', { method: 'POST' }).then(() => { state.needLogin = true; render(); });
});
window.addEventListener('popstate', () => route({ focus: true }));
// install: the browser's prompt is kept for the Install button in Settings
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; });

// ---------- colour: WCAG contrast from sRGB, mixing in OKLab like CSS color-mix() ----------
const rgbOf = (hex) => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};
const hexOf = (c) => `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const luminance = (c) => { const [r, g, b] = c.map(toLinear); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** WCAG contrast ratio of two sRGB colours given as [r, g, b] in 0..1. */
export function contrastRatio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function toOklab(c) {
  const [r, g, b] = c.map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, A, B]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    .map((v) => Math.min(1, Math.max(0, toGamma(v))));
}
const mixOklab = (a, b, w) => { const A = toOklab(a); const B = toOklab(b); return fromOklab(A.map((v, i) => v * w + B[i] * (1 - w))); };
const mixSrgb = (a, b, w) => a.map((v, i) => v * w + b[i] * (1 - w));

export const DEFAULT_ACCENT = '#7656ff';
/** The accent to show: the old default #7c5cff (white text 4.35:1) is read as #7656ff; any other colour is kept. */
export function accentOf(s) {
  const a = String(s?.accent || DEFAULT_ACCENT).toLowerCase();
  return a === '#7c5cff' || !rgbOf(a) ? DEFAULT_ACCENT : a;
}

/**
 * Paint an accent for the current theme: --accent; the ink on accent fills (data-on-accent: white
 * unless white is below 4.5:1, then dark); --accent-ink, accent-coloured text mixed toward white
 * (light theme: toward the text colour) until it reaches 4.5:1 on every surface and accent tint it
 * sits on, so a custom accent can never make links, badges or the active nav item unreadable; and
 * --accent-mark, the same for chart marks at 3:1 (gold on a white card would be 1.5:1).
 */
export function paintAccent(accent) {
  const root = document.documentElement;
  const a = rgbOf(accent) || rgbOf(DEFAULT_ACCENT);
  root.style.setProperty('--accent', hexOf(a));
  const onAccent = contrastRatio([1, 1, 1], a) >= 4.5 ? 'light' : 'dark';
  root.dataset.onAccent = onAccent;
  const css = getComputedStyle(root);
  const [bg, bg2, panel, panel2, text] = ['--bg', '--bg2', '--panel', '--panel2', '--text'].map((k) => rgbOf(css.getPropertyValue(k)));
  if (!(bg && bg2 && panel && panel2 && text)) {
    root.style.removeProperty('--accent-ink');
    root.style.removeProperty('--accent-mark');
    return { accent: hexOf(a), onAccent, ink: null };
  }
  const light = root.dataset.theme === 'light';
  // plain surfaces, a badge or chip on its accent tint over a card, the active nav item's tint over the sidebar
  const under = [bg, bg2, panel, panel2, mixSrgb(a, panel, 0.18), mixSrgb(a, bg2, 0.16)];
  const toward = light ? text : [1, 1, 1];
  let ink;
  for (let w = light ? 0.45 : 0.72; ; w = Math.max(0, w - 0.04)) {
    ink = mixOklab(a, toward, w);
    if (w === 0 || Math.min(...under.map((u) => contrastRatio(ink, u))) >= 4.6) break;
  }
  root.style.setProperty('--accent-ink', hexOf(ink));
  // chart marks (bars, hatched history, sparklines): the accent itself unless it is below 3:1 on cards and tracks
  let mark;
  for (let w = 1; ; w = Math.max(0, w - 0.05)) {
    mark = mixOklab(a, toward, w);
    if (w === 0 || Math.min(contrastRatio(mark, panel), contrastRatio(mark, bg2)) >= 3) break;
  }
  root.style.setProperty('--accent-mark', hexOf(mark));
  return { accent: hexOf(a), onAccent, ink: hexOf(ink) };
}

/** 'smooth' unless the system asks for reduced motion. */
export const scrollMotion = () => (matchMedia('(prefers-reduced-motion: no-preference)').matches ? 'smooth' : 'auto');

export function applyTheme(s) {
  const root = document.documentElement;
  const theme = s.theme === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : s.theme;
  root.dataset.theme = theme;
  root.dataset.density = s.ui_density || 'comfortable';
  root.dataset.covers = s.cover_size || 'm';
  root.dataset.coverTitles = s.cover_titles || 'auto';
  const { accent, onAccent, ink } = paintAccent(accentOf(s));
  document.querySelector('meta[name=theme-color]').content = theme === 'light' ? '#f4f5f9' : theme === 'black' ? '#000000' : '#0b0d12';
  try {
    localStorage.setItem('pt-theme', theme); localStorage.setItem('pt-accent', accent);
    // onAccent and ink ride in pt-ui, so the script in index.html applies them before the first paint
    localStorage.setItem('pt-ui', JSON.stringify({ density: root.dataset.density, covers: root.dataset.covers, coverTitles: root.dataset.coverTitles, onAccent, ...(ink ? { ink } : {}) }));
  } catch { /* private mode */ }
}

let themeWatch = false;
async function boot({ focus = false } = {}) {
  const st = await api('/auth/status').catch(() => ({ auth_enabled: false, authenticated: true }));
  state.authEnabled = st.auth_enabled;
  if (!st.authenticated) { state.needLogin = true; return render(); }
  state.settings = await api('/settings').catch(() => ({}));
  applyTheme(state.settings);
  // follow the theme when it is 'auto' and the system switches (once, however often you sign in)
  if (!themeWatch) matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (state.settings?.theme === 'auto') applyTheme(state.settings); });
  themeWatch = true;
  // start page (only when opening the app at its root)
  const start = { library: '/library', sessions: '/sessions', stats: '/stats' }[state.settings.start_page];
  let started = false;
  try { started = !!sessionStorage.getItem('pt-started'); sessionStorage.setItem('pt-started', '1'); } catch { /* ignore */ }
  if (start && current() === '/' && !started) history.replaceState({}, '', start);
  await route({ focus });
  watchSync({ refresh: true });
  refreshDupeBadge();
  refreshYear();
}

// offline support needs a secure context: HTTPS, or localhost / 127.0.0.1
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
boot();
