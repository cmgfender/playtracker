// Genres and worlds, for Legends: "your role-playing career", "your horror years". A game belongs by
// how IGDB files it:
//   genres  IGDB genre names (what you do in it)
//   themes  IGDB theme names (the world it is set in, the mood it keeps)
// A genre shows up once three of its games are in a library. The broadest shelves (Adventure, Indie,
// Action) are left out: nearly every game is on them, and a legend that holds everything tells nothing.
export const GENRES = [
  { id: 'rpg', name: 'Role-playing games', tagline: 'A party, a levelling curve and a hundred hours of side quests', genres: ['Role-playing (RPG)'] },
  { id: 'shooters', name: 'Shooters', tagline: 'Down the sights, from corridors to open maps', genres: ['Shooter'] },
  { id: 'platformers', name: 'Platformers', tagline: 'Run, jump, miss, try again', genres: ['Platform'] },
  { id: 'strategy', name: 'Strategy', tagline: 'One more turn, one more base, one more hour', genres: ['Strategy', 'Real Time Strategy (RTS)', 'Turn-based strategy (TBS)', 'Tactical'], themes: ['4X (explore, expand, exploit, and exterminate)'] },
  { id: 'racing', name: 'Racing', tagline: 'Braking points, drifts and one more lap', genres: ['Racing'] },
  { id: 'sports', name: 'Sports', tagline: 'Seasons played from the sofa', genres: ['Sport'] },
  { id: 'fighting', name: 'Fighting games', tagline: 'Two health bars and a best of three', genres: ['Fighting'] },
  { id: 'brawlers', name: 'Hack, slash and brawl', tagline: 'Combos, crowds and a room that locks until everyone is down', genres: ['Hack and slash/Beat \'em up'] },
  { id: 'puzzle', name: 'Puzzle games', tagline: 'Stuck for an hour, then obvious', genres: ['Puzzle'] },
  { id: 'simulation', name: 'Simulators', tagline: 'Other people\'s jobs, done for fun', genres: ['Simulator'] },
  { id: 'point-and-click', name: 'Point-and-click', tagline: 'Use everything on everything', genres: ['Point-and-click'] },
  { id: 'visual-novels', name: 'Visual novels', tagline: 'Read, choose, read on', genres: ['Visual Novel'] },
  { id: 'music', name: 'Music and rhythm', tagline: 'On the beat, or near enough', genres: ['Music'] },
  { id: 'cards', name: 'Cards and boards', tagline: 'A hand, a table and the luck of the draw', genres: ['Card & Board Game'] },
  { id: 'arcade', name: 'Arcade', tagline: 'Short runs and a score to beat', genres: ['Arcade', 'Pinball'] },
  { id: 'moba', name: 'MOBAs', tagline: 'Three lanes and a team to blame', genres: ['MOBA'] },
  { id: 'horror', name: 'Horror', tagline: 'Played with the lights on, mostly', themes: ['Horror'] },
  { id: 'sci-fi', name: 'Science fiction', tagline: 'Ships, stations and the far future', themes: ['Science fiction'] },
  { id: 'fantasy', name: 'Fantasy', tagline: 'Swords, spells and a map with a dragon on it', themes: ['Fantasy'] },
  { id: 'stealth', name: 'Stealth', tagline: 'Unseen, or reloading the save', themes: ['Stealth'] },
  { id: 'open-world', name: 'Open worlds', tagline: 'A map, a horizon and no hurry', themes: ['Open world'] },
  { id: 'survival', name: 'Survival', tagline: 'Hungry, cold and one hit from losing it all', themes: ['Survival'] },
  { id: 'sandbox', name: 'Sandboxes', tagline: 'No goal but the one you set', themes: ['Sandbox'] },
  { id: 'war', name: 'War stories', tagline: 'Front lines, real and invented', themes: ['Warfare'] },
  { id: 'history', name: 'Historical', tagline: 'Other centuries, more or less as they were', themes: ['Historical'] },
  { id: 'mystery', name: 'Mysteries', tagline: 'A question at the start and an answer at the end', themes: ['Mystery'] },
  { id: 'comedy', name: 'Comedies', tagline: 'Games that were in on the joke', themes: ['Comedy'] },
  { id: 'party', name: 'Party games', tagline: 'Four controllers and a crowded sofa', themes: ['Party'], genres: ['Quiz/Trivia'] },
];
