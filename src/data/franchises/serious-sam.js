// Serious Sam. The format is described in ../franchises.js.
export default {
  id: 'serious-sam', name: 'Serious Sam', aliases: ['Serious Sam'], prefix: ['serious sam'],
  eras: [
    ['Serious Sam: The First Encounter', 'Classic', 'The first two Encounters, Next Encounter and Serious Sam 2'],
    ['Serious Sam HD: The First Encounter', 'HD and BFE', 'HD remakes of the first two, BFE and the indie spin-offs'],
    ['Serious Sam 4', 'Serious Sam 4', 'Serious Sam 4, Siberian Mayhem and the Shatterverse roguelite'],
  ],
  entries: [
    [2001, 'Serious Sam: The First Encounter', 'main', { aka: ['Serious Sam Classic: The First Encounter'] }],
    [2002, 'Serious Sam: The Second Encounter', 'main', { aka: ['Serious Sam Classic: The Second Encounter'] }],
    [2004, 'Serious Sam: Next Encounter', 'spinoff'],
    [2005, 'Serious Sam 2'],
    [2009, 'Serious Sam HD: The First Encounter', 'remake', { of: 'Serious Sam: The First Encounter' }],
    [2010, 'Serious Sam HD: The Second Encounter', 'remake', { of: 'Serious Sam: The Second Encounter' }],
    [2011, 'Serious Sam Double D', 'spinoff', { aka: ['Serious Sam Double D XXL'] }],
    [2011, 'Serious Sam: The Random Encounter', 'spinoff'],
    [2011, 'Serious Sam 3: BFE'],
    [2017, "Serious Sam's Bogus Detour", 'spinoff'],
    [2020, 'Serious Sam 4'],
    [2022, 'Serious Sam: Siberian Mayhem', 'spinoff'],
    [2026, 'Serious Sam: Shatterverse', 'spinoff'],
  ],
  // 4 is a prequel to BFE, which is a prequel to The First Encounter
  story: ['Serious Sam 4', 'Serious Sam 3: BFE', 'Serious Sam: The First Encounter', 'Serious Sam: The Second Encounter', 'Serious Sam 2'],
};
