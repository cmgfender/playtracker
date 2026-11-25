// Animal Crossing. The format is described in ../franchises.js.
export default {
  id: 'animal-crossing', name: 'Animal Crossing', aliases: ['Animal Crossing', 'Dōbutsu no Mori'], prefix: ['animal crossing'],
  eras: [
    ['Animal Crossing', 'GameCube, DS and Wii', 'A village that runs on the real clock, then Wild World and City Folk'],
    ['Animal Crossing: New Leaf', '3DS and Wii U', 'The player becomes mayor in New Leaf; the amiibo spin-offs'],
    ['Animal Crossing: Pocket Camp', 'Phones and Switch', 'A campsite on phones, and a deserted island in New Horizons'],
  ],
  entries: [
    [2001, 'Animal Crossing'],
    [2005, 'Animal Crossing: Wild World'],
    [2008, 'Animal Crossing: City Folk', 'main', { aka: ["Animal Crossing: Let's Go to the City"] }],
    [2012, 'Animal Crossing: New Leaf'],
    [2015, 'Animal Crossing: Happy Home Designer', 'spinoff'],
    [2015, 'Animal Crossing: amiibo Festival', 'spinoff'],
    [2016, 'Animal Crossing: New Leaf – Welcome amiibo', 'rerelease', { of: 'Animal Crossing: New Leaf' }],
    [2017, 'Animal Crossing: Pocket Camp', 'spinoff'],
    [2020, 'Animal Crossing: New Horizons'],
    [2024, 'Animal Crossing: Pocket Camp Complete', 'rerelease', { of: 'Animal Crossing: Pocket Camp' }],
  ],
};
