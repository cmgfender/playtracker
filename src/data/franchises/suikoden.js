// Suikoden. The format is described in ../franchises.js.
export default {
  id: 'suikoden', name: 'Suikoden', aliases: ['Suikoden', 'Gensō Suikoden'], prefix: ['suikoden', 'genso suikoden'],
  eras: [
    ['Suikoden', 'Gate Rune and Dunan', 'The Gate Rune War and the Dunan Unification War, on PlayStation'],
    ['Suikoden III', 'PlayStation 2 and DS', 'III, IV and V, with the Tactics and Tierkreis spin-offs'],
  ],
  entries: [
    [1995, 'Suikoden', 'main', { aka: ['Gensō Suikoden'] }],
    [1998, 'Suikoden II'],
    [2002, 'Suikoden III'],
    [2004, 'Suikoden IV'],
    [2005, 'Suikoden Tactics', 'spinoff'],
    [2006, 'Suikoden V'],
    [2008, 'Suikoden Tierkreis', 'spinoff'],
    [2025, 'Suikoden I & II HD Remaster: Gate Rune and Dunan Unification Wars', 'remaster', { of: ['Suikoden', 'Suikoden II'], era: 'Gate Rune and Dunan', aka: ['Suikoden I & II HD Remaster'] }],
  ],
  // IV is set 150 years before the first game, Tactics just after it, V six years before; III fifteen years after II
  story: ['Suikoden IV', 'Suikoden Tactics', 'Suikoden V', 'Suikoden', 'Suikoden II', 'Suikoden III'],
};
