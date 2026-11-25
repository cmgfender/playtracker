// Quake. The format is described in ../franchises.js.
export default {
  id: 'quake', name: 'Quake', aliases: ['Quake'], prefix: ['quake ii', 'quake iii', 'quake 4', 'quake live', 'quake champions', 'enemy territory: quake wars'],
  eras: [
    ['Quake', 'id Software', 'The first three, made by id: dark fantasy, the Strogg, then the arena'],
    ['Quake 4', 'The Strogg war', "Raven's Quake 4 and Splash Damage's Quake Wars"],
    ['Quake Live', 'Arenas and remasters', 'Free-to-play arena shooters, and the originals made new'],
  ],
  entries: [
    [1996, 'Quake'],
    [1997, 'Quake II'],
    [1999, 'Quake III Arena'],
    [2005, 'Quake 4'],
    [2007, 'Enemy Territory: Quake Wars', 'spinoff'],
    [2010, 'Quake Live', 'spinoff'],
    [2019, 'Quake II RTX', 'remaster', { of: 'Quake II' }],
    [2021, 'Quake (2021)', 'remaster', { of: 'Quake' }],
    [2022, 'Quake Champions', 'spinoff'],
    [2023, 'Quake II (2023)', 'remaster', { of: 'Quake II' }],
  ],
};
