// Halo. The format is described in ../franchises.js.
export default {
  id: 'halo', name: 'Halo', aliases: ['Halo'], prefix: ['halo'],
  eras: [
    ['Halo: Combat Evolved', 'Bungie', "Bungie's original trilogy, ODST and Reach, and Ensemble's Halo Wars"],
    ['Halo: Combat Evolved Anniversary', '343 Industries', 'The Reclaimer saga, the anniversary remasters, the collection and Infinite'],
    ['Halo: Campaign Evolved', 'Halo Studios', 'Unreal Engine 5, and a return to where it began'],
  ],
  entries: [
    [2001, 'Halo: Combat Evolved', 'main', { aka: ['Halo CE', 'Halo'] }],
    [2004, 'Halo 2'],
    [2007, 'Halo 3'],
    [2009, 'Halo Wars', 'spinoff'],
    [2009, 'Halo 3: ODST'],
    [2010, 'Halo: Reach'],
    [2011, 'Halo: Combat Evolved Anniversary', 'remaster', { of: 'Halo: Combat Evolved' }],
    [2012, 'Halo 4'],
    [2013, 'Halo: Spartan Assault', 'spinoff'],
    [2014, 'Halo 2: Anniversary', 'remaster', { of: 'Halo 2' }],
    [2014, 'Halo: The Master Chief Collection', 'collection', { includes: ['Halo: Combat Evolved Anniversary', 'Halo 2: Anniversary', 'Halo 3', 'Halo 3: ODST', 'Halo: Reach', 'Halo 4'] }],
    [2015, 'Halo: Spartan Strike', 'spinoff'],
    [2015, 'Halo 5: Guardians'],
    [2016, 'Halo Wars: Definitive Edition', 'remaster', { of: 'Halo Wars' }],
    [2017, 'Halo Wars 2', 'spinoff'],
    [2021, 'Halo Infinite'],
    [2026, 'Halo: Campaign Evolved', 'remake', { of: 'Halo: Combat Evolved' }],
  ],
  // by the year the story is set: Halo Wars (2531), Reach and Combat Evolved (2552), Halo 2 and ODST
  // (2552), Halo 3 (2552-53), Halo 4 (2557), Halo 5 (2558), Halo Wars 2 (2559), Infinite (2560)
  story: ['Halo Wars', 'Halo: Reach', 'Halo: Combat Evolved', 'Halo 2', 'Halo 3: ODST', 'Halo 3', 'Halo 4', 'Halo 5: Guardians', 'Halo Wars 2', 'Halo Infinite'],
};
