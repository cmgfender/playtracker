// Virtua Fighter. The format is described in ../franchises.js.
export default {
  id: 'virtua-fighter', name: 'Virtua Fighter', aliases: ['Virtua Fighter'], prefix: ['virtua fighter', 'fighters megamix'],
  eras: [
    ['Virtua Fighter', 'The 1990s arcade games', 'The first 3D fighter, its Model 2 and Model 3 sequels, and the Saturn games'],
    ['Virtua Fighter 4', 'Virtua Fighter 4 and 5', 'NAOMI 2 and Lindbergh arcade games, and the later versions of 5'],
  ],
  entries: [
    [1993, 'Virtua Fighter'],
    [1994, 'Virtua Fighter 2'],
    [1995, 'Virtua Fighter Remix', 'rerelease', { of: 'Virtua Fighter' }],
    [1996, 'Virtua Fighter Kids', 'spinoff'],
    [1996, 'Virtua Fighter 3'],
    [1996, 'Fighters Megamix', 'spinoff'],
    [1997, 'Virtua Fighter 3tb', 'rerelease', { of: 'Virtua Fighter 3' }],
    [2001, 'Virtua Fighter 4'],
    [2002, 'Virtua Fighter 4: Evolution', 'rerelease', { of: 'Virtua Fighter 4' }],
    [2006, 'Virtua Fighter 5'],
    [2010, 'Virtua Fighter 5 Final Showdown', 'rerelease', { of: 'Virtua Fighter 5' }],
    [2021, 'Virtua Fighter 5 Ultimate Showdown', 'remaster', { of: 'Virtua Fighter 5 Final Showdown' }],
    [2025, 'Virtua Fighter 5 R.E.V.O.', 'rerelease', { of: 'Virtua Fighter 5 Ultimate Showdown', aka: ['Virtua Fighter 5 R.E.V.O. World Stage', 'Virtua Fighter 5 REVO'] }],
  ],
};
