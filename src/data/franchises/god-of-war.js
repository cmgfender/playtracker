// God of War. The format is described in ../franchises.js.
export default {
  id: 'god-of-war', name: 'God of War', aliases: ['God of War'], prefix: ['god of war'],
  eras: [
    ['God of War (2005)', 'The Greek saga', "Kratos's revenge on the gods of Olympus"],
    ['God of War (2018)', 'The Norse saga', 'Kratos and Atreus in Midgard and the Nine Realms'],
  ],
  entries: [
    [2005, 'God of War (2005)', 'main', { aka: ['God of War'] }],
    [2007, 'God of War II'],
    [2007, 'God of War: Betrayal', 'spinoff'],
    [2008, 'God of War: Chains of Olympus', 'spinoff'],
    [2009, 'God of War Collection', 'collection', { includes: ['God of War (2005)', 'God of War II'] }],
    [2010, 'God of War III'],
    [2010, 'God of War: Ghost of Sparta', 'spinoff'],
    [2011, 'God of War: Origins Collection', 'collection', { includes: ['God of War: Chains of Olympus', 'God of War: Ghost of Sparta'] }],
    [2012, 'God of War Saga', 'collection', { includes: ['God of War (2005)', 'God of War II', 'God of War: Chains of Olympus', 'God of War III', 'God of War: Ghost of Sparta'] }],
    [2013, 'God of War: Ascension'],
    [2015, 'God of War III Remastered', 'remaster', { of: 'God of War III' }],
    [2018, 'God of War (2018)', 'main', { aka: ['God of War'] }],
    [2022, 'God of War Ragnarök'],
    [2026, 'God of War Sons of Sparta', 'spinoff'],
  ],
  // Sons of Sparta (Kratos as a boy), Ascension (six months after Kratos's pact with Ares), Chains of Olympus, God of War, Ghost of
  // Sparta, Betrayal, II, III, then the Norse games
  story: ['God of War Sons of Sparta', 'God of War: Ascension', 'God of War: Chains of Olympus', 'God of War (2005)', 'God of War: Ghost of Sparta', 'God of War: Betrayal', 'God of War II', 'God of War III', 'God of War (2018)', 'God of War Ragnarök'],
};
