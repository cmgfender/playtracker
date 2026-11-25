// Fallout. The format is described in ../franchises.js.
export default {
  id: 'fallout', name: 'Fallout', aliases: ['Fallout'], prefix: ['fallout'],
  eras: [
    ['Fallout', 'Interplay and Black Isle', 'The isometric originals, and the first spin-offs'],
    ['Fallout 3', 'Bethesda', "Open worlds since Fallout 3: the Capital Wasteland, Obsidian's New Vegas, the Commonwealth and Appalachia"],
  ],
  entries: [
    [1997, 'Fallout'],
    [1998, 'Fallout 2'],
    [2001, 'Fallout Tactics: Brotherhood of Steel', 'spinoff'],
    [2004, 'Fallout: Brotherhood of Steel', 'spinoff'],
    [2008, 'Fallout 3'],
    [2010, 'Fallout: New Vegas'],
    [2015, 'Fallout Shelter', 'spinoff'],
    [2015, 'Fallout 4'],
    [2017, 'Fallout 4 VR', 'rerelease', { of: 'Fallout 4' }],
    [2018, 'Fallout 76'],
  ],
};
