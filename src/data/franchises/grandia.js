// Grandia. The format is described in ../franchises.js.
export default {
  id: 'grandia', name: 'Grandia', aliases: ['Grandia'], prefix: ['grandia'],
  eras: [
    ['Grandia', 'The originals', 'Grandia, II, Xtreme and III, from the Saturn to the PS2'],
    ['Grandia II Anniversary Edition', 'Remasters', 'The first two remastered for PC and modern consoles'],
  ],
  entries: [
    [1997, 'Grandia'],
    [2000, 'Grandia II'],
    [2002, 'Grandia Xtreme', 'spinoff'],
    [2005, 'Grandia III'],
    [2015, 'Grandia II Anniversary Edition', 'remaster', { of: 'Grandia II' }],
    [2019, 'Grandia HD Collection', 'collection', { includes: ['Grandia', 'Grandia II'] }],
  ],
};
