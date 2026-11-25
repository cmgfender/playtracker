// Ace Attorney. The format is described in ../franchises.js.
export default {
  id: 'ace-attorney', name: 'Ace Attorney', aliases: ['Ace Attorney', 'Gyakuten Saiban', 'Phoenix Wright'],
  prefix: ['ace attorney', 'phoenix wright', 'apollo justice', 'the great ace attorney', 'gyakuten saiban', 'professor layton vs. phoenix wright'],
  eras: [
    ['Phoenix Wright: Ace Attorney', 'The Phoenix Wright trilogy', "Phoenix's first three games, made for Game Boy Advance and brought West on DS"],
    ['Apollo Justice: Ace Attorney', 'Apollo and the Investigations', 'Apollo Justice, the Miles Edgeworth spin-offs and the Professor Layton crossover'],
    ['Phoenix Wright: Ace Attorney – Dual Destinies', 'The 3DS games', 'Dual Destinies, Spirit of Justice and the Great Ace Attorney games, in 3D'],
    ['Phoenix Wright: Ace Attorney Trilogy (2019)', 'The collections', 'The series collected in HD for modern consoles and PC'],
  ],
  entries: [
    [2001, 'Phoenix Wright: Ace Attorney', 'main', { aka: ['Gyakuten Saiban', 'Ace Attorney'] }],
    [2002, 'Phoenix Wright: Ace Attorney – Justice for All', 'main', { aka: ['Gyakuten Saiban 2'] }],
    [2004, 'Phoenix Wright: Ace Attorney – Trials and Tribulations', 'main', { aka: ['Gyakuten Saiban 3'] }],
    [2007, 'Apollo Justice: Ace Attorney', 'main', { aka: ['Gyakuten Saiban 4'] }],
    [2009, 'Ace Attorney Investigations: Miles Edgeworth', 'spinoff', { aka: ['Gyakuten Kenji'] }],
    [2011, "Ace Attorney Investigations 2: Prosecutor's Gambit", 'spinoff', { aka: ['Gyakuten Kenji 2'] }],
    [2012, 'Professor Layton vs. Phoenix Wright: Ace Attorney', 'spinoff'],
    [2013, 'Phoenix Wright: Ace Attorney – Dual Destinies', 'main', { aka: ['Gyakuten Saiban 5'] }],
    [2014, 'Phoenix Wright: Ace Attorney Trilogy', 'collection', { includes: ['Phoenix Wright: Ace Attorney', 'Phoenix Wright: Ace Attorney – Justice for All', 'Phoenix Wright: Ace Attorney – Trials and Tribulations'] }],
    [2015, 'The Great Ace Attorney: Adventures', 'spinoff', { aka: ['Dai Gyakuten Saiban'] }],
    [2016, 'Phoenix Wright: Ace Attorney – Spirit of Justice', 'main', { aka: ['Gyakuten Saiban 6'] }],
    [2017, 'The Great Ace Attorney 2: Resolve', 'spinoff', { aka: ['Dai Gyakuten Saiban 2'] }],
    [2019, 'Phoenix Wright: Ace Attorney Trilogy (2019)', 'collection', { includes: ['Phoenix Wright: Ace Attorney', 'Phoenix Wright: Ace Attorney – Justice for All', 'Phoenix Wright: Ace Attorney – Trials and Tribulations'] }],
    [2021, 'The Great Ace Attorney Chronicles', 'collection', { includes: ['The Great Ace Attorney: Adventures', 'The Great Ace Attorney 2: Resolve'] }],
    [2024, 'Apollo Justice: Ace Attorney Trilogy', 'collection', { includes: ['Apollo Justice: Ace Attorney', 'Phoenix Wright: Ace Attorney – Dual Destinies', 'Phoenix Wright: Ace Attorney – Spirit of Justice'] }],
    [2024, 'Ace Attorney Investigations Collection', 'collection', { includes: ['Ace Attorney Investigations: Miles Edgeworth', "Ace Attorney Investigations 2: Prosecutor's Gambit"] }],
  ],
  // the Great Ace Attorney games are set around 1900; the Investigations games come between Trials and Tribulations and Apollo Justice
  story: ['The Great Ace Attorney: Adventures', 'The Great Ace Attorney 2: Resolve', 'Phoenix Wright: Ace Attorney', 'Phoenix Wright: Ace Attorney – Justice for All',
    'Phoenix Wright: Ace Attorney – Trials and Tribulations', 'Ace Attorney Investigations: Miles Edgeworth', "Ace Attorney Investigations 2: Prosecutor's Gambit",
    'Apollo Justice: Ace Attorney', 'Phoenix Wright: Ace Attorney – Dual Destinies', 'Phoenix Wright: Ace Attorney – Spirit of Justice'],
};
