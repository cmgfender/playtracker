// Counter-Strike. The format is described in ../franchises.js.
export default {
  id: 'counter-strike', name: 'Counter-Strike', aliases: ['Counter-Strike'], prefix: ['counter strike'],
  eras: [
    ['Counter-Strike', 'GoldSrc', 'The Half-Life mod made a retail game, and Condition Zero'],
    ['Counter-Strike: Source', 'Source', 'Counter-Strike rebuilt in Source, then Global Offensive'],
    ['Counter-Strike 2', 'Source 2', 'Global Offensive moved to Source 2'],
  ],
  entries: [
    [2000, 'Counter-Strike'],
    [2004, 'Counter-Strike: Condition Zero'],
    [2004, 'Counter-Strike: Condition Zero Deleted Scenes', 'spinoff'],
    [2004, 'Counter-Strike: Source', 'remake', { of: 'Counter-Strike' }],
    [2012, 'Counter-Strike: Global Offensive'],
    [2023, 'Counter-Strike 2'],
  ],
};
