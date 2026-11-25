// Metroid. The format is described in ../franchises.js.
export default {
  id: 'metroid', name: 'Metroid', aliases: ['Metroid'], prefix: ['metroid'],
  eras: [
    ['Metroid', 'The 2D originals', 'Samus on NES, Game Boy and Super NES'],
    ['Metroid Prime', 'Prime and Fusion', "Retro's first-person Prime trilogy, Fusion, Zero Mission and Other M"],
    ['Metroid: Samus Returns', 'The return', "MercurySteam's Samus Returns and Dread, Prime remastered, and Prime 4"],
  ],
  entries: [
    [1986, 'Metroid'],
    [1991, 'Metroid II: Return of Samus'],
    [1994, 'Super Metroid'],
    [2002, 'Metroid Prime'],
    [2002, 'Metroid Fusion'],
    [2004, 'Metroid: Zero Mission', 'remake', { of: 'Metroid' }],
    [2004, 'Metroid Prime 2: Echoes'],
    [2006, 'Metroid Prime Hunters', 'spinoff'],
    [2007, 'Metroid Prime 3: Corruption'],
    [2009, 'Metroid Prime: Trilogy', 'collection', { includes: ['Metroid Prime', 'Metroid Prime 2: Echoes', 'Metroid Prime 3: Corruption'] }],
    [2010, 'Metroid: Other M'],
    [2016, 'Metroid Prime: Federation Force', 'spinoff'],
    [2017, 'Metroid: Samus Returns', 'remake', { of: 'Metroid II: Return of Samus' }],
    [2021, 'Metroid Dread'],
    [2023, 'Metroid Prime Remastered', 'remaster', { of: 'Metroid Prime' }],
    [2025, 'Metroid Prime 4: Beyond'],
  ],
};
