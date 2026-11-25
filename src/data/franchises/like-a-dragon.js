// Like a Dragon. The format is described in ../franchises.js.
export default {
  id: 'like-a-dragon', name: 'Like a Dragon', aliases: ['Like a Dragon', 'Yakuza', 'Yakuza: Like a Dragon'], prefix: ['yakuza', 'like a dragon'],
  eras: [
    ['Yakuza', 'The Kiryu saga', "Kazuma Kiryu's story, from the first game to 6, its prequel 0 and the Kiwami remakes"],
    ['Yakuza: Like a Dragon', 'The Ichiban era', "Ichiban Kasuga and turn-based battles, with Kiryu's last chapters"],
  ],
  entries: [
    [2005, 'Yakuza'],
    [2006, 'Yakuza 2'],
    [2009, 'Yakuza 3'],
    [2010, 'Yakuza 4'],
    [2011, 'Yakuza: Dead Souls', 'spinoff'],
    [2012, 'Yakuza 5'],
    [2015, 'Yakuza 0'],
    [2016, 'Yakuza Kiwami', 'remake', { of: 'Yakuza' }],
    [2016, 'Yakuza 6: The Song of Life'],
    [2017, 'Yakuza Kiwami 2', 'remake', { of: 'Yakuza 2' }],
    [2019, 'The Yakuza Remastered Collection', 'collection', { includes: ['Yakuza 3', 'Yakuza 4', 'Yakuza 5'] }],
    [2020, 'Yakuza: Like a Dragon'],
    [2023, 'Like a Dragon: Ishin!', 'spinoff'],
    [2023, 'Like a Dragon Gaiden: The Man Who Erased His Name', 'spinoff'],
    [2024, 'Like a Dragon: Infinite Wealth'],
    [2025, 'Like a Dragon: Pirate Yakuza in Hawaii', 'spinoff'],
    [2026, 'Yakuza Kiwami 3 & Dark Ties', 'remake', { of: 'Yakuza 3' }],
  ],
};
