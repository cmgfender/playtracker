// Pikmin. The format is described in ../franchises.js.
export default {
  id: 'pikmin', name: 'Pikmin', aliases: ['Pikmin'], prefix: ['pikmin', 'hey! pikmin', 'new play control! pikmin'],
  eras: [
    ['Pikmin', 'GameCube and Wii', 'Olimar on the planet of the Pikmin: Pikmin and Pikmin 2'],
    ['Pikmin 3', 'Wii U and 3DS', 'Three new captains in Pikmin 3, and the side-on Hey! Pikmin'],
    ['Pikmin Bloom', 'Bloom and Pikmin 4', 'Walking with Pikmin on phones, and Pikmin 4 on Switch'],
  ],
  entries: [
    [2001, 'Pikmin', 'main', { aka: ['Pikmin 1'] }],
    [2004, 'Pikmin 2'],
    [2008, 'New Play Control! Pikmin', 'rerelease', { of: 'Pikmin' }],
    [2009, 'New Play Control! Pikmin 2', 'rerelease', { of: 'Pikmin 2' }],
    [2013, 'Pikmin 3'],
    [2017, 'Hey! Pikmin', 'spinoff'],
    [2020, 'Pikmin 3 Deluxe', 'rerelease', { of: 'Pikmin 3' }],
    [2021, 'Pikmin Bloom', 'spinoff'],
    [2023, 'Pikmin 1+2', 'collection', { includes: ['Pikmin', 'Pikmin 2'], era: 'GameCube and Wii' }],
    [2023, 'Pikmin 4'],
    [2026, 'Pikmin 4 – Nintendo Switch 2 Edition + Dandori Academy', 'rerelease', { of: 'Pikmin 4' }],
  ],
};
