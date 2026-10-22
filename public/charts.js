import { esc, fmtMin, plat } from './app.js';

// Lightweight responsive SVG charts. Each returns an HTML string; call bindTips(root) after inserting.


function niceMax(v) {
  if (v <= 0) return 60;
  const h = v / 60;
  const steps = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000];
  for (const s of steps) if (h <= s) return s * 60;
  return Math.ceil(h / 1000) * 1000 * 60;
}

/**
 * Bar chart. data: [{ label, value, stack?: [{ key, value, color }], tip? }]
 */
export function barChart(data, { height = 200, width = 640, color = 'var(--accent)', labelEvery, formatTick } = {}) {
  const H = height;
  const W = width;
  const padL = 34; const padB = 22; const padT = 8;
  const n = Math.max(1, data.length);
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const iw = W - padL;
  const ih = H - padB - padT;
  const bw = iw / n;
  const gap = Math.min(6, bw * 0.28);
  const every = labelEvery || Math.ceil(n / (n > 20 ? 7 : 12));
  const ticks = [0, 0.5, 1].map((f) => max * f);
  let bars = '';
  data.forEach((d, i) => {
    const x = padL + i * bw + gap / 2;
    const w = Math.max(1, bw - gap);
    const tip = d.tip || `${d.label}: ${fmtMin(d.value)}`;
    if (d.stack && d.stack.length) {
      let y = padT + ih;
      d.stack.forEach((s, j) => {
        const h = (s.value / max) * ih;
        if (h <= 0) return;
        y -= h;
        const top = j === d.stack.filter((z) => z.value > 0).length - 1;
        bars += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${s.color}" ${top ? `rx="${Math.min(4, w / 2)}"` : ''}/>`;
      });
    } else if (d.value > 0) {
      const h = Math.max(2, (d.value / max) * ih);
      bars += `<rect x="${x}" y="${padT + ih - h}" width="${w}" height="${h}" rx="${Math.min(4, w / 2)}" fill="${d.color || color}"/>`;
    }
    bars += `<rect class="hit" data-tip="${esc(tip)}" x="${padL + i * bw}" y="${padT}" width="${bw}" height="${ih}" fill="transparent"/>`;
  });
  const labels = data.map((d, i) => (i % every === 0 ? `<text x="${padL + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>` : '')).join('');
  const grid = ticks.map((t) => {
    const y = padT + ih - (t / max) * ih;
    return `<line class="gridline" x1="${padL}" x2="${W}" y1="${y}" y2="${y}"/><text x="${padL - 6}" y="${y + 3}" text-anchor="end">${formatTick ? formatTick(t) : `${Math.round(t / 60)}h`}</text>`;
  }).join('');
  return `<div class="chart" style="aspect-ratio:${W}/${H}"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${HATCH}<g class="axis">${grid}${labels}</g>${bars}</svg><div class="tip"></div></div>`;
}

// Hatched fill used for estimated (inferred) history.
const HATCH = '<defs><pattern id="pt-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="color-mix(in srgb, var(--accent) 22%, transparent)"/><line x1="0" y1="0" x2="0" y2="6" stroke="color-mix(in srgb, var(--accent) 70%, transparent)" stroke-width="2.2"/></pattern>'
  + '<pattern id="pt-hatch-ov" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="var(--panel)" stroke-opacity=".55" stroke-width="1.6"/></pattern></defs>';

export function sparkline(values, { color = 'var(--accent)' } = {}) {
  const n = values.length;
  if (n < 2) return '';
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (n - 1)) * 100},${40 - (v / max) * 36}`);
  return `<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none"><defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".5"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="M0,40 L${pts.join(' L')} L100,40 Z" fill="url(#sg)"/><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

export function donut(segments, { label = '', sub = '' } = {}) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const r = 52; const c = 2 * Math.PI * r;
  let off = 0;
  const arcs = segments.map((s) => {
    const len = (s.value / total) * c;
    const el = `<circle r="${r}" cx="70" cy="70" fill="none" stroke="${s.color}" stroke-width="16" stroke-dasharray="${Math.max(0, len - 2)} ${c}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"><title>${esc(s.label)}: ${fmtMin(s.value)}</title></circle>`;
    off += len;
    return el;
  }).join('');
  return `<svg viewBox="0 0 140 140"><circle r="${r}" cx="70" cy="70" fill="none" stroke="var(--bg2)" stroke-width="16"/>${arcs}
    <text x="70" y="68" text-anchor="middle" fill="var(--text)" font-size="20" font-weight="800">${esc(label)}</text>
    <text x="70" y="86" text-anchor="middle" fill="var(--muted)" font-size="10.5">${esc(sub)}</text></svg>`;
}

