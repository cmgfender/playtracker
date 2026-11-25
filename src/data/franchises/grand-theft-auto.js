// Grand Theft Auto. The format is described in ../franchises.js.
export default {
  id: 'grand-theft-auto', name: 'Grand Theft Auto', aliases: ['Grand Theft Auto', 'GTA'], prefix: ['grand theft auto'],
  eras: [
    ['Grand Theft Auto', 'The 2D universe', "DMA Design's top-down games"],
    ['Grand Theft Auto III', 'The 3D universe', 'Liberty City, Vice City and San Andreas in 3D, and the Stories prequels'],
    ['Grand Theft Auto IV', 'The HD universe', 'A new continuity: Liberty City again, Los Santos, Online and Leonida'],
  ],
  entries: [
    [1997, 'Grand Theft Auto'],
    [1999, 'Grand Theft Auto 2'],
    [2001, 'Grand Theft Auto III'],
    [2002, 'Grand Theft Auto: Vice City'],
    [2004, 'Grand Theft Auto: San Andreas'],
    [2004, 'Grand Theft Auto Advance', 'spinoff'],
    [2005, 'Grand Theft Auto: Liberty City Stories', 'spinoff'],
    [2006, 'Grand Theft Auto: Vice City Stories', 'spinoff'],
    [2008, 'Grand Theft Auto IV'],
    [2009, 'Grand Theft Auto: Chinatown Wars', 'spinoff'],
    [2009, 'Grand Theft Auto: Episodes from Liberty City', 'spinoff'],
    [2013, 'Grand Theft Auto V'],
    [2013, 'Grand Theft Auto Online', 'spinoff'],
    [2021, 'Grand Theft Auto: The Trilogy – The Definitive Edition', 'collection', { includes: ['Grand Theft Auto III', 'Grand Theft Auto: Vice City', 'Grand Theft Auto: San Andreas'], aka: ['Grand Theft Auto: The Trilogy'], era: 'The 3D universe' }],
    [2026, 'Grand Theft Auto VI'],
  ],
};
