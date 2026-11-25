// Wipeout. The format is described in ../franchises.js.
// The prefixes are narrow: "Wipeout" alone also starts the unrelated games of the TV show.
export default {
  id: 'wipeout', name: 'Wipeout', aliases: ['Wipeout'], prefix: ['wipeout 2097', 'wipeout xl', 'wipeout 64', 'wipeout fusion', 'wipeout pure', 'wipeout pulse', 'wipeout hd', 'wipeout 2048', 'wipeout omega'],
  eras: [
    ['Wipeout', 'Psygnosis', "Psygnosis' games on PlayStation and the N64"],
    ['Wipeout Fusion', 'Studio Liverpool', 'The renamed studio, from Fusion on PS2 to 2048 on Vita'],
  ],
  entries: [
    [1995, 'Wipeout'],
    [1996, 'Wipeout 2097', 'main', { aka: ['Wipeout XL'] }],
    [1998, 'Wipeout 64'],
    [1999, 'Wipeout 3', 'main', { aka: ['Wip3out'] }],
    [2000, 'Wipeout 3: Special Edition', 'rerelease', { of: 'Wipeout 3' }],
    [2002, 'Wipeout Fusion'],
    [2005, 'Wipeout Pure'],
    [2007, 'Wipeout Pulse'],
    [2008, 'Wipeout HD'],
    [2012, 'Wipeout 2048'],
    [2017, 'Wipeout Omega Collection', 'collection', { includes: ['Wipeout HD', 'Wipeout 2048'] }],
  ],
};
