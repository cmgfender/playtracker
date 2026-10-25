import { esc, fmtMin, plat } from './app.js';

/*
 * Charts: hand-written SVG drawn at the real pixel size of their box.
 *
 * How a chart gets on screen
 *   1. A chart function (barChart, heatmap, or chart(kind, …) for a new kind) returns a placeholder
 *      string, <div class="chart KIND" data-chart="ID">, and keeps { kind, data, opts } in a module Map.
 *   2. After inserting the HTML, call mountCharts(root) (bindTips is the old name). It draws every chart
 *      in root at its clientWidth x clientHeight, so 11px axis text is 11px and nothing is stretched,
 *      and watches it with one shared ResizeObserver: the first draw happens as soon as the box has a
 *      size (a chart in a hidden view draws when the view shows, before paint), later size changes
 *      redraw after 100ms. Charts that leave the DOM are unobserved and forgotten (liveCharts() counts
 *      the ones kept, for tests).
 *   Heights come from CSS (.chart.bar[data-size=page|card|small], smaller at <=600px) or opts.height.
 *
 * Adding a chart type
 *   registerChart('kind', (data, opts, box) => ({ svg, label, w?, h?, defs? }))
 *   export const myChart = (data, opts) => chart('kind', data, opts);
 *   - box = { w, h }: the CSS pixels available. Return the inner SVG markup, an aria-label summary
 *     (every chart is <svg role="img" aria-label=…>), and w/h only when the drawing is wider than the
 *     box (it then scrolls: pass opts.scroll = 'what it shows' to make the box a keyboard-focusable,
 *     labelled scroller, and opts.onDraw(el, first) to e.g. scroll it to the latest data).
 *   - opts.cls adds classes to the box, opts.size / opts.height size it.
 *   Shared machinery for draw functions:
 *   - niceScale(max, { target, unit }): round ticks. unit 'min' steps 5/10/15/20/30m, then 1, 2, 4, 6, 8,
 *     10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100…h (labels via fmtMin short, never two alike); unit
 *     'count' steps 1-2-5. Returns { max, step, ticks, fmt }.
 *   - plotArea(box, labels, pad?): left padding that fits the widest y label (>= 30px), 20px for x labels.
 *   - yAxis(area, scale, fmt?): gridlines (dashed), the solid baseline and the y labels.
 *   - xLabels(area, items[{ x, text }]): x labels, thinned so none overlap and none leave the box.
 *   - barTop(x, y, w, h, r): a bar path with only its top corners rounded.
 *   - hit(x, y, w, h, tip, top?): a transparent hover target; its tooltip shows `tip` at height `top`.
 *   - summarize(title, items, fmt?): "Title: 122h total, busiest Oct 2 with 17h 25m" (items { value, name|label }).
 *   - textWidth(s): width of 11px axis text, estimated.
 *   - HATCH defs: fill="url(#pt-hatch)" marks estimated history (#pt-hatch-ov overlays a heatmap cell).
 */

// ---------- core ----------
const KINDS = {};
const charts = new Map(); // id -> { kind, data, opts, el, w, h, born, timer }
let nextId = 0;
let epoch = 0; // mountCharts() calls so far: a chart string never inserted is dropped one call later

export function registerChart(kind, draw) { KINDS[kind] = draw; }

/** Placeholder for a chart of a registered kind; drawn by mountCharts(). */
export function chart(kind, data, opts = {}) {
  const id = `c${++nextId}`;
  charts.set(id, { kind, data, opts, el: null, w: 0, h: 0, born: epoch });
  const attrs = [
    opts.size ? `data-size="${opts.size}"` : '',
    opts.height ? `style="height:${opts.height}px"` : '',
    // a drawing wider than its box scrolls: focusable, so arrow keys scroll it, and named
    opts.scroll ? `tabindex="0" role="group" aria-label="${esc(opts.scroll)}"` : '',
  ].filter(Boolean).join(' ');
  return `<div class="chart ${kind}${opts.cls ? ` ${opts.cls}` : ''}" data-chart="${id}" ${attrs}><div class="tip" aria-hidden="true"></div></div>`;
}

