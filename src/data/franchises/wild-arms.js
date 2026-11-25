// Wild Arms. The format is described in ../franchises.js.
export default {
  id: 'wild-arms', name: 'Wild Arms', aliases: ['Wild Arms', 'Wild ARMs'], prefix: ['wild arms'],
  eras: [
    ['Wild Arms', 'PlayStation', 'The first two on the original PlayStation'],
    ['Wild Arms 3', 'PlayStation 2', '3, 4, 5 and the remake Alter Code: F on PS2, and XF on PSP'],
  ],
  entries: [
    [1996, 'Wild Arms'],
    [1999, 'Wild Arms 2', 'main', { aka: ['Wild Arms 2nd Ignition'] }],
    [2002, 'Wild Arms 3', 'main', { aka: ['Wild Arms Advanced 3rd'] }],
    [2003, 'Wild Arms Alter Code: F', 'remake', { of: 'Wild Arms' }],
    [2005, 'Wild Arms 4', 'main', { aka: ['Wild Arms: The 4th Detonator'] }],
    [2006, 'Wild Arms 5', 'main', { aka: ['Wild Arms: The Vth Vanguard'] }],
    [2007, 'Wild Arms XF', 'spinoff'],
  ],
};
