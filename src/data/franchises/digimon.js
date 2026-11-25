// Digimon. The format is described in ../franchises.js.
// The main RPG line only: Digimon World, Digimon Story (with Cyber Sleuth), Survive and Time Stranger.
export default {
  id: 'digimon', name: 'Digimon', aliases: ['Digimon', 'Digimon World', 'Digimon Story'], prefix: ['digimon'],
  eras: [
    ['Digimon World', 'Digimon World', 'Raising and adventure RPGs on PlayStation, PS2 and GameCube'],
    ['Digimon World DS', 'Digimon Story on DS', 'Monster-collecting RPGs on DS, the first two sold in the West as Digimon World'],
    ['Digimon World Re:Digitize', 'The revival', 'Re:Digitize, Cyber Sleuth, Next Order, Survive and Time Stranger'],
  ],
  entries: [
    [1999, 'Digimon World'],
    [2000, 'Digimon World 2'],
    [2002, 'Digimon World 3'],
    [2005, 'Digimon World 4', 'main', { aka: ['Digimon World X'] }],
    [2006, 'Digimon World DS', 'main', { aka: ['Digimon Story'] }],
    [2007, 'Digimon World Dawn and Dusk', 'main', { aka: ['Digimon World Dawn', 'Digimon World Dusk', 'Digimon Story: Sunburst', 'Digimon Story: Moonlight'] }],
    [2010, 'Digimon Story: Lost Evolution'],
    [2011, 'Digimon Story: Super Xros Wars', 'main', { aka: ['Digimon Story: Super Xros Wars Red', 'Digimon Story: Super Xros Wars Blue'] }],
    [2012, 'Digimon World Re:Digitize'],
    [2013, 'Digimon World Re:Digitize Decode', 'rerelease', { of: 'Digimon World Re:Digitize' }],
    [2015, 'Digimon Story: Cyber Sleuth'],
    [2016, 'Digimon World: Next Order'],
    [2017, "Digimon Story: Cyber Sleuth – Hacker's Memory"],
    [2019, 'Digimon Story Cyber Sleuth: Complete Edition', 'collection', { includes: ['Digimon Story: Cyber Sleuth', "Digimon Story: Cyber Sleuth – Hacker's Memory"] }],
    [2022, 'Digimon Survive'],
    [2025, 'Digimon Story: Time Stranger'],
  ],
};
