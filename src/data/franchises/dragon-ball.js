// Dragon Ball. The format is described in ../franchises.js.
// Only the games most people know and own: the Budokai and Budokai Tenkaichi/Sparking! line, Raging
// Blast, Xenoverse, FighterZ, Kakarot and their kin. Older and Japan-only games are left out.
export default {
  id: 'dragon-ball', name: 'Dragon Ball', aliases: ['Dragon Ball', 'Dragon Ball Z', 'Dragonball', 'Dragon Ball Super', 'Dragon Ball GT'],
  prefix: ['dragon ball', 'dragonball', 'super dragon ball'],
  eras: [
    ['Dragon Ball Z: The Legacy of Goku', 'Budokai and Tenkaichi', 'Budokai, Budokai Tenkaichi and the Legacy of Goku games, on PS2, GameCube, GBA and PSP'],
    ['Dragon Ball Z: Burst Limit', 'PS3 and Xbox 360', 'Burst Limit, Raging Blast, Ultimate Tenkaichi and Battle of Z'],
    ['Dragon Ball Xenoverse', 'Xenoverse and after', 'Xenoverse, FighterZ, Kakarot and Sparking! Zero'],
  ],
  entries: [
    [2002, 'Dragon Ball Z: The Legacy of Goku'],
    [2002, 'Dragon Ball Z: Budokai'],
    [2003, 'Dragon Ball Z: The Legacy of Goku II'],
    [2003, 'Dragon Ball Z: Budokai 2'],
    [2004, "Dragon Ball Z: Buu's Fury"],
    [2004, 'Dragon Ball Z: Budokai 3'],
    [2005, 'Dragon Ball Z: Budokai Tenkaichi', 'main', { aka: ['Dragon Ball Z: Sparking!'] }],
    [2006, 'Dragon Ball Z: Shin Budokai', 'spinoff'],
    [2006, 'Dragon Ball Z: Budokai Tenkaichi 2', 'main', { aka: ['Dragon Ball Z: Sparking! Neo'] }],
    [2007, 'Dragon Ball Z: Budokai Tenkaichi 3', 'main', { aka: ['Dragon Ball Z: Sparking! Meteor'] }],
    [2008, 'Dragon Ball Z: Burst Limit'],
    [2009, 'Dragon Ball: Raging Blast'],
    [2010, 'Dragon Ball: Raging Blast 2'],
    [2011, 'Dragon Ball Z: Ultimate Tenkaichi'],
    [2012, 'Dragon Ball Z: Budokai HD Collection', 'collection', { era: 'Budokai and Tenkaichi', includes: ['Dragon Ball Z: Budokai', 'Dragon Ball Z: Budokai 3'] }],
    [2014, 'Dragon Ball Z: Battle of Z'],
    [2015, 'Dragon Ball Xenoverse'],
    [2016, 'Dragon Ball Xenoverse 2'],
    [2018, 'Dragon Ball FighterZ'],
    [2019, 'Super Dragon Ball Heroes: World Mission', 'spinoff'],
    [2020, 'Dragon Ball Z: Kakarot'],
    [2022, 'Dragon Ball: The Breakers', 'spinoff'],
    [2024, 'Dragon Ball: Sparking! Zero'],
    [2025, 'Dragon Ball Gekishin Squadra', 'spinoff', { aka: ['Dragon Ball: Gekishin Squadra'] }],
  ],
};
