// Series (franchises) read from titles: which games belong together when IGDB has not said so.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { inferSeries } from '../src/services/series.js';

/** { title: [series] } for a list of titles (null for a game in no series). */
const seriesOf = (titles) => { const m = inferSeries(titles.map((title, id) => ({ id, title }))); return Object.fromEntries(titles.map((t, i) => [t, m.get(i) || null])); };

describe('series from titles', () => {
  test('a number or a subtitle names the series; other titles may simply begin with it', () => {
    assert.deepEqual(seriesOf(['Halo 3', 'Halo: Reach', 'Halo Infinite', 'Portal', 'Portal 2', 'Hades', 'Hades II', 'Fallout 3', 'Fallout: New Vegas', 'Fallout Shelter']), {
      'Halo 3': ['Halo'], 'Halo: Reach': ['Halo'], 'Halo Infinite': ['Halo'], Portal: ['Portal'], 'Portal 2': ['Portal'], Hades: ['Hades'], 'Hades II': ['Hades'],
      'Fallout 3': ['Fallout'], 'Fallout: New Vegas': ['Fallout'], 'Fallout Shelter': ['Fallout'],
    });
  });

  test('roman numerals and "The": Final Fantasy VII / X, The Elder Scrolls V / IV, The Legend of Zelda', () => {
    const s = seriesOf(['Final Fantasy VII', 'Final Fantasy X', 'The Elder Scrolls V: Skyrim', 'The Elder Scrolls IV: Oblivion', 'The Legend of Zelda: Breath of the Wild', 'The Legend of Zelda: Tears of the Kingdom', 'The Witcher 3: Wild Hunt', 'The Witcher 2: Assassins of Kings']);
    assert.deepEqual([...new Set(Object.values(s).flat())].sort(), ['Final Fantasy', 'The Elder Scrolls', 'The Legend of Zelda', 'The Witcher']);
    assert.ok(Object.values(s).every((x) => x?.length === 1));
  });

  test('two or more words in common are a series without any mark', () => {
    assert.deepEqual(seriesOf(["Assassin's Creed Odyssey", "Assassin's Creed Valhalla", 'God of War', 'God of War Ragnarök', 'Resident Evil 4', 'Resident Evil Village', 'Mass Effect Legendary Edition', 'Mass Effect: Andromeda']), {
      "Assassin's Creed Odyssey": ["Assassin's Creed"], "Assassin's Creed Valhalla": ["Assassin's Creed"], 'God of War': ['God of War'], 'God of War Ragnarök': ['God of War'],
      'Resident Evil 4': ['Resident Evil'], 'Resident Evil Village': ['Resident Evil'], 'Mass Effect Legendary Edition': ['Mass Effect'], 'Mass Effect: Andromeda': ['Mass Effect'],
    });
  });

  test('a wrong series is worse than none: one shared word, or a shared phrase, is not enough', () => {
    const s = seriesOf(['Doom', 'Doom Eternal', 'Journey', 'Journey to the Savage Planet', 'Call of Juarez', 'Call of Cthulhu', 'Dark Messiah', 'Dark Souls III', 'Star Trek Online', 'Star Wars: Squadrons',
      'Super Smash Bros. Ultimate', 'Super Meat Boy', 'Red Dead Redemption 2', 'Red Faction', 'LEGO Batman', 'LEGO Star Wars', 'Stardew Valley', 'Elden Ring', '2048', '']);
    assert.deepEqual(Object.entries(s).filter(([, v]) => v).map(([k]) => k), [], JSON.stringify(s));
  });

  test('a series inside a series: a Star Wars Jedi game is a Star Wars game too; names holding the same games are one', () => {
    const s = seriesOf(['Star Wars Jedi: Fallen Order', 'Star Wars Jedi: Survivor', 'Star Wars: Battlefront II', 'Batman: Arkham City', 'Batman: Arkham Knight']);
    assert.deepEqual(s['Star Wars Jedi: Survivor'], ['Star Wars Jedi', 'Star Wars'], 'the most specific first');
    assert.deepEqual(s['Star Wars: Battlefront II'], ['Star Wars']);
    assert.deepEqual(s['Batman: Arkham City'], ['Batman'], 'not "Batman: Arkham" as well');
  });

  test('a series needs two games', () => {
    assert.deepEqual(seriesOf(['Halo 3', 'Portal 2', 'The Witcher 3: Wild Hunt']), { 'Halo 3': null, 'Portal 2': null, 'The Witcher 3: Wild Hunt': null });
  });

  test('titles in other scripts and odd titles do not throw', () => {
    assert.doesNotThrow(() => seriesOf(['ペルソナ5', 'ペルソナ4', '龍が如く 7', '龍が如く 8', '   ', '!!!', '1', '2', 'A: B', 'A: C']));
    assert.deepEqual(seriesOf(['龍が如く 7', '龍が如く 8'])['龍が如く 7'], ['龍が如く']);
  });
});
