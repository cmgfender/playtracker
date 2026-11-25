// Monster Rancher (Monster Farm in Japan). The format is described in ../franchises.js.
export default {
  id: 'monster-rancher', name: 'Monster Rancher', aliases: ['Monster Rancher', 'Monster Farm'], prefix: ['monster rancher', 'monster farm'],
  eras: [
    ['Monster Rancher', 'PlayStation', 'Monsters raised from music CDs: the first two on PlayStation'],
    ['Monster Rancher 3', 'PlayStation 2 and DS', '3, 4 and EVO on PS2, and the DS game'],
  ],
  entries: [
    [1997, 'Monster Rancher', 'main', { aka: ['Monster Farm'] }],
    [1999, 'Monster Rancher 2', 'main', { aka: ['Monster Farm 2'] }],
    [2001, 'Monster Rancher 3', 'main', { aka: ['Monster Farm 3'] }],
    [2003, 'Monster Rancher 4', 'main', { aka: ['Monster Farm 4'] }],
    [2005, 'Monster Rancher EVO'],
    [2008, 'Monster Rancher DS', 'spinoff'],
    [2021, 'Monster Rancher 1 & 2 DX', 'collection', { includes: ['Monster Rancher', 'Monster Rancher 2'], era: 'PlayStation' }],
  ],
};
