// Baldur's Gate. The format is described in ../franchises.js.
export default {
  id: 'baldurs-gate', name: "Baldur's Gate", aliases: ["Baldur's Gate"], prefix: ["baldur's gate"],
  eras: [
    ["Baldur's Gate", 'Interplay', "BioWare's Bhaalspawn saga and Snowblind's Dark Alliance games, for Interplay"],
    ["Baldur's Gate: Enhanced Edition", 'Beamdog', "Beamdog's Enhanced Editions of BioWare's games, and Siege of Dragonspear"],
    ["Baldur's Gate 3", 'Larian', "Larian's turn-based sequel, set over a century after the Bhaalspawn saga"],
  ],
  entries: [
    [1998, "Baldur's Gate"],
    [1999, "Baldur's Gate: Tales of the Sword Coast", 'spinoff'],
    [2000, "Baldur's Gate II: Shadows of Amn", 'main', { aka: ["Baldur's Gate II"] }],
    [2001, "Baldur's Gate II: Throne of Bhaal"],
    [2001, "Baldur's Gate: Dark Alliance", 'spinoff'],
    [2004, "Baldur's Gate: Dark Alliance II", 'spinoff'],
    [2012, "Baldur's Gate: Enhanced Edition", 'remaster', { of: ["Baldur's Gate", "Baldur's Gate: Tales of the Sword Coast"] }],
    [2013, "Baldur's Gate II: Enhanced Edition", 'remaster', { of: ["Baldur's Gate II: Shadows of Amn", "Baldur's Gate II: Throne of Bhaal"] }],
    [2016, "Baldur's Gate: Siege of Dragonspear"],
    [2019, "Baldur's Gate and Baldur's Gate II: Enhanced Editions", 'collection', { includes: ["Baldur's Gate: Enhanced Edition", "Baldur's Gate: Siege of Dragonspear", "Baldur's Gate II: Enhanced Edition"], aka: ["The Baldur's Gate: Enhanced Edition Pack"] }],
    [2021, "Baldur's Gate: Dark Alliance (2021)", 'rerelease', { of: "Baldur's Gate: Dark Alliance", era: 'Interplay' }],
    [2022, "Baldur's Gate: Dark Alliance II (2022)", 'rerelease', { of: "Baldur's Gate: Dark Alliance II", era: 'Interplay' }],
    [2023, "Baldur's Gate 3"],
  ],
  // Siege of Dragonspear is set between the first game and the second
  story: ["Baldur's Gate", "Baldur's Gate: Tales of the Sword Coast", "Baldur's Gate: Siege of Dragonspear", "Baldur's Gate II: Shadows of Amn", "Baldur's Gate II: Throne of Bhaal", "Baldur's Gate 3"],
};
