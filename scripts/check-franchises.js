// Checks the curated franchises (src/data/franchises/*.js) the way the tests do, and says what is
// wrong in a way that is quick to fix: npm run check:franchises [id ...]
//   - each file's id is its name; ids unique; aliases and prefixes given
//   - entries in release order, years sane, no title twice, kinds known
//   - a remake, remaster or re-release says what it is a version of (`of`), naming an entry;
//     collections hold entries; `era` names an era; eras start at entries, in release order, the
//     first at the first entry; the story names entries
//   - two entries of one franchise sold under the same normalised title differ in year; no title
//     belongs to two franchises; no prefix of one franchise starts a title of another
import fs from 'node:fs';
import { normalizeTitle } from '../src/services/titles.js';

// each file on its own, so one that does not load is reported, not the end of the check
const dir = new URL('../src/data/franchises/', import.meta.url);
const FRANCHISES = [];
const broken = [];
for (const file of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
  try {
    const f = (await import(new URL(file, dir).href)).default;
    if (!f || f.id !== file.slice(0, -3)) broken.push(`${file}: its default export's id must be its file name`);
    else FRANCHISES.push(f);
  } catch (e) { broken.push(`${file}: ${e.message.split('\n')[0]}`); }
}

const KINDS = ['main', 'spinoff', 'remake', 'remaster', 'rerelease', 'collection'];
const VERSIONS = ['remake', 'remaster', 'rerelease'];
const only = new Set(process.argv.slice(2));
const thisYear = new Date().getFullYear();
const problems = [...broken];
const say = (f, msg) => problems.push(`${f.id}: ${msg}`);
const yearless = (t) => t.replace(/\s*\((?:19|20)\d{2}\)$/, '');

const ids = new Set();
for (const f of FRANCHISES) {
  if (ids.has(f.id)) say(f, 'id used twice');
  ids.add(f.id);
  if (only.size && !only.has(f.id)) continue;
  if (!f.name || !f.aliases?.length || !f.prefix?.length) say(f, 'name, aliases and prefix are required');
  const titles = f.entries.map((e) => e[1]);
  const set = new Set(titles);
  if (set.size !== titles.length) say(f, `a title twice: ${titles.filter((t, i) => titles.indexOf(t) !== i).join(', ')}`);
  f.entries.forEach(([y, t, k = 'main', o = {}], i) => {
    if (!Number.isInteger(y) || y < 1970 || y > thisYear) say(f, `${t}: year ${y}`);
    if (i && y < f.entries[i - 1][0]) say(f, `${t} (${y}) is listed after ${f.entries[i - 1][1]} (${f.entries[i - 1][0]})`);
    if (!KINDS.includes(k)) say(f, `${t}: kind ${k}`);
    if (VERSIONS.includes(k) !== !!o.of) say(f, `${t}: ${VERSIONS.includes(k) ? `a ${k} needs of` : `only a remake, remaster or re-release has of`}`);
    for (const x of [].concat(o.of || [])) if (!set.has(x) || x === t) say(f, `${t}: of ${x} is no other entry`);
    for (const x of o.includes || []) if (!set.has(x)) say(f, `${t}: includes ${x}, no entry`);
    if (o.includes && k !== 'collection') say(f, `${t}: only a collection includes`);
    if (o.era && !(f.eras || []).some((e) => e[1] === o.era)) say(f, `${t}: era ${o.era} is not one of its eras`);
    for (const a of o.aka || []) if (typeof a !== 'string') say(f, `${t}: aka must be titles`);
  });
  const starts = (f.eras || []).map((e) => titles.indexOf(e[0]));
  (f.eras || []).forEach((e, j) => {
    if (starts[j] < 0) say(f, `era ${e[1]} starts at ${e[0]}, no entry`);
    if (!e[1] || !e[2]) say(f, `era starting at ${e[0]} needs a name and what defines it`);
    if (j && starts[j] <= starts[j - 1]) say(f, `era ${e[1]} starts before the era listed ahead of it`);
  });
  if (starts.length && starts[0] !== 0) say(f, `the first era must start at the first entry (${titles[0]})`);
  for (const s of f.story || []) if (!set.has(s)) say(f, `the story's ${s} is no entry`);
  for (const h of f.hubs || []) if (!h.title || !h.ids || !Number.isInteger(h.from)) say(f, 'a hub needs title, from and ids');
  // one normalised title, two entries: they must differ in year (the year tells them apart)
  const byKey = new Map();
  for (const [y, t, , o = {}] of f.entries) for (const key of new Set([t, yearless(t), ...(o.aka || [])].map(normalizeTitle))) { if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push([y, t]); }
  for (const [key, l] of byKey) { const ys = l.map((x) => x[0]); if (new Set(ys).size !== ys.length) say(f, `"${key}" names ${l.map((x) => x[1]).join(' and ')} of the same year`); }
}
// across franchises: a title in two, a prefix of one starting another's title
const owner = new Map();
for (const f of FRANCHISES) for (const [, t, , o = {}] of f.entries) for (const key of new Set([t, yearless(t), ...(o.aka || [])].map(normalizeTitle))) {
  if (owner.has(key) && owner.get(key) !== f.id) problems.push(`"${key}" is in ${owner.get(key)} and ${f.id}`);
  owner.set(key, f.id);
}
for (const f of FRANCHISES) for (const p of f.prefix.map(normalizeTitle)) for (const [key, id] of owner) {
  if (id !== f.id && (key === p || key.startsWith(`${p} `))) {
    // a longer prefix of the other franchise wins, so only a clash when the other has none as long
    const other = FRANCHISES.find((x) => x.id === id);
    if (!other.prefix.map(normalizeTitle).some((q) => q.length >= p.length && (key === q || key.startsWith(`${q} `)))) problems.push(`${f.id}'s prefix "${p}" starts ${id}'s "${key}"`);
  }
}
const n = FRANCHISES.reduce((a, f) => a + f.entries.length, 0);
if (problems.length) { console.log(problems.map((p) => `✗ ${p}`).join('\n')); console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} in ${FRANCHISES.length} franchises`); process.exit(1); }
console.log(`${FRANCHISES.length} franchises, ${n} entries, ${FRANCHISES.filter((f) => (f.eras || []).length > 1).length} with eras: no problems`);
