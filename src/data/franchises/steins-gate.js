// The Science Adventure series: Chaos;Head, Steins;Gate, Robotics;Notes and their sequels. The
// format is described in ../franchises.js.
export default {
  id: 'steins-gate', name: 'Science Adventure', aliases: ['Science Adventure', 'Steins;Gate', 'Chaos;Head', 'Robotics;Notes', 'Chaos;Child'],
  prefix: ['steins gate', 'chaos head', 'chaos child', 'robotics notes', 'anonymous code'],
  eras: [
    ['Chaos;Head', 'The first three', 'Chaos;Head, Steins;Gate and Robotics;Notes, set in Shibuya, Akihabara and Tanegashima'],
    ['Chaos;Child', 'The sequels', 'Chaos;Child, Steins;Gate 0 and Robotics;Notes DaSH follow the first three, then Anonymous;Code'],
  ],
  entries: [
    [2008, 'Chaos;Head'],
    [2009, 'Chaos;Head Noah', 'rerelease', { of: 'Chaos;Head' }],
    [2009, 'Steins;Gate'],
    [2011, "Steins;Gate: My Darling's Embrace", 'spinoff'],
    [2012, 'Robotics;Notes'],
    [2013, 'Steins;Gate: Linear Bounded Phenogram', 'spinoff'],
    [2014, 'Robotics;Notes Elite', 'rerelease', { of: 'Robotics;Notes' }],
    [2014, 'Chaos;Child'],
    [2015, 'Steins;Gate 0'],
    [2018, 'Steins;Gate Elite', 'remake', { of: 'Steins;Gate', era: 'The first three' }],
    [2019, 'Robotics;Notes DaSH'],
    [2022, 'Anonymous;Code'],
  ],
};
