// Rayman. The format is described in ../franchises.js. The Rabbids are in it only where Rayman's name
// is on the game.
export default {
  id: 'rayman', name: 'Rayman', aliases: ['Rayman'], prefix: ['rayman'],
  eras: [
    ['Rayman', 'The classics', 'The 2D original, The Great Escape in 3D and Hoodlum Havoc, and their ports'],
    ['Rayman Raving Rabbids', 'Raving Rabbids', 'Party games in which the Rabbids take over'],
    ['Rayman Origins', 'UbiArt', 'Hand-drawn 2D platforming on the UbiArt Framework: Origins and Legends'],
  ],
  entries: [
    [1995, 'Rayman'],
    [1999, 'Rayman 2: The Great Escape'],
    [2000, 'Rayman Revolution', 'rerelease', { of: 'Rayman 2: The Great Escape', aka: ['Rayman 2: Revolution'] }],
    [2001, 'Rayman Advance', 'rerelease', { of: 'Rayman' }],
    [2001, 'Rayman M', 'spinoff', { aka: ['Rayman Arena'] }],
    [2003, 'Rayman 3: Hoodlum Havoc'],
    [2005, 'Rayman DS', 'rerelease', { of: 'Rayman 2: The Great Escape' }],
    [2006, 'Rayman Raving Rabbids', 'spinoff'],
    [2007, 'Rayman Raving Rabbids 2', 'spinoff'],
    [2008, 'Rayman Raving Rabbids: TV Party', 'spinoff'],
    [2011, 'Rayman 3D', 'rerelease', { of: 'Rayman 2: The Great Escape', era: 'The classics' }],
    [2011, 'Rayman Origins'],
    [2012, 'Rayman 3 HD', 'remaster', { of: 'Rayman 3: Hoodlum Havoc', era: 'The classics' }],
    [2013, 'Rayman Legends'],
    [2017, 'Rayman Legends: Definitive Edition', 'rerelease', { of: 'Rayman Legends' }],
    [2026, 'Rayman: 30th Anniversary Edition', 'rerelease', { of: 'Rayman', era: 'The classics' }],
  ],
};
