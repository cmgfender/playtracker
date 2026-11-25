// Tools for the curated franchises (src/data/franchises/*.js):
//   npm run franchise -- match "<store title>" [--year 2019] [--igdb "<IGDB name>"] [--id steam:1938090]
//       where a game with this title would land: which franchise, which entry, and how (title,
//       version, test, bonus, hub, other) - to see a new store title is understood before adding aka
//   npm run franchise -- show <id>
//       the franchise as the data has it: eras, entries in release order with their kind, what each
//       version is a version of, and the story order
//   npm run franchise -- new <id> "<Name>"
//       a new file to fill in, with every field of the format; then `npm run check:franchises <id>`
import fs from 'node:fs';
import { matchTitle } from '../src/services/franchises.js';
import { CURATED, BY_ID } from '../src/services/franchises/catalog.js';

const [cmd, ...args] = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i && args[i - 1].startsWith('--')));

if (cmd === 'match' && positional[0]) {
  const r = matchTitle(positional[0], { year: opt('year') ? Number(opt('year')) : null, igdbName: opt('igdb'), ids: opt('id') ? [opt('id')] : [] });
  console.log(r ? r : 'No curated franchise: it would go by IGDB\'s franchises and the title (series.js), or stand alone.');
} else if (cmd === 'show' && positional[0]) {
  const f = BY_ID.get(positional[0]);
  if (!f) { console.log(`No franchise ${positional[0]}. There are ${CURATED.length}: ${CURATED.map((x) => x.id).join(' ')}`); process.exit(1); }
  console.log(`${f.name} (${f.id}) · aliases: ${f.aliases.join(', ')} · prefix: ${f.prefix.join(', ')}`);
  let era = -1;
  for (const e of f.entries) {
    if (e.era !== era && e.era != null && !e.eraName) { era = e.era; console.log(`\n  ${f.eras[era].name} - ${f.eras[era].note}`); }
    const of = e.of.length ? ` (of ${e.of.map((j) => f.entries[j].title).join(', ')}${e.partial ? ', in parts' : ''})` : '';
    const inc = e.inc.length ? ` (holds ${e.inc.map((j) => f.entries[j].title).join(', ')})` : '';
    console.log(`  ${e.year} ${e.kind === 'main' ? '    ' : `[${e.kind}] `}${e.title}${of}${inc}${e.eraName ? ` {${e.eraName}}` : ''}`);
  }
  if (f.story) console.log(`\n  Story: ${f.story.join(' / ')}`);
} else if (cmd === 'new' && positional[0] && positional[1]) {
  const [id, name] = positional;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) { console.log('An id is lower case words joined by dashes: final-fantasy'); process.exit(1); }
  const file = new URL(`../src/data/franchises/${id}.js`, import.meta.url);
  if (fs.existsSync(file)) { console.log(`src/data/franchises/${id}.js exists: edit it.`); process.exit(1); }
  fs.writeFileSync(file, `// ${name}. The format is described in ../franchises.js; how to fill it in, in ./README.md.
export default {
  id: '${id}', name: ${JSON.stringify(name).replace(/^"|"$/g, "'")}, aliases: [${JSON.stringify(name).replace(/"/g, "'")}], prefix: [${JSON.stringify(name.toLowerCase()).replace(/"/g, "'")}],
  // eras: [[title of the era's first entry, name, what defines it]] - for a series of about six or more
  eras: [],
  entries: [
    // [year first released anywhere, title, kind?, { aka?, of?, partial?, includes?, era? }], in release order
  ],
};
`);
  console.log(`Wrote src/data/franchises/${id}.js. Fill in the entries, then: npm run check:franchises ${id}`);
} else {
  console.log('npm run franchise -- match "<store title>" [--year N] [--igdb "<name>"] [--id platform:ext_id]\nnpm run franchise -- show <id>\nnpm run franchise -- new <id> "<Name>"');
}