function draw(c) {
  const { el } = c;
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (!w) return false; // not laid out yet (hidden view): the observer draws it once it is
  const first = !c.w;
  const out = KINDS[c.kind](c.data, c.opts, { w, h });
  const W = out.w || w;
  const H = out.h || h;
  el.querySelector(':scope > svg')?.remove();
  el.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(out.label)}">${out.defs || ''}${out.svg}</svg>`);
  c.w = w; c.h = el.clientHeight; // a drawing that sets its own height has just changed the box's
  c.opts.onDraw?.(el, first);
  return true;
}

function forget(id, c) {
  clearTimeout(c.timer);
  if (c.el) ro?.unobserve(c.el);
  charts.delete(id);
}
function sweep() {
  for (const [id, c] of charts) if (c.el ? !c.el.isConnected : c.born < epoch) forget(id, c);
}

const ro = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
  for (const e of entries) {
    const c = charts.get(e.target.dataset.chart);
    if (!c || c.el !== e.target) { ro.unobserve(e.target); continue; }
    if (!e.target.isConnected) continue;
    const w = e.target.clientWidth;
    const h = e.target.clientHeight;
    if (!w || (w === c.w && h === c.h)) continue;
    clearTimeout(c.timer);
    // first sight: draw now (this runs before paint, so no empty frame); a resize settles first
    if (!c.w) draw(c); else c.timer = setTimeout(() => { if (c.el.isConnected) draw(c); }, 100);
  }
  sweep();
}) : null;

/** Draw the charts inside root and keep them sized; wires up their tooltips. */
export function mountCharts(root = document) {
  sweep();
  epoch++;
  root.querySelectorAll('[data-chart]').forEach((el) => {
    const c = charts.get(el.dataset.chart);
    if (!c || c.el === el) return;
    c.el = el;
    draw(c);
    ro?.observe(el);
    bindTip(el);
  });
}
export const bindTips = mountCharts;
/** How many charts are kept alive (drawn or waiting to be): for leak tests. */
export const liveCharts = () => { sweep(); return charts.size; };

function bindTip(ch) {
  const tip = ch.querySelector(':scope > .tip');
  if (!tip) return;
  const show = (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (!t) { tip.classList.remove('on'); return; }
    const r = ch.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    const sl = ch.scrollLeft;
    tip.textContent = t.dataset.tip;
    tip.style.left = `${Math.min(sl + r.width - 40, Math.max(sl + 40, tr.left - r.left + sl + tr.width / 2))}px`;
    tip.style.top = `${Math.max(16, t.dataset.top ? Number(t.dataset.top) : tr.top - r.top)}px`;
    tip.classList.add('on');
  };
  ch.addEventListener('pointermove', show);
  ch.addEventListener('pointerdown', show);
  ch.addEventListener('pointerleave', () => tip.classList.remove('on'));
}

// ---------- shared drawing helpers ----------
const r1 = (v) => Math.round(v * 10) / 10;
/** Width of 11px axis text (system UI font), estimated: digits and short words average ~6.2px. */
export const textWidth = (s) => String(s).length * 6.3;

// tick steps in minutes: 5-30m, then 1, 2, 4, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100…h
const HOUR_STEPS = [1, 2, 4, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80];
for (let k = 10; k <= 1e4; k *= 10) HOUR_STEPS.push(...[10, 12, 16, 20, 24, 30, 40, 50, 60, 80].map((x) => x * k));
const MIN_STEPS = [5, 10, 15, 20, 30, ...HOUR_STEPS.map((x) => x * 60)];
const COUNT_STEPS = [];
for (let k = 1; k <= 1e9; k *= 10) COUNT_STEPS.push(k, 2 * k, 5 * k);

