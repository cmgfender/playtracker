// Mario Tennis. The format is described in ../franchises.js.
export default {
  id: 'mario-tennis', name: 'Mario Tennis', aliases: ['Mario Tennis'], prefix: ['mario tennis', "mario's tennis", 'mario power tennis'],
  eras: [
    ["Mario's Tennis", 'Virtual Boy to GameCube', "Mario's Tennis, then Camelot's console games, each with a handheld RPG partner"],
    ['Mario Tennis Open', '3DS and Wii U', 'Open on 3DS and Ultra Smash on Wii U, both without a story mode'],
    ['Mario Tennis Aces', 'Switch', 'Aces on Switch and Fever on Switch 2, each with an adventure mode'],
  ],
  entries: [
    [1995, "Mario's Tennis"],
    [2000, 'Mario Tennis', 'main', { aka: ['Mario Tennis 64'] }],
    [2000, 'Mario Tennis GB'],
    [2004, 'Mario Power Tennis', 'main', { aka: ['Mario Tennis GC'] }],
    [2005, 'Mario Tennis: Power Tour', 'main', { aka: ['Mario Tennis Advance', 'Mario Power Tennis'] }],
    [2009, 'New Play Control! Mario Power Tennis', 'rerelease', { of: 'Mario Power Tennis' }],
    [2012, 'Mario Tennis Open'],
    [2015, 'Mario Tennis: Ultra Smash'],
    [2018, 'Mario Tennis Aces'],
    [2026, 'Mario Tennis Fever'],
  ],
};
