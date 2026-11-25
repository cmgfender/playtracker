// Hearts of Iron. The format is described in ../franchises.js.
export default {
  id: 'hearts-of-iron', name: 'Hearts of Iron', aliases: ['Hearts of Iron'], prefix: ['hearts of iron', 'arsenal of democracy: a hearts of iron game', 'darkest hour: a hearts of iron game'],
  eras: [
    ['Hearts of Iron', 'Europa engine', 'Hearts of Iron I and II, and the spin-offs built on II'],
    ['Hearts of Iron III', 'Clausewitz', '3D maps on the Clausewitz engine: III and IV'],
  ],
  entries: [
    [2002, 'Hearts of Iron'],
    [2005, 'Hearts of Iron II'],
    [2009, 'Hearts of Iron III'],
    [2010, 'Arsenal of Democracy: A Hearts of Iron Game', 'spinoff', { era: 'Europa engine' }],
    [2011, 'Darkest Hour: A Hearts of Iron Game', 'spinoff', { era: 'Europa engine' }],
    [2016, 'Hearts of Iron IV'],
  ],
};
