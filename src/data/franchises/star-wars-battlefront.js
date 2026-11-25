// Star Wars Battlefront. The format is described in ../franchises.js.
export default {
  id: 'star-wars-battlefront', name: 'Star Wars Battlefront', aliases: ['Star Wars Battlefront', 'Star Wars: Battlefront'], prefix: ['star wars battlefront'],
  eras: [
    ['Star Wars: Battlefront', 'Pandemic', "Pandemic's Battlefronts, and Rebellion's handheld squadrons"],
    ['Star Wars Battlefront (2015)', 'DICE', "DICE's reboot and its sequel, and Aspyr's collection of the originals"],
  ],
  entries: [
    [2004, 'Star Wars: Battlefront'],
    [2005, 'Star Wars: Battlefront II'],
    [2007, 'Star Wars Battlefront: Renegade Squadron', 'spinoff'],
    [2009, 'Star Wars Battlefront: Elite Squadron', 'spinoff'],
    [2015, 'Star Wars Battlefront (2015)', 'main', { aka: ['Star Wars Battlefront'] }],
    [2017, 'Star Wars Battlefront II (2017)', 'main', { aka: ['Star Wars Battlefront II'] }],
    [2024, 'Star Wars: Battlefront Classic Collection', 'collection', { includes: ['Star Wars: Battlefront', 'Star Wars: Battlefront II'] }],
  ],
};
