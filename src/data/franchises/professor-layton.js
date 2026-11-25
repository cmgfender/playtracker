// Professor Layton. The format is described in ../franchises.js.
export default {
  id: 'professor-layton', name: 'Professor Layton', aliases: ['Professor Layton', 'Layton'], prefix: ['professor layton', 'layton'],
  eras: [
    ['Professor Layton and the Curious Village', 'The first trilogy', 'Layton and Luke on DS: Curious Village, Diabolical Box and Unwound Future'],
    ['Professor Layton and the Last Specter', 'The prequel trilogy', 'Set before Curious Village: Last Specter, Miracle Mask and Azran Legacy'],
    ["Layton's Mystery Journey: Katrielle and the Millionaires' Conspiracy", 'Katrielle', "Layton's daughter Katrielle solves cases in London"],
  ],
  entries: [
    [2007, 'Professor Layton and the Curious Village'],
    [2007, 'Professor Layton and the Diabolical Box', 'main', { aka: ["Professor Layton and Pandora's Box"] }],
    [2008, 'Professor Layton and the Unwound Future', 'main', { aka: ['Professor Layton and the Lost Future'] }],
    [2009, 'Professor Layton and the Last Specter', 'main', { aka: ["Professor Layton and the Spectre's Call"] }],
    [2011, 'Professor Layton and the Miracle Mask'],
    [2013, 'Professor Layton and the Azran Legacy'],
    [2017, "Layton's Mystery Journey: Katrielle and the Millionaires' Conspiracy"],
    [2018, "Layton's Mystery Journey: Katrielle and the Millionaires' Conspiracy – Deluxe Edition", 'rerelease', { of: "Layton's Mystery Journey: Katrielle and the Millionaires' Conspiracy" }],
  ],
  story: ['Professor Layton and the Last Specter', 'Professor Layton and the Miracle Mask', 'Professor Layton and the Azran Legacy',
    'Professor Layton and the Curious Village', 'Professor Layton and the Diabolical Box', 'Professor Layton and the Unwound Future',
    "Layton's Mystery Journey: Katrielle and the Millionaires' Conspiracy"],
};
