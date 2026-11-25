// Fatal Frame (Project Zero in Europe). The format is described in ../franchises.js.
export default {
  id: 'fatal-frame', name: 'Fatal Frame', aliases: ['Fatal Frame', 'Project Zero'], prefix: ['fatal frame', 'project zero'],
  eras: [
    ['Fatal Frame', 'PlayStation 2 and Xbox', 'The first three, on PS2 and Xbox'],
    ['Fatal Frame: Mask of the Lunar Eclipse', 'With Nintendo', 'Published by Nintendo: Mask of the Lunar Eclipse, the Wii remake, Spirit Camera and Maiden of Black Water'],
    ['Fatal Frame: Maiden of Black Water (2021)', 'Every platform', 'Koei Tecmo brings the series to every platform, and remakes II'],
  ],
  entries: [
    [2001, 'Fatal Frame', 'main', { aka: ['Project Zero'] }],
    [2003, 'Fatal Frame II: Crimson Butterfly', 'main', { aka: ['Project Zero II: Crimson Butterfly'] }],
    [2005, 'Fatal Frame III: The Tormented', 'main', { aka: ['Project Zero 3: The Tormented'] }],
    [2008, 'Fatal Frame: Mask of the Lunar Eclipse', 'main', { aka: ['Project Zero: Mask of the Lunar Eclipse'] }],
    [2012, 'Spirit Camera: The Cursed Memoir', 'spinoff'],
    [2012, 'Fatal Frame II: Deep Crimson Butterfly', 'remake', { of: 'Fatal Frame II: Crimson Butterfly', aka: ['Project Zero 2: Wii Edition'] }],
    [2014, 'Fatal Frame: Maiden of Black Water', 'main', { aka: ['Project Zero: Maiden of Black Water'] }],
    [2021, 'Fatal Frame: Maiden of Black Water (2021)', 'remaster', { of: 'Fatal Frame: Maiden of Black Water', aka: ['Project Zero: Maiden of Black Water'] }],
    [2023, 'Fatal Frame: Mask of the Lunar Eclipse (2023)', 'remaster', { of: 'Fatal Frame: Mask of the Lunar Eclipse', aka: ['Project Zero: Mask of the Lunar Eclipse'] }],
    [2026, 'Fatal Frame II: Crimson Butterfly Remake', 'remake', { of: 'Fatal Frame II: Crimson Butterfly', aka: ['Project Zero II: Crimson Butterfly Remake'] }],
  ],
};
