// Half-Life. The format is described in ../franchises.js.
export default {
  id: 'half-life', name: 'Half-Life', aliases: ['Half-Life'], prefix: ['half life'],
  eras: [
    ['Half-Life', 'GoldSrc', "Valve's first engine: Half-Life and its expansions"],
    ['Half-Life 2', 'Source', 'City 17, the episodes, and Half-Life rebuilt in Source'],
    ['Half-Life: Alyx', 'Source 2', 'Half-Life in virtual reality'],
  ],
  entries: [
    [1998, 'Half-Life'],
    [1999, 'Half-Life: Opposing Force', 'spinoff'],
    [2001, 'Half-Life: Blue Shift', 'spinoff'],
    [2004, 'Half-Life: Source', 'rerelease', { of: 'Half-Life', era: 'Source' }],
    [2004, 'Half-Life 2'],
    [2004, 'Half-Life 2: Deathmatch', 'spinoff'],
    [2005, 'Half-Life 2: Lost Coast', 'spinoff'],
    [2006, 'Half-Life Deathmatch: Source', 'spinoff'],
    [2006, 'Half-Life 2: Episode One'],
    [2007, 'Half-Life 2: Episode Two'],
    [2007, 'The Orange Box', 'collection', { includes: ['Half-Life 2', 'Half-Life 2: Episode One', 'Half-Life 2: Episode Two'] }],
    [2015, 'Half-Life 2: Update', 'remaster', { of: 'Half-Life 2' }],
    [2020, 'Black Mesa', 'remake', { of: 'Half-Life' }],
    [2020, 'Half-Life: Alyx'],
  ],
};
