// Sniper Elite. The format is described in ../franchises.js.
export default {
  id: 'sniper-elite', name: 'Sniper Elite', aliases: ['Sniper Elite'], prefix: ['sniper elite'],
  eras: [
    ['Sniper Elite', 'Berlin 1945', 'The original and V2, both in Berlin, and the zombie spin-offs'],
    ['Sniper Elite III', 'Open levels', 'Larger, more open maps from Sniper Elite III on, and VR spin-offs'],
  ],
  entries: [
    [2005, 'Sniper Elite'],
    [2012, 'Sniper Elite V2'],
    [2013, 'Sniper Elite: Nazi Zombie Army', 'spinoff'],
    [2013, 'Sniper Elite: Nazi Zombie Army 2', 'spinoff'],
    [2014, 'Sniper Elite III'],
    [2017, 'Sniper Elite 4'],
    [2019, 'Sniper Elite V2 Remastered', 'remaster', { of: 'Sniper Elite V2', era: 'Berlin 1945' }],
    [2021, 'Sniper Elite VR', 'spinoff'],
    [2022, 'Sniper Elite 5'],
    [2023, 'Sniper Elite VR: Winter Warrior', 'spinoff'],
    [2025, 'Sniper Elite: Resistance', 'spinoff'],
  ],
};
