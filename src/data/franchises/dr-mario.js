// Dr. Mario. The format is described in ../franchises.js.
export default {
  id: 'dr-mario', name: 'Dr. Mario', aliases: ['Dr. Mario'], prefix: ['dr mario', 'dr luigi'],
  eras: [
    ['Dr. Mario', 'Cartridges', 'NES and Game Boy, Nintendo 64, and two collections'],
    ['Dr. Mario Online Rx', 'Download only', 'Online play, from WiiWare and the eShop to phones'],
  ],
  entries: [
    [1990, 'Dr. Mario'],
    [1994, 'Tetris & Dr. Mario', 'collection', { includes: ['Dr. Mario'] }],
    [2001, 'Dr. Mario 64'],
    [2005, 'Dr. Mario & Puzzle League', 'collection', { includes: ['Dr. Mario'] }],
    [2008, 'Dr. Mario Online Rx', 'main', { aka: ['Dr. Mario & Germ Buster'] }],
    [2013, 'Dr. Luigi'],
    [2015, 'Dr. Mario: Miracle Cure'],
    [2019, 'Dr. Mario World', 'spinoff'],
  ],
};
