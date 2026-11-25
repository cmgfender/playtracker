// Star Ocean. The format is described in ../franchises.js.
export default {
  id: 'star-ocean', name: 'Star Ocean', aliases: ['Star Ocean'], prefix: ['star ocean'],
  eras: [
    ['Star Ocean', 'The 2D originals', 'Star Ocean and The Second Story, on Super Famicom and PlayStation'],
    ['Star Ocean: Till the End of Time', 'The 3D games', 'Till the End of Time and The Last Hope, with PSP remakes of the first two'],
    ['Star Ocean: Integrity and Faithlessness', 'PS4 and after', 'Integrity and Faithlessness, The Divine Force, and newer remasters and remakes'],
  ],
  entries: [
    [1996, 'Star Ocean'],
    [1998, 'Star Ocean: The Second Story', 'main', { aka: ['Star Ocean 2'] }],
    [2003, 'Star Ocean: Till the End of Time', 'main', { aka: ['Star Ocean 3'] }],
    [2007, 'Star Ocean: First Departure', 'remake', { of: 'Star Ocean' }],
    [2008, 'Star Ocean: Second Evolution', 'remake', { of: 'Star Ocean: The Second Story' }],
    [2009, 'Star Ocean: The Last Hope', 'main', { aka: ['Star Ocean 4'] }],
    [2010, 'Star Ocean: The Last Hope International', 'rerelease', { of: 'Star Ocean: The Last Hope' }],
    [2016, 'Star Ocean: Integrity and Faithlessness', 'main', { aka: ['Star Ocean 5'] }],
    [2017, 'Star Ocean: The Last Hope 4K & Full HD Remaster', 'remaster', { of: 'Star Ocean: The Last Hope' }],
    [2019, 'Star Ocean: First Departure R', 'remaster', { of: 'Star Ocean: First Departure' }],
    [2022, 'Star Ocean: The Divine Force'],
    [2023, 'Star Ocean: The Second Story R', 'remake', { of: 'Star Ocean: The Second Story' }],
  ],
  // by stardate: The Last Hope is the prequel, Till the End of Time the last
  story: ['Star Ocean: The Last Hope', 'Star Ocean', 'Star Ocean: The Second Story', 'Star Ocean: Integrity and Faithlessness', 'Star Ocean: The Divine Force', 'Star Ocean: Till the End of Time'],
};
