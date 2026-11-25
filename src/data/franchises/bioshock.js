// BioShock. The format is described in ../franchises.js.
export default {
  id: 'bioshock', name: 'BioShock', aliases: ['BioShock', 'Bioshock'], prefix: ['bioshock'],
  entries: [
    [2007, 'BioShock'],
    [2010, 'BioShock 2'],
    [2013, 'BioShock Infinite'],
    [2016, 'BioShock: The Collection', 'collection', { includes: ['BioShock Remastered', 'BioShock 2 Remastered', 'BioShock Infinite'] }],
    [2016, 'BioShock Remastered', 'remaster', { of: 'BioShock' }],
    [2016, 'BioShock 2 Remastered', 'remaster', { of: 'BioShock 2' }],
  ],
};
