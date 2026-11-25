// Monster Hunter. The format is described in ../franchises.js.
export default {
  id: 'monster-hunter', name: 'Monster Hunter', aliases: ['Monster Hunter'], prefix: ['monster hunter'],
  eras: [
    ['Monster Hunter', 'PlayStation 2 and PSP', 'The first hunts, and the PSP games that made it a phenomenon in Japan'],
    ['Monster Hunter Tri', 'The Nintendo years', 'Tri, 4 and Generations on Wii, Wii U, 3DS and Switch, and Stories'],
    ['Monster Hunter: World', 'Worldwide', 'World, Rise and Wilds take it around the world'],
  ],
  entries: [
    [2004, 'Monster Hunter'],
    [2005, 'Monster Hunter Freedom', 'rerelease', { of: 'Monster Hunter' }],
    [2006, 'Monster Hunter 2'],
    [2007, 'Monster Hunter Freedom 2', 'rerelease', { of: 'Monster Hunter 2' }],
    [2008, 'Monster Hunter Freedom Unite', 'rerelease', { of: 'Monster Hunter 2' }],
    [2009, 'Monster Hunter Tri', 'main', { aka: ['Monster Hunter 3'] }],
    [2011, 'Monster Hunter 3 Ultimate', 'rerelease', { of: 'Monster Hunter Tri' }],
    [2013, 'Monster Hunter 4'],
    [2014, 'Monster Hunter 4 Ultimate', 'rerelease', { of: 'Monster Hunter 4' }],
    [2015, 'Monster Hunter Generations'],
    [2016, 'Monster Hunter Stories', 'spinoff'],
    [2017, 'Monster Hunter Generations Ultimate', 'rerelease', { of: 'Monster Hunter Generations' }],
    [2018, 'Monster Hunter: World', 'main', { aka: ['Monster Hunter World: Iceborne'] }],
    [2021, 'Monster Hunter Rise'],
    [2021, 'Monster Hunter Stories 2: Wings of Ruin', 'spinoff'],
    [2023, 'Monster Hunter Now', 'spinoff'],
    [2025, 'Monster Hunter Wilds'],
    [2026, 'Monster Hunter Stories 3: Twisted Reflection', 'spinoff'],
  ],
};
