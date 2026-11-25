// Twisted Metal. The format is described in ../franchises.js.
export default {
  id: 'twisted-metal', name: 'Twisted Metal', aliases: ['Twisted Metal'], prefix: ['twisted metal'],
  eras: [
    ['Twisted Metal', 'SingleTrac', "SingleTrac's first two games on PlayStation"],
    ['Twisted Metal III', '989 Studios', "989 Studios' two PlayStation sequels"],
    ['Twisted Metal: Black', 'Incognito', 'Incognito, then Eat Sleep Play: from Black to the 2012 game'],
  ],
  entries: [
    [1995, 'Twisted Metal'],
    [1996, 'Twisted Metal 2', 'main', { aka: ['Twisted Metal: World Tour'] }],
    [1998, 'Twisted Metal III'],
    [1999, 'Twisted Metal 4'],
    [2001, 'Twisted Metal: Black'],
    [2001, 'Twisted Metal: Small Brawl', 'spinoff'],
    [2005, 'Twisted Metal: Head-On'],
    [2008, 'Twisted Metal: Head-On: Extra Twisted Edition', 'rerelease', { of: 'Twisted Metal: Head-On' }],
    [2012, 'Twisted Metal (2012)', 'main', { aka: ['Twisted Metal'] }],
  ],
};
