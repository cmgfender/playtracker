// StarCraft. The format is described in ../franchises.js.
export default {
  id: 'starcraft', name: 'StarCraft', aliases: ['StarCraft', 'Starcraft'], prefix: ['starcraft'],
  eras: [
    ['StarCraft', 'The original', 'StarCraft and Brood War, the Nintendo 64 port, and the remasters'],
    ['StarCraft II: Wings of Liberty', 'StarCraft II', "A trilogy told by Raynor, then Kerrigan, then Artanis"],
  ],
  entries: [
    [1998, 'StarCraft'],
    [1998, 'StarCraft: Brood War'],
    [2000, 'StarCraft 64', 'rerelease', { of: ['StarCraft', 'StarCraft: Brood War'] }],
    [2010, 'StarCraft II: Wings of Liberty'],
    [2013, 'StarCraft II: Heart of the Swarm'],
    [2015, 'StarCraft II: Legacy of the Void'],
    [2017, 'StarCraft: Remastered', 'remaster', { of: ['StarCraft', 'StarCraft: Brood War'], era: 'The original' }],
    [2019, 'StarCraft: Cartooned', 'remaster', { of: 'StarCraft: Remastered', era: 'The original' }],
  ],
};
