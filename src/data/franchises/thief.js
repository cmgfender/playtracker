// Thief. The format is described in ../franchises.js.
export default {
  id: 'thief', name: 'Thief', aliases: ['Thief'], prefix: ['thief: the dark project', 'thief gold', 'thief ii', 'thief: deadly shadows', 'thief vr'],
  eras: [
    ['Thief: The Dark Project', 'The trilogy', "Garrett's original trilogy, from Looking Glass and then Ion Storm"],
    ['Thief (2014)', 'Later games', "Eidos-Montréal's reboot, then a VR return to the City"],
  ],
  entries: [
    [1998, 'Thief: The Dark Project'],
    [1999, 'Thief Gold', 'rerelease', { of: 'Thief: The Dark Project' }],
    [2000, 'Thief II: The Metal Age'],
    [2004, 'Thief: Deadly Shadows'],
    [2014, 'Thief (2014)', 'main', { aka: ['Thief'] }],
    [2025, 'Thief VR: Legacy of Shadow', 'spinoff'],
  ],
};
