// Commander Keen. The format is described in ../franchises.js.
export default {
  id: 'commander-keen', name: 'Commander Keen', aliases: ['Commander Keen'], prefix: ['commander keen'],
  entries: [
    [1990, 'Commander Keen in Invasion of the Vorticons'],
    [1991, 'Commander Keen in Keen Dreams', 'main', { aka: ['Keen Dreams'] }],
    [1991, 'Commander Keen in Goodbye, Galaxy!'],
    [1991, 'Commander Keen in Aliens Ate My Baby Sitter!'],
    [2001, 'Commander Keen', 'spinoff'],
    [2007, 'Commander Keen Complete Pack', 'collection', { includes: ['Commander Keen in Invasion of the Vorticons', 'Commander Keen in Goodbye, Galaxy!'] }],
  ],
};
