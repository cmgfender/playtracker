// Life Is Strange. The format is described in ../franchises.js.
export default {
  id: 'life-is-strange', name: 'Life Is Strange', aliases: ['Life Is Strange'], prefix: ['life is strange'],
  eras: [
    ['Life Is Strange', 'Max and Chloe', 'Arcadia Bay: the first game and its prequel'],
    ['The Awesome Adventures of Captain Spirit', 'The Diaz brothers', "Sean and Daniel's road trip, and the Captain Spirit spin-off"],
    ['Life Is Strange: True Colors', 'Later games', "Alex Chen in Haven Springs, then Max Caulfield's return"],
  ],
  entries: [
    [2015, 'Life Is Strange'],
    [2017, 'Life Is Strange: Before the Storm'],
    [2018, 'The Awesome Adventures of Captain Spirit', 'spinoff'],
    [2018, 'Life Is Strange 2'],
    [2021, 'Life Is Strange: True Colors'],
    [2022, 'Life Is Strange Remastered', 'remaster', { of: 'Life Is Strange', era: 'Max and Chloe' }],
    [2022, 'Life Is Strange: Before the Storm Remastered', 'remaster', { of: 'Life Is Strange: Before the Storm', era: 'Max and Chloe' }],
    [2022, 'Life Is Strange Remastered Collection', 'collection', { includes: ['Life Is Strange Remastered', 'Life Is Strange: Before the Storm Remastered'], era: 'Max and Chloe' }],
    [2022, 'Life Is Strange: Arcadia Bay Collection', 'collection', { includes: ['Life Is Strange Remastered', 'Life Is Strange: Before the Storm Remastered'], era: 'Max and Chloe' }],
    [2024, 'Life Is Strange: Double Exposure'],
    [2026, 'Life Is Strange: Reunion'],
  ],
  story: ['Life Is Strange: Before the Storm', 'Life Is Strange', 'Life Is Strange 2', 'Life Is Strange: True Colors', 'Life Is Strange: Double Exposure', 'Life Is Strange: Reunion'],
};
