// Phantasy Star. The format is described in ../franchises.js.
export default {
  id: 'phantasy-star', name: 'Phantasy Star', aliases: ['Phantasy Star'], prefix: ['phantasy star'],
  eras: [
    ['Phantasy Star', 'The classic RPGs', 'The four turn-based games on Master System and Mega Drive'],
    ['Phantasy Star Online', 'Online and Universe', 'Phantasy Star Online and its versions, Universe, Portable and Zero'],
    ['Phantasy Star Online 2', 'Phantasy Star Online 2', 'Phantasy Star Online 2 and its successor New Genesis'],
  ],
  entries: [
    [1987, 'Phantasy Star'],
    [1989, 'Phantasy Star II'],
    [1990, 'Phantasy Star III: Generations of Doom'],
    [1993, 'Phantasy Star IV: The End of the Millennium', 'main', { aka: ['Phantasy Star IV'] }],
    [2000, 'Phantasy Star Online'],
    [2002, 'Phantasy Star Online Episode I & II', 'rerelease', { of: 'Phantasy Star Online' }],
    [2003, 'Phantasy Star Generation:1', 'remake', { of: 'Phantasy Star', era: 'The classic RPGs' }],
    [2003, 'Phantasy Star Online Episode III: C.A.R.D. Revolution', 'spinoff'],
    [2004, 'Phantasy Star Online: Blue Burst', 'rerelease', { of: 'Phantasy Star Online' }],
    [2005, 'Phantasy Star Generation:2', 'remake', { of: 'Phantasy Star II', era: 'The classic RPGs' }],
    [2006, 'Phantasy Star Universe'],
    [2008, 'Phantasy Star Portable', 'spinoff'],
    [2008, 'Phantasy Star Zero', 'spinoff', { aka: ['Phantasy Star 0'] }],
    [2009, 'Phantasy Star Portable 2', 'spinoff'],
    [2012, 'Phantasy Star Online 2'],
    [2021, 'Phantasy Star Online 2: New Genesis'],
  ],
};
