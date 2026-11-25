// Until Dawn. The format is described in ../franchises.js. Supermassive's Dark Pictures games are
// in the-dark-pictures.js: Until Dawn is Sony's series, not part of that anthology.
export default {
  id: 'until-dawn', name: 'Until Dawn', aliases: ['Until Dawn'], prefix: ['until dawn'],
  entries: [
    [2015, 'Until Dawn'],
    [2016, 'Until Dawn: Rush of Blood', 'spinoff'],
    [2018, 'The Inpatient', 'spinoff'],
    [2024, 'Until Dawn (2024)', 'remake', { of: 'Until Dawn', aka: ['Until Dawn'] }],
  ],
  // The Inpatient is a prequel, set sixty years before Until Dawn
  story: ['The Inpatient', 'Until Dawn'],
};
