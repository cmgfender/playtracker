// Gradius. The format is described in ../franchises.js.
export default {
  id: 'gradius', name: 'Gradius', aliases: ['Gradius'], prefix: ['gradius'],
  eras: [
    ['Gradius', 'The arcade games', 'The Vic Viper and its power-up bar, from Gradius to Gradius III and Salamander'],
    ['Gradius Gaiden', 'Later games', 'Gaiden on PlayStation, Gradius IV and V, Galaxies on Game Boy Advance and ReBirth'],
  ],
  entries: [
    [1985, 'Gradius', 'main', { aka: ['Nemesis'] }],
    [1986, 'Salamander', 'spinoff', { aka: ['Life Force'] }],
    [1988, 'Gradius II', 'main', { aka: ['Gradius II: Gofer no Yabou', 'Vulcan Venture'] }],
    [1989, 'Gradius III'],
    [1997, 'Gradius Gaiden', 'spinoff'],
    [1999, 'Gradius IV', 'main', { aka: ['Gradius IV: Fukkatsu'] }],
    [2000, 'Gradius III and IV', 'collection', { includes: ['Gradius III', 'Gradius IV'] }],
    [2001, 'Gradius Galaxies', 'main', { aka: ['Gradius Advance', 'Gradius Generation'] }],
    [2004, 'Gradius V'],
    [2006, 'Gradius Collection', 'collection', { includes: ['Gradius', 'Gradius II', 'Gradius III', 'Gradius IV', 'Gradius Gaiden'], aka: ['Gradius Portable'] }],
    [2008, 'Gradius ReBirth'],
    [2025, 'Gradius Origins', 'collection', { era: 'The arcade games', includes: ['Gradius', 'Salamander', 'Gradius II', 'Gradius III'] }],
  ],
};
