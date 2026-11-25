// Excite: Excitebike, Excite Truck and Excitebots. The format is described in ../franchises.js.
export default {
  id: 'excite', name: 'Excite', aliases: ['Excite', 'Excitebike'], prefix: ['excitebike', 'excite truck', 'excitebots'],
  eras: [
    ['Excitebike', 'Excitebike', 'Motocross on NES, then Excitebike 64 by Left Field Productions'],
    ['Excite Truck', 'Monster Games', 'Motion-controlled racing on Wii by Monster Games'],
  ],
  entries: [
    [1984, 'Excitebike'],
    [2000, 'Excitebike 64'],
    [2006, 'Excite Truck'],
    [2009, 'Excitebots: Trick Racing'],
    [2009, 'Excitebike: World Rally'],
    [2011, '3D Classics: Excitebike', 'remaster', { of: 'Excitebike', era: 'Excitebike' }],
  ],
};
