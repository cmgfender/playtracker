// Hitman. The format is described in ../franchises.js.
export default {
  id: 'hitman', name: 'Hitman', aliases: ['Hitman'], prefix: ['hitman'],
  eras: [
    ['Hitman: Codename 47', 'The original series', "Agent 47's first contracts, through Blood Money"],
    ['Hitman: Sniper Challenge', 'Absolution', 'A story-driven detour'],
    ['Hitman (2016)', 'World of Assassination', 'Sandbox levels around the world, gathered into one game'],
  ],
  entries: [
    [2000, 'Hitman: Codename 47'],
    [2002, 'Hitman 2: Silent Assassin'],
    [2004, 'Hitman: Contracts'],
    [2006, 'Hitman: Blood Money'],
    [2012, 'Hitman: Sniper Challenge', 'spinoff'],
    [2012, 'Hitman: Absolution'],
    [2013, 'Hitman HD Trilogy', 'collection', { includes: ['Hitman 2: Silent Assassin', 'Hitman: Contracts', 'Hitman: Blood Money'] }],
    [2014, 'Hitman Go', 'spinoff'],
    [2015, 'Hitman: Sniper', 'spinoff'],
    [2016, 'Hitman (2016)', 'main', { aka: ['Hitman'] }],
    [2018, 'Hitman 2'],
    [2019, 'Hitman HD Enhanced Collection', 'collection', { includes: ['Hitman: Blood Money', 'Hitman: Absolution'] }],
    [2021, 'Hitman 3'],
    [2023, 'Hitman: World of Assassination', 'collection', { includes: ['Hitman (2016)', 'Hitman 2', 'Hitman 3'], aka: ['HITMAN World of Assassination'] }],
    [2023, 'Hitman: Blood Money – Reprisal', 'rerelease', { of: 'Hitman: Blood Money' }],
  ],
};
