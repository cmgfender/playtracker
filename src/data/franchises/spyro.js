// Spyro. The format is described in ../franchises.js. The Skylanders games are in skylanders.js.
export default {
  id: 'spyro', name: 'Spyro', aliases: ['Spyro', 'Spyro the Dragon', 'The Legend of Spyro'], prefix: ['spyro', 'legend of spyro'],
  eras: [
    ['Spyro the Dragon', 'The trilogy', "Insomniac's PlayStation trilogy, and its remake"],
    ['Spyro: Season of Ice', 'After Insomniac', 'Other studios, on GBA, DS, PS2, GameCube and Xbox'],
    ['The Legend of Spyro: A New Beginning', 'The Legend of Spyro', 'A reboot trilogy with a new story and a darker tone'],
  ],
  entries: [
    [1998, 'Spyro the Dragon'],
    [1999, "Spyro 2: Ripto's Rage!", 'main', { aka: ['Spyro 2: Gateway to Glimmer'] }],
    [2000, 'Spyro: Year of the Dragon'],
    [2001, 'Spyro: Season of Ice', 'spinoff'],
    [2002, 'Spyro 2: Season of Flame', 'spinoff'],
    [2002, 'Spyro: Enter the Dragonfly'],
    [2003, 'Spyro: Attack of the Rhynocs', 'spinoff', { aka: ['Spyro Adventure'] }],
    [2004, 'Spyro Orange: The Cortex Conspiracy', 'spinoff', { aka: ['Spyro Fusion'] }],
    [2004, "Spyro: A Hero's Tail"],
    [2005, 'Spyro: Shadow Legacy', 'spinoff'],
    [2006, 'The Legend of Spyro: A New Beginning'],
    [2007, 'The Legend of Spyro: The Eternal Night'],
    [2008, 'The Legend of Spyro: Dawn of the Dragon'],
    [2018, 'Spyro Reignited Trilogy', 'collection', { includes: ['Spyro the Dragon', "Spyro 2: Ripto's Rage!", 'Spyro: Year of the Dragon'], era: 'The trilogy' }],
  ],
};
