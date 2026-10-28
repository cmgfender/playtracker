import { esc, fmtMin, plat, navigate } from './app.js';

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
 *   - opts.keys = 'what it shows' makes the box a focusable, labelled group whose arrow keys step
 *     through the marks (Up / Down by opts.keyRow, for grids), showing each tooltip and reading it
 *     out through a polite live line. box.id is the chart's id, for ids of its own <defs>.
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
 *   - HATCH defs: fill="url(#pt-hatch)" marks estimated history (#pt-hatch-ov overlays a heatmap cell);
 *     hatchDef(id, colour) is the same hatch in a series' own colour.
 *
 * Kinds: bar, heat, punch (weekday x hour grid), hist (histogram with median / p90 marks), area
 * (stacked area over time), lanes (swimlanes: a row of bars per game), curve (a game's cumulative
 * play with sessions and unlocks per period), scatter (completion vs hours), lines (several series
 * over the same periods: lines, or grouped bars); erastrip (eras on a month axis) is registered in insights.js.
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
    // keyboard tooltips: focusable, arrow keys step through the marks and a live line reads each one
    !opts.scroll && opts.keys ? `tabindex="0" role="group" aria-label="${esc(opts.keys)}" data-keys` : '',
  ].filter(Boolean).join(' ');
  const live = opts.keys && !opts.scroll ? '<div class="vh chart-live" aria-live="polite"></div>' : '';
  return `<div class="chart ${kind}${opts.cls ? ` ${opts.cls}` : ''}" data-chart="${id}" ${attrs}><div class="tip" aria-hidden="true"></div>${live}</div>`;
}

function draw(c) {
  const { el } = c;
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (!w) return false; // not laid out yet (hidden view): the observer draws it once it is
  const first = !c.w;
  const out = KINDS[c.kind](c.data, c.opts, { w, h, id: el.dataset.chart });
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
    ch.querySelector('.kf')?.classList.remove('kf');
    if (!t) { tip.classList.remove('on'); return; }
    const r = ch.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    const sl = ch.scrollLeft;
    tip.textContent = t.dataset.tip;
    // centred on the mark, but kept inside the chart (a long tip near an edge would widen the page)
    const half = Math.max(40, Math.min(tip.offsetWidth, r.width) / 2);
    tip.style.left = `${Math.min(sl + r.width - half, Math.max(sl + half, tr.left - r.left + sl + tr.width / 2))}px`;
    tip.style.top = `${Math.max(16, t.dataset.top ? Number(t.dataset.top) : tr.top - r.top)}px`;
    tip.classList.add('on');
  };
  ch.addEventListener('pointermove', show);
  ch.addEventListener('pointerdown', show);
  ch.addEventListener('pointerleave', () => { if (document.activeElement !== ch) tip.classList.remove('on'); });
  // marks with an href open it on click; on a touch screen the first tap shows the tip, a second opens
  let touch = false; let armed = null;
  ch.addEventListener('pointerdown', (e) => { touch = e.pointerType === 'touch'; });
  ch.addEventListener('click', (e) => {
    const t = e.target.closest?.('[data-href]');
    if (!t) { armed = null; return; }
    if (touch && armed !== t) { armed = t; return; }
    navigate(t.dataset.href);
  });
  if (!ch.hasAttribute('data-keys')) return;
  // keyboard: Left / Right step through the marks in drawing order, Up / Down by opts.keyRow (a grid's row), Home / End
  let at = -1;
  const live = ch.querySelector(':scope > .chart-live');
  const off = () => { tip.classList.remove('on'); ch.querySelector('.kf')?.classList.remove('kf'); };
  ch.addEventListener('keydown', (e) => {
    const marks = [...ch.querySelectorAll(':scope > svg [data-tip]')];
    if (!marks.length) return;
    const row = charts.get(ch.dataset.chart)?.opts.keyRow || 1;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: row, ArrowUp: -row }[e.key];
    let next;
    if (step) next = at < 0 || at >= marks.length ? (step > 0 ? 0 : marks.length - 1) : Math.max(0, Math.min(marks.length - 1, at + step));
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = marks.length - 1;
    else if (e.key === 'Escape' && tip.classList.contains('on')) { e.preventDefault(); off(); return; } else if (e.key === 'Enter' && marks[at]?.dataset.href) { e.preventDefault(); navigate(marks[at].dataset.href); return; } else return;
    e.preventDefault();
    at = next;
    const t = marks[at];
    show({ target: t });
    t.classList.add('kf');
    if (live) live.textContent = t.dataset.tip;
  });
  ch.addEventListener('blur', off);
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
export const hit = (x, y, w, h, tip, top, href) => `<rect class="hit${href ? ' go' : ''}" x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="transparent" data-tip="${esc(tip)}"${top !== undefined ? ` data-top="${r1(top)}"` : ''}${href ? ` data-href="${esc(href)}"` : ''}/>`;

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
    hits += hit(a.x + i * slot, a.y, slot, a.h, d.href ? `${tip} · ${opts.hrefHint || 'open'}` : tip, topY, d.href);
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
 * Bar chart. data: [{ label, name?, value, color?, stack?: [{ key, value, color }], tip?, href? }]
 * A bar with an href opens it on click, and on Enter when the chart has opts.keys; opts.hrefHint
 * ends its tooltip ("… · see sessions").
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

