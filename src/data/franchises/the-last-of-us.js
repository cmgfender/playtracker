// The Last of Us. The format is described in ../franchises.js.
export default {
  id: 'the-last-of-us', name: 'The Last of Us', aliases: ['The Last of Us'], prefix: ['last of us'],
  entries: [
    [2013, 'The Last of Us'],
    [2014, 'The Last of Us: Left Behind', 'spinoff'],
    [2014, 'The Last of Us Remastered', 'remaster', { of: 'The Last of Us' }],
    [2020, 'The Last of Us Part II'],
    [2022, 'The Last of Us Part I', 'remake', { of: 'The Last of Us' }],
    [2024, 'The Last of Us Part II Remastered', 'remaster', { of: 'The Last of Us Part II' }],
    [2025, 'The Last of Us Complete', 'collection', { includes: ['The Last of Us Part I', 'The Last of Us Part II Remastered'] }],
  ],
};
