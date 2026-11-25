// Guilty Gear. The format is described in ../franchises.js.
export default {
  id: 'guilty-gear', name: 'Guilty Gear', aliases: ['Guilty Gear'], prefix: ['guilty gear'],
  eras: [
    ['Guilty Gear', 'Sprites', 'Hand-drawn 2D from the first game through XX and its versions, and the 3D Overture'],
    ['Guilty Gear Xrd: Sign', 'Xrd', 'Cel-shaded 3D made to look hand-drawn, in Unreal Engine 3'],
    ['Guilty Gear -Strive-', 'Strive', 'Rebuilt in Unreal Engine 4, with rollback netcode'],
  ],
  entries: [
    [1998, 'Guilty Gear'],
    [2000, 'Guilty Gear X'],
    [2002, 'Guilty Gear XX', 'main', { aka: ['Guilty Gear X2', 'Guilty Gear XX: The Midnight Carnival'] }],
    [2003, 'Guilty Gear XX #Reload', 'rerelease', { of: 'Guilty Gear XX', aka: ['Guilty Gear X2 #Reload'] }],
    [2003, 'Guilty Gear Isuka', 'spinoff'],
    [2005, 'Guilty Gear XX Slash', 'rerelease', { of: 'Guilty Gear XX' }],
    [2006, 'Guilty Gear Dust Strikers', 'spinoff'],
    [2006, 'Guilty Gear XX Accent Core', 'rerelease', { of: 'Guilty Gear XX', aka: ['Guilty Gear XX Λ Core'] }],
    [2007, 'Guilty Gear 2: Overture'],
    [2008, 'Guilty Gear XX Accent Core Plus', 'rerelease', { of: 'Guilty Gear XX', aka: ['Guilty Gear XX Λ Core Plus'] }],
    [2012, 'Guilty Gear XX Accent Core Plus R', 'rerelease', { of: 'Guilty Gear XX', aka: ['Guilty Gear XX Λ Core Plus R'] }],
    [2014, 'Guilty Gear Xrd: Sign'],
    [2015, 'Guilty Gear Xrd: Revelator'],
    [2017, 'Guilty Gear Xrd Rev 2', 'rerelease', { of: 'Guilty Gear Xrd: Revelator' }],
    [2021, 'Guilty Gear -Strive-'],
  ],
};
