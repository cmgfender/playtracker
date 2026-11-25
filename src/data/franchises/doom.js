// Doom. The format is described in ../franchises.js.
export default {
  id: 'doom', name: 'Doom', aliases: ['Doom'], prefix: ['doom'],
  eras: [
    ['Doom (1993)', 'The id classics', 'Doom, Doom II and their 90s offshoots'],
    ['Doom 3', 'Doom 3', 'Slower and darker: a horror shooter on Mars'],
    ['Doom (2016)', 'The modern saga', 'The Slayer: Doom, Eternal and The Dark Ages, and the classics re-released'],
  ],
  entries: [
    [1993, 'Doom (1993)', 'main', { aka: ['Doom', 'The Ultimate Doom'] }],
    [1994, 'Doom II', 'main', { aka: ['Doom II: Hell on Earth'] }],
    [1996, 'Final Doom', 'spinoff'],
    [1997, 'Doom 64', 'spinoff'],
    [2004, 'Doom 3'],
    [2012, 'Doom 3: BFG Edition', 'remaster', { of: 'Doom 3' }],
    [2016, 'Doom (2016)', 'main', { aka: ['Doom'] }],
    [2017, 'Doom VFR', 'spinoff'],
    [2020, 'Doom Eternal'],
    [2024, 'Doom + Doom II', 'collection', { includes: ['Doom (1993)', 'Doom II', 'Final Doom'] }],
    [2025, 'Doom: The Dark Ages'],
  ],
};
