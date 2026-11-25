// Images asked for at about the width they are drawn at (public/app.js sized): Xbox sends a cover as
// it was uploaded (1.5 MB) and an achievement icon of 3 MB unless a width is asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// (app.js is a browser module: the one function is read out of it)
const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('export function sized('), src.indexOf('/** `src` (and where it was scaled'));
assert.ok(body.startsWith('export function sized(') && body.length < 1500, 'sized() found in app.js');
const sized = new Function(`${body.replace('export function sized', 'return function sized')}`)();

test('hosts that can scale are asked for the width; the others, and an address that names one already, are left alone', () => {
  const store = 'http://store-images.s-microsoft.com/image/apps.1.2.aaaa-bbbb.cccc-dddd';
  assert.equal(sized(store), `${store}?w=360`);
  assert.equal(sized(store, 128), `${store}?w=128`);
  assert.equal(sized(`${store}?q=90`), `${store}?q=90&w=360`);
  const eds = 'https://images-eds-ssl.xboxlive.com/image?url=abc.def_ghi&format=png';
  assert.equal(sized(eds, 128), `${eds}&w=128`);
  assert.equal(sized('http://images-eds.xboxlive.com/image?url=abc'), 'http://images-eds.xboxlive.com/image?url=abc&w=360');
  assert.equal(sized('https://image.api.playstation.com/vulcan/ap/rnd/1/2/x.png'), 'https://image.api.playstation.com/vulcan/ap/rnd/1/2/x.png?w=360');
  assert.equal(sized('https://psnobj.prod.dl.playstation.net/psnobj/NPWR1_00/a.png', 128), 'https://psnobj.prod.dl.playstation.net/psnobj/NPWR1_00/a.png?w=128');
  // Nintendo's art comes in two sizes: the smaller for a thumbnail, the larger for a cover
  assert.equal(sized('https://atum-img-lp1.cdn.nintendo.net/i/c/abc_512', 128), 'https://atum-img-lp1.cdn.nintendo.net/i/c/abc_256');
  assert.equal(sized('https://atum-img-lp1.cdn.nintendo.net/i/c/abc_512'), 'https://atum-img-lp1.cdn.nintendo.net/i/c/abc_512');
  for (const same of ['https://cdn.cloudflare.steamstatic.com/steam/apps/240/library_600x900.jpg', 'https://images.igdb.com/igdb/image/upload/t_cover_big/co2k5h.jpg', 'http://image.xboxlive.com/global/t.58410A06/ach/0/3',
    `${store}?w=200`, `${eds}&w=64`, 'https://image.api.playstation.com/x.png?w=96', '/covers/local.png', 'https://example.com/store-images.s-microsoft.com/image/x']) assert.equal(sized(same), same, same);
  assert.equal(sized(null), '');
  assert.equal(sized(''), '');
});
