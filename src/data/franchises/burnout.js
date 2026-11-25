// Burnout. The format is described in ../franchises.js.
export default {
  id: 'burnout', name: 'Burnout', aliases: ['Burnout'],
  prefix: ['burnout 2', 'burnout 3', 'burnout revenge', 'burnout legends', 'burnout dominator', 'burnout paradise', 'burnout crash'],
  eras: [
    ['Burnout', 'Acclaim', "Criterion's first two games, published by Acclaim"],
    ['Burnout 3: Takedown', 'Takedowns', 'Published by EA: crash your rivals off the road, from Takedown to Dominator'],
    ['Burnout Paradise', 'Paradise City', 'The open world of Paradise, its re-releases, and Crash!'],
  ],
  entries: [
    [2001, 'Burnout'],
    [2002, 'Burnout 2: Point of Impact'],
    [2004, 'Burnout 3: Takedown'],
    [2005, 'Burnout Revenge'],
    [2005, 'Burnout Legends', 'spinoff'],
    [2007, 'Burnout Dominator'],
    [2008, 'Burnout Paradise'],
    [2009, 'Burnout Paradise: The Ultimate Box', 'rerelease', { of: 'Burnout Paradise' }],
    [2011, 'Burnout Crash!', 'spinoff'],
    [2018, 'Burnout Paradise Remastered', 'remaster', { of: 'Burnout Paradise' }],
  ],
};
