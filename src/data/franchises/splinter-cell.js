// Tom Clancy's Splinter Cell. The format is described in ../franchises.js.
export default {
  id: 'splinter-cell', name: "Tom Clancy's Splinter Cell", aliases: ["Tom Clancy's Splinter Cell", 'Splinter Cell'], prefix: ["tom clancy's splinter cell", 'splinter cell'],
  eras: [
    ["Tom Clancy's Splinter Cell", 'Third Echelon', 'Sam Fisher in the shadows for Third Echelon, from Splinter Cell to Double Agent'],
    ["Tom Clancy's Splinter Cell: Conviction", 'Conviction and Blacklist', 'Faster stealth action: Sam on his own, then leading Fourth Echelon'],
  ],
  entries: [
    [2002, "Tom Clancy's Splinter Cell", 'main', { aka: ['Splinter Cell'] }],
    [2004, "Tom Clancy's Splinter Cell: Pandora Tomorrow", 'main', { aka: ['Splinter Cell: Pandora Tomorrow'] }],
    [2005, "Tom Clancy's Splinter Cell: Chaos Theory", 'main', { aka: ['Splinter Cell: Chaos Theory'] }],
    [2006, "Tom Clancy's Splinter Cell: Essentials", 'spinoff', { aka: ['Splinter Cell: Essentials'] }],
    [2006, "Tom Clancy's Splinter Cell: Double Agent", 'main', { aka: ['Splinter Cell: Double Agent'] }],
    [2010, "Tom Clancy's Splinter Cell: Conviction", 'main', { aka: ['Splinter Cell: Conviction'] }],
    [2011, "Tom Clancy's Splinter Cell 3D", 'rerelease', { of: "Tom Clancy's Splinter Cell: Chaos Theory", era: 'Third Echelon', aka: ['Splinter Cell 3D'] }],
    [2011, "Tom Clancy's Splinter Cell Classic Trilogy HD", 'collection', { era: 'Third Echelon', includes: ["Tom Clancy's Splinter Cell", "Tom Clancy's Splinter Cell: Pandora Tomorrow", "Tom Clancy's Splinter Cell: Chaos Theory"], aka: ['Splinter Cell Classic Trilogy HD'] }],
    [2013, "Tom Clancy's Splinter Cell: Blacklist", 'main', { aka: ['Splinter Cell: Blacklist'] }],
  ],
};
