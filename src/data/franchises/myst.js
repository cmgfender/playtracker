// Myst. The format is described in ../franchises.js.
export default {
  id: 'myst', name: 'Myst', aliases: ['Myst'], prefix: ['realmyst', 'myst iii', 'myst iv', 'myst v', 'myst online', 'uru: ages beyond myst'],
  eras: [
    ['Myst', 'Cyan', 'Myst and Riven, and the first versions of Myst made new'],
    ['Myst III: Exile', 'The later sequels', 'Exile and Revelation from other studios, Uru and End of Ages from Cyan'],
    ['realMyst: Masterpiece Edition', 'Remakes', 'Cyan remakes Myst and Riven for modern systems and VR'],
  ],
  entries: [
    [1993, 'Myst'],
    [1997, 'Riven', 'main', { aka: ['Riven: The Sequel to Myst'] }],
    [1999, 'Myst: Masterpiece Edition', 'remaster', { of: 'Myst' }],
    [2000, 'realMyst', 'remake', { of: 'Myst' }],
    [2001, 'Myst III: Exile'],
    [2003, 'Uru: Ages Beyond Myst', 'spinoff', { aka: ['Uru: Complete Chronicles'] }],
    [2004, 'Myst IV: Revelation'],
    [2005, 'Myst V: End of Ages'],
    [2007, 'Myst Online: Uru Live', 'spinoff'],
    [2014, 'realMyst: Masterpiece Edition', 'remaster', { of: 'realMyst' }],
    [2020, 'Myst (2020)', 'remake', { of: 'Myst', aka: ['Myst'] }],
    [2024, 'Riven (2024)', 'remake', { of: 'Riven', aka: ['Riven'] }],
  ],
};
