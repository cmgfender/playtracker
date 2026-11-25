// Tekken. The format is described in ../franchises.js.
export default {
  id: 'tekken', name: 'Tekken', aliases: ['Tekken'], prefix: ['tekken'],
  eras: [
    ['Tekken', 'The PlayStation years', "Namco's 3D fighters, from the arcade to PlayStation 3"],
    ['Tekken 7', 'Unreal Engine', 'The Mishima saga ends in 7, and 8 begins anew'],
  ],
  entries: [
    [1994, 'Tekken'],
    [1995, 'Tekken 2'],
    [1997, 'Tekken 3'],
    [1999, 'Tekken Tag Tournament', 'spinoff'],
    [2001, 'Tekken 4'],
    [2004, 'Tekken 5'],
    [2005, 'Tekken 5: Dark Resurrection', 'rerelease', { of: 'Tekken 5' }],
    [2007, 'Tekken 6'],
    [2011, 'Tekken Tag Tournament 2', 'spinoff'],
    [2015, 'Tekken 7'],
    [2024, 'Tekken 8'],
  ],
};
