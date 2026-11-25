// Etrian Odyssey. The format is described in ../franchises.js.
export default {
  id: 'etrian-odyssey', name: 'Etrian Odyssey', aliases: ['Etrian Odyssey', 'Sekaiju no Meikyuu'], prefix: ['etrian odyssey', 'etrian mystery dungeon', 'sekaiju no meikyuu'],
  eras: [
    ['Etrian Odyssey', 'Nintendo DS', 'The first three, with maps drawn on the touch screen'],
    ['Etrian Odyssey IV: Legends of the Titan', 'Nintendo 3DS', 'IV, V and Nexus in 3D, and the Untold remakes of the first two'],
  ],
  entries: [
    [2007, 'Etrian Odyssey'],
    [2008, 'Etrian Odyssey II: Heroes of Lagaard'],
    [2010, 'Etrian Odyssey III: The Drowned City'],
    [2012, 'Etrian Odyssey IV: Legends of the Titan'],
    [2013, 'Etrian Odyssey Untold: The Millennium Girl', 'remake', { of: 'Etrian Odyssey' }],
    [2014, 'Etrian Odyssey 2 Untold: The Fafnir Knight', 'remake', { of: 'Etrian Odyssey II: Heroes of Lagaard' }],
    [2015, 'Etrian Mystery Dungeon', 'spinoff'],
    [2016, 'Etrian Odyssey V: Beyond the Myth'],
    [2018, 'Etrian Odyssey Nexus'],
    [2023, 'Etrian Odyssey Origins Collection', 'collection', { includes: ['Etrian Odyssey', 'Etrian Odyssey II: Heroes of Lagaard', 'Etrian Odyssey III: The Drowned City'], era: 'Nintendo DS' }],
  ],
};
