// Monkey Island. The format is described in ../franchises.js.
export default {
  id: 'monkey-island', name: 'Monkey Island', aliases: ['Monkey Island'],
  prefix: ['monkey island', 'the secret of monkey island', 'the curse of monkey island', 'escape from monkey island', 'tales of monkey island', 'return to monkey island'],
  eras: [
    ['The Secret of Monkey Island', 'LucasArts', "Guybrush Threepwood's four LucasArts adventures, and their Special Editions"],
    ['Tales of Monkey Island', 'Revival', "Telltale's episodic Tales, then Ron Gilbert's Return"],
  ],
  entries: [
    [1990, 'The Secret of Monkey Island'],
    [1991, "Monkey Island 2: LeChuck's Revenge"],
    [1997, 'The Curse of Monkey Island'],
    [2000, 'Escape from Monkey Island'],
    [2009, 'Tales of Monkey Island'],
    [2009, 'The Secret of Monkey Island: Special Edition', 'remaster', { of: 'The Secret of Monkey Island', era: 'LucasArts' }],
    [2010, "Monkey Island 2 Special Edition: LeChuck's Revenge", 'remaster', { of: "Monkey Island 2: LeChuck's Revenge", era: 'LucasArts' }],
    [2011, 'Monkey Island: Special Edition Collection', 'collection', { includes: ['The Secret of Monkey Island: Special Edition', "Monkey Island 2 Special Edition: LeChuck's Revenge"], era: 'LucasArts' }],
    [2022, 'Return to Monkey Island'],
  ],
};
