// Kingdom Hearts. The format is described in ../franchises.js.
export default {
  id: 'kingdom-hearts', name: 'Kingdom Hearts', aliases: ['Kingdom Hearts'], prefix: ['kingdom hearts'],
  eras: [
    ['Kingdom Hearts', 'The first journeys', "Sora's first journeys: Kingdom Hearts and II on PS2, Chain of Memories on Game Boy Advance"],
    ['Kingdom Hearts 358/2 Days', 'The handheld chapters', 'Roxas, Terra, Aqua and Ventus, and the Mark of Mastery'],
    ['Kingdom Hearts HD 1.5 ReMIX', 'HD, and the end of the Dark Seeker saga', 'The HD collections and Kingdom Hearts III'],
  ],
  entries: [
    [2002, 'Kingdom Hearts'],
    [2002, 'Kingdom Hearts Final Mix', 'rerelease', { of: 'Kingdom Hearts' }],
    [2004, 'Kingdom Hearts: Chain of Memories'],
    [2005, 'Kingdom Hearts II'],
    [2007, 'Kingdom Hearts II Final Mix', 'rerelease', { of: 'Kingdom Hearts II' }],
    [2007, 'Kingdom Hearts Re:Chain of Memories', 'remake', { of: 'Kingdom Hearts: Chain of Memories' }],
    [2009, 'Kingdom Hearts 358/2 Days'],
    [2010, 'Kingdom Hearts Birth by Sleep'],
    [2010, 'Kingdom Hearts Re:coded', 'spinoff'],
    [2012, 'Kingdom Hearts 3D: Dream Drop Distance'],
    [2013, 'Kingdom Hearts HD 1.5 ReMIX', 'collection', { includes: ['Kingdom Hearts Final Mix', 'Kingdom Hearts Re:Chain of Memories'] }],
    [2014, 'Kingdom Hearts HD 2.5 ReMIX', 'collection', { includes: ['Kingdom Hearts II Final Mix', 'Kingdom Hearts Birth by Sleep'] }],
    [2017, 'Kingdom Hearts 0.2: Birth by Sleep – A Fragmentary Passage', 'spinoff'],
    [2017, 'Kingdom Hearts HD 2.8 Final Chapter Prologue', 'collection', { includes: ['Kingdom Hearts 3D: Dream Drop Distance', 'Kingdom Hearts 0.2: Birth by Sleep – A Fragmentary Passage'] }],
    [2017, 'Kingdom Hearts HD 1.5 + 2.5 ReMIX', 'collection', { includes: ['Kingdom Hearts Final Mix', 'Kingdom Hearts Re:Chain of Memories', 'Kingdom Hearts II Final Mix', 'Kingdom Hearts Birth by Sleep'] }],
    [2019, 'Kingdom Hearts III', 'main', { aka: ['Kingdom Hearts III + Re Mind'] }],
    [2020, 'Kingdom Hearts Melody of Memory', 'spinoff'],
    [2026, 'Kingdom Hearts Collection [I~III]', 'collection', { includes: ['Kingdom Hearts Final Mix', 'Kingdom Hearts Re:Chain of Memories', 'Kingdom Hearts II Final Mix', 'Kingdom Hearts Birth by Sleep', 'Kingdom Hearts 3D: Dream Drop Distance', 'Kingdom Hearts 0.2: Birth by Sleep – A Fragmentary Passage', 'Kingdom Hearts III'], aka: ['Kingdom Hearts Integrum Masterpiece', 'Kingdom Hearts Collection I-III'] }],
  ],
};