export function heatmap(year, days, { weekStartsOn = 1, estimated = {} } = {}) {
  const start = new Date(year, 0, 1);
  const offset = (start.getDay() - weekStartsOn + 7) % 7;
  const cell = 12; const gap = 3; const top = 18; const left = 26;
  const values = Object.values(days);
  const max = Math.max(60, ...values);
  const levels = [0, 0.15, 0.35, 0.6, 1];
  const color = (m) => {
    if (!m) return 'var(--bg2)';
    const f = m / max;
    const lvl = levels.findIndex((l) => f <= l);
    const pct = [0, 30, 50, 75, 100][lvl < 0 ? 4 : lvl];
    return `color-mix(in srgb, var(--accent) ${pct}%, var(--bg2))`;
  };
  let rects = '';
  let months = '';
  const d = new Date(start);
  let lastMonth = -1;
  const today = new Date();
  while (d.getFullYear() === year) {
    const idx = Math.floor((d - start) / 864e5 + 0.5) + offset;
    const col = Math.floor(idx / 7);
    const row = idx % 7;
    const key = `${year}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const m = days[key] || 0;
    const future = d > today;
    const est = estimated[key] || 0;
    const mostlyEst = m && est >= m / 2;
    const tip = `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${m ? fmtMin(m) : 'no play'}${est ? ` (${fmtMin(est)} estimated)` : ''}`;
    const x = left + col * (cell + gap); const y = top + row * (cell + gap);
    rects += `<rect class="hit" x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${future ? 'transparent' : color(m)}" ${future ? 'stroke="var(--line)" stroke-dasharray="2 2"' : ''} data-tip="${esc(tip)}"/>`;
    // estimated days keep their intensity colour, with a hatch overlay
    if (mostlyEst && !future) rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="url(#pt-hatch-ov)" pointer-events="none"/>`;
    if (d.getMonth() !== lastMonth) {
      lastMonth = d.getMonth();
      months += `<text x="${left + col * (cell + gap)}" y="11">${d.toLocaleDateString(undefined, { month: 'short' })}</text>`;
    }
    d.setDate(d.getDate() + 1);
  }
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayLabels = [1, 3, 5].map((r) => `<text x="0" y="${top + r * (cell + gap) + 10}">${wd[(r + weekStartsOn) % 7]}</text>`).join('');
  const width = left + 54 * (cell + gap);
  const height = top + 7 * (cell + gap);
  return `<div class="chart heat"><svg viewBox="0 0 ${width} ${height}">${HATCH}<g class="axis">${months}${dayLabels}</g>${rects}</svg><div class="tip"></div></div>
    <div class="row small muted" style="justify-content:flex-end;gap:4px;margin-top:6px">${Object.keys(estimated).length ? '<span class="hatch-dot dot" style="width:11px;height:11px;border-radius:3px"></span> estimated &nbsp;&nbsp;' : ''}Less ${[0, 0.1, 0.3, 0.55, 1].map((f) => `<span style="width:11px;height:11px;border-radius:3px;background:${color(f * max)}"></span>`).join('')} More</div>`;
}

/** Horizontal bars of top games. */
export function topList(games, { coverFn, limit = 10 } = {}) {
  const max = Math.max(1, ...games.map((g) => g.minutes));
  return games.slice(0, limit).map((g, i) => `
    <a class="hbar" href="/game/${g.game_id}" data-link>
      ${coverFn(g)}
      <div style="min-width:0"><div class="ellipsis" style="font-weight:620">${esc(g.title)}</div>
        <div class="track" style="display:flex"><i style="width:${((g.minutes - (g.estimated_minutes || 0)) / max) * 100}%;background:${i === 0 ? 'linear-gradient(90deg,var(--accent),var(--accent2))' : 'var(--accent)'};opacity:${1 - i * 0.05}"></i>${g.estimated_minutes ? `<i class="hatch-bg" style="width:${(g.estimated_minutes / max) * 100}%" title="${fmtMin(g.estimated_minutes)} estimated from history"></i>` : ''}</div></div>
      <div class="nowrap" style="font-weight:700;font-variant-numeric:tabular-nums">${fmtMin(g.minutes, { short: g.minutes > 600 })}<div class="tiny muted" style="text-align:right">${g.sessions ? `${g.sessions} sess.` : g.estimated_minutes ? 'est.' : ''}</div></div>
    </a>`).join('');
}

export function platformLegend(list, extra = '') {
  return `<div class="legend">${list.map((p) => `<span><i class="dot" style="background:${plat(p.platform).color}"></i>${esc(plat(p.platform).label)} · ${fmtMin(p.minutes, { short: true })}</span>`).join('')}${extra}</div>`;
}

export function bindTips(root) {
  root.querySelectorAll('.chart').forEach((ch) => {
    const tip = ch.querySelector('.tip');
    if (!tip || ch.dataset.bound) return;
    ch.dataset.bound = '1';
    const show = (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t) { tip.classList.remove('on'); return; }
      const r = ch.getBoundingClientRect();
      const tr = t.getBoundingClientRect();
      tip.textContent = t.dataset.tip;
      tip.style.left = `${Math.min(r.width - 40, Math.max(40, tr.left - r.left + tr.width / 2))}px`;
      tip.style.top = `${Math.max(16, tr.top - r.top + (t.tagName === 'rect' && t.classList.contains('hit') && !ch.classList.contains('heat') ? tr.height * 0.35 : 0))}px`;
      tip.classList.add('on');
    };
    ch.addEventListener('pointermove', show);
    ch.addEventListener('pointerdown', show);
    ch.addEventListener('pointerleave', () => tip.classList.remove('on'));
  });
}
