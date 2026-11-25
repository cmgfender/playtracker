// Portal. The format is described in ../franchises.js. The Orange Box is in half-life.js.
// "Portal" alone starts too many other titles to be a prefix: the entries match by their own titles.
export default {
  id: 'portal', name: 'Portal', aliases: ['Portal'], prefix: ['portal 2'],
  entries: [
    [2007, 'Portal'],
    [2008, 'Portal: Still Alive', 'rerelease', { of: 'Portal' }],
    [2011, 'Portal 2'],
    [2017, 'Bridge Constructor Portal', 'spinoff'],
    [2022, 'Aperture Desk Job', 'spinoff'],
    [2022, 'Portal: Companion Collection', 'collection', { includes: ['Portal', 'Portal 2'] }],
    [2022, 'Portal with RTX', 'remaster', { of: 'Portal' }],
  ],
};