/** Round axis ticks from 0 to at least `max`: at most `target` steps, each label distinct. */
export function niceScale(max, { target = 4, unit = 'min' } = {}) {
  const steps = unit === 'min' ? MIN_STEPS : COUNT_STEPS;
  const top0 = Math.max(0, Number(max) || 0);
  // minute steps only up to one hour: 20m steps to 80m would read 0, 20m, 40m, 1h, 1h
  const step = steps.find((s) => Math.ceil(top0 / s) <= target && (unit !== 'min' || s >= 60 || Math.ceil(top0 / s) * s <= 60)) || steps[steps.length - 1];
  const top = Math.max(unit === 'min' && !top0 ? 60 : step, Math.ceil(top0 / step) * step);
  const st = unit === 'min' && !top0 ? 30 : step;
  const ticks = [];
  for (let t = 0; t <= top + 1e-9; t += st) ticks.push(t);
  const fmt = unit === 'min' ? (t) => (t ? fmtMin(t, { short: true }) : '0') : (t) => (t ? t.toLocaleString() : '0');
  return { max: top, step: st, ticks, fmt };
}

/** Plot area inside a box: left padding fits the widest y label. */
export function plotArea({ w, h }, yLabels = [], { top = 8, bottom = 20, right = 2 } = {}) {
  const left = Math.max(30, Math.ceil(Math.max(0, ...yLabels.map(textWidth))) + 8);
  return { x: left, y: top, w: Math.max(1, w - left - right), h: Math.max(1, h - top - bottom), W: w, H: h };
}

/** Dashed gridlines at each tick above 0, a solid baseline at 0, labels right-aligned left of the plot. */
export function yAxis(a, scale, fmt = scale.fmt) {
  return scale.ticks.map((t) => {
    const y = r1(a.y + a.h - (t / scale.max) * a.h);
    return `<line class="${t ? 'gridline' : 'baseline'}" x1="${a.x}" x2="${a.x + a.w}" y1="${y}" y2="${y}"/><text x="${a.x - 6}" y="${y + 3.5}" text-anchor="end">${esc(fmt(t))}</text>`;
  }).join('');
}

/** X labels centred on x, kept inside the box and dropped where they would touch the previous one. */
export function xLabels(a, items) {
  let lastRight = -Infinity;
  let out = '';
  for (const { x, text } of items) {
    if (!text) continue;
    const half = textWidth(text) / 2;
    // never left of the plot (the y axis labels end there) or past the right edge
    const cx = Math.min(a.W - half, Math.max(a.x - 2 + half, x));
    if (cx - half < lastRight + 6) continue;
    lastRight = cx + half;
    out += `<text x="${r1(cx)}" y="${a.H - 5}" text-anchor="middle">${esc(text)}</text>`;
  }
  return out;
}

/** A bar whose top corners are rounded (radius r) and whose foot sits square on the baseline. */
export function barTop(x, y, w, h, r = 4) {
  r = Math.max(0, Math.min(r, w / 2, h));
  return `M${r1(x)},${r1(y + h)}V${r1(y + r)}Q${r1(x)},${r1(y)} ${r1(x + r)},${r1(y)}H${r1(x + w - r)}Q${r1(x + w)},${r1(y)} ${r1(x + w)},${r1(y + r)}V${r1(y + h)}Z`;
}

/** Transparent hover target; the tooltip shows `tip`, placed at height `top` (default: the target's top). */
export const hit = (x, y, w, h, tip, top) => `<rect class="hit" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="transparent" data-tip="${esc(tip)}"${top !== undefined ? ` data-top="${r1(top)}"` : ''}/>`;

/** "Title: 122h total, busiest Oct 2 with 17h 25m" ("Title: nothing played" when empty). */
export function summarize(title, items, fmt = (v) => fmtMin(v)) {
  const total = items.reduce((a, d) => a + (d.value || 0), 0);
  if (!total) return `${title}: nothing played`;
  const top = items.reduce((a, d) => (d.value > a.value ? d : a), items[0]);
  return `${title}: ${fmt(total)} total, busiest ${top.name || top.label} with ${fmt(top.value)}`;
}

