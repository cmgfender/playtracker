// Anno. The format is described in ../franchises.js. Its prefixes are the games' numbers: "Anno" alone
// starts other games' titles.
export default {
  id: 'anno', name: 'Anno', aliases: ['Anno'],
  prefix: ['anno 1602', 'anno 1503', 'anno 1701', 'anno 1404', 'anno 2070', 'anno 2205', 'anno 1800', 'anno 117'],
  eras: [
    ['Anno 1602', 'The early games', 'Island colonies in history: 1602, 1503, 1701 and 1404'],
    ['Anno 2070', 'The future', 'A flooded Earth in 2070, then the Moon in 2205'],
    ['Anno 1800', 'Back in history', 'The Industrial Revolution in 1800, then the Roman Empire in 117'],
  ],
  entries: [
    [1998, 'Anno 1602', 'main', { aka: ['1602 A.D.'] }],
    [2002, 'Anno 1503', 'main', { aka: ['1503 A.D.: The New World', 'Anno 1503: The New World'] }],
    [2006, 'Anno 1701', 'main', { aka: ['1701 A.D.'] }],
    [2009, 'Anno 1404', 'main', { aka: ['Dawn of Discovery'] }],
    [2011, 'Anno 2070'],
    [2015, 'Anno 2205'],
    [2019, 'Anno 1800'],
    [2020, 'Anno 1602 History Edition', 'remaster', { of: 'Anno 1602', era: 'The early games' }],
    [2020, 'Anno 1503 History Edition', 'remaster', { of: 'Anno 1503', era: 'The early games' }],
    [2020, 'Anno 1701 History Edition', 'remaster', { of: 'Anno 1701', era: 'The early games' }],
    [2020, 'Anno 1404 History Edition', 'remaster', { of: 'Anno 1404', era: 'The early games' }],
    [2020, 'Anno History Collection', 'collection', { era: 'The early games', includes: ['Anno 1602 History Edition', 'Anno 1503 History Edition', 'Anno 1701 History Edition', 'Anno 1404 History Edition'] }],
    [2025, 'Anno 117: Pax Romana', 'main', { aka: ['Anno 117'] }],
  ],
};
