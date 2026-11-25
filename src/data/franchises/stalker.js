// S.T.A.L.K.E.R. The format is described in ../franchises.js.
export default {
  id: 'stalker', name: 'S.T.A.L.K.E.R.', aliases: ['S.T.A.L.K.E.R.', 'STALKER'], prefix: ['s.t.a.l.k.e.r.', 'stalker: shadow of', 'stalker: clear sky', 'stalker: call of pripyat', 'stalker 2'],
  eras: [
    ['S.T.A.L.K.E.R.: Shadow of Chernobyl', 'The original trilogy', 'The X-Ray engine games of 2007 to 2009, later brought to consoles'],
    ['S.T.A.L.K.E.R. 2: Heart of Chornobyl', 'Heart of Chornobyl', 'The Unreal Engine 5 sequel'],
  ],
  entries: [
    [2007, 'S.T.A.L.K.E.R.: Shadow of Chernobyl', 'main', { aka: ['S.T.A.L.K.E.R.: Shadow of Chornobyl', 'STALKER: Shadow of Chernobyl'] }],
    [2008, 'S.T.A.L.K.E.R.: Clear Sky', 'main', { aka: ['STALKER: Clear Sky'] }],
    [2009, 'S.T.A.L.K.E.R.: Call of Pripyat', 'main', { aka: ['STALKER: Call of Pripyat'] }],
    [2024, 'S.T.A.L.K.E.R.: Legends of the Zone Trilogy', 'collection', { includes: ['S.T.A.L.K.E.R.: Shadow of Chernobyl', 'S.T.A.L.K.E.R.: Clear Sky', 'S.T.A.L.K.E.R.: Call of Pripyat'] }],
    [2024, 'S.T.A.L.K.E.R. 2: Heart of Chornobyl', 'main', { aka: ['S.T.A.L.K.E.R. 2: Heart of Chernobyl', 'STALKER 2: Heart of Chornobyl'] }],
    [2025, 'S.T.A.L.K.E.R.: Legends of the Zone Trilogy – Enhanced Edition', 'collection', { includes: ['S.T.A.L.K.E.R.: Shadow of Chernobyl', 'S.T.A.L.K.E.R.: Clear Sky', 'S.T.A.L.K.E.R.: Call of Pripyat'], era: 'The original trilogy' }],
  ],
  story: ['S.T.A.L.K.E.R.: Clear Sky', 'S.T.A.L.K.E.R.: Shadow of Chernobyl', 'S.T.A.L.K.E.R.: Call of Pripyat', 'S.T.A.L.K.E.R. 2: Heart of Chornobyl'],
};
