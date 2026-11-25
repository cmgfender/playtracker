// Metro. The format is described in ../franchises.js.
export default {
  id: 'metro', name: 'Metro', aliases: ['Metro'], prefix: ['metro 2033', 'metro: last light', 'metro redux', 'metro exodus', 'metro awakening'],
  eras: [
    ['Metro 2033', 'The Moscow metro', 'Artyom underground in Moscow, and the Redux remasters'],
    ['Metro Exodus', 'Exodus', 'Artyom leaves Moscow on a train across Russia, and a VR prequel'],
  ],
  entries: [
    [2010, 'Metro 2033'],
    [2013, 'Metro: Last Light'],
    [2014, 'Metro 2033 Redux', 'remaster', { of: 'Metro 2033' }],
    [2014, 'Metro: Last Light Redux', 'remaster', { of: 'Metro: Last Light' }],
    [2014, 'Metro Redux', 'collection', { includes: ['Metro 2033 Redux', 'Metro: Last Light Redux'] }],
    [2019, 'Metro Exodus'],
    [2021, 'Metro Exodus Enhanced Edition', 'remaster', { of: 'Metro Exodus' }],
    [2024, 'Metro Awakening', 'spinoff'],
  ],
  story: ['Metro Awakening', 'Metro 2033', 'Metro: Last Light', 'Metro Exodus'],
};
