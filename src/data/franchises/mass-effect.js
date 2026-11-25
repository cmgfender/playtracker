// Mass Effect. The format is described in ../franchises.js.
export default {
  id: 'mass-effect', name: 'Mass Effect', aliases: ['Mass Effect'], prefix: ['mass effect'],
  eras: [
    ['Mass Effect', 'The Shepard trilogy', "Commander Shepard's fight against the Reapers"],
    ['Mass Effect: Andromeda', 'After Shepard', 'Andromeda, and the trilogy remastered'],
  ],
  entries: [
    [2007, 'Mass Effect'],
    [2010, 'Mass Effect 2'],
    [2012, 'Mass Effect 3'],
    [2012, 'Mass Effect Trilogy', 'collection', { includes: ['Mass Effect', 'Mass Effect 2', 'Mass Effect 3'] }],
    [2017, 'Mass Effect: Andromeda'],
    [2021, 'Mass Effect Legendary Edition', 'collection', { includes: ['Mass Effect', 'Mass Effect 2', 'Mass Effect 3'] }],
  ],
};
