// Merge suggestions name two copies of one game, not two titles that look alike (services/duplicates.js
// sameGame). On a real library 173 suggestions were 39 copies and 134 chores: a game beside its beta,
// its demo, a game whose name merely begins the same, GreedFall beside Redfall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameGame } from '../src/services/duplicates.js';
import { normalizeTitle } from '../src/services/titles.js';

const g = (title) => ({ title, norm_title: normalizeTitle(title) });
const score = (a, b) => sameGame(g(a), g(b));

test('two copies of one game are suggested: the same title, another edition or build, a remaster, a letter apart', () => {
  for (const [a, b] of [['Batman: Arkham Origins', 'Batman: Arkham Origins'], ['Battlefield: Bad Company 2', 'Battlefield Bad Company 2'], ['Monster Hunter: World', 'MONSTER HUNTER: WORLD'],
    ['Tom Clancy\'s Splinter Cell Blacklist', 'Tom Clancy’s Splinter Cell Blacklist']]) assert.equal(score(a, b), 1, `${a} / ${b}`);
  for (const [a, b] of [['Alan Wake', 'Alan Wake Remastered'], ['Cities: Skylines', 'Cities: Skylines - Remastered'], ['The Witcher 3: Wild Hunt', 'The Witcher 3: Wild Hunt — Remastered'], ['RimWorld', 'RimWorld Console Edition'],
    ['Stellaris', 'Stellaris: Console Edition'], ['The Vanishing of Ethan Carter', 'The Vanishing of Ethan Carter Redux'], ['Sid Meier\'s Civilization VI', 'Sid Meier’s Civilization VI (Windows PC)'],
    ['DOOM Eternal', 'DOOM Eternal (BATTLEMODE)'], ['Kentucky Route Zero', 'Kentucky Route Zero: TV Edition'],
    // (an edition named in two words takes none of the game's own name with it)
    ['Stardew Valley', 'Stardew Valley Expanded Edition'], ['Hollow Knight', 'Hollow Knight Voidheart Edition'], ['Celeste', 'Celeste HD']]) assert.equal(score(a, b), 0.9, `${a} / ${b}`);
  assert.equal(score('Ghost Recon: Future Soldier', 'Tom Clancy\'s Ghost Recon Future Soldier'), 0.85, 'the publisher\'s name in front');
  assert.ok(score('Far Cry 6', 'FARCRY 6') >= 0.93);
  assert.ok(score('Watch_Dogs 2', 'Watch Dogs2') >= 0.93);
  assert.ok(score('Spider-Man', 'Spiderman') >= 0.8);
});

test('titles that only look alike are not: a beta or demo, another game that begins the same, a sequel, a near miss', () => {
  for (const [a, b] of [
    // not the game
    ['Battlefield 1', 'Battlefield 1 Open Beta'], ['Halo 5: Guardians', 'Halo 5: Guardians Beta'], ['Anthem', 'Anthem Demo'], ['The Dark Pictures Anthology: House of Ashes', 'The Dark Pictures Anthology: House of Ashes Demo'],
    ['The Dark Pictures Anthology: Little Hope', 'The Dark Pictures Anthology: Little Hope - Friend\'s Pass'], ['METAL GEAR SOLID MASTER COLLECTION Vol.2', 'METAL GEAR SOLID MASTER COLLECTION Vol.2 BONUS CONTENT'],
    // another game that begins, or ends, the same
    ['Battlefield', 'Battlefield Hardline'], ['Celeste', 'Celeste Farewell'], ['Perfect Dark', 'Perfect Dark Zero'], ['Alan Wake', 'Alan Wake\'s American Nightmare'], ['ASTRO BOT', 'ASTRO BOT Rescue Mission'], ['Call of Duty', 'Call of Duty: WaW'],
    ['Sid Meier\'s Civilization IV', 'Sid Meier\'s Civilization IV: Warlords'], ['Elite Dangerous', 'Elite Dangerous Core'], ['SUPERHOT', 'SUPERHOT VR'], ['Splosion Man', 'Ms. Splosion Man'], ['Haven', 'Teddy\'s Haven'],
    // a sequel, a near miss
    ['Hades', 'Hades II'], ['Resident Evil 2', 'Resident Evil 3'], ['GreedFall', 'Redfall'], ['FIFA 15 Downloadable Demo', 'NHL 15 Downloadable Demo'],
  ]) assert.equal(score(a, b), 0, `${a} / ${b}`);
  // two betas of one game are two copies of the same thing
  assert.equal(score('Battlefield 6 Open Beta', 'BATTLEFIELD 6 OPEN BETA'), 1);
});
