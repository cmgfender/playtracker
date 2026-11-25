// Mario & Luigi. The format is described in ../franchises.js.
export default {
  id: 'mario-and-luigi', name: 'Mario & Luigi', aliases: ['Mario & Luigi', 'Mario and Luigi'], prefix: ['mario & luigi'],
  eras: [
    ['Mario & Luigi: Superstar Saga', 'AlphaDream', "AlphaDream's games on Game Boy Advance, DS and 3DS"],
    ['Mario & Luigi: Brothership', 'Acquire', 'A new studio, and the first game on Switch'],
  ],
  entries: [
    [2003, 'Mario & Luigi: Superstar Saga'],
    [2005, 'Mario & Luigi: Partners in Time'],
    [2009, "Mario & Luigi: Bowser's Inside Story"],
    [2013, 'Mario & Luigi: Dream Team', 'main', { aka: ['Mario & Luigi: Dream Team Bros.'] }],
    [2015, 'Mario & Luigi: Paper Jam', 'main', { aka: ['Mario & Luigi: Paper Jam Bros.'] }],
    [2017, "Mario & Luigi: Superstar Saga + Bowser's Minions", 'remake', { of: 'Mario & Luigi: Superstar Saga' }],
    [2018, "Mario & Luigi: Bowser's Inside Story + Bowser Jr.'s Journey", 'remake', { of: "Mario & Luigi: Bowser's Inside Story" }],
    [2024, 'Mario & Luigi: Brothership'],
  ],
};
