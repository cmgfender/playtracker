// Jak and Daxter. The format is described in ../franchises.js.
export default {
  id: 'jak-and-daxter', name: 'Jak and Daxter', aliases: ['Jak and Daxter'], prefix: ['jak and daxter', 'jak ii', 'jak 3', 'jak x', 'daxter'],
  eras: [
    ['Jak and Daxter: The Precursor Legacy', 'Naughty Dog', "Naughty Dog's PS2 trilogy and Jak X"],
    ['Daxter', 'Other studios', "Ready at Dawn's Daxter and High Impact's The Lost Frontier"],
  ],
  entries: [
    [2001, 'Jak and Daxter: The Precursor Legacy'],
    [2003, 'Jak II', 'main', { aka: ['Jak II: Renegade'] }],
    [2004, 'Jak 3'],
    [2005, 'Jak X: Combat Racing', 'spinoff', { aka: ['Jak X'] }],
    [2006, 'Daxter', 'spinoff'],
    [2009, 'Jak and Daxter: The Lost Frontier'],
    [2012, 'Jak and Daxter Collection', 'collection', { aka: ['Jak and Daxter Trilogy'], includes: ['Jak and Daxter: The Precursor Legacy', 'Jak II', 'Jak 3'], era: 'Naughty Dog' }],
  ],
  // Daxter is set in the two years between The Precursor Legacy and Jak II
  story: ['Jak and Daxter: The Precursor Legacy', 'Daxter', 'Jak II', 'Jak 3', 'Jak X: Combat Racing', 'Jak and Daxter: The Lost Frontier'],
};
