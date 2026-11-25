// Devil May Cry. The format is described in ../franchises.js.
export default {
  id: 'devil-may-cry', name: 'Devil May Cry', aliases: ['Devil May Cry'], prefix: ['devil may cry'],
  eras: [
    ['Devil May Cry', 'Dante on PlayStation 2', 'The original trilogy'],
    ['Devil May Cry 4', 'Nero', 'Nero joins in 4, the DmC reboot, and 5'],
  ],
  entries: [
    [2001, 'Devil May Cry'],
    [2003, 'Devil May Cry 2'],
    [2005, "Devil May Cry 3: Dante's Awakening"],
    [2006, "Devil May Cry 3: Dante's Awakening Special Edition", 'rerelease', { of: "Devil May Cry 3: Dante's Awakening" }],
    [2008, 'Devil May Cry 4'],
    [2012, 'Devil May Cry HD Collection', 'collection', { includes: ['Devil May Cry', 'Devil May Cry 2', "Devil May Cry 3: Dante's Awakening Special Edition"] }],
    [2013, 'DmC: Devil May Cry', 'spinoff'],
    [2015, 'DmC: Devil May Cry – Definitive Edition', 'remaster', { of: 'DmC: Devil May Cry' }],
    [2015, 'Devil May Cry 4: Special Edition', 'rerelease', { of: 'Devil May Cry 4' }],
    [2019, 'Devil May Cry 5'],
    [2020, 'Devil May Cry 5: Special Edition', 'rerelease', { of: 'Devil May Cry 5' }],
  ],
};
