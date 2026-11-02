import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import { makeChatModel, makeChatController } from '@moonbase/chat';
import { decodeChatInput } from '@moonbase/contracts/chat-schema';
import { decodeEditorRecovery } from '@moonbase/contracts/workspace-schema';

const fixture = (name) =>
  readFileSync(
    new URL(`../docs/fixtures/headless-baseline/${name}-v1.txt`, import.meta.url),
    'utf8',
  );
for (const [name, decode] of [
  ['send', (value) => decodeChatInput('sendChat', value)],
  ['stop', (value) => decodeChatInput('stopChat', value)],
  ['recovery', (value) => decodeEditorRecovery(value)],
]) {
  const bytes = fixture(name);
  assert.equal(
    JSON.stringify(decode(JSON.parse(bytes))),
    bytes,
    `${name}: baseline serialization changed`,
  );
}
let bytes = fixture('chat');
const original = bytes,
  saved = JSON.parse(bytes);
const runtime = ManagedRuntime.make(Layer.empty),
  scope = Scope.makeUnsafe();
const unavailable = () => {
  throw Error('Import/acquisition/preservation must not invoke capabilities');
};
try {
  const model = await runtime.runPromise(
    Effect.provideService(
      makeChatModel({
        context: saved.session,
        chat: { command: unavailable, watch: unavailable },
        connection: { command: unavailable, watch: unavailable },
        storage: {
          read: () => bytes,
          write: (value) => {
            bytes = value;
          },
        },
      }),
      Scope.Scope,
      scope,
    ),
  );
  const controller = makeChatController(runtime, model);
  assert.equal(controller.getSnapshot().draft, saved.drafts[0].text);
  assert.deepEqual(controller.getSnapshot().pending, saved.pending);
  assert.equal(controller.preserve(), true);
  assert.equal(bytes, original, 'baseline saved chat bytes changed');
  await controller.dispose();
} finally {
  await runtime.runPromise(Scope.close(scope, Exit.void));
  await runtime.dispose();
}
console.log('Baseline-produced saved chat/recovery and Send/Stop bytes remain compatible.');
