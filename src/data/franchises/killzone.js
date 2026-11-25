// Killzone. The format is described in ../franchises.js.
export default {
  id: 'killzone', name: 'Killzone', aliases: ['Killzone'], prefix: ['killzone'],
  eras: [
    ['Killzone', 'The Helghan war', 'The Second Extrasolar War, from the invasion of Vekta to Helghan'],
    ['Killzone: Shadow Fall', 'Shadow Fall', 'Thirty years later, on a Vekta split by a wall, on PS4'],
  ],
  entries: [
    [2004, 'Killzone'],
    [2006, 'Killzone: Liberation', 'spinoff'],
    [2009, 'Killzone 2'],
    [2011, 'Killzone 3'],
    [2012, 'Killzone HD', 'remaster', { of: 'Killzone' }],
    [2012, 'Killzone Trilogy', 'collection', { includes: ['Killzone HD', 'Killzone 2', 'Killzone 3'] }],
    [2013, 'Killzone: Mercenary', 'spinoff'],
    [2013, 'Killzone: Shadow Fall'],
  ],
};
