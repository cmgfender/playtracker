// Command & Conquer. The format is described in ../franchises.js. Its eras are its three lines, so
// a game is in its line's era whenever it came out; the collections sit with the first games.
export default {
  id: 'command-and-conquer', name: 'Command & Conquer', aliases: ['Command & Conquer', 'Command and Conquer', 'C&C'], prefix: ['command & conquer'],
  eras: [
    ['Command & Conquer', 'Tiberian', "GDI against Kane's Brotherhood of Nod over Tiberium, from Tiberian Dawn to Twilight"],
    ['Command & Conquer: Red Alert', 'Red Alert', 'Alternate history: the Allies against the Soviets, later Yuri and the Empire'],
    ['Command & Conquer: Generals', 'Generals', 'A near-future war between the USA, China and the GLA'],
  ],
  entries: [
    [1995, 'Command & Conquer', 'main', { aka: ['Command & Conquer: Tiberian Dawn', 'Command & Conquer and The Covert Operations'] }],
    [1996, 'Command & Conquer: Red Alert', 'main', { aka: ['Command & Conquer Red Alert, Counterstrike and The Aftermath'] }],
    [1997, 'Command & Conquer: Sole Survivor', 'spinoff', { era: 'Tiberian' }],
    [1999, 'Command & Conquer: Tiberian Sun', 'main', { era: 'Tiberian', aka: ['Command & Conquer: Tiberian Sun and Firestorm', 'Command & Conquer 2: Tiberian Sun'] }],
    [2000, 'Command & Conquer: Red Alert 2', 'main', { aka: ["Command & Conquer: Red Alert 2 and Yuri's Revenge"] }],
    [2002, 'Command & Conquer: Renegade', 'spinoff', { era: 'Tiberian' }],
    [2003, 'Command & Conquer: Generals'],
    [2006, 'Command & Conquer: The First Decade', 'collection', { era: 'Tiberian', includes: ['Command & Conquer', 'Command & Conquer: Red Alert', 'Command & Conquer: Tiberian Sun', 'Command & Conquer: Red Alert 2', 'Command & Conquer: Renegade', 'Command & Conquer: Generals'] }],
    [2007, 'Command & Conquer 3: Tiberium Wars', 'main', { era: 'Tiberian' }],
    [2008, 'Command & Conquer: Red Alert 3', 'main', { era: 'Red Alert' }],
    [2010, 'Command & Conquer 4: Tiberian Twilight', 'main', { era: 'Tiberian' }],
    [2012, 'Command & Conquer: The Ultimate Collection', 'collection', { era: 'Tiberian', includes: ['Command & Conquer', 'Command & Conquer: Red Alert', 'Command & Conquer: Tiberian Sun', 'Command & Conquer: Red Alert 2', 'Command & Conquer: Renegade', 'Command & Conquer: Generals', 'Command & Conquer 3: Tiberium Wars', 'Command & Conquer: Red Alert 3', 'Command & Conquer 4: Tiberian Twilight'] }],
    [2020, 'Command & Conquer Remastered Collection', 'collection', { era: 'Tiberian', includes: ['Command & Conquer', 'Command & Conquer: Red Alert'], aka: ['Command & Conquer Remastered'] }],
  ],
};
