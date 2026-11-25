// Borderlands. The format is described in ../franchises.js.
export default {
  id: 'borderlands', name: 'Borderlands', aliases: ['Borderlands'], prefix: ['borderlands'],
  entries: [
    [2009, 'Borderlands'],
    [2012, 'Borderlands 2'],
    [2014, 'Borderlands: The Pre-Sequel'],
    [2014, 'Tales from the Borderlands', 'spinoff'],
    [2015, 'Borderlands: The Handsome Collection', 'collection', { includes: ['Borderlands 2', 'Borderlands: The Pre-Sequel'] }],
    [2018, 'Borderlands 2 VR', 'rerelease', { of: 'Borderlands 2' }],
    [2019, 'Borderlands: Game of the Year Edition', 'remaster', { of: 'Borderlands' }],
    [2019, 'Borderlands 3'],
    [2020, 'Borderlands Legendary Collection', 'collection', { includes: ['Borderlands', 'Borderlands 2', 'Borderlands: The Pre-Sequel'] }],
    [2021, "Tiny Tina's Assault on Dragon Keep: A Wonderlands One-shot Adventure", 'spinoff'],
    [2022, "Tiny Tina's Wonderlands", 'spinoff'],
    [2022, 'New Tales from the Borderlands', 'spinoff'],
    [2025, 'Borderlands 4'],
  ],
};
