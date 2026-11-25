// Plants vs. Zombies. The format is described in ../franchises.js.
export default {
  id: 'plants-vs-zombies', name: 'Plants vs. Zombies', aliases: ['Plants vs. Zombies', 'Plants vs Zombies'], prefix: ['plants vs. zombies'],
  eras: [
    ['Plants vs. Zombies', 'Tower defense', "PopCap's lawn defense: the original, its mobile sequel and the remaster"],
    ['Plants vs. Zombies: Garden Warfare', 'Shooters', 'Third-person team shooters, from Garden Warfare to Battle for Neighborville'],
  ],
  entries: [
    [2009, 'Plants vs. Zombies'],
    [2013, "Plants vs. Zombies 2: It's About Time", 'main', { aka: ['Plants vs. Zombies 2'] }],
    [2014, 'Plants vs. Zombies: Garden Warfare', 'spinoff'],
    [2016, 'Plants vs. Zombies: Garden Warfare 2', 'spinoff'],
    [2019, 'Plants vs. Zombies: Battle for Neighborville', 'spinoff'],
    [2025, 'Plants vs. Zombies: Replanted', 'remaster', { of: 'Plants vs. Zombies', era: 'Tower defense' }],
  ],
};
