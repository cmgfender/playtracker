// The Elder Scrolls. The format is described in ../franchises.js.
export default {
  id: 'elder-scrolls', name: 'The Elder Scrolls', aliases: ['The Elder Scrolls', 'Elder Scrolls'], prefix: ['elder scrolls'],
  eras: [
    ['The Elder Scrolls: Arena', 'The first games', 'Arena and Daggerfall: vast, generated worlds, and two spin-offs'],
    ['The Elder Scrolls III: Morrowind', 'Morrowind to Skyrim', 'Hand-made provinces: Vvardenfell, Cyrodiil and Skyrim'],
    ['The Elder Scrolls Online', 'Online and beyond', 'An MMO, card and mobile games, and Skyrim and Oblivion made new'],
  ],
  entries: [
    [1994, 'The Elder Scrolls: Arena'],
    [1996, 'The Elder Scrolls II: Daggerfall'],
    [1997, 'An Elder Scrolls Legend: Battlespire', 'spinoff', { aka: ['Battlespire'] }],
    [1998, 'The Elder Scrolls Adventures: Redguard', 'spinoff'],
    [2002, 'The Elder Scrolls III: Morrowind'],
    [2006, 'The Elder Scrolls IV: Oblivion'],
    [2011, 'The Elder Scrolls V: Skyrim'],
    [2014, 'The Elder Scrolls Online'],
    [2016, 'The Elder Scrolls V: Skyrim Special Edition', 'remaster', { of: 'The Elder Scrolls V: Skyrim' }],
    [2017, 'The Elder Scrolls: Legends', 'spinoff'],
    [2017, 'The Elder Scrolls V: Skyrim VR', 'rerelease', { of: 'The Elder Scrolls V: Skyrim' }],
    [2020, 'The Elder Scrolls: Blades', 'spinoff'],
    [2021, 'The Elder Scrolls V: Skyrim Anniversary Edition', 'rerelease', { of: 'The Elder Scrolls V: Skyrim' }],
    [2024, 'The Elder Scrolls: Castles', 'spinoff'],
    [2025, 'The Elder Scrolls IV: Oblivion Remastered', 'remaster', { of: 'The Elder Scrolls IV: Oblivion' }],
  ],
  // by era: Online (Second Era 582), Arena (3E 389), Daggerfall (3E 417), Morrowind (3E 427), Oblivion (3E 433), Skyrim (4E 201)
  story: ['The Elder Scrolls Online', 'The Elder Scrolls: Arena', 'The Elder Scrolls II: Daggerfall', 'The Elder Scrolls III: Morrowind', 'The Elder Scrolls IV: Oblivion', 'The Elder Scrolls V: Skyrim'],
};