// Hatched fill used for estimated (inferred) history.
export const HATCH = '<defs><pattern id="pt-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="color-mix(in srgb, var(--accent-mark) 22%, transparent)"/><line x1="0" y1="0" x2="0" y2="6" stroke="color-mix(in srgb, var(--accent-mark) 70%, transparent)" stroke-width="2.2"/></pattern>'
  + '<pattern id="pt-hatch-ov" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="var(--panel)" stroke-opacity=".55" stroke-width="1.6"/></pattern></defs>';

// ---------- bar chart ----------
// Stack order, bottom up: neighbours differ in lightness (Steam and PlayStation 2.7:1 apart in dark),
// other keys follow in their own order, estimated history always on top.
const STACK_ORDER = ['steam', 'psn', 'xbox', 'custom', 'manual', 'import'];
const stackRank = (k) => (k === 'estimated' ? 99 : STACK_ORDER.includes(k) ? STACK_ORDER.indexOf(k) : 50);

registerChart('bar', (data, opts, box) => {
  const { color = 'var(--accent-mark)', unit = 'min' } = opts;
  const n = Math.max(1, data.length);
  const max = Math.max(0, ...data.map((d) => d.value));
  const scale0 = niceScale(max, { unit, target: Math.max(2, Math.min(5, Math.floor((box.h - 28) / 34))) });
  const fmt = opts.formatTick || scale0.fmt;
  const a = plotArea(box, scale0.ticks.map(fmt));
  const y = (v) => a.y + a.h - (v / scale0.max) * a.h;
  const slot = a.w / n;
  const gap = Math.max(1, Math.min(6, slot * 0.28));
  const bw = Math.max(1, Math.min(opts.maxBar || 44, slot - gap));
  const rad = Math.min(4, bw / 2);
  let marks = '';
  let hits = '';
  data.forEach((d, i) => {
    const x = a.x + i * slot + (slot - bw) / 2;
    const tip = d.tip || `${d.name || d.label}: ${fmtMin(d.value)}`;
    let topY = a.y + a.h;
    if (d.stack && d.stack.length) {
      const segs = d.stack.filter((z) => z.value > 0).sort((p, q) => stackRank(p.key) - stackRank(q.key));
      segs.forEach((s, j) => {
        const h = (s.value / scale0.max) * a.h;
        topY -= h;
        // a 1px line in the card colour splits the segments; only the top one is rounded
        const shape = j === segs.length - 1 ? `<path class="mk" d="${barTop(x, topY, bw, h, rad)}"` : `<rect class="mk" x="${r1(x)}" y="${r1(topY)}" width="${r1(bw)}" height="${r1(h)}"`;
        marks += `${shape} data-key="${esc(s.key || '')}" fill="${s.color}" stroke="var(--panel)" stroke-width="1"/>`;
      });
    } else if (d.value > 0) {
      const h = Math.max(2, (d.value / scale0.max) * a.h);
      topY -= h;
      marks += `<path class="mk" d="${barTop(x, topY, bw, h, rad)}" fill="${d.color || color}"/>`;
    }
    hits += hit(a.x + i * slot, a.y, slot, a.h, tip, topY);
  });
  // labels at most every 32px (wider labels need more), thinned again by xLabels() if they would touch
  const lw = Math.max(32, Math.max(0, ...data.map((d) => textWidth(d.label || ''))) + 10);
  const every = opts.labelEvery || Math.ceil(n / Math.max(1, Math.floor(a.w / lw)));
  const labels = xLabels(a, data.map((d, i) => ({ x: a.x + i * slot + slot / 2, text: i % every === 0 ? d.label : '' })));
  return {
    defs: HATCH,
    svg: `<g class="axis">${yAxis(a, scale0, fmt)}${labels}</g>${marks}${hits}`,
    label: opts.summary ? opts.summary(data) : summarize(opts.title || 'Playtime', data),
  };
});

/**
 * Bar chart. data: [{ label, name?, value, color?, stack?: [{ key, value, color }], tip? }]
 * `label` is the x axis text, `name` the longer form used in tooltips and the summary.
 * opts: { title (aria summary), size: 'page' | 'card' | 'small', color, unit: 'min' | 'count',
 *   labelEvery, formatTick, maxBar (px), summary(data) }
 */
