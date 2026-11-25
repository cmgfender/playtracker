// Trine. The format is described in ../franchises.js.
export default {
  id: 'trine', name: 'Trine', aliases: ['Trine'], prefix: ['trine'],
  eras: [
    ['Trine', 'Side-on', 'Three heroes solving physics puzzles in 2.5D: the first two games'],
    ['Trine 3: The Artifacts of Power', 'Into 3D', 'The heroes move in full 3D'],
    ['Trine 4: The Nightmare Prince', 'Back to 2.5D', 'Side-on puzzles again from Trine 4'],
  ],
  entries: [
    [2009, 'Trine'],
    [2011, 'Trine 2'],
    [2013, 'Trine 2: Complete Story', 'rerelease', { of: 'Trine 2' }],
    [2014, 'Trine: Enchanted Edition', 'remaster', { of: 'Trine' }],
    [2015, 'Trine 3: The Artifacts of Power'],
    [2019, 'Trine 4: The Nightmare Prince'],
    [2019, 'Trine: Ultimate Collection', 'collection', { includes: ['Trine: Enchanted Edition', 'Trine 2: Complete Story', 'Trine 3: The Artifacts of Power', 'Trine 4: The Nightmare Prince'] }],
    [2023, 'Trine 5: A Clockwork Conspiracy'],
  ],
};
