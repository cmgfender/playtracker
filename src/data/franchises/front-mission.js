// Front Mission. The format is described in ../franchises.js.
export default {
  id: 'front-mission', name: 'Front Mission', aliases: ['Front Mission'], prefix: ['front mission', 'left alive'],
  eras: [
    ['Front Mission', 'Super Famicom and PlayStation', 'The tactics games from the first to Front Mission 3'],
    ['Front Mission 4', 'PS2 and after', 'Front Mission 4 and 5, and the action spin-offs Evolved and Left Alive'],
    ['Front Mission 1st: Remake', 'The remakes', 'The first three games remade for Switch and later other consoles'],
  ],
  entries: [
    [1995, 'Front Mission'],
    [1997, 'Front Mission 2'],
    [1999, 'Front Mission 3'],
    [2003, 'Front Mission 1st', 'remake', { of: 'Front Mission' }],
    [2003, 'Front Mission 4'],
    [2005, 'Front Mission 5: Scars of the War', 'main', { aka: ['Front Mission 5'] }],
    [2010, 'Front Mission Evolved', 'spinoff'],
    [2019, 'Left Alive', 'spinoff'],
    [2022, 'Front Mission 1st: Remake', 'remake', { of: 'Front Mission' }],
    [2023, 'Front Mission 2: Remake', 'remake', { of: 'Front Mission 2' }],
    [2025, 'Front Mission 3: Remake', 'remake', { of: 'Front Mission 3' }],
  ],
};
