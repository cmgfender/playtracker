// Dead Island. The format is described in ../franchises.js.
export default {
  id: 'dead-island', name: 'Dead Island', aliases: ['Dead Island'], prefix: ['dead island', 'escape dead island'],
  eras: [
    ['Dead Island', 'Banoi and Palanai', "Techland's island games, their spin-offs and remasters"],
    ['Dead Island 2', 'Los Angeles', 'Los Angeles, made by Dambuster Studios'],
  ],
  entries: [
    [2011, 'Dead Island'],
    [2013, 'Dead Island: Riptide'],
    [2014, 'Escape Dead Island', 'spinoff'],
    [2016, 'Dead Island Definitive Edition', 'remaster', { of: 'Dead Island' }],
    [2016, 'Dead Island: Riptide Definitive Edition', 'remaster', { of: 'Dead Island: Riptide' }],
    [2016, 'Dead Island: Retro Revenge', 'spinoff'],
    [2016, 'Dead Island Definitive Collection', 'collection', { includes: ['Dead Island Definitive Edition', 'Dead Island: Riptide Definitive Edition', 'Dead Island: Retro Revenge'] }],
    [2023, 'Dead Island 2'],
  ],
};
