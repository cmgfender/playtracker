// Unreal and Unreal Tournament. The format is described in ../franchises.js.
export default {
  id: 'unreal', name: 'Unreal', aliases: ['Unreal', 'Unreal Tournament'], prefix: ['unreal tournament', 'unreal championship', 'unreal ii', 'unreal anthology'],
  eras: [
    ['Unreal', 'Unreal Engine 1', 'Unreal and the first Unreal Tournament'],
    ['Unreal Tournament 2003', 'Unreal Engine 2', 'UT2003, UT2004, Unreal II and the Xbox Championships'],
    ['Unreal Tournament 3', 'Unreal Engine 3', 'Unreal Tournament 3'],
  ],
  entries: [
    [1998, 'Unreal'],
    [1999, 'Unreal Tournament'],
    [2000, 'Unreal Gold', 'rerelease', { of: 'Unreal' }],
    [2002, 'Unreal Tournament 2003'],
    [2002, 'Unreal Championship', 'spinoff'],
    [2003, 'Unreal II: The Awakening'],
    [2004, 'Unreal Tournament 2004'],
    [2005, 'Unreal Championship 2: The Liandri Conflict', 'spinoff'],
    [2006, 'Unreal Anthology', 'collection', { includes: ['Unreal Gold', 'Unreal Tournament', 'Unreal II: The Awakening', 'Unreal Tournament 2004'] }],
    [2007, 'Unreal Tournament 3'],
  ],
};
