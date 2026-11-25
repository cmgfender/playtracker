// Warcraft. The format is described in ../franchises.js.
export default {
  id: 'warcraft', name: 'Warcraft', aliases: ['Warcraft', 'World of Warcraft'], prefix: ['warcraft', 'world of warcraft', 'hearthstone'],
  eras: [
    ['Warcraft: Orcs & Humans', 'Real-time strategy', 'The real-time strategy games, their remakes, and Forsaken Kingdom'],
    ['World of Warcraft', 'The MMO era', 'World of Warcraft and the games around it: Hearthstone, Classic, Rumble and Forever'],
  ],
  entries: [
    [1994, 'Warcraft: Orcs & Humans'],
    [1995, 'Warcraft II: Tides of Darkness', 'main', { aka: ['Warcraft II'] }],
    [1996, 'Warcraft II: Beyond the Dark Portal'],
    [1997, 'Warcraft II: The Dark Saga', 'rerelease', { of: ['Warcraft II: Tides of Darkness', 'Warcraft II: Beyond the Dark Portal'] }],
    [1999, 'Warcraft II: Battle.net Edition', 'rerelease', { of: ['Warcraft II: Tides of Darkness', 'Warcraft II: Beyond the Dark Portal'] }],
    [2002, 'Warcraft III: Reign of Chaos', 'main', { aka: ['Warcraft III'] }],
    [2003, 'Warcraft III: The Frozen Throne'],
    [2004, 'World of Warcraft'],
    [2014, 'Hearthstone', 'spinoff', { aka: ['Hearthstone: Heroes of Warcraft'] }],
    [2019, 'World of Warcraft Classic', 'rerelease', { of: 'World of Warcraft', aka: ['WoW Classic'] }],
    [2020, 'Warcraft III: Reforged', 'remake', { of: ['Warcraft III: Reign of Chaos', 'Warcraft III: The Frozen Throne'], era: 'Real-time strategy' }],
    [2023, 'Warcraft Rumble', 'spinoff', { aka: ['Warcraft Arclight Rumble'] }],
    [2024, 'Warcraft: Remastered', 'remaster', { of: 'Warcraft: Orcs & Humans', aka: ['Warcraft I: Remastered'], era: 'Real-time strategy' }],
    [2024, 'Warcraft II: Remastered', 'remaster', { of: ['Warcraft II: Tides of Darkness', 'Warcraft II: Beyond the Dark Portal'], era: 'Real-time strategy' }],
    [2024, 'Warcraft: Remastered Battle Chest', 'collection', { includes: ['Warcraft: Remastered', 'Warcraft II: Remastered', 'Warcraft III: Reforged'], aka: ['Warcraft Battle Chest'], era: 'Real-time strategy' }],
    [2026, 'Warcraft III Reforged: Forsaken Kingdom', 'main', { era: 'Real-time strategy' }],
    [2026, 'World of Warcraft: Forever', 'spinoff'],
  ],
  // Forsaken Kingdom tells the years between Warcraft III and World of Warcraft
  story: ['Warcraft: Orcs & Humans', 'Warcraft II: Tides of Darkness', 'Warcraft II: Beyond the Dark Portal', 'Warcraft III: Reign of Chaos', 'Warcraft III: The Frozen Throne', 'Warcraft III Reforged: Forsaken Kingdom', 'World of Warcraft'],
};
