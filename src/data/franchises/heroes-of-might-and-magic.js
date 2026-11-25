// Heroes of Might and Magic, called Might & Magic Heroes from VI. The format is described in
// ../franchises.js. Olden Era (2026) is in early access, so not in it yet.
export default {
  id: 'heroes-of-might-and-magic', name: 'Heroes of Might and Magic',
  aliases: ['Heroes of Might and Magic', 'Heroes of Might & Magic', 'Might & Magic Heroes'],
  prefix: ['heroes of might and magic', 'might and magic heroes', 'might and magic: clash of heroes'],
  eras: [
    ['Heroes of Might and Magic: A Strategic Quest', 'New World Computing', 'The New World Computing games, from the first to IV'],
    ['Heroes of Might and Magic V', 'Ashan', "Ubisoft's world of Ashan: V by Nival, then VI, VII and Clash of Heroes"],
  ],
  entries: [
    [1995, 'Heroes of Might and Magic: A Strategic Quest', 'main', { aka: ['Heroes of Might and Magic'] }],
    [1996, 'Heroes of Might and Magic II: The Succession Wars', 'main', { aka: ['Heroes of Might and Magic II'] }],
    [1999, 'Heroes of Might and Magic III: The Restoration of Erathia', 'main', { aka: ['Heroes of Might and Magic III'] }],
    [2002, 'Heroes of Might and Magic IV'],
    [2006, 'Heroes of Might and Magic V'],
    [2009, 'Might & Magic: Clash of Heroes', 'spinoff'],
    [2011, 'Might & Magic Heroes VI', 'main', { aka: ['Heroes of Might and Magic VI'] }],
    [2015, 'Heroes of Might & Magic III – HD Edition', 'remaster', { of: 'Heroes of Might and Magic III: The Restoration of Erathia', era: 'New World Computing' }],
    [2015, 'Might & Magic Heroes VII', 'main', { aka: ['Heroes of Might and Magic VII'] }],
    [2023, 'Might & Magic: Clash of Heroes – Definitive Edition', 'remaster', { of: 'Might & Magic: Clash of Heroes' }],
  ],
};
