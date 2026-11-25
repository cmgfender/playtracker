// Batman: Arkham. The format is described in ../franchises.js.
export default {
  id: 'batman-arkham', name: 'Batman: Arkham', aliases: ['Batman: Arkham', 'Batman Arkham'], prefix: ['batman arkham'],
  eras: [
    ['Batman: Arkham Asylum', 'The Arkham games', "Rocksteady's trilogy and WB Montréal's prequel"],
    ['Batman: Arkham VR', 'After Arkham Knight', 'The remasters, virtual reality and the Suicide Squad'],
  ],
  entries: [
    [2009, 'Batman: Arkham Asylum'],
    [2011, 'Batman: Arkham City'],
    [2013, 'Batman: Arkham Origins'],
    [2013, 'Batman: Arkham Origins Blackgate', 'spinoff'],
    [2015, 'Batman: Arkham Knight'],
    [2016, 'Batman: Arkham VR', 'spinoff'],
    [2016, 'Batman: Return to Arkham', 'collection', { includes: ['Batman: Arkham Asylum', 'Batman: Arkham City'] }],
    [2018, 'Batman: Arkham Collection', 'collection', { includes: ['Batman: Arkham Asylum', 'Batman: Arkham City', 'Batman: Arkham Knight'] }],
    [2023, 'Batman: Arkham Trilogy', 'collection', { includes: ['Batman: Arkham Asylum', 'Batman: Arkham City', 'Batman: Arkham Knight'] }],
    [2024, 'Suicide Squad: Kill the Justice League', 'spinoff'],
    [2024, 'Batman: Arkham Shadow', 'spinoff'],
  ],
};
