// Assassin's Creed. The format is described in ../franchises.js.
export default {
  id: 'assassins-creed', name: "Assassin's Creed", aliases: ["Assassin's Creed"], prefix: ["assassin's creed"],
  eras: [
    ["Assassin's Creed", 'The Desmond saga', "Altaïr, Ezio and Connor, framed by Desmond Miles's story"],
    ["Assassin's Creed IV: Black Flag", 'After Desmond', 'Pirates, the French Revolution and Victorian London, with Abstergo in the present'],
    ["Assassin's Creed Origins", 'The RPG era', "Open-world role-playing in Egypt, Greece and England, Mirage's stealth in Baghdad, Japan, and the Black Flag remake"],
  ],
  entries: [
    [2007, "Assassin's Creed"],
    [2009, "Assassin's Creed II"],
    [2009, "Assassin's Creed: Bloodlines", 'spinoff'],
    [2010, "Assassin's Creed Brotherhood"],
    [2011, "Assassin's Creed Revelations"],
    [2012, "Assassin's Creed III"],
    [2012, "Assassin's Creed III: Liberation", 'spinoff'],
    [2013, "Assassin's Creed IV: Black Flag"],
    [2014, "Assassin's Creed Liberation HD", 'remaster', { of: "Assassin's Creed III: Liberation" }],
    [2014, "Assassin's Creed Unity"],
    [2014, "Assassin's Creed Rogue"],
    [2015, "Assassin's Creed Chronicles: China", 'spinoff'],
    [2015, "Assassin's Creed Syndicate"],
    [2016, "Assassin's Creed Chronicles: India", 'spinoff'],
    [2016, "Assassin's Creed Chronicles: Russia", 'spinoff'],
    [2016, "Assassin's Creed: The Ezio Collection", 'collection', { includes: ["Assassin's Creed II", "Assassin's Creed Brotherhood", "Assassin's Creed Revelations"] }],
    [2017, "Assassin's Creed Origins"],
    [2018, "Assassin's Creed Rogue Remastered", 'remaster', { of: "Assassin's Creed Rogue" }],
    [2018, "Assassin's Creed Odyssey"],
    [2019, "Assassin's Creed III Remastered", 'remaster', { of: ["Assassin's Creed III", "Assassin's Creed III: Liberation"] }],
    [2019, "Assassin's Creed: The Rebel Collection", 'collection', { includes: ["Assassin's Creed IV: Black Flag", "Assassin's Creed Rogue"] }],
    [2020, "Assassin's Creed Valhalla"],
    [2023, "Assassin's Creed Mirage"],
    [2023, "Assassin's Creed Nexus VR", 'spinoff'],
    [2025, "Assassin's Creed Shadows"],
    [2026, "Assassin's Creed Black Flag Resynced", 'remake', { of: "Assassin's Creed IV: Black Flag" }],
  ],
  // by when each is set: Odyssey (431 BC), Origins (49 BC), Mirage (861), Valhalla (872), Assassin's
  // Creed (1191), II (1476), Brotherhood (1499), Revelations (1511), Shadows (1579), Black Flag
  // (1715), Rogue (1752), III (1754), Liberation (1765), Unity (1789), Syndicate (1868)
  story: ["Assassin's Creed Odyssey", "Assassin's Creed Origins", "Assassin's Creed Mirage", "Assassin's Creed Valhalla", "Assassin's Creed", "Assassin's Creed II", "Assassin's Creed Brotherhood",
    "Assassin's Creed Revelations", "Assassin's Creed Shadows", "Assassin's Creed IV: Black Flag", "Assassin's Creed Rogue", "Assassin's Creed III", "Assassin's Creed III: Liberation", "Assassin's Creed Unity", "Assassin's Creed Syndicate"],
};
