// Silent Hill. The format is described in ../franchises.js.
export default {
  id: 'silent-hill', name: 'Silent Hill', aliases: ['Silent Hill'], prefix: ['silent hill'],
  eras: [
    ['Silent Hill', 'Team Silent', "Konami's original team: 1 to 4"],
    ['Silent Hill: Origins', 'The Western years', 'Climax, Double Helix and Vatra take over'],
    ['Silent Hill: The Short Message', 'The revival', 'The Short Message, the Silent Hill 2 remake, f and Townfall'],
  ],
  entries: [
    [1999, 'Silent Hill'],
    [2001, 'Silent Hill 2'],
    [2003, 'Silent Hill 3'],
    [2004, 'Silent Hill 4: The Room'],
    [2007, 'Silent Hill: Origins'],
    [2008, 'Silent Hill: Homecoming'],
    [2009, 'Silent Hill: Shattered Memories', 'remake', { of: 'Silent Hill' }],
    [2012, 'Silent Hill: Downpour'],
    [2012, 'Silent Hill HD Collection', 'collection', { includes: ['Silent Hill 2', 'Silent Hill 3'] }],
    [2012, 'Silent Hill: Book of Memories', 'spinoff'],
    [2024, 'Silent Hill: The Short Message', 'spinoff'],
    [2024, 'Silent Hill 2 (2024)', 'remake', { of: 'Silent Hill 2' }],
    [2025, 'Silent Hill f', 'spinoff'],
    [2026, 'Silent Hill: Townfall', 'spinoff'],
  ],
};
