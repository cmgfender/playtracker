// Mana (Seiken Densetsu). The format is described in ../franchises.js.
export default {
  id: 'mana', name: 'Mana', aliases: ['Mana', 'Seiken Densetsu', 'World of Mana'],
  prefix: ['seiken densetsu', 'final fantasy adventure', 'secret of mana', 'trials of mana', 'legend of mana', 'sword of mana', 'children of mana',
    'dawn of mana', 'heroes of mana', 'adventures of mana', 'collection of mana', 'visions of mana'],
  eras: [
    ['Final Fantasy Adventure', 'The 2D originals', 'Game Boy and Super Famicom action RPGs, Legend of Mana, and Sword of Mana'],
    ['Children of Mana', 'World of Mana', 'The 2006-2007 World of Mana line: Children, Dawn and Heroes of Mana'],
    ['Adventures of Mana', 'Remakes and Visions', 'The early games remade and collected, and Visions of Mana'],
  ],
  entries: [
    [1991, 'Final Fantasy Adventure', 'main', { aka: ['Seiken Densetsu: Final Fantasy Gaiden'] }],
    [1993, 'Secret of Mana', 'main', { aka: ['Seiken Densetsu 2'] }],
    [1995, 'Trials of Mana', 'main', { aka: ['Seiken Densetsu 3'] }],
    [1999, 'Legend of Mana', 'main', { aka: ['Seiken Densetsu: Legend of Mana'] }],
    [2003, 'Sword of Mana', 'remake', { of: 'Final Fantasy Adventure', aka: ['Shinyaku Seiken Densetsu'] }],
    [2006, 'Children of Mana', 'spinoff'],
    [2006, 'Dawn of Mana', 'main', { aka: ['Seiken Densetsu 4'] }],
    [2007, 'Heroes of Mana', 'spinoff'],
    [2016, 'Adventures of Mana', 'remake', { of: 'Final Fantasy Adventure' }],
    [2017, 'Collection of Mana', 'collection', { includes: ['Final Fantasy Adventure', 'Secret of Mana', 'Trials of Mana'], aka: ['Seiken Densetsu Collection'] }],
    [2018, 'Secret of Mana (2018)', 'remake', { of: 'Secret of Mana' }],
    [2020, 'Trials of Mana (2020)', 'remake', { of: 'Trials of Mana' }],
    [2021, 'Legend of Mana Remastered', 'remaster', { of: 'Legend of Mana' }],
    [2024, 'Visions of Mana'],
  ],
};
