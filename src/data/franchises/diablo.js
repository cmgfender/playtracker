// Diablo. The format is described in ../franchises.js.
export default {
  id: 'diablo', name: 'Diablo', aliases: ['Diablo'], prefix: ['diablo'],
  eras: [
    ['Diablo', 'Blizzard North', 'The gothic originals'],
    ['Diablo III', 'Blizzard', 'Diablo III, Immortal, IV, and II resurrected'],
  ],
  entries: [
    [1996, 'Diablo'],
    [2000, 'Diablo II'],
    [2012, 'Diablo III'],
    [2014, 'Diablo III: Ultimate Evil Edition', 'rerelease', { of: 'Diablo III', aka: ['Diablo III: Reaper of Souls – Ultimate Evil Edition', 'Diablo III: Reaper of Souls'] }],
    [2017, 'Diablo III: Eternal Collection', 'rerelease', { of: 'Diablo III' }],
    [2021, 'Diablo II: Resurrected', 'remaster', { of: 'Diablo II' }],
    [2022, 'Diablo Immortal', 'spinoff'],
    [2023, 'Diablo IV'],
  ],
};
