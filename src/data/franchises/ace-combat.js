// Ace Combat. The format is described in ../franchises.js.
export default {
  id: 'ace-combat', name: 'Ace Combat', aliases: ['Ace Combat'], prefix: ['ace combat'],
  eras: [
    ['Air Combat', 'PlayStation', 'Arcade-style dogfights and the first stories, on PlayStation'],
    ['Ace Combat 04: Shattered Skies', 'PlayStation 2', "04, 5 and Zero tell Strangereal's wars on PS2, with X on PSP"],
    ['Ace Combat 6: Fires of Liberation', 'HD consoles', 'From 6 on Xbox 360 to 7 and 8, with the Assault Horizon games and Infinity'],
  ],
  entries: [
    [1995, 'Air Combat', 'main', { aka: ['Ace Combat'] }],
    [1997, 'Ace Combat 2'],
    [1999, 'Ace Combat 3: Electrosphere'],
    [2001, 'Ace Combat 04: Shattered Skies', 'main', { aka: ['Ace Combat 4: Shattered Skies', 'Ace Combat: Distant Thunder'] }],
    [2004, 'Ace Combat 5: The Unsung War', 'main', { aka: ['Ace Combat: Squadron Leader'] }],
    [2006, 'Ace Combat Zero: The Belkan War', 'main', { aka: ['Ace Combat: The Belkan War'] }],
    [2006, 'Ace Combat X: Skies of Deception', 'spinoff'],
    [2007, 'Ace Combat 6: Fires of Liberation'],
    [2010, 'Ace Combat: Joint Assault', 'spinoff'],
    [2011, 'Ace Combat: Assault Horizon', 'spinoff'],
    [2011, 'Ace Combat: Assault Horizon Legacy', 'remake', { of: 'Ace Combat 2', era: 'PlayStation', aka: ['Ace Combat 3D: Cross Rumble', 'Ace Combat: Assault Horizon Legacy+'] }],
    [2014, 'Ace Combat Infinity', 'spinoff'],
    [2019, 'Ace Combat 7: Skies Unknown'],
    [2026, 'Ace Combat 8: Wings of Theve'],
  ],
};
