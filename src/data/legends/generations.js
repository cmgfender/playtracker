// Console generations, for Legends: a game belongs to the generation it came out in (by its release
// date; a game released only on another generation's consoles goes with them).
//   from       the day the generation's first major console launched; it runs until the next one's
//   consoles   its hardware, as IGDB names the platforms (to place a game by where it was released)
export const GENERATIONS = [
  { id: 'gen2', name: 'The Atari era', short: 'Atari 2600', from: '1976-11-01', note: 'Cartridges come home: the Atari 2600, Intellivision and ColecoVision',
    consoles: ['Atari 2600', 'Atari 5200', 'Intellivision', 'ColecoVision', 'Odyssey'] },
  { id: 'gen3', name: 'The 8-bit era', short: 'NES · Master System', from: '1983-07-15', note: 'The Famicom and NES rebuild the business after the crash',
    consoles: ['Nintendo Entertainment System', 'Family Computer', 'Family Computer Disk System', 'Sega Master System/Mark III', 'Atari 7800', 'Game Boy'] },
  { id: 'gen4', name: 'The 16-bit era', short: 'Super NES · Genesis', from: '1988-10-29', note: 'Super NES against Genesis, and the Game Boy in every pocket',
    consoles: ['Super Nintendo Entertainment System', 'Super Famicom', 'Sega Mega Drive/Genesis', 'Sega CD', 'Sega 32X', 'TurboGrafx-16/PC Engine', 'Neo Geo AES', 'Neo Geo MVS', 'Sega Game Gear', 'Game Boy Color'] },
  { id: 'gen5', name: 'The PlayStation and N64 era', short: 'PlayStation · N64 · Saturn', from: '1994-12-03', note: 'Games go 3D and move to discs',
    consoles: ['PlayStation', 'Nintendo 64', 'Sega Saturn', '3DO Interactive Multiplayer', 'Atari Jaguar', 'Virtual Boy'] },
  { id: 'gen6', name: 'The PS2, Xbox and GameCube era', short: 'PS2 · Xbox · GameCube · Dreamcast', from: '2000-03-04', note: 'The PlayStation 2 takes over the living room, the Xbox arrives, the Dreamcast bows out',
    consoles: ['PlayStation 2', 'Xbox', 'Nintendo GameCube', 'Dreamcast', 'Game Boy Advance'] },
  { id: 'gen7', name: 'The Xbox 360, PS3 and Wii era', short: 'Xbox 360 · PS3 · Wii', from: '2005-11-22', note: 'HD, achievements, online everything, and motion controls for everyone',
    consoles: ['Xbox 360', 'PlayStation 3', 'Wii', 'Nintendo DS', 'Nintendo DSi', 'PlayStation Portable'] },
  { id: 'gen8', name: 'The PS4, Xbox One and Switch era', short: 'PS4 · Xbox One · Switch', from: '2013-11-15', note: 'Share buttons, live services, and a console you can take with you',
    consoles: ['PlayStation 4', 'Xbox One', 'Nintendo Switch', 'Wii U', 'Nintendo 3DS', 'New Nintendo 3DS', 'PlayStation Vita'] },
  { id: 'gen9', name: 'The PS5 and Xbox Series era', short: 'PS5 · Xbox Series · Switch 2', from: '2020-11-10', note: 'Solid-state drives, 4K, and a library that follows you between machines',
    consoles: ['PlayStation 5', 'Xbox Series X|S', 'Nintendo Switch 2'] },
];
