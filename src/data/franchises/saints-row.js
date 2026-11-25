// Saints Row. The format is described in ../franchises.js.
export default {
  id: 'saints-row', name: 'Saints Row', aliases: ['Saints Row'], prefix: ['saints row'],
  eras: [
    ['Saints Row', 'Stilwater', 'Gang wars on the streets of Stilwater: the first two games'],
    ['Saints Row: The Third', 'Over the top', 'Steelport, a simulation and Hell: the series turns absurd'],
    ['Saints Row (2022)', 'Reboot', 'A new crew of Saints in Santo Ileso'],
  ],
  entries: [
    [2006, 'Saints Row'],
    [2008, 'Saints Row 2'],
    [2011, 'Saints Row: The Third'],
    [2012, 'Saints Row: The Third – The Full Package', 'rerelease', { of: 'Saints Row: The Third' }],
    [2013, 'Saints Row IV'],
    [2015, 'Saints Row IV: Re-Elected', 'rerelease', { of: 'Saints Row IV' }],
    [2015, 'Saints Row: Gat out of Hell', 'spinoff'],
    [2017, 'Agents of Mayhem', 'spinoff'],
    [2020, 'Saints Row: The Third Remastered', 'remaster', { of: 'Saints Row: The Third' }],
    [2022, 'Saints Row (2022)', 'main', { aka: ['Saints Row'] }],
  ],
};
