// Souls. The format is described in ../franchises.js.
export default {
  id: 'dark-souls', name: 'Souls', aliases: ['Dark Souls', "Demon's Souls", 'Souls'], prefix: ['dark souls'],
  entries: [
    [2009, "Demon's Souls"],
    [2011, 'Dark Souls'],
    [2012, 'Dark Souls: Prepare to Die Edition', 'rerelease', { of: 'Dark Souls' }],
    [2014, 'Dark Souls II'],
    [2015, 'Dark Souls II: Scholar of the First Sin', 'rerelease', { of: 'Dark Souls II' }],
    [2016, 'Dark Souls III'],
    [2018, 'Dark Souls: Remastered', 'remaster', { of: 'Dark Souls' }],
    [2018, 'Dark Souls Trilogy', 'collection', { includes: ['Dark Souls: Remastered', 'Dark Souls II: Scholar of the First Sin', 'Dark Souls III'] }],
    [2020, "Demon's Souls (2020)", 'remake', { of: "Demon's Souls" }],
  ],
};
