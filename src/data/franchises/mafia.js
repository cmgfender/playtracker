// Mafia. The format is described in ../franchises.js.
export default {
  id: 'mafia', name: 'Mafia', aliases: ['Mafia'], prefix: ['mafia'],
  eras: [
    ['Mafia', '2K Czech', 'Lost Heaven and Empire Bay, made by Illusion Softworks, later 2K Czech'],
    ['Mafia III', 'Hangar 13', 'New Bordeaux, the Definitive Editions and the Sicilian prequel'],
  ],
  entries: [
    [2002, 'Mafia', 'main', { aka: ['Mafia: The City of Lost Heaven'] }],
    [2010, 'Mafia II', 'main', { aka: ['Mafia II (Classic)'] }],
    [2016, 'Mafia III'],
    [2020, 'Mafia II: Definitive Edition', 'remaster', { of: 'Mafia II' }],
    [2020, 'Mafia III: Definitive Edition', 'rerelease', { of: 'Mafia III' }],
    [2020, 'Mafia: Definitive Edition', 'remake', { of: 'Mafia' }],
    [2020, 'Mafia: Trilogy', 'collection', { includes: ['Mafia: Definitive Edition', 'Mafia II: Definitive Edition', 'Mafia III: Definitive Edition'] }],
    [2025, 'Mafia: The Old Country'],
    [2026, 'Mafia: The Omertà Collection', 'collection', { includes: ['Mafia: Definitive Edition', 'Mafia II: Definitive Edition', 'Mafia III: Definitive Edition', 'Mafia: The Old Country'] }],
  ],
  // The Old Country in 1900s Sicily, Mafia in the 1930s, Mafia II in 1945-51, Mafia III in 1968
  story: ['Mafia: The Old Country', 'Mafia', 'Mafia II', 'Mafia III'],
};
