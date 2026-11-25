// Uncharted. The format is described in ../franchises.js.
export default {
  id: 'uncharted', name: 'Uncharted', aliases: ['Uncharted'], prefix: ['uncharted'],
  eras: [
    ["Uncharted: Drake's Fortune", 'The PlayStation 3 trilogy', "Nathan Drake's first three adventures, and Golden Abyss"],
    ["Uncharted: The Nathan Drake Collection", "A Thief's End", 'The trilogy remastered, the last Drake story, and Chloe and Nadine'],
  ],
  entries: [
    [2007, "Uncharted: Drake's Fortune"],
    [2009, 'Uncharted 2: Among Thieves'],
    [2011, "Uncharted 3: Drake's Deception"],
    [2011, 'Uncharted: Golden Abyss', 'spinoff'],
    [2015, 'Uncharted: The Nathan Drake Collection', 'collection', { includes: ["Uncharted: Drake's Fortune", 'Uncharted 2: Among Thieves', "Uncharted 3: Drake's Deception"] }],
    [2016, "Uncharted 4: A Thief's End"],
    [2017, 'Uncharted: The Lost Legacy', 'spinoff'],
    [2022, 'Uncharted: Legacy of Thieves Collection', 'collection', { includes: ["Uncharted 4: A Thief's End", 'Uncharted: The Lost Legacy'] }],
  ],
};
