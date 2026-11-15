import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, ManagedRuntime } from 'effect';
import { makeShellClients } from '../src/renderer/ipc/application-clients.ts';
import { makeDesktopIpcLayer, toMessagePortLike } from '../src/renderer/ipc/desktop-ipc.ts';

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
    makeDesktopIpcLayer(Effect.succeed(toMessagePortLike(port1))),
  );
  const shell = makeShellClients(runtime, { connect: async () => {}, pathForFile: () => '' });
  try {
    await assert.rejects(shell.chatTargets(), { code: 'Incompatible' });
    await assert.rejects(shell.createChatWorktree('/root', 'chat\0branch', 'request'), {
      code: 'InvalidInput',
    });
    assert.deepEqual(sent, ['getChatTargets']);
  } finally {
    await runtime.dispose();
    port2.close();
  }
});
