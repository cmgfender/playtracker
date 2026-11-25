// Guitar Hero, with Band Hero and DJ Hero. The format is described in ../franchises.js.
export default {
  id: 'guitar-hero', name: 'Guitar Hero', aliases: ['Guitar Hero'], prefix: ['guitar hero', 'band hero', 'dj hero'],
  eras: [
    ['Guitar Hero', 'Harmonix', "Harmonix's three games for RedOctane"],
    ['Guitar Hero III: Legends of Rock', 'Neversoft', "Activision's yearly games, led by Neversoft, from III to Warriors of Rock"],
    ['Guitar Hero Live', 'FreeStyleGames', 'A new six-button guitar and live-action crowds'],
  ],
  entries: [
    [2005, 'Guitar Hero'],
    [2006, 'Guitar Hero II'],
    [2007, 'Guitar Hero Encore: Rocks the 80s', 'spinoff'],
    [2007, 'Guitar Hero III: Legends of Rock'],
    [2008, 'Guitar Hero: On Tour', 'spinoff'],
    [2008, 'Guitar Hero: Aerosmith', 'spinoff'],
    [2008, 'Guitar Hero World Tour'],
    [2008, 'Guitar Hero On Tour: Decades', 'spinoff'],
    [2009, 'Guitar Hero: Metallica', 'spinoff'],
    [2009, 'Guitar Hero On Tour: Modern Hits', 'spinoff'],
    [2009, 'Guitar Hero Smash Hits', 'spinoff', { aka: ['Guitar Hero Greatest Hits'] }],
    [2009, 'Guitar Hero 5'],
    [2009, 'DJ Hero', 'spinoff'],
    [2009, 'Band Hero', 'spinoff'],
    [2009, 'Guitar Hero: Van Halen', 'spinoff'],
    [2010, 'Guitar Hero: Warriors of Rock'],
    [2010, 'DJ Hero 2', 'spinoff'],
    [2015, 'Guitar Hero Live'],
  ],
};
