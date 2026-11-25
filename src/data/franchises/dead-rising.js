// Dead Rising. The format is described in ../franchises.js.
export default {
  id: 'dead-rising', name: 'Dead Rising', aliases: ['Dead Rising'], prefix: ['dead rising'],
  eras: [
    ['Dead Rising', 'Willamette', "Frank West's 72 hours in a mall overrun by zombies, and its Wii remake"],
    ['Dead Rising 2: Case Zero', 'Fortune City and after', 'Chuck Greene in Fortune City, Nick Ramos in 3 and Frank West again in 4'],
  ],
  entries: [
    [2006, 'Dead Rising'],
    [2009, 'Dead Rising: Chop Till You Drop', 'remake', { of: 'Dead Rising' }],
    [2010, 'Dead Rising 2: Case Zero', 'spinoff'],
    [2010, 'Dead Rising 2'],
    [2010, 'Dead Rising 2: Case West', 'spinoff'],
    [2011, 'Dead Rising 2: Off the Record', 'rerelease', { of: 'Dead Rising 2' }],
    [2013, 'Dead Rising 3'],
    [2016, 'Dead Rising 4'],
    [2024, 'Dead Rising Deluxe Remaster', 'remaster', { of: 'Dead Rising', era: 'Willamette' }],
  ],
};
