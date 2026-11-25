// Age of Empires, with Age of Mythology. The format is described in ../franchises.js.
export default {
  id: 'age-of-empires', name: 'Age of Empires', aliases: ['Age of Empires', 'Age of Mythology'], prefix: ['age of empires', 'age of mythology'],
  eras: [
    ['Age of Empires', 'Ensemble Studios', "Ensemble's games, from the first to Age of Empires III"],
    ['Age of Empires Online', 'After Ensemble', 'Ensemble closed in 2009: Online and the HD and Extended editions'],
    ['Age of Empires: Definitive Edition', 'Definitive Editions', 'The Definitive Editions, Age of Empires IV and Retold'],
  ],
  entries: [
    [1997, 'Age of Empires'],
    [1999, 'Age of Empires II: The Age of Kings', 'main', { aka: ['Age of Empires II'] }],
    [2002, 'Age of Mythology', 'spinoff'],
    [2005, 'Age of Empires III'],
    [2011, 'Age of Empires Online', 'spinoff'],
    [2013, 'Age of Empires II: HD Edition', 'remaster', { of: 'Age of Empires II: The Age of Kings' }],
    [2014, 'Age of Mythology: Extended Edition', 'remaster', { of: 'Age of Mythology' }],
    [2018, 'Age of Empires: Definitive Edition', 'remaster', { of: 'Age of Empires' }],
    [2019, 'Age of Empires II: Definitive Edition', 'remaster', { of: 'Age of Empires II: The Age of Kings' }],
    [2020, 'Age of Empires III: Definitive Edition', 'remaster', { of: 'Age of Empires III' }],
    [2021, 'Age of Empires IV'],
    [2024, 'Age of Mythology: Retold', 'remaster', { of: 'Age of Mythology' }],
  ],
};