// ---------- shared by the kinds below ----------
/** The estimated-history hatch in a series' own colour, as a <pattern id=…> for a chart's <defs>. */
export const hatchDef = (id, color) => `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="color-mix(in srgb, ${color} 22%, transparent)"/><line x1="0" y1="0" x2="0" y2="6" stroke="color-mix(in srgb, ${color} 75%, transparent)" stroke-width="2.2"/></pattern>`;
/** "Mon" / "Monday" for getDay() index d (Jan 7 2024 was a Sunday). */
export const dayName = (d, weekday = 'short') => new Date(2024, 0, 7 + d).toLocaleDateString(undefined, { weekday });
const ticksFor = (box, reserve = 28) => Math.max(2, Math.min(5, Math.floor((box.h - reserve) / 34)));
/** Labels every k-th slot so none is narrower than its text; xLabels() thins again if they would touch. */
const everyFor = (labels, width) => {
  const lw = Math.max(32, Math.max(0, ...labels.map((l) => textWidth(l.label || ''))) + 10);
  return Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(width / lw))));
};
const sum = (xs) => xs.reduce((a, v) => a + (v || 0), 0);
const pts = (list) => list.map(([x, y]) => `${r1(x)},${r1(y)}`).join(' ');

// ---------- punchcard: weekday x hour ----------
/**
 * data: { minutes: number[7][24] (index 0 = Sunday, as getDay()), weekStartsOn }. Rows follow the
 * week start. opts.hourLabel(h) names an hour ("6p" or "18"). Its height follows its width.
 */
registerChart('punch', ({ minutes, weekStartsOn = 1 }, opts, box) => {
  const hl = opts.hourLabel || ((h) => String(h));
  const left = 36; const top = 2; const bottom = 22; const gap = 2;
  const pitch = Math.max(7, (box.w - left) / 24);
  const ch = Math.round(Math.max(18, Math.min(26, pitch * 0.85)));
  const max = Math.max(1, ...minutes.flat());
  const color = heatColor(max);
  let cells = ''; let days = ''; let total = 0; let best = null;
  for (let r = 0; r < 7; r++) {
    const d = (r + weekStartsOn) % 7;
    const y = top + r * ch;
    days += `<text x="0" y="${r1(y + ch / 2 + 3.5)}">${esc(dayName(d))}</text>`;
    for (let hr = 0; hr < 24; hr++) {
      const m = minutes[d]?.[hr] || 0;
      total += m;
      if (m && (!best || m > best.m)) best = { m, d, hr };
      const tip = `${dayName(d, 'long')} ${hl(hr)}–${hl((hr + 1) % 24)}: ${m ? fmtMin(m) : 'no play'}`;
      cells += `<rect class="hit" x="${r1(left + hr * pitch + gap / 2)}" y="${r1(y + gap / 2)}" width="${r1(pitch - gap)}" height="${r1(ch - gap)}" rx="2.5" fill="${color(m)}" data-tip="${esc(tip)}"/>`;
    }
  }
  const H = top + 7 * ch + bottom;
  const every = pitch * 3 >= 30 ? 3 : 6;
  const hours = xLabels({ x: left, W: box.w, H }, Array.from({ length: 24 }, (_, hr) => ({ x: left + hr * pitch + pitch / 2, text: hr % every === 0 ? hl(hr) : '' })));
  const title = opts.title || 'When you play';
  return {
    h: H,
    svg: `<g class="axis">${days}${hours}</g>${cells}`,
    label: total ? `${title}: ${fmtMin(total)} of timed play, busiest ${dayName(best.d, 'long')} ${hl(best.hr)} with ${fmtMin(best.m)}` : `${title}: nothing played`,
  };
});
/** Weekday x hour grid; arrow keys walk it (Up / Down by a day). */
export const punchcard = (data, opts = {}) => chart('punch', data, { keyRow: 24, ...opts });

