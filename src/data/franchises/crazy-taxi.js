// Crazy Taxi. The format is described in ../franchises.js.
export default {
  id: 'crazy-taxi', name: 'Crazy Taxi', aliases: ['Crazy Taxi'], prefix: ['crazy taxi'],
  entries: [
    [1999, 'Crazy Taxi'],
    [2001, 'Crazy Taxi 2'],
    [2002, 'Crazy Taxi 3: High Roller'],
    [2003, 'Crazy Taxi: Catch a Ride', 'spinoff'],
    [2007, 'Crazy Taxi: Fare Wars', 'collection', { includes: ['Crazy Taxi', 'Crazy Taxi 2'] }],
  ],
};
