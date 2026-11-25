// Mario Golf. The format is described in ../franchises.js.
export default {
  id: 'mario-golf', name: 'Mario Golf', aliases: ['Mario Golf'], prefix: ['mario golf', 'mario open golf', 'nes open tournament golf'],
  eras: [
    ['NES Open Tournament Golf', 'NES', 'Mario Open Golf, on the Famicom Disk System and NES'],
    ['Mario Golf', 'Camelot', "Camelot's games, from Nintendo 64 and Game Boy Color to Switch"],
  ],
  entries: [
    [1991, 'NES Open Tournament Golf', 'main', { aka: ['Mario Open Golf'] }],
    [1999, 'Mario Golf', 'main', { aka: ['Mario Golf 64'] }],
    [1999, 'Mario Golf GB'],
    [2003, 'Mario Golf: Toadstool Tour', 'main', { aka: ['Mario Golf: Family Tour'] }],
    [2004, 'Mario Golf: Advance Tour'],
    [2014, 'Mario Golf: World Tour'],
    [2021, 'Mario Golf: Super Rush'],
  ],
};
