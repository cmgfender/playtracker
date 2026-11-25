// Mario Kart. The format is described in ../franchises.js.
export default {
  id: 'mario-kart', name: 'Mario Kart', aliases: ['Mario Kart'], prefix: ['mario kart', 'super mario kart'],
  eras: [
    ['Super Mario Kart', 'Split screen', 'Couch racing from Super NES to GameCube'],
    ['Mario Kart DS', 'Online', 'Races online, from Mario Kart DS to 8 Deluxe'],
    ['Mario Kart World', 'Open world', 'Every track joined into one world'],
  ],
  entries: [
    [1992, 'Super Mario Kart'],
    [1996, 'Mario Kart 64'],
    [2001, 'Mario Kart: Super Circuit'],
    [2003, 'Mario Kart: Double Dash!!'],
    [2005, 'Mario Kart DS'],
    [2008, 'Mario Kart Wii'],
    [2011, 'Mario Kart 7'],
    [2014, 'Mario Kart 8'],
    [2017, 'Mario Kart 8 Deluxe', 'rerelease', { of: 'Mario Kart 8' }],
    [2019, 'Mario Kart Tour', 'spinoff'],
    [2020, 'Mario Kart Live: Home Circuit', 'spinoff'],
    [2025, 'Mario Kart World'],
  ],
};
