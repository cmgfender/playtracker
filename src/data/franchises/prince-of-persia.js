// Prince of Persia. The format is described in ../franchises.js.
export default {
  id: 'prince-of-persia', name: 'Prince of Persia', aliases: ['Prince of Persia'], prefix: ['prince of persia'],
  eras: [
    ['Prince of Persia (1989)', 'The originals', "Jordan Mechner's 2D games for Broderbund, then Prince of Persia 3D"],
    ['Prince of Persia: The Sands of Time', 'The Sands of Time', "Ubisoft Montreal's trilogy and The Forgotten Sands"],
    ['Prince of Persia (2008)', 'New directions', 'The cel-shaded 2008 reboot, The Lost Crown and The Rogue Prince of Persia'],
  ],
  entries: [
    [1989, 'Prince of Persia (1989)', 'main', { aka: ['Prince of Persia'] }],
    [1993, 'Prince of Persia 2: The Shadow and the Flame'],
    [1999, 'Prince of Persia 3D'],
    [2003, 'Prince of Persia: The Sands of Time'],
    [2004, 'Prince of Persia: Warrior Within'],
    [2005, 'Prince of Persia: The Two Thrones'],
    [2005, 'Prince of Persia: Revelations', 'rerelease', { of: 'Prince of Persia: Warrior Within' }],
    [2006, 'Prince of Persia Trilogy', 'collection', { includes: ['Prince of Persia: The Sands of Time', 'Prince of Persia: Warrior Within', 'Prince of Persia: The Two Thrones'] }],
    [2007, 'Prince of Persia: Rival Swords', 'rerelease', { of: 'Prince of Persia: The Two Thrones' }],
    [2007, 'Prince of Persia Classic', 'remake', { of: 'Prince of Persia (1989)', era: 'The originals' }],
    [2008, 'Prince of Persia (2008)', 'main', { aka: ['Prince of Persia'] }],
    [2010, 'Prince of Persia: The Forgotten Sands', 'main', { era: 'The Sands of Time' }],
    [2010, 'Prince of Persia Classic Trilogy HD', 'collection', { era: 'The Sands of Time', includes: ['Prince of Persia: The Sands of Time', 'Prince of Persia: Warrior Within', 'Prince of Persia: The Two Thrones'], aka: ['Prince of Persia Trilogy 3D', 'Prince of Persia Trilogy HD'] }],
    [2024, 'Prince of Persia: The Lost Crown'],
    [2025, 'The Rogue Prince of Persia', 'spinoff'],
  ],
  // The Sands of Time saga: The Forgotten Sands is set between The Sands of Time and Warrior Within
  story: ['Prince of Persia: The Sands of Time', 'Prince of Persia: The Forgotten Sands', 'Prince of Persia: Warrior Within', 'Prince of Persia: The Two Thrones'],
};
