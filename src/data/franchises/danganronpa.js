// Danganronpa. The format is described in ../franchises.js.
export default {
  id: 'danganronpa', name: 'Danganronpa', aliases: ['Danganronpa'], prefix: ['danganronpa'],
  eras: [
    ['Danganronpa: Trigger Happy Havoc', "Hope's Peak Academy", "Makoto, Hajime and Komaru, and the saga of Hope's Peak Academy"],
    ['Danganronpa V3: Killing Harmony', 'Killing Harmony and after', 'A new cast in V3, then the board-game spin-off S'],
  ],
  entries: [
    [2010, 'Danganronpa: Trigger Happy Havoc'],
    [2012, 'Danganronpa 2: Goodbye Despair'],
    [2013, 'Danganronpa 1・2 Reload', 'collection', { includes: ['Danganronpa: Trigger Happy Havoc', 'Danganronpa 2: Goodbye Despair'] }],
    [2014, 'Danganronpa Another Episode: Ultra Despair Girls', 'spinoff'],
    [2017, 'Danganronpa V3: Killing Harmony'],
    [2021, 'Danganronpa S: Ultimate Summer Camp', 'spinoff'],
    [2021, 'Danganronpa Decadence', 'collection', { includes: ['Danganronpa: Trigger Happy Havoc', 'Danganronpa 2: Goodbye Despair', 'Danganronpa V3: Killing Harmony', 'Danganronpa S: Ultimate Summer Camp'] }],
  ],
};
