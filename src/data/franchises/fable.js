// Fable. The format is described in ../franchises.js.
export default {
  id: 'fable', name: 'Fable', aliases: ['Fable'], prefix: ['fable'],
  eras: [
    ['Fable', 'Xbox', 'The first game and The Lost Chapters'],
    ['Fable II', 'Xbox 360', "Lionhead's sequels, spin-offs and the Anniversary remaster"],
  ],
  entries: [
    [2004, 'Fable'],
    [2005, 'Fable: The Lost Chapters', 'rerelease', { of: 'Fable' }],
    [2008, 'Fable II'],
    [2010, 'Fable III'],
    [2012, 'Fable Heroes', 'spinoff'],
    [2012, 'Fable: The Journey', 'spinoff'],
    [2014, 'Fable Anniversary', 'remaster', { of: 'Fable' }],
  ],
};
