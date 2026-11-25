// Metal Slug. The format is described in ../franchises.js.
export default {
  id: 'metal-slug', name: 'Metal Slug', aliases: ['Metal Slug'], prefix: ['metal slug'],
  eras: [
    ['Metal Slug', 'SNK', 'The Neo Geo originals by the former Nazca team at SNK, up to 3'],
    ['Metal Slug 4', 'After SNK', "4 onward by new teams after SNK's bankruptcy, the compilations, and Tactics"],
  ],
  entries: [
    [1996, 'Metal Slug', 'main', { aka: ['Metal Slug: Super Vehicle-001'] }],
    [1998, 'Metal Slug 2'],
    [1999, 'Metal Slug X', 'rerelease', { of: 'Metal Slug 2' }],
    [2000, 'Metal Slug 3'],
    [2002, 'Metal Slug 4'],
    [2003, 'Metal Slug 5'],
    [2006, 'Metal Slug 6'],
    [2006, 'Metal Slug Anthology', 'collection', { includes: ['Metal Slug', 'Metal Slug 2', 'Metal Slug X', 'Metal Slug 3', 'Metal Slug 4', 'Metal Slug 5', 'Metal Slug 6'] }],
    [2008, 'Metal Slug 7'],
    [2009, 'Metal Slug XX', 'rerelease', { of: 'Metal Slug 7' }],
    [2024, 'Metal Slug Tactics', 'spinoff'],
  ],
};
