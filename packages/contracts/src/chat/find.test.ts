import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getChatFindExpression } from '@moonbase/contracts/chat';

const find = (text: string, query: string) =>
  [...text.matchAll(getChatFindExpression(query))].map((hit) => [hit.index, hit[0]]);

test('Find matches literal text with simple Unicode case folding at original offsets', () => {
  assert.deepEqual(find('a.b a+b (a)', 'a+b'), [[4, 'a+b']]);
  assert.deepEqual(find('x [y] \\z $', '[y] \\z $'), [[2, '[y] \\z $']]);
  assert.deepEqual(find('moon 🌔 MOON 🌔', 'moon 🌔'), [
    [0, 'moon 🌔'],
    [8, 'MOON 🌔'],
  ]);
  assert.deepEqual(find('👩‍💻 then 👩', '👩'), [
    [0, '👩'],
    [11, '👩'],
  ]);
  assert.deepEqual(find('STRAẞE straße', 'straße'), [
    [0, 'STRAẞE'],
    [7, 'straße'],
  ]);
  assert.deepEqual(find('ΣΟΦΟΣ σοφος σοφοσ', 'σοφος'), [
    [0, 'ΣΟΦΟΣ'],
    [6, 'σοφος'],
    [12, 'σοφοσ'],
  ]);
});

test('Find does not apply full case folding or normalization', () => {
  assert.deepEqual(find('STRASSE', 'straße'), []);
  assert.deepEqual(find('straße', 'STRASSE'), []);
  assert.deepEqual(find('İstanbul', 'istanbul'), []);
  const composed = 'café',
    decomposed = 'café';
  assert.deepEqual(find(composed, decomposed), []);
  assert.deepEqual(find(decomposed, composed), []);
  assert.deepEqual(find(`${composed} ${decomposed}`, decomposed), [[5, decomposed]]);
});
