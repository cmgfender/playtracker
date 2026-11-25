// The Walking Dead, Telltale's series. The format is described in ../franchises.js.
export default {
  id: 'the-walking-dead', name: "Telltale's The Walking Dead", aliases: ["Telltale's The Walking Dead", 'The Walking Dead: The Telltale Series'],
  prefix: ['the walking dead: season', "telltale's the walking dead", 'the walking dead: the telltale', 'the walking dead: michonne', 'the walking dead: a new frontier', 'the walking dead: the final season', 'the walking dead: 400 days'],
  eras: [
    ['The Walking Dead', 'Telltale', "Lee and then Clementine's story, and Michonne, told by Telltale"],
    ['The Walking Dead: The Final Season', 'The Final Season', "Clementine's last season, finished by Skybound after Telltale closed"],
  ],
  entries: [
    [2012, 'The Walking Dead', 'main', { aka: ['The Walking Dead: Season One'] }],
    [2013, 'The Walking Dead: Season Two'],
    [2016, 'The Walking Dead: Michonne', 'spinoff'],
    [2016, 'The Walking Dead: A New Frontier', 'main', { aka: ['The Walking Dead: The Telltale Series – A New Frontier'] }],
    [2017, 'The Walking Dead Collection', 'collection', { includes: ['The Walking Dead', 'The Walking Dead: Season Two', 'The Walking Dead: Michonne', 'The Walking Dead: A New Frontier'] }],
    [2018, 'The Walking Dead: The Final Season'],
    [2019, 'The Walking Dead: The Telltale Definitive Series', 'collection', { includes: ['The Walking Dead', 'The Walking Dead: Season Two', 'The Walking Dead: Michonne', 'The Walking Dead: A New Frontier', 'The Walking Dead: The Final Season'] }],
  ],
};
