// Utawarerumono. The format is described in ../franchises.js.
export default {
  id: 'utawarerumono', name: 'Utawarerumono', aliases: ['Utawarerumono'], prefix: ['utawarerumono', 'monochrome mobius'],
  eras: [
    ['Utawarerumono', 'Hakuoro', "Hakuoro's story: the original visual novel and its remake"],
    ['Utawarerumono: Mask of Deception', 'Haku', "Haku's duology, the Zan action games and the prequel Monochrome Mobius"],
  ],
  entries: [
    [2002, 'Utawarerumono'],
    [2015, 'Utawarerumono: Mask of Deception'],
    [2016, 'Utawarerumono: Mask of Truth'],
    [2018, 'Utawarerumono: Prelude to the Fallen', 'remake', { of: 'Utawarerumono', era: 'Hakuoro', aka: ['Utawarerumono: Chiriyuku Mono e no Komoriuta'] }],
    [2018, 'Utawarerumono: Zan', 'spinoff'],
    [2021, 'Utawarerumono: Zan 2', 'spinoff'],
    [2022, 'Monochrome Mobius: Rights and Wrongs Forgotten', 'spinoff'],
  ],
};
