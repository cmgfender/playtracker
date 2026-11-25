// Infamous. The format is described in ../franchises.js.
export default {
  id: 'infamous', name: 'Infamous', aliases: ['Infamous'], prefix: ['infamous'],
  eras: [
    ['Infamous', 'Cole MacGrath', "Cole's story in Empire City and New Marais, on PS3"],
    ['Infamous Second Son', 'Seattle', 'Delsin Rowe and Fetch in Seattle, on PS4'],
  ],
  entries: [
    [2009, 'Infamous'],
    [2011, 'Infamous 2'],
    [2011, 'Infamous: Festival of Blood', 'spinoff'],
    [2012, 'Infamous Collection', 'collection', { includes: ['Infamous', 'Infamous 2', 'Infamous: Festival of Blood'] }],
    [2014, 'Infamous Second Son'],
    [2014, 'Infamous First Light', 'spinoff'],
  ],
};
