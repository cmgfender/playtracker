// BlazBlue. The format is described in ../franchises.js.
export default {
  id: 'blazblue', name: 'BlazBlue', aliases: ['BlazBlue'], prefix: ['blazblue'],
  eras: [
    ['BlazBlue: Calamity Trigger', 'The Azure saga', 'Ragna the Bloodedge, from Calamity Trigger to Central Fiction'],
    ['BlazBlue: Cross Tag Battle', 'After the saga', 'A crossover fighter and the Entropy Effect roguelite'],
  ],
  entries: [
    [2008, 'BlazBlue: Calamity Trigger'],
    [2009, 'BlazBlue: Continuum Shift'],
    [2010, 'BlazBlue: Continuum Shift II', 'rerelease', { of: 'BlazBlue: Continuum Shift' }],
    [2011, 'BlazBlue: Continuum Shift Extend', 'rerelease', { of: 'BlazBlue: Continuum Shift' }],
    [2012, 'BlazBlue: Chrono Phantasma'],
    [2015, 'BlazBlue: Chrono Phantasma Extend', 'rerelease', { of: 'BlazBlue: Chrono Phantasma' }],
    [2015, 'BlazBlue: Central Fiction', 'main', { aka: ['BlazBlue: Centralfiction'] }],
    [2018, 'BlazBlue: Cross Tag Battle', 'spinoff'],
    [2024, 'BlazBlue Entropy Effect', 'spinoff'],
    [2026, 'BlazBlue Entropy Effect X', 'rerelease', { of: 'BlazBlue Entropy Effect' }],
  ],
};
