// Soulcalibur. The format is described in ../franchises.js.
export default {
  id: 'soulcalibur', name: 'Soulcalibur', aliases: ['Soulcalibur', 'Soul Calibur', 'Soul series'], prefix: ['soulcalibur', 'soul calibur', 'soul edge'],
  eras: [
    ['Soul Edge', 'The arcade years', 'Soul Edge to Soulcalibur II, in the arcade first and then on consoles'],
    ['Soulcalibur III', 'Console era', 'III to V on PS2, PS3 and Xbox 360, with the Legends and Broken Destiny spin-offs'],
    ['Soulcalibur VI', 'Soulcalibur VI', 'Unreal Engine 4 retells the story from the first game'],
  ],
  entries: [
    [1995, 'Soul Edge', 'main', { aka: ['Soul Blade'] }],
    [1998, 'Soulcalibur'],
    [2002, 'Soulcalibur II'],
    [2005, 'Soulcalibur III'],
    [2007, 'Soulcalibur Legends', 'spinoff'],
    [2008, 'Soulcalibur IV'],
    [2009, 'Soulcalibur: Broken Destiny', 'spinoff'],
    [2012, 'Soulcalibur V'],
    [2013, 'Soulcalibur II HD Online', 'remaster', { of: 'Soulcalibur II', era: 'The arcade years' }],
    [2018, 'Soulcalibur VI'],
  ],
};
