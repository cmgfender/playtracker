// Trackmania. The format is described in ../franchises.js.
export default {
  id: 'trackmania', name: 'Trackmania', aliases: ['Trackmania', 'TrackMania'], prefix: ['trackmania', 'trackmania²'],
  eras: [
    ['TrackMania (2003)', 'The first games', "Nadeo's TrackMania, Sunrise, Nations and United, and their Forever editions"],
    ['TrackMania² Canyon', 'ManiaPlanet', "Ubisoft's TrackMania² environments on ManiaPlanet, and Turbo"],
    ['Trackmania (2020)', 'Trackmania (2020)', 'The Stadium remade, free to play, with seasonal campaigns'],
  ],
  entries: [
    [2003, 'TrackMania (2003)', 'main', { aka: ['TrackMania'] }],
    [2005, 'TrackMania Sunrise'],
    [2005, 'TrackMania Original', 'remaster', { of: 'TrackMania (2003)' }],
    [2006, 'TrackMania Nations ESWC', 'main', { aka: ['TrackMania Nations'] }],
    [2006, 'TrackMania United'],
    [2008, 'TrackMania Nations Forever', 'rerelease', { of: 'TrackMania Nations ESWC' }],
    [2008, 'TrackMania United Forever', 'rerelease', { of: 'TrackMania United' }],
    [2011, 'TrackMania² Canyon', 'main', { aka: ['TrackMania 2: Canyon'] }],
    [2013, 'TrackMania² Stadium', 'main', { aka: ['TrackMania 2: Stadium'] }],
    [2013, 'TrackMania² Valley', 'main', { aka: ['TrackMania 2: Valley'] }],
    [2016, 'TrackMania Turbo', 'spinoff'],
    [2017, 'TrackMania² Lagoon', 'main', { aka: ['TrackMania 2: Lagoon'] }],
    [2020, 'Trackmania (2020)', 'main', { aka: ['Trackmania'] }],
  ],
};
