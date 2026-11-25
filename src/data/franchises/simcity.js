// SimCity. The format is described in ../franchises.js.
export default {
  id: 'simcity', name: 'SimCity', aliases: ['SimCity', 'Sim City'], prefix: ['simcity', 'sim city'],
  eras: [
    ['SimCity (1989)', 'The Maxis classics', 'The numbered PC games, from SimCity to SimCity 4'],
    ['SimCity DS', 'Spin-offs', 'SimCity DS, Societies by Tilted Mill, and SimCity Creator'],
    ['SimCity (2013)', 'The 2013 reboot', 'Online play on the GlassBox engine'],
  ],
  entries: [
    [1989, 'SimCity (1989)', 'main', { aka: ['SimCity', 'SimCity Classic'] }],
    [1993, 'SimCity 2000'],
    [1999, 'SimCity 3000'],
    [2000, 'SimCity 3000 Unlimited', 'rerelease', { of: 'SimCity 3000', aka: ['SimCity 3000 World Edition', 'SimCity 3000 UK Edition'] }],
    [2003, 'SimCity 4'],
    [2007, 'SimCity DS', 'spinoff'],
    [2007, 'SimCity Societies', 'spinoff'],
    [2008, 'SimCity Creator', 'spinoff'],
    [2013, 'SimCity (2013)', 'main', { aka: ['SimCity'] }],
  ],
};