// ---------- histogram ----------
/**
 * data: { buckets: [{ label, min, max (null = open), count, minutes }], median, p90 } (minutes).
 * Bars count sessions; a solid line marks the median, a dashed one the 90th percentile.
 */
registerChart('hist', ({ buckets, median, p90 }, opts, box) => {
  const n = Math.max(1, buckets.length);
  const scale = niceScale(Math.max(0, ...buckets.map((b) => b.count)), { unit: 'count', target: ticksFor(box, 48) });
  const a = plotArea(box, scale.ticks.map(scale.fmt), { top: 22 });
  const y = (v) => a.y + a.h - (v / scale.max) * a.h;
  const slot = a.w / n;
  const bw = Math.max(2, slot - Math.max(2, Math.min(8, slot * 0.18)));
  const name = (b) => b.label.replace('-', '–');
  let marks = ''; let hits = '';
  buckets.forEach((b, i) => {
    const x = a.x + i * slot + (slot - bw) / 2;
    if (b.count) marks += `<path class="mk" d="${barTop(x, y(b.count), bw, a.y + a.h - y(b.count), 4)}" fill="var(--accent-mark)"/>`;
    hits += hit(a.x + i * slot, a.y, slot, a.h, `${name(b)}: ${b.count.toLocaleString()} session${b.count === 1 ? '' : 's'}${b.minutes ? ` (${fmtMin(b.minutes)})` : ''}`, y(b.count));
  });
  const at = (v) => {
    const i = buckets.findIndex((b) => v >= b.min && (b.max == null || v < b.max));
    if (i < 0) return null;
    const b = buckets[i];
    return a.x + (i + (b.max == null ? 0.2 : (v - b.min) / (b.max - b.min))) * slot;
  };
  const lines = [];
  if (median) lines.push({ x: at(median), text: `median ${fmtMin(median)}`, dash: '' });
  if (p90) lines.push({ x: at(p90), text: `90% under ${fmtMin(p90)}`, dash: '4 3' });
  const placed = lines.filter((l) => l.x != null);
  // side by side when they would touch: the left label ends at its line, the right one starts at its line
  const close = placed.length === 2 && Math.abs(placed[1].x - placed[0].x) < (textWidth(placed[0].text) + textWidth(placed[1].text)) / 2 + 8;
  let ref = '';
  placed.forEach((l, k) => {
    const w = textWidth(l.text);
    let anchor = 'middle'; let tx = l.x;
    if (close) { anchor = k === 0 ? 'end' : 'start'; tx = k === 0 ? l.x - 3 : l.x + 3; }
    const left0 = anchor === 'end' ? tx - w : anchor === 'start' ? tx : tx - w / 2;
    tx += Math.max(0, 2 - left0) - Math.max(0, left0 + w - a.W + 2);
    ref += `<line class="ref" x1="${r1(l.x)}" x2="${r1(l.x)}" y1="${a.y - 6}" y2="${a.y + a.h}" stroke-dasharray="${l.dash}"/><text x="${r1(tx)}" y="12" text-anchor="${anchor}">${esc(l.text)}</text>`;
  });
  const every = everyFor(buckets.map((b) => ({ label: name(b) })), a.w);
  const labels = xLabels(a, buckets.map((b, i) => ({ x: a.x + i * slot + slot / 2, text: i % every === 0 ? name(b) : '' })));
  const count = sum(buckets.map((b) => b.count));
  const title = opts.title || 'Session lengths';
  return {
    svg: `<g class="axis">${yAxis(a, scale)}${labels}${ref}</g>${marks}${hits}`,
    label: count ? `${title}: ${count.toLocaleString()} session${count === 1 ? '' : 's'}${median ? `, median ${fmtMin(median)}` : ''}${p90 ? `, 90% under ${fmtMin(p90)}` : ''}` : `${title}: no sessions`,
  };
});
export const histogram = (data, opts = {}) => chart('hist', data, { size: 'card', cls: 'bar', ...opts });

