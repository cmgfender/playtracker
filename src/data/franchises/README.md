# Curated franchises: adding and updating

One file per franchise, named after its id (`halo.js`, `final-fantasy.js`). Every `.js` file in this
folder is loaded at startup by `src/data/franchises.js`, which also documents each field. Coverage is
for everyone: mass-appeal and niche series alike, never chosen from one person's library.

## Add a franchise

1. `npm run franchise -- new <id> "<Name>"` writes a file to fill in.
2. Fill in `entries` in release order (see the rules below), then `eras` for a series of about six
   or more entries, and `story` only where the story is told out of order.
3. `npm run check:franchises <id>` until it reports no problems. It checks the same things the tests
   do: release order, kinds, every `of`/`includes`/`era`/`story` naming an entry, titles that
   normalise the same telling apart by year, and no title or prefix shared with another franchise.
4. `npm run franchise -- show <id>` to read it back as eras and versions.
5. `npm run franchise -- match "<store title>" --year <year>` for the titles stores really use
   (Steam, Xbox, PlayStation): each should land on the entry you mean. Add `aka` when one does not.

## Update one

- A new game came out: add it at its place in release order (same-year entries in the order they
  came out). A game newer than the file is still placed by its release date, as "Also in the series",
  until it is added.
- A remaster, remake or re-release: add it with `kind` and `of` (the entry it is a version of). If it
  belongs to an earlier era than its release (a remaster of the 3D-era games released in the HD era,
  where eras follow the story), give it `era: '<era name>'`.
- A collection: `kind: 'collection'` and `includes`. Owning it puts the games it holds in your library.
- A launcher that holds several games (the Call of Duty app): a `hubs` entry with its store ids.

## Rules for the data

- **Year**: the first release anywhere (Japan or the arcade first for many). Early access and betas
  don't count; 1.0 does. Only games already out.
- **Kinds**: `main` (default), `spinoff`, `remake` (rebuilt), `remaster` (the same game made to look
  new), `rerelease` (the same game again, often with more in it: Persona 5 Royal, a port),
  `collection`. A remake of part of a game (Final Fantasy VII Remake) is `partial: true`: it stands
  for none of the original.
- **Titles**: the usual official English title. A reboot sold under the original's exact title gets
  its year: `'Doom (2016)'`. Editions (Deluxe, Definitive, Ultimate, Special, Anniversary, Complete,
  GOTY…), platform tags and roman numerals are ignored when titles are compared, so two entries that
  differ only by them must differ in year.
- **aka**: other titles it is sold under (regional names, store titles like "HITMAN World of
  Assassination", "EA SPORTS FC 25").
- **aliases**: the series' names, as IGDB and people use them. **prefix**: lower-case title starts
  that belong to this series only; never a common word ("metro", "thief", "anno", "fifa"). The
  longest prefix wins between franchises.
- **Eras**: 2–5, each `[title of its first entry, short name, one line on what defines it]`; factual
  (developers, hardware, story arcs, gameplay). Plain short English, no marketing, no arrows.

## How games are matched (src/services/franchises/match.js)

A game's title (then IGDB's name for it) is looked up exactly, then as a test build (beta, insider,
demo, test server: kept with the entry, not counted as played), bonus content, a mode or a platform's
build ("BATTLEMODE", "- Xbox Series X|S", "for Xbox One": the game itself), and a version
("Remastered", "HD", "- Master Collection Version", or a later release under the same name: a
re-release of the entry). Episodes ("- Episode 1: …") and brands in front ("EA SPORTS …") are dropped
first. To teach it a new kind of store title, add its words to `RULES` there and a case to
`test/franchises.test.js` ("store titles").

The rest of the service: `catalog.js` prepares this data, `library.js` reads your games,
`timeline.js` builds a franchise's timeline, eras, versions, next and your order, and
`src/services/franchises.js` is the API the routes use.
