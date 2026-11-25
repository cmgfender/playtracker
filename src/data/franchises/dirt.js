// Colin McRae Rally and Dirt, with EA Sports WRC after them. The format is described in ../franchises.js.
export default {
  id: 'dirt', name: 'Dirt', aliases: ['Dirt', 'Colin McRae Rally', 'Colin McRae Rally and Dirt'],
  prefix: ['colin mcrae', 'dirt rally', 'ea sports wrc'],
  eras: [
    ['Colin McRae Rally', 'Colin McRae Rally', 'Stage rallying with Colin McRae, from PlayStation and PC to PS2 and Xbox'],
    ['Colin McRae: Dirt', 'Dirt', "Rally plus off-road racing; McRae's name is dropped from Dirt 3"],
    ['Dirt Rally', 'Dirt Rally', 'Simulation rallying returns, beside Dirt 4 and the arcade Dirt 5'],
    ['EA Sports WRC', 'EA Sports WRC', 'Same lineage: begun as a sequel to Dirt Rally 2.0; the WRC licence, on Unreal Engine 4'],
  ],
  entries: [
    [1998, 'Colin McRae Rally'],
    [2000, 'Colin McRae Rally 2.0'],
    [2002, 'Colin McRae Rally 3'],
    [2003, 'Colin McRae Rally 04'],
    [2004, 'Colin McRae Rally 2005'],
    [2007, 'Colin McRae: Dirt', 'main', { aka: ['Dirt', 'Dirt: Colin McRae Off-Road'] }],
    [2009, 'Colin McRae: Dirt 2', 'main', { aka: ['Dirt 2'] }],
    [2011, 'Dirt 3'],
    [2012, 'Dirt: Showdown', 'spinoff'],
    [2013, 'Colin McRae Rally (2013)', 'remaster', { of: 'Colin McRae Rally 2.0', era: 'Colin McRae Rally', aka: ['Colin McRae Rally'] }],
    [2015, 'Dirt Rally'],
    [2017, 'Dirt 4'],
    [2019, 'Dirt Rally 2.0'],
    [2020, 'Dirt 5'],
    [2023, 'EA Sports WRC'],
  ],
};
