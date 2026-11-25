// Yoshi. The format is described in ../franchises.js. Yoshi's Island (Super Mario World 2) is in
// super-mario.js.
export default {
  id: 'yoshi', name: 'Yoshi', aliases: ['Yoshi'],
  prefix: ["yoshi's story", "yoshi's island ds", "yoshi's new island", "yoshi's woolly world", "yoshi's crafted world", 'yoshi topsy-turvy', 'yoshi touch & go', 'yoshi and the mysterious book'],
  eras: [
    ['Yoshi', 'Puzzles and Safari', "Yoshi, Yoshi's Cookie and the light-gun Yoshi's Safari"],
    ["Yoshi's Story", 'Platformers', "Yoshi's Story, the tilt and touch games, and the Yoshi's Island sequels"],
    ["Yoshi's Woolly World", 'Good-Feel', "Good-Feel's worlds of yarn and craft, and the Mysterious Book"],
  ],
  entries: [
    [1991, 'Yoshi', 'main', { aka: ['Mario & Yoshi'] }],
    [1992, "Yoshi's Cookie"],
    [1993, "Yoshi's Safari"],
    [1997, "Yoshi's Story"],
    [2004, 'Yoshi Topsy-Turvy', 'main', { aka: ["Yoshi's Universal Gravitation"] }],
    [2005, 'Yoshi Touch & Go'],
    [2006, "Yoshi's Island DS"],
    [2014, "Yoshi's New Island"],
    [2015, "Yoshi's Woolly World"],
    [2017, "Poochy & Yoshi's Woolly World", 'rerelease', { of: "Yoshi's Woolly World" }],
    [2019, "Yoshi's Crafted World"],
    [2026, 'Yoshi and the Mysterious Book'],
  ],
};