export const barChart = (data, opts = {}) => chart('bar', data, { size: 'card', ...opts });

// ---------- year heatmap ----------
registerChart('heat', ({ year, days, estimated = {}, weekStartsOn = 1 }, opts, box) => {
  const start = new Date(year, 0, 1);
  const offset = (start.getDay() - weekStartsOn + 7) % 7;
  const top = 18; const left = 30; const gap = 3;
  const cell = Math.max(11, Math.min(15, Math.floor((box.w - left) / 54) - gap));
  const pitch = cell + gap;
  const max = Math.max(60, ...Object.values(days));
  const color = heatColor(max);
  let rects = '';
  let months = '';
  const d = new Date(start);
  let lastMonth = -1;
  const today = new Date();
  let total = 0; let played = 0; let best = null; let todayX = null;
  while (d.getFullYear() === year) {
    const idx = Math.floor((d - start) / 864e5 + 0.5) + offset;
    const col = Math.floor(idx / 7);
    const row = idx % 7;
    const key = `${year}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const m = days[key] || 0;
    const future = d > today;
    const est = estimated[key] || 0;
    const mostlyEst = m && est >= m / 2;
    const name = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const tip = `${name}: ${m ? fmtMin(m) : 'no play'}${est ? ` (${fmtMin(est)} estimated)` : ''}`;
    const x = left + col * pitch; const y = top + row * pitch;
    if (m) { total += m; played++; if (!best || m > best.value) best = { value: m, name: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }; }
    if (d.toDateString() === today.toDateString()) todayX = x;
    rects += `<rect class="hit" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5" fill="${future ? 'transparent' : color(m)}" ${future ? 'stroke="var(--line)" stroke-dasharray="2 2"' : ''} data-tip="${esc(tip)}"/>`;
    // estimated days keep their intensity colour, with a hatch overlay
    if (mostlyEst && !future) rects += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2.5" fill="url(#pt-hatch-ov)" pointer-events="none"/>`;
    if (d.getMonth() !== lastMonth) {
      lastMonth = d.getMonth();
      // a month starting in the last column of the year has no room for its name
      if (col < 52) months += `<text x="${x}" y="12">${d.toLocaleDateString(undefined, { month: 'short' })}</text>`;
    }
    d.setDate(d.getDate() + 1);
  }
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayLabels = [1, 3, 5].map((r) => `<text x="0" y="${top + r * pitch + cell - 2}">${wd[(r + weekStartsOn) % 7]}</text>`).join('');
  opts.todayX = todayX === null ? null : todayX + cell;
  return {
    defs: HATCH,
    w: left + 54 * pitch,
    h: top + 7 * pitch,
    svg: `<g class="axis">${months}${dayLabels}</g>${rects}`,
    label: total ? `${year}: ${fmtMin(total)} on ${played} day${played === 1 ? '' : 's'}, busiest ${best.name} with ${fmtMin(best.value)}` : `${year}: nothing played`,
  };
});

function heatColor(max) {
  const levels = [0, 0.15, 0.35, 0.6, 1];
  return (m) => {
    if (!m) return 'var(--bg2)';
    const lvl = levels.findIndex((l) => m / max <= l);
    return `color-mix(in srgb, var(--accent-mark) ${[0, 30, 50, 75, 100][lvl < 0 ? 4 : lvl]}%, var(--bg2))`;
  };
}

/** Every day of a year; scrolls sideways where it does not fit and opens on the latest week. */
export function heatmap(year, days, { weekStartsOn = 1, estimated = {} } = {}) {
  const max = Math.max(60, ...Object.values(days));
  const color = heatColor(max);
  return chart('heat', { year, days, estimated, weekStartsOn }, {
    scroll: `Activity in ${year}, by day`,
    // first draw: today's week (or the year's end) at the right edge
    onDraw(el, first) {
      if (!first) return;
      const x = charts.get(el.dataset.chart)?.opts.todayX;
      el.scrollLeft = x ? Math.max(0, x + 8 - el.clientWidth) : el.scrollWidth;
    },
  }) + `<div class="row small muted heat-legend" aria-hidden="true">${Object.keys(estimated).length ? '<span class="hatch-dot dot"></span> estimated &nbsp;&nbsp;' : ''}Less ${[0, 0.1, 0.3, 0.55, 1].map((f) => `<span style="background:${color(f * max)}"></span>`).join('')} More</div>`;
}

// ---------- small fixed-size pieces ----------
/** KPI background trend: up to 14 points as mini bars (a 2-point area is a meaningless triangle), else an area. */
export function sparkline(values, { color = 'var(--accent-mark)' } = {}) {
  const n = values.length;
  if (n < 2) return '';
  const max = Math.max(1, ...values);
  if (n <= 14) return `<div class="spark spark-bars" aria-hidden="true">${values.map((v) => `<i style="height:${v > 0 ? Math.max(6, (v / max) * 100) : 0}%"></i>`).join('')}</div>`;
  const pts = values.map((v, i) => `${(i / (n - 1)) * 100},${40 - (v / max) * 36}`);
  return `<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".5"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="M0,40 L${pts.join(' L')} L100,40 Z" fill="url(#sg)"/><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

export function donut(segments, { label = '', sub = '', title = 'Share' } = {}) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const r = 52; const c = 2 * Math.PI * r;
  let off = 0;
  const arcs = segments.map((s) => {
    const len = (s.value / total) * c;
    const el = `<circle r="${r}" cx="70" cy="70" fill="none" stroke="${s.color}" stroke-width="16" stroke-dasharray="${Math.max(0, len - 2)} ${c}" stroke-dashoffset="${-off}" transform="rotate(-90 70 70)"><title>${esc(s.label)}: ${fmtMin(s.value)}</title></circle>`;
    off += len;
    return el;
  }).join('');
  const aria = `${title}: ${segments.map((s) => `${s.label} ${Math.round((s.value / total) * 100)}%`).join(', ')}`;
  return `<svg viewBox="0 0 140 140" role="img" aria-label="${esc(aria)}"><circle r="${r}" cx="70" cy="70" fill="none" stroke="var(--bg2)" stroke-width="16"/>${arcs}
    <text x="70" y="68" text-anchor="middle" fill="var(--text)" font-size="20" font-weight="800">${esc(label)}</text>
    <text x="70" y="86" text-anchor="middle" fill="var(--muted)" font-size="11">${esc(sub)}</text></svg>`;
}

/** Horizontal bars of top games. */
export function topList(games, { coverFn, limit = 10 } = {}) {
  const max = Math.max(1, ...games.map((g) => g.minutes));
  return games.slice(0, limit).map((g, i) => `
    <a class="hbar" href="/game/${g.game_id}" data-link>
      ${coverFn(g)}
      <div style="min-width:0"><div class="ellipsis" style="font-weight:600">${esc(g.title)}</div>
        <div class="track" style="display:flex"><i style="width:${((g.minutes - (g.estimated_minutes || 0)) / max) * 100}%;background:${i === 0 ? 'var(--accent-grad)' : 'var(--accent-mark)'};opacity:${1 - i * 0.05}"></i>${g.estimated_minutes ? `<i class="hatch-bg" style="width:${(g.estimated_minutes / max) * 100}%" title="${fmtMin(g.estimated_minutes)} estimated from history"></i>` : ''}</div></div>
      <div class="nowrap" style="font-weight:700;font-variant-numeric:tabular-nums">${fmtMin(g.minutes, { short: g.minutes > 600 })}<div class="tiny muted" style="text-align:right">${g.sessions ? `${g.sessions} sess.` : g.estimated_minutes ? 'est.' : ''}</div></div>
    </a>`).join('');
}

export function platformLegend(list, extra = '') {
  return `<div class="legend">${list.map((p) => `<span><i class="dot" style="background:${plat(p.platform).color}"></i>${esc(plat(p.platform).label)} · ${fmtMin(p.minutes, { short: true })}</span>`).join('')}${extra}</div>`;
}
