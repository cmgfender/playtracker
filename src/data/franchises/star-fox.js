// Star Fox. The format is described in ../franchises.js.
export default {
  id: 'star-fox', name: 'Star Fox', aliases: ['Star Fox', 'Starwing', 'Lylat Wars'], prefix: ['star fox', 'starwing', 'lylat wars'],
  eras: [
    ['Star Fox', 'Super NES and N64', 'Arwing rail shooters by Nintendo, from Star Fox to Star Fox 64'],
    ['Star Fox Adventures', 'Other studios', "Rare's Adventures, Namco's Assault and Q-Games' Command"],
    ['Star Fox 64 3D', 'Remakes and Zero', 'Star Fox 64 remade on 3DS and Switch 2, and Zero and Guard on Wii U'],
  ],
  entries: [
    [1993, 'Star Fox', 'main', { aka: ['Starwing'] }],
    [1997, 'Star Fox 64', 'main', { aka: ['Lylat Wars'] }],
    [2002, 'Star Fox Adventures'],
    [2005, 'Star Fox: Assault'],
    [2006, 'Star Fox Command'],
    [2011, 'Star Fox 64 3D', 'remake', { of: 'Star Fox 64' }],
    [2016, 'Star Fox Zero'],
    [2016, 'Star Fox Guard', 'spinoff'],
    [2017, 'Star Fox 2', 'main', { era: 'Super NES and N64' }],
    [2026, 'Star Fox (2026)', 'remake', { of: 'Star Fox 64' }],
  ],
};
