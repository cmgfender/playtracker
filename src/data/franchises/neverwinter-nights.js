// Neverwinter Nights. The format is described in ../franchises.js.
export default {
  id: 'neverwinter-nights', name: 'Neverwinter Nights', aliases: ['Neverwinter Nights', 'Neverwinter'], prefix: ['neverwinter'],
  eras: [
    ['Neverwinter Nights', 'The originals', "BioWare's game and Obsidian's sequel"],
    ['Neverwinter', 'Online and enhanced', "Cryptic's MMO, and both games updated by Beamdog and Aspyr"],
  ],
  entries: [
    [2002, 'Neverwinter Nights'],
    [2005, 'Neverwinter Nights: Diamond Edition', 'rerelease', { of: 'Neverwinter Nights', aka: ['Neverwinter Nights Diamond'] }],
    [2006, 'Neverwinter Nights 2'],
    [2013, 'Neverwinter', 'spinoff'],
    [2018, 'Neverwinter Nights: Enhanced Edition', 'remaster', { of: 'Neverwinter Nights' }],
    [2025, 'Neverwinter Nights 2: Enhanced Edition', 'remaster', { of: 'Neverwinter Nights 2' }],
  ],
};
