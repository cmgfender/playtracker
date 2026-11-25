// Contra. The format is described in ../franchises.js.
export default {
  id: 'contra', name: 'Contra', aliases: ['Contra', 'Probotector'], prefix: ['contra', 'super contra', 'neo contra'],
  eras: [
    ['Contra', 'Arcade and 16-bit', 'Bill and Lance run and gun in the arcade and on NES, Game Boy, Super NES and Genesis'],
    ['Contra: Legacy of War', '3D and the revival', "Appaloosa's 3D game, then Shattered Soldier, Neo Contra, Contra 4, ReBirth and Uprising"],
    ['Contra Anniversary Collection', 'Contra today', 'The Anniversary Collection, Rogue Corps and Operation Galuga'],
  ],
  entries: [
    [1987, 'Contra', 'main', { aka: ['Gryzor'] }],
    [1988, 'Super Contra', 'main', { aka: ['Super C'] }],
    [1991, 'Operation C'],
    [1992, 'Contra III: The Alien Wars', 'main', { aka: ['Contra Spirits', 'Super Probotector: Alien Rebels'] }],
    [1994, 'Contra: Hard Corps'],
    [1996, 'Contra: Legacy of War', 'spinoff'],
    [2002, 'Contra: Shattered Soldier'],
    [2004, 'Neo Contra'],
    [2007, 'Contra 4'],
    [2009, 'Contra ReBirth'],
    [2011, 'Hard Corps: Uprising', 'spinoff'],
    [2019, 'Contra Anniversary Collection', 'collection', { includes: ['Contra', 'Super Contra', 'Operation C', 'Contra III: The Alien Wars', 'Contra: Hard Corps'] }],
    [2019, 'Contra: Rogue Corps', 'spinoff'],
    [2024, 'Contra: Operation Galuga', 'remake', { of: 'Contra' }],
  ],
};
