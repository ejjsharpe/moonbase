import assert from 'node:assert/strict';
import { type ErrorGroup, getErrorGroup } from '@moonbase/contracts/error-groups';
import { test } from 'node:test';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { DesktopNative } from '../src/renderer/ipc/desktop-native.ts';
import { makeDesktopIpcLayer, toMessagePortLike } from '../src/renderer/ipc/desktop-ipc.ts';
/** Whether a failure means `group` for its request. */
const inGroup = (group: ErrorGroup) => (error: unknown) => getErrorGroup(error) === group;

test('a reply the renderer cannot decode is Incompatible, and a request its schemas refuse is InvalidInput', async () => {
  const { port1, port2 } = new MessageChannel();
  const sent: string[] = [];
  // A main whose every reply is one no procedure's schema reads as its success.
  port2.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data as string) as { _tag: string; id?: string; tag?: string };
    if (frame._tag !== 'Request') return;
    sent.push(frame.tag!);
    port2.postMessage(
      JSON.stringify({
        _tag: 'Exit',
        requestId: frame.id,
        exit: { _tag: 'Success', value: 42 },
      }),
    );
  });
  port2.start();
  const runtime = ManagedRuntime.make(
    Layer.provide(
      DesktopNative.layer({ connect: async () => {}, pathForFile: () => '' }),
      makeDesktopIpcLayer(Effect.succeed(toMessagePortLike(port1))),
    ),
  );
  const native = await runtime.runPromise(DesktopNative);
  try {
    await assert.rejects(runtime.runPromise(native.chooseChatFolder), inGroup('incompatible'));
    await assert.rejects(
      runtime.runPromise(native.createChatWorktree('/root', 'chat\0branch', 'request')),
      inGroup('refusal'),
    );
    assert.deepEqual(sent, ['chooseChatFolder']);
  } finally {
    await runtime.dispose();
    port2.close();
  }
});
