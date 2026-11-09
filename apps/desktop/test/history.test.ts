import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatTarget } from '@moonbase/contracts/chat';
import {
  emptyHistory,
  findStep,
  isSamePlace,
  settleStep,
  stepTo,
  visitPlace,
  type Place,
  type PlaceHistory,
} from '../src/renderer/shell/history.ts';

const chatTarget = (conversationId: string) =>
  ({ host: { kind: 'local' }, actorId: 'actor', conversationId }) as unknown as ChatTarget;
const chat = (conversationId: string | null): Place => ({
  kind: 'chat',
  chat: conversationId ? chatTarget(conversationId) : null,
});
const file = (checkoutId: string, path: string | null): Place => ({
  kind: 'project',
  checkoutId,
  path,
});
const visitAll = (...places: Place[]) =>
  places.reduce<PlaceHistory>((history, place) => visitPlace(history, place), emptyHistory);
const always = () => true;

test('places are the same by chat, or by checkout and file', () => {
  assert.equal(isSamePlace(chat(null), chat(null)), true);
  assert.equal(isSamePlace(chat('a'), chat('a')), true);
  assert.equal(isSamePlace(chat('a'), chat(null)), false);
  assert.equal(isSamePlace(chat('a'), chat('b')), false);
  assert.equal(isSamePlace(file('one', 'a.ts'), file('one', 'a.ts')), true);
  assert.equal(isSamePlace(file('one', 'a.ts'), file('one', 'b.ts')), false);
  assert.equal(isSamePlace(file('one', 'a.ts'), file('two', 'a.ts')), false);
  assert.equal(isSamePlace(file('one', null), chat(null)), false);
  assert.equal(isSamePlace(chat(null), file('one', null)), false);
});

test('a visit follows the place showing, and the same place again is not a step', () => {
  const history = visitAll(chat(null), file('one', 'a.ts'), file('one', 'a.ts'));
  assert.deepEqual(history.places, [chat(null), file('one', 'a.ts')]);
  assert.equal(history.index, 1);
});

test('a new chat gives way to the chat it starts, and an empty project to its first file', () => {
  assert.deepEqual(visitAll(file('one', 'a.ts'), chat(null), chat('a')).places, [
    file('one', 'a.ts'),
    chat('a'),
  ]);
  assert.deepEqual(visitAll(chat('a'), file('one', null), file('one', 'a.ts')).places, [
    chat('a'),
    file('one', 'a.ts'),
  ]);
  // Leaving an empty project for somewhere else keeps it.
  assert.deepEqual(visitAll(file('one', null), file('two', 'b.ts')).places, [
    file('one', null),
    file('two', 'b.ts'),
  ]);
});

test('a step never lands on the place already showing', () => {
  const history = visitAll(file('one', 'a.ts'), file('two', 'b.ts'), file('one', 'a.ts'));
  const open = (place: Place) => !(place.kind === 'project' && place.checkoutId === 'two');
  assert.equal(findStep(history, -1, open), undefined);
  assert.equal(findStep(history, -1, always), 1);
});

test('back and forward step over places that cannot be shown', () => {
  const history = visitAll(chat('a'), file('closed', 'x.ts'), file('one', 'a.ts'));
  const open = (place: Place) => !(place.kind === 'project' && place.checkoutId === 'closed');
  assert.equal(findStep(history, -1, open), 0);
  assert.equal(findStep(history, 1, open), undefined);
  const back = stepTo(history, 0);
  assert.equal(findStep(back, -1, open), undefined);
  assert.equal(findStep(back, 1, open), 2);
  assert.equal(findStep(emptyHistory, -1, always), undefined);
});

test('a visit after going back drops the places forward of it', () => {
  const back = stepTo(visitAll(chat('z'), chat('a'), file('one', 'a.ts')), 0);
  const history = visitPlace(back, file('two', null));
  assert.deepEqual(history.places, [chat('z'), file('two', null)]);
  assert.equal(history.index, 1);
  assert.equal(findStep(history, 1, always), undefined);
});

test('arriving back at a place records nothing new', () => {
  const back = stepTo(visitAll(chat('z'), chat('a')), 0);
  assert.deepEqual(visitPlace(back, chat('z')), back);
});

test('the oldest places go past fifty', () => {
  const places = Array.from({ length: 60 }, (_, index) => file('one', `${index}.ts`));
  const history = visitAll(...places);
  assert.equal(history.places.length, 50);
  assert.deepEqual(history.places[0], file('one', '10.ts'));
  assert.equal(history.index, 49);
});

test('a step whose place never showed drops it, and the history follows what shows', () => {
  const history = visitAll(chat('a'), file('one', 'gone.ts'), file('one', 'b.ts'));
  // Back to a deleted file: the window stays on b.ts.
  const stuck = settleStep(
    stepTo(history, 1),
    { from: 2, to: 1, reached: false },
    file('one', 'b.ts'),
  );
  assert.deepEqual(stuck.places, [chat('a'), file('one', 'b.ts')]);
  assert.equal(stuck.index, 1);
  assert.equal(findStep(stuck, -1, always), 0);
  // Back to chat a, then a click elsewhere before the step was done: the click counts.
  const moved = settleStep(stepTo(history, 0), { from: 2, to: 0, reached: true }, chat('b'));
  assert.deepEqual(moved.places, [chat('a'), chat('b')]);
  assert.equal(moved.index, 1);
  // A step that showed its place changes nothing more.
  const shown = settleStep(stepTo(history, 0), { from: 2, to: 0, reached: true }, chat('a'));
  assert.deepEqual(shown, stepTo(history, 0));
});
