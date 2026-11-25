// RollerCoaster Tycoon. The format is described in ../franchises.js.
export default {
  id: 'rollercoaster-tycoon', name: 'RollerCoaster Tycoon', aliases: ['RollerCoaster Tycoon'], prefix: ['rollercoaster tycoon', 'roller coaster tycoon'],
  eras: [
    ['RollerCoaster Tycoon', "Chris Sawyer's games", 'Isometric parks hand-coded by Chris Sawyer, and their re-releases'],
    ['RollerCoaster Tycoon 3', 'Frontier', "Frontier's fully 3D parks, with rides you can ride"],
    ['RollerCoaster Tycoon 3D', 'Other studios', 'Handheld, PC and console games from other developers'],
  ],
  entries: [
    [1999, 'RollerCoaster Tycoon'],
    [2002, 'RollerCoaster Tycoon 2'],
    [2003, 'RollerCoaster Tycoon Deluxe', 'rerelease', { of: 'RollerCoaster Tycoon' }],
    [2004, 'RollerCoaster Tycoon 2: Triple Thrill Pack', 'rerelease', { of: 'RollerCoaster Tycoon 2' }],
    [2004, 'RollerCoaster Tycoon 3'],
    [2012, 'RollerCoaster Tycoon 3D', 'spinoff'],
    [2016, 'RollerCoaster Tycoon World'],
    [2016, 'RollerCoaster Tycoon Classic', 'remaster', { of: ['RollerCoaster Tycoon', 'RollerCoaster Tycoon 2'], era: "Chris Sawyer's games" }],
    [2018, 'RollerCoaster Tycoon Adventures', 'spinoff'],
    [2020, 'RollerCoaster Tycoon 3: Complete Edition', 'remaster', { of: 'RollerCoaster Tycoon 3', era: 'Frontier' }],
    [2023, 'RollerCoaster Tycoon Adventures Deluxe', 'rerelease', { of: 'RollerCoaster Tycoon Adventures' }],
  ],
};
