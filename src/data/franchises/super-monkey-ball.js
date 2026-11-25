// Super Monkey Ball. The format is described in ../franchises.js.
export default {
  id: 'super-monkey-ball', name: 'Super Monkey Ball', aliases: ['Super Monkey Ball', 'Monkey Ball'], prefix: ['super monkey ball', 'monkey ball'],
  eras: [
    ['Super Monkey Ball', 'GameCube and Game Boy Advance', 'The two arcade-born originals, Jr. and the Deluxe collection of both'],
    ['Super Monkey Ball: Touch & Roll', 'Handhelds and Wii', 'Touch, tilt and motion games on DS, Wii, 3DS and Vita, and Adventure'],
    ['Super Monkey Ball: Banana Blitz HD', 'Ryu Ga Gotoku Studio', 'Banana Blitz HD and Banana Mania remade the old games, then Banana Rumble'],
  ],
  entries: [
    [2001, 'Super Monkey Ball', 'main', { aka: ['Monkey Ball'] }],
    [2002, 'Super Monkey Ball 2'],
    [2002, 'Super Monkey Ball Jr.', 'spinoff'],
    [2005, 'Super Monkey Ball Deluxe', 'collection', { includes: ['Super Monkey Ball', 'Super Monkey Ball 2'] }],
    [2005, 'Super Monkey Ball: Touch & Roll', 'spinoff', { aka: ['Super Monkey Ball DS'] }],
    [2006, 'Super Monkey Ball Adventure', 'spinoff'],
    [2006, 'Super Monkey Ball: Banana Blitz'],
    [2010, 'Super Monkey Ball: Step & Roll'],
    [2011, 'Super Monkey Ball 3D'],
    [2012, 'Super Monkey Ball: Banana Splitz'],
    [2019, 'Super Monkey Ball: Banana Blitz HD', 'remaster', { of: 'Super Monkey Ball: Banana Blitz' }],
    [2021, 'Super Monkey Ball Banana Mania', 'remake', { of: ['Super Monkey Ball', 'Super Monkey Ball 2'] }],
    [2024, 'Super Monkey Ball Banana Rumble'],
  ],
};
