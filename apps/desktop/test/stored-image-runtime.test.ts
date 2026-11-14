import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Layer, ManagedRuntime } from 'effect';
import type {
  ChatClient,
  ChatTranscriptPart,
  ChatTranscriptSource,
} from '@moonbase/contracts/chat';
import { controlledHostFixture, until } from '../../../tests/chat/fixture.ts';
import { createImageRuntime, retainedImage } from './stored-image-fixture.ts';
import { ChatIpcSession } from '../src/main/chat/session.ts';
import { respondTranscriptImage } from '../src/main/chat/transcript-native.ts';

const ipcRuntime = ManagedRuntime.make(Layer.empty);
after(() => ipcRuntime.dispose());

for (const mode of ['local', 'remote'] as const)
  test(`${mode} retained real images are served by main from exact record ownership and independently padded authenticated chunks`, async () => {
    const host =
      mode === 'remote'
        ? await controlledHostFixture(new URL('./stored-image-faux.mjs', import.meta.url))
        : undefined;
    const directory =
      host?.directory ?? (await realpath(await mkdtemp(join(tmpdir(), 'moonbase-images-'))));
    const session = host?.session ?? {
      host: { hostId: 'image-host', storeId: 'image-store' },
      actorId: 'personal',
    };
    const local = host
      ? undefined
      : createImageRuntime({ ...session, databasePath: join(directory, 'chat.sqlite') });
    const root = host?.root();
    let connectionId: string | undefined;
    try {
      if (root)
        connectionId =
          (await root.connection.command('connect', { profileId: root.profile.id })).connectionId ??
          undefined;
      const client: ChatClient = root?.chat ?? local!.client;
      const create = async (requestId: string) =>
        (
          await client.command('createChat', {
            session,
            requestId,
            title: requestId,
            settings: host?.settings ?? { cwd: directory, model: local!.model },
          })
        ).conversation.target;
      const target = await create('images'),
        other = await create('other');
      await client.command('sendChat', {
        target,
        requestId: 'send-images',
        text: 'Retain the controlled images',
      });
      const snapshot = await until(
        () => client.command('getChat', { target }),
        (snapshot) =>
          snapshot.entries.some((entry) =>
            entry.transcript?.parts.some((part) => part.kind === 'image'),
          ),
      );
      const transcript = snapshot.entries.find((entry) =>
        entry.transcript?.parts.some((part) => part.kind === 'image'),
      )!.transcript!;
      const images = transcript.parts.filter((part) => part.kind === 'image');
      assert.equal(images.length, 3);
      let chunks = 0,
        padded = 0;
      const reader: ChatClient = {
        ...client,
        command: async (operation, input, options) => {
          const reply = await client.command(operation, input, options);
          if (operation === 'getChatTranscriptContent' && reply && 'data' in reply) {
            chunks++;
            if (reply.data.endsWith('=')) padded++;
          }
          return reply;
        },
      };
      const ipc = new ChatIpcSession(ipcRuntime, reader, { mode: 'local' }, session, () => {});
      let id = 0;
      const serve = async (source: ChatTranscriptSource, part: ChatTranscriptPart) => {
        const reply = await ipc
          .call(
            'transcript',
            'image',
            {
              source,
              selection: { partId: part.partId, bytes: part.bytes, revision: part.revision },
              mimeType: part.mimeType,
            },
            `image-${id++}`,
          )
          .catch((error: { code: string }) => ({ ok: false as const, error }));
        if (!reply.ok) return reply.error.code;
        const response = await respondTranscriptImage(
          new Request(reply.value as string),
          'csp',
          (token) => ipc.findImage(token),
        );
        return response.ok ? Buffer.from(await response.arrayBuffer()) : response.status;
      };
      assert.deepEqual(await serve(transcript.source, images[0]!), retainedImage);
      assert(chunks > 1);
      assert(padded > 1);
      for (const source of [
        { ...transcript.source, target: { ...target, actorId: 'foreign' } },
        {
          ...transcript.source,
          target: { ...target, host: { ...target.host, storeId: 'foreign' } },
        },
      ] as ChatTranscriptSource[])
        assert.equal(await serve(source, images[0]!), 'Unauthorized');
      for (const source of [
        { ...transcript.source, target: other },
        { ...transcript.source, entryId: '999999999' },
      ] as ChatTranscriptSource[])
        assert.equal(await serve(source, images[0]!), 502);
      assert.equal(
        await serve(transcript.source, { ...images[0]!, revision: 'b'.repeat(64) }),
        502,
      );
      assert.equal(await serve(transcript.source, { ...images[0]!, partId: 'm99.b99' }), 502);
      // A truncated PNG keeps its signature, so Chromium's decoder reports it; HTML is refused here.
      assert.deepEqual(await serve(transcript.source, images[1]!), retainedImage.subarray(0, -1));
      assert.equal(await serve(transcript.source, images[2]!), 415);
      await ipc.dispose();
      assert.equal(ipc.count, 0);
    } finally {
      if (root && connectionId)
        await root.connection.command('disconnect', { connectionId }).catch(() => {});
      if (host) {
        const report = await host.close();
        assert(report.hostPids.length > 0);
        assert(report.forwardPids.length > 0);
      } else {
        await local!.runtime.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
