import assert from 'node:assert/strict';
import { getErrorGroup } from '@moonbase/contracts/error-groups';
import { test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import type { ChatTranscriptPart, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { controlledHostFixture, until } from '../../../test/chat/controlled-host-fixture.ts';
import { createImageRuntime, retainedImage } from './fixtures/stored-image-fixture.ts';
import { respondTranscriptImage } from '../src/main/chat/transcript-native.ts';
import {
  fakeChatTargets,
  toChatService,
  type FakeChat,
  makeIpcFixture,
} from './fixtures/ipc-fixture.ts';

for (const mode of ['local', 'remote'] as const)
  test(`${mode} retained real images are served by main from exact record ownership and independently padded authenticated chunks`, async () => {
    const host =
      mode === 'remote'
        ? await controlledHostFixture(new URL('./fixtures/faux-stored-image.mjs', import.meta.url))
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
      const client = root?.chat ?? local!.client;
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
      const reader: FakeChat = {
        ...client,
        command: async (operation, input, options) => {
          const reply = await client.command(operation, input as never, options);
          if (operation === 'getChatTranscriptContent' && reply && 'data' in reply) {
            chunks++;
            if (reply.data.endsWith('=')) padded++;
          }
          return reply as never;
        },
      };
      const desktop = await makeIpcFixture({
        chat: {
          backends: fakeChatTargets({ local: { chat: toChatService(reader), context: session } }),
        },
      });
      const serve = async (source: ChatTranscriptSource, part: ChatTranscriptPart) => {
        const url = await desktop
          .target('local')
          .transcript.imageUrl({
            source,
            selection: { partId: part.partId, bytes: part.bytes, revision: part.revision },
            mimeType: part.mimeType as 'image/png',
          })
          .catch((error: unknown) => getErrorGroup(error) ?? 'unknown');
        if (!url.startsWith('moonbase:')) return url;
        const response = await Effect.runPromise(
          respondTranscriptImage(new Request(url), 'csp', await desktop.findImages()),
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
        assert.equal(await serve(source, images[0]!), 'access');
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
      await desktop.dispose();
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
