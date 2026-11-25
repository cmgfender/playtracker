// Xenoblade. The format is described in ../franchises.js.
export default {
  id: 'xenoblade', name: 'Xenoblade', aliases: ['Xenoblade', 'Xenoblade Chronicles'], prefix: ['xenoblade'],
  eras: [
    ['Xenoblade Chronicles', 'Bionis and Mira', 'The first game on Wii and X on Wii U, with their ports and remasters'],
    ['Xenoblade Chronicles 2', 'Alrest and Aionios', '2 and Torna on Switch, then 3, which joins the worlds of the first two'],
  ],
  entries: [
    [2010, 'Xenoblade Chronicles'],
    [2015, 'Xenoblade Chronicles 3D', 'rerelease', { of: 'Xenoblade Chronicles' }],
    [2015, 'Xenoblade Chronicles X'],
    [2017, 'Xenoblade Chronicles 2'],
    [2018, 'Xenoblade Chronicles 2: Torna – The Golden Country', 'main', { aka: ['Xenoblade Chronicles 2: Torna'] }],
    [2020, 'Xenoblade Chronicles: Definitive Edition', 'remaster', { of: 'Xenoblade Chronicles', era: 'Bionis and Mira' }],
    [2022, 'Xenoblade Chronicles 3'],
    [2025, 'Xenoblade Chronicles X: Definitive Edition', 'remaster', { of: 'Xenoblade Chronicles X', era: 'Bionis and Mira' }],
  ],
};
