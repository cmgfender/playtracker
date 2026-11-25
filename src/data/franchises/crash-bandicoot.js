// Crash Bandicoot. The format is described in ../franchises.js.
export default {
  id: 'crash-bandicoot', name: 'Crash Bandicoot', aliases: ['Crash Bandicoot'], prefix: ['crash bandicoot', 'crash team'],
  eras: [
    ['Crash Bandicoot', 'Naughty Dog', 'The PlayStation trilogy and Crash Team Racing'],
    ['Crash Bash', 'After Naughty Dog', "Eurocom, Traveller's Tales, Vicarious Visions and Radical take the wheel"],
    ['Crash Bandicoot N. Sane Trilogy', 'The revival', 'The trilogy and Crash Team Racing remade, and a fourth game'],
  ],
  entries: [
    [1996, 'Crash Bandicoot'],
    [1997, 'Crash Bandicoot 2: Cortex Strikes Back'],
    [1998, 'Crash Bandicoot: Warped'],
    [1999, 'Crash Team Racing', 'spinoff'],
    [2000, 'Crash Bash', 'spinoff'],
    [2001, 'Crash Bandicoot: The Wrath of Cortex'],
    [2002, 'Crash Bandicoot: The Huge Adventure', 'spinoff', { aka: ['Crash Bandicoot XS'] }],
    [2003, 'Crash Nitro Kart', 'spinoff'],
    [2004, 'Crash Twinsanity'],
    [2005, 'Crash Tag Team Racing', 'spinoff'],
    [2007, 'Crash of the Titans'],
    [2008, 'Crash: Mind over Mutant'],
    [2017, 'Crash Bandicoot N. Sane Trilogy', 'collection', { includes: ['Crash Bandicoot', 'Crash Bandicoot 2: Cortex Strikes Back', 'Crash Bandicoot: Warped'] }],
    [2019, 'Crash Team Racing Nitro-Fueled', 'remake', { of: 'Crash Team Racing' }],
    [2020, "Crash Bandicoot 4: It's About Time"],
    [2021, 'Crash Bandicoot: On the Run!', 'spinoff'],
    [2023, 'Crash Team Rumble', 'spinoff'],
  ],
};
