// Paper Mario. The format is described in ../franchises.js.
export default {
  id: 'paper-mario', name: 'Paper Mario', aliases: ['Paper Mario'], prefix: ['paper mario', 'super paper mario'],
  eras: [
    ['Paper Mario', 'The RPGs', "Partners, badges and levels, then Super Paper Mario's platforming"],
    ['Paper Mario: Sticker Star', 'Crafts', 'Battles fought with stickers, paint and origami, without levels'],
  ],
  entries: [
    [2000, 'Paper Mario'],
    [2004, 'Paper Mario: The Thousand-Year Door'],
    [2007, 'Super Paper Mario'],
    [2012, 'Paper Mario: Sticker Star'],
    [2016, 'Paper Mario: Color Splash'],
    [2020, 'Paper Mario: The Origami King'],
    [2024, 'Paper Mario: The Thousand-Year Door (2024)', 'remake', { of: 'Paper Mario: The Thousand-Year Door', era: 'The RPGs' }],
  ],
};
