// Advance Wars, with the Famicom Wars games before it. The format is described in ../franchises.js.
export default {
  id: 'advance-wars', name: 'Advance Wars', aliases: ['Advance Wars', 'Nintendo Wars', 'Famicom Wars', 'Battalion Wars'],
  prefix: ['advance wars', 'famicom wars', 'super famicom wars', 'game boy wars', 'battalion wars'],
  eras: [
    ['Famicom Wars', 'Japan only', 'Intelligent Systems and Hudson games on Famicom, Super Famicom and Game Boy'],
    ['Advance Wars', 'Advance Wars', 'Worldwide on Game Boy Advance and DS, with the Battalion Wars spin-offs'],
  ],
  entries: [
    [1988, 'Famicom Wars'],
    [1991, 'Game Boy Wars'],
    [1998, 'Super Famicom Wars'],
    [1998, 'Game Boy Wars 2'],
    [2001, 'Game Boy Wars 3'],
    [2001, 'Advance Wars'],
    [2003, 'Advance Wars 2: Black Hole Rising'],
    [2005, 'Advance Wars: Dual Strike', 'main', { aka: ['Famicom Wars DS'] }],
    [2005, 'Battalion Wars', 'spinoff', { aka: ['Totsugeki!! Famicom Wars'] }],
    [2007, 'Battalion Wars 2', 'spinoff'],
    [2008, 'Advance Wars: Days of Ruin', 'main', { aka: ['Advance Wars: Dark Conflict'] }],
    [2023, 'Advance Wars 1+2: Re-Boot Camp', 'remake', { of: ['Advance Wars', 'Advance Wars 2: Black Hole Rising'] }],
  ],
};
