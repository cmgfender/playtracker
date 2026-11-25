// Katamari. The format is described in ../franchises.js.
export default {
  id: 'katamari', name: 'Katamari', aliases: ['Katamari', 'Katamari Damacy'], prefix: ['katamari'],
  eras: [
    ['Katamari Damacy', 'PS2 and PSP', 'The Prince rolls up the world for the King of All Cosmos'],
    ['Beautiful Katamari', 'HD and Vita', 'Beautiful Katamari on Xbox 360, Katamari Forever on PS3 and Touch My Katamari on Vita'],
    ['Katamari Damacy Reroll', 'Reroll', 'The first two games remastered, then Once Upon a Katamari'],
  ],
  entries: [
    [2004, 'Katamari Damacy'],
    [2005, 'We Love Katamari'],
    [2005, 'Me & My Katamari'],
    [2007, 'Beautiful Katamari'],
    [2009, 'Katamari Forever', 'main', { aka: ['Katamari Damacy Tribute'] }],
    [2011, 'Touch My Katamari'],
    [2018, 'Katamari Damacy Reroll', 'remaster', { of: 'Katamari Damacy' }],
    [2023, 'We Love Katamari Reroll + Royal Reverie', 'remaster', { of: 'We Love Katamari' }],
    [2025, 'Once Upon a Katamari'],
  ],
};