// ---------- stacked area over time ----------
/**
 * data: { labels: [{ label, name }], series: [{ name, color, tracked: number[], estimated: number[] }] }.
 * Tracked play of every series stacks bottom up; their estimated history stacks on top, hatched in
 * each series' colour.
 */
registerChart('area', ({ labels, series }, opts, box) => {
  const n = labels.length;
  const layers = [
    ...series.map((s, j) => ({ s, j, vals: s.tracked, est: false })),
    ...series.map((s, j) => ({ s, j, vals: s.estimated || [], est: true })),
  ].filter((l) => l.vals.some((v) => v > 0));
  const totals = labels.map((_, i) => sum(layers.map((l) => l.vals[i])));
  const scale = niceScale(Math.max(0, ...totals), { unit: 'min', target: ticksFor(box) });
  const a = plotArea(box, scale.ticks.map(scale.fmt), { right: 4 });
  const X = (i) => (n === 1 ? a.x + a.w / 2 : a.x + (i / (n - 1)) * a.w);
  const Y = (v) => a.y + a.h - (v / scale.max) * a.h;
  const xs = n === 1 ? [a.x, a.x + a.w] : labels.map((_, i) => X(i));
  const at = (vals, i) => (n === 1 ? vals[0] : vals[i]) || 0;
  let base = xs.map(() => 0);
  let defs = '';
  let marks = '';
  for (const l of layers) {
    const top = xs.map((_, i) => base[i] + at(l.vals, i));
    const id = `${box.id}-h${l.j}`;
    if (l.est) defs += hatchDef(id, l.s.color);
    marks += `<polygon class="mk" data-key="${esc(l.est ? 'estimated' : l.s.name)}" points="${pts([...xs.map((x, i) => [x, Y(top[i])]), ...xs.map((x, i) => [x, Y(base[i])]).reverse()])}" fill="${l.est ? `url(#${id})` : l.s.color}" stroke="var(--panel)" stroke-width="1" stroke-linejoin="round"/>`;
    base = top;
  }
  if (layers.length) marks += `<polyline points="${pts(xs.map((x, i) => [x, Y(base[i])]))}" fill="none" stroke="var(--text)" stroke-opacity=".5" stroke-width="1.2"/>`;
  const slot = n === 1 ? a.w : a.w / (n - 1);
  let hits = '';
  labels.forEach((lb, i) => {
    const parts = series.map((s) => ({ s, t: s.tracked[i] || 0, e: (s.estimated || [])[i] || 0 })).filter((p) => p.t + p.e > 0);
    const est = sum(parts.map((p) => p.e));
    const tip = `${lb.name}: ${totals[i] ? fmtMin(totals[i]) : 'no play'}${parts.length > 1 ? ` · ${parts.map((p) => `${p.s.name} ${fmtMin(p.t + p.e, { short: p.t + p.e >= 600 })}`).join(', ')}` : ''}${est ? ` · ${fmtMin(est)} estimated` : ''}`;
    const x0 = Math.max(a.x, X(i) - slot / 2);
    hits += hit(x0, a.y, Math.min(a.x + a.w, X(i) + slot / 2) - x0, a.h, tip, Y(totals[i]));
  });
  const every = everyFor(labels, a.w);
  const xl = xLabels(a, labels.map((l, i) => ({ x: X(i), text: i % every === 0 ? l.label : '' })));
  return {
    defs: `<defs>${defs}</defs>`,
    svg: `<g class="axis">${yAxis(a, scale)}${xl}</g>${marks}${hits}`,
    label: opts.summary ? opts.summary() : summarize(opts.title || 'Playtime', labels.map((l, i) => ({ value: totals[i], name: l.name }))),
  };
});
export const areaChart = (data, opts = {}) => chart('area', data, { size: 'card', cls: 'bar', ...opts });

// ---------- swimlanes ----------
/**
 * data: { labels: [{ label, name }], rows: [{ title, tracked: number[], estimated: number[], minutes, others? }] }.
 * A lane per game with a bar per period (tracked solid, estimated history hatched on top); the
 * "others" lane has its own scale. Its height follows the number of lanes.
 */
registerChart('lanes', ({ labels, rows }, opts, box) => {
  const n = Math.max(1, labels.length);
  const labelW = Math.round(Math.min(170, Math.max(84, box.w * 0.26)));
  const rowH = 30; const top = 2; const bottom = 22;
  const x0 = labelW + 8;
  const plotW = Math.max(1, box.w - x0);
  const slot = plotW / n;
  const bw = Math.max(1, slot - Math.min(3, slot * 0.3));
  const peak = (r) => Math.max(1, ...r.tracked.map((t, i) => t + (r.estimated[i] || 0)));
  const gmax = Math.max(1, ...rows.filter((r) => !r.others).map(peak));
  const fit = Math.max(4, Math.floor(labelW / 6.6));
  let lanes = ''; let marks = ''; let hits = '';
  rows.forEach((r, k) => {
    const y = top + k * rowH;
    const foot = y + rowH - 5;
    const room = rowH - 10;
    const max = r.others ? peak(r) : gmax;
    const t = r.title.length > fit ? `${r.title.slice(0, fit - 1).trimEnd()}…` : r.title;
    lanes += `<rect x="${x0}" y="${y + 2}" width="${r1(plotW)}" height="${rowH - 4}" rx="5" fill="var(--bg2)"/><text class="lane-t${r.others ? ' others' : ''}" x="0" y="${r1(y + rowH / 2 + 4)}">${esc(t)}</text>`;
    for (let i = 0; i < n; i++) {
      const tr = r.tracked[i] || 0; const es = r.estimated[i] || 0;
      if (tr + es <= 0) continue;
      const hh = Math.max(2, ((tr + es) / max) * room);
      const ht = hh * (tr / (tr + es));
      const x = x0 + i * slot + (slot - bw) / 2;
      if (ht > 0) marks += `<rect x="${r1(x)}" y="${r1(foot - ht)}" width="${r1(bw)}" height="${r1(ht)}" rx="${Math.min(1.5, bw / 2)}" fill="${r.others ? 'var(--line-strong)' : 'var(--accent-mark)'}"/>`;
      if (hh - ht > 0.5) marks += `<rect x="${r1(x)}" y="${r1(foot - hh)}" width="${r1(bw)}" height="${r1(hh - ht)}" fill="url(#pt-hatch)"/>`;
      hits += hit(x0 + i * slot, y + 2, slot, rowH - 4, `${r.title} · ${labels[i].name}: ${fmtMin(tr + es)}${es ? ` (${fmtMin(es)} estimated)` : ''}`, foot - hh);
    }
  });
  const H = top + rows.length * rowH + bottom;
  const every = everyFor(labels, plotW);
  const xl = xLabels({ x: x0, W: box.w, H }, labels.map((l, i) => ({ x: x0 + i * slot + slot / 2, text: i % every === 0 ? l.label : '' })));
  const games = rows.filter((r) => !r.others);
  const title = opts.title || 'What you played';
  return {
    defs: HATCH,
    h: H,
    svg: `${lanes}<g class="axis">${xl}</g>${marks}${hits}`,
    label: games.length ? `${title}: ${games.length} game${games.length === 1 ? '' : 's'}, most played ${games[0].title} with ${fmtMin(games[0].minutes)}` : `${title}: nothing played`,
  };
});
export const swimlanes = (data, opts = {}) => chart('lanes', data, opts);

// ---------- a game's cumulative curve ----------
/**
 * data: { series: [{ label, name, minutes, tracked, estimated, sessions, unlocked, cumulative_tracked, cumulative_estimated }] }.
 * Estimated history is the hatched layer at the bottom (it came first), tracked play the solid one
 * on top, their sum the line. Under the plot: sessions per period (bars) and unlocks (dots).
 */
registerChart('curve', ({ series }, opts, box) => {
  const n = series.length;
  const hasS = series.some((s) => s.sessions); const hasU = series.some((s) => s.unlocked);
  const strips = (hasS ? 22 : 0) + (hasU ? 22 : 0);
  const totals = series.map((s) => s.cumulative_tracked + s.cumulative_estimated);
  const scale = niceScale(Math.max(0, ...totals), { unit: 'min', target: ticksFor(box, 28 + strips) });
  const a = plotArea(box, [...scale.ticks.map(scale.fmt), ...(strips ? ['Sessions'] : [])], { bottom: 20 + strips, right: 6 });
  const X = (i) => (n === 1 ? a.x + a.w / 2 : a.x + (i / (n - 1)) * a.w);
  const Y = (v) => a.y + a.h - (v / scale.max) * a.h;
  const xs = n === 1 ? [a.x, a.x + a.w] : series.map((_, i) => X(i));
  const v = (k, i) => (n === 1 ? series[0][k] : series[i][k]) || 0;
  const est = xs.map((_, i) => v('cumulative_estimated', i));
  const all = xs.map((_, i) => est[i] + v('cumulative_tracked', i));
  const band = (lo, hi) => pts([...xs.map((x, i) => [x, Y(hi[i])]), ...xs.map((x, i) => [x, Y(lo[i])]).reverse()]);
  let marks = '';
  if (est.some((x) => x > 0)) marks += `<polygon class="mk" data-key="estimated" points="${band(xs.map(() => 0), est)}" fill="url(#pt-hatch)"/>`;
  marks += `<polygon class="mk" data-key="tracked" points="${band(est, all)}" fill="color-mix(in srgb, var(--accent-mark) 55%, transparent)"/>`;
  marks += `<polyline points="${pts(xs.map((x, i) => [x, Y(all[i])]))}" fill="none" stroke="var(--accent-mark)" stroke-width="2" stroke-linejoin="round"/>`;
  let strip = ''; let side = '';
  let sy = a.y + a.h + 6;
  const slot = n === 1 ? a.w : a.w / (n - 1);
  if (hasS) {
    const mx = Math.max(1, ...series.map((s) => s.sessions));
    const w = Math.max(1.5, Math.min(10, slot * 0.6));
    series.forEach((s, i) => {
      if (!s.sessions) return;
      const hh = Math.max(2, (s.sessions / mx) * 16);
      strip += `<rect x="${r1(X(i) - w / 2)}" y="${r1(sy + 16 - hh)}" width="${r1(w)}" height="${r1(hh)}" rx="1" fill="var(--accent2)"/>`;
    });
    side += `<text x="${a.x - 6}" y="${sy + 12}" text-anchor="end">Sessions</text>`;
    sy += 22;
  }
  if (hasU) {
    const mx = Math.max(1, ...series.map((s) => s.unlocked));
    series.forEach((s, i) => { if (s.unlocked) strip += `<circle cx="${r1(X(i))}" cy="${sy + 8}" r="${r1(2 + 4 * Math.sqrt(s.unlocked / mx))}" fill="var(--star)"/>`; });
    side += `<text x="${a.x - 6}" y="${sy + 12}" text-anchor="end">Unlocks</text>`;
  }
  let hits = '';
  series.forEach((s, i) => {
    const x0 = Math.max(a.x, X(i) - slot / 2);
    const tip = `${s.name}: ${s.minutes ? fmtMin(s.minutes) : 'no play'}${s.estimated ? ` (${fmtMin(s.estimated)} estimated)` : ''} · ${s.sessions} session${s.sessions === 1 ? '' : 's'}${hasU ? ` · ${s.unlocked} unlocked` : ''} · ${fmtMin(totals[i])} in all`;
    hits += hit(x0, a.y, Math.min(a.x + a.w, X(i) + slot / 2) - x0, a.h + strips, tip, Y(totals[i]));
  });
  const every = everyFor(series, a.w);
  const xl = xLabels(a, series.map((s, i) => ({ x: X(i), text: i % every === 0 ? s.label : '' })));
  const last = n ? series[n - 1] : null;
  const title = opts.title || 'Playtime over time';
  return {
    defs: HATCH,
    svg: `<g class="axis">${yAxis(a, scale)}${xl}${side}</g>${marks}${strip}${hits}`,
    label: last ? `${title}: ${fmtMin(totals[n - 1])} from ${series[0].name} to ${last.name}, ${fmtMin(last.cumulative_tracked)} tracked${last.cumulative_estimated ? ` and ${fmtMin(last.cumulative_estimated)} estimated history` : ''}` : `${title}: nothing played`,
  };
});
export const curveChart = (data, opts = {}) => chart('curve', data, { cls: 'bar', size: 'page', ...opts });

// ---------- scatter: completion vs hours ----------
/**
 * data: { points: [{ x (minutes), y (0-100), tip, color? }] } in drawing order (keyboard order too).
 * x is logarithmic in hours, by decade.
 */
registerChart('scatter', ({ points }, opts, box) => {
  const hrs = points.map((p) => Math.max(1, p.x / 60));
  const lo = 10 ** Math.floor(Math.log10(Math.min(...hrs, 10)));
  const hi = 10 ** Math.ceil(Math.log10(Math.max(...hrs, lo * 10)));
  const yScale = { max: 100, ticks: [0, 25, 50, 75, 100], fmt: (t) => `${t}%` };
  const a = plotArea(box, ['100%%'], { top: 10, right: 8 }); // room for "100%" (the % is wider than the estimate)
  const L = (hh) => Math.log10(hh);
  const X = (m) => a.x + ((L(Math.max(lo, m / 60)) - L(lo)) / (L(hi) - L(lo))) * a.w;
  const Y = (p) => a.y + a.h - (Math.max(0, Math.min(100, p)) / 100) * a.h;
  let grid = ''; const xl = [];
  for (let d = lo; d <= hi + 1e-9; d *= 10) {
    const x = X(d * 60);
    if (d > lo) grid += `<line class="gridline" x1="${r1(x)}" x2="${r1(x)}" y1="${a.y}" y2="${a.y + a.h}"/>`;
    xl.push({ x, text: fmtMin(d * 60, { short: true }) });
  }
  const dots = points.map((p) => `<circle class="pt" cx="${r1(X(p.x))}" cy="${r1(Y(p.y))}" r="4.5" fill="${p.color || 'var(--accent-mark)'}" fill-opacity=".85" stroke="var(--panel)" stroke-width="1.5" data-tip="${esc(p.tip)}"/>`).join('');
  const avg = points.length ? Math.round(sum(points.map((p) => p.y)) / points.length) : 0;
  const title = opts.title || 'Completion vs hours';
  return {
    svg: `<g class="axis">${yAxis(a, yScale)}${grid}${xLabels(a, xl)}</g>${dots}`,
    label: points.length ? `${title}: ${points.length} game${points.length === 1 ? '' : 's'}, ${avg}% complete on average` : `${title}: no games with achievements`,
  };
});
export const scatterChart = (data, opts = {}) => chart('scatter', data, { cls: 'bar', size: 'page', ...opts });

// ---------- several series over the same periods ----------
/**
 * data: { labels: [{ label, name }], series: [{ name, color, values: (number|null)[], estimated?: number[] }] }.
 * opts.mode 'lines' (default; null values leave a gap) or 'bars' (grouped; each bar's estimated
 * history hatched on top in the series' colour).
 */
registerChart('lines', ({ labels, series }, opts, box) => {
  const n = Math.max(1, labels.length);
  const bars = opts.mode === 'bars';
  const scale = niceScale(Math.max(0, ...series.flatMap((s) => s.values.filter((x) => x != null))), { unit: 'min', target: ticksFor(box) });
  const a = plotArea(box, scale.ticks.map(scale.fmt));
  const slot = a.w / n;
  const X = (i) => a.x + i * slot + slot / 2;
  const Y = (v) => a.y + a.h - (v / scale.max) * a.h;
  let defs = ''; let marks = '';
  if (bars) {
    const k = Math.max(1, series.length);
    const bw = Math.max(1, Math.min(16, (slot * 0.8 - (k - 1)) / k));
    series.forEach((s, j) => {
      defs += hatchDef(`${box.id}-h${j}`, s.color);
      s.values.forEach((v, i) => {
        if (!v) return;
        const e = Math.min(v, (s.estimated || [])[i] || 0);
        const x = X(i) - (k * bw + (k - 1)) / 2 + j * (bw + 1);
        const ht = ((v - e) / scale.max) * a.h; const he = (e / scale.max) * a.h;
        const foot = a.y + a.h;
        if (ht > 0) marks += e ? `<rect class="mk" x="${r1(x)}" y="${r1(foot - ht)}" width="${r1(bw)}" height="${r1(ht)}" fill="${s.color}"/>` : `<path class="mk" d="${barTop(x, foot - ht, bw, ht, 3)}" fill="${s.color}"/>`;
        if (he > 0) marks += `<path class="mk" data-key="estimated" d="${barTop(x, foot - ht - he, bw, he, 3)}" fill="url(#${box.id}-h${j})"/>`;
      });
    });
  } else {
    series.forEach((s, j) => {
      let run = [];
      const flush = () => { if (run.length > 1) marks += `<polyline points="${pts(run)}" fill="none" stroke="${s.color}" stroke-width="${j === series.length - 1 ? 2.5 : 2}" stroke-linejoin="round" stroke-linecap="round"/>`; run = []; };
      s.values.forEach((v, i) => { if (v == null) flush(); else run.push([X(i), Y(v)]); });
      flush();
      s.values.forEach((v, i) => { if (v != null) marks += `<circle cx="${r1(X(i))}" cy="${r1(Y(v))}" r="${n > 24 ? 1.5 : 3}" fill="${s.color}"/>`; });
    });
  }
  let hits = '';
  labels.forEach((l, i) => {
    const parts = series.filter((s) => s.values[i] != null).map((s) => `${s.name} ${fmtMin(s.values[i])}${(s.estimated || [])[i] ? ` (${fmtMin(s.estimated[i])} est.)` : ''}`);
    const top = Math.min(...series.map((s) => (s.values[i] != null ? Y(s.values[i]) : a.y + a.h)));
    hits += hit(a.x + i * slot, a.y, slot, a.h, `${l.name}: ${parts.join(' · ') || 'no play'}`, top);
  });
  const every = everyFor(labels, a.w);
  const xl = xLabels(a, labels.map((l, i) => ({ x: X(i), text: i % every === 0 ? l.label : '' })));
  const title = opts.title || 'Playtime';
  return {
    defs: `<defs>${defs}</defs>`,
    svg: `<g class="axis">${yAxis(a, scale)}${xl}</g>${marks}${hits}`,
    label: opts.summary ? opts.summary() : `${title}: ${series.map((s) => `${s.name} ${fmtMin(sum(s.values))}`).join(', ') || 'nothing played'}`,
  };
});
export const lineChart = (data, opts = {}) => chart('lines', data, { size: 'card', cls: 'bar', ...opts });
