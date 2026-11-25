// The big franchises, curated - one file each in ./franchises/, named after the franchise's id. Every
// main entry in the order it was released, the spin-offs, remakes, remasters, re-releases and
// collections people own, the eras each series falls into, and - where the story is told out of
// order - the order of the story. Years are the first release anywhere (Japan or the arcade first
// for many; a beta or early access does not count); entries of the same year are listed in the
// order they came out.
//
// Only what was out when a file was written is in it: a newer game of a franchise in your library
// is placed by its release date, and a re-release under an entry's name (a "Remastered", a later
// port) is found as a version of it. Matching to your games is by title (normalised: editions,
// platform tags and roman numerals do not matter) and, where one title names two games (Doom 1993
// and 2016), by the release year.
//
// A file:
//   export default {
//     id: 'halo',                 the file's name, lower case with dashes
//     name: 'Halo',
//     aliases: ['Halo'],          names IGDB and people use for the series
//     prefix: ['halo'],           a game whose title starts with one of these is in the series
//     eras: [[title of the era's first entry, name, what defines it], ...]
//     hubs: [{ title, from, ids: { steam: [...], xbox: [...] }, note }]
//     entries: [[year, title, kind?, { aka?, of?, partial?, includes?, era? }], ...]
//     story: [entry titles in the order the story takes place, where that is not the release order]
//   };
//
// entries
//   kind     main (default) | spinoff | remake | remaster | rerelease | collection
//            remake: rebuilt (Resident Evil 2, 2019); remaster: the same game made to look new
//            (Dark Souls: Remastered); rerelease: the same game again, often with more in it
//            (Persona 5 Royal, a port)
//   of       the entry (or entries) a remake, remaster or re-release is a version of; playing it
//            counts as playing that game
//   partial  a remake of part of a game (the Final Fantasy VII Remake project): it stands for none
//            of the original
//   includes the entries a collection holds
//   era      the name of the era it belongs to when that is not the one its release falls in (a
//            remaster of an era's games released in a later era)
//   aka      other titles it is sold under
// eras: an era runs from its first entry to the next era's first entry, in release order
// hubs: launchers that hold several games of the series (their time cannot be split by game), known
//   by their store ids
//
// Run `npm run check:franchises` after a change: it checks every file the way the tests do.

import fs from 'node:fs';

const dir = new URL('./franchises/', import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();

/** Every curated franchise, in the order of their file names. */
export const FRANCHISES = (await Promise.all(files.map((f) => import(new URL(f, dir).href)))).map((m, i) => {
  const f = m.default;
  if (!f || f.id !== files[i].slice(0, -3)) throw new Error(`src/data/franchises/${files[i]}: its id must be its file name`);
  return f;
});
