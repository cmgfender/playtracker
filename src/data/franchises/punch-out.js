// Punch-Out!!. The format is described in ../franchises.js.
export default {
  id: 'punch-out', name: 'Punch-Out!!', aliases: ['Punch-Out!!'], prefix: ['punch out', 'super punch out', "mike tyson's punch out"],
  eras: [
    ['Punch-Out!!', 'Arcade', 'The two-screen arcade games of 1984'],
    ["Mike Tyson's Punch-Out!!", 'NES and Super NES', 'Boxing comes home on NES and Super NES'],
    ['Punch-Out!! (2009)', 'Wii', 'The Wii revival by Next Level Games'],
  ],
  entries: [
    [1984, 'Punch-Out!!'],
    [1984, 'Super Punch-Out!!'],
    [1987, "Mike Tyson's Punch-Out!!"],
    [1990, 'Punch-Out!! (1990)', 'rerelease', { of: "Mike Tyson's Punch-Out!!", aka: ['Punch-Out!! Featuring Mr. Dream'] }],
    [1994, 'Super Punch-Out!! (1994)'],
    [2009, 'Punch-Out!! (2009)'],
  ],
};
