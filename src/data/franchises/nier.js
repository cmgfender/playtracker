// NieR, with Drakengard, the series it grew out of. The format is described in ../franchises.js.
export default {
  id: 'nier', name: 'NieR', aliases: ['NieR', 'Drakengard', 'Drag-On Dragoon'], prefix: ['nier', 'drakengard', 'drag-on dragoon'],
  eras: [
    ['Drakengard', 'Drakengard and the first NieR', 'Dark fantasy on PS2 and PS3 from Cavia, then Drakengard 3 by Access Games'],
    ['NieR: Automata', 'Automata and after', 'PlatinumGames action in NieR: Automata and its later editions'],
  ],
  entries: [
    [2003, 'Drakengard', 'main', { aka: ['Drag-On Dragoon'] }],
    [2005, 'Drakengard 2', 'main', { aka: ['Drag-On Dragoon 2'] }],
    [2010, 'NieR', 'main', { aka: ['NieR Gestalt', 'NieR Replicant'] }],
    [2013, 'Drakengard 3', 'main', { aka: ['Drag-On Dragoon 3'] }],
    [2017, 'NieR: Automata'],
    [2018, 'NieR: Automata Become as Gods Edition', 'rerelease', { of: 'NieR: Automata' }],
    [2019, 'NieR: Automata Game of the YoRHa Edition', 'rerelease', { of: 'NieR: Automata' }],
    [2021, 'NieR Replicant ver.1.22474487139...', 'remaster', { of: 'NieR', era: 'Drakengard and the first NieR', aka: ['NieR Replicant ver.1.22'] }],
    [2022, 'NieR: Automata The End of YoRHa Edition', 'rerelease', { of: 'NieR: Automata' }],
  ],
  story: ['Drakengard 3', 'Drakengard', 'Drakengard 2', 'NieR', 'NieR: Automata'],
};
