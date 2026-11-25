// Deus Ex. The format is described in ../franchises.js.
export default {
  id: 'deus-ex', name: 'Deus Ex', aliases: ['Deus Ex'], prefix: ['deus ex'],
  eras: [
    ['Deus Ex', 'Ion Storm', "JC Denton's conspiracy and its sequel, made by Ion Storm"],
    ['Deus Ex: Human Revolution', 'Eidos-Montréal', "Adam Jensen's story, set decades before the first game"],
  ],
  entries: [
    [2000, 'Deus Ex'],
    [2002, 'Deus Ex: The Conspiracy', 'rerelease', { of: 'Deus Ex' }],
    [2003, 'Deus Ex: Invisible War'],
    [2011, 'Deus Ex: Human Revolution'],
    [2013, 'Deus Ex: The Fall', 'spinoff'],
    [2013, "Deus Ex: Human Revolution – Director's Cut", 'rerelease', { of: 'Deus Ex: Human Revolution' }],
    [2016, 'Deus Ex: Mankind Divided'],
  ],
  story: ['Deus Ex: Human Revolution', 'Deus Ex: The Fall', 'Deus Ex: Mankind Divided', 'Deus Ex', 'Deus Ex: Invisible War'],
};
