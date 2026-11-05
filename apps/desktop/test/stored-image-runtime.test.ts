import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { iterateTranscriptSource } from '@moonbase/application/chat';
import type { ChatController } from '@moonbase/application/chat';
import type { ChatClient, ChatTranscriptSource } from '@moonbase/contracts/chat';
import { controlledHostFixture, until } from '../../../tests/chat/fixture.ts';
import { createImageRuntime, retainedImage } from './stored-image-fixture.ts';
import { ImageResources, readStoredImage } from '../src/renderer/chat/stored-image.ts';

for (const mode of ['local', 'remote'] as const)
  test(`${mode} retained real images use exact record ownership and independently padded authenticated chunks`, async () => {
    const host =
      mode === 'remote'
        ? await controlledHostFixture(new URL('./stored-image-host.mjs', import.meta.url))
        : undefined;
    const directory =
      host?.directory ?? (await realpath(await mkdtemp(join(tmpdir(), 'moonbase-images-'))));
    const session = host?.session ?? {
      host: { hostId: 'image-host', storeId: 'image-store' },
      actorId: 'personal',
    };
    const local = host
      ? undefined
      : createImageRuntime(
          { ...session, cwd: directory, databasePath: join(directory, 'chat.sqlite') },
          true,
        );
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
            ...(local ? { settings: { cwd: directory, model: local.model } } : {}),
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
      const adapter: Pick<ChatController, 'iterateTranscript'> = {
        iterateTranscript: (source, options) =>
          iterateTranscriptSource({
            source,
            ...options,
            read: async (input, options) => {
              const chunk = await client.command('getChatTranscriptContent', input, options);
              if (chunk.kind === 'content') {
                chunks++;
                if (chunk.data.endsWith('=')) padded++;
              }
              return chunk;
            },
          }),
      };
      const resources = new ImageResources(),
        signal = new AbortController().signal;
      const image = await readStoredImage(
        adapter,
        transcript.source,
        images[0]!,
        resources,
        signal,
      );
      assert.deepEqual(Buffer.from(image.bytes), retainedImage);
      image.release();
      assert(chunks > 1);
      assert(padded > 1);
      for (const source of [
        { ...transcript.source, target: other },
        { ...transcript.source, target: { ...target, actorId: 'foreign' } },
        {
          ...transcript.source,
          target: { ...target, host: { ...target.host, storeId: 'foreign' } },
        },
        { ...transcript.source, entryId: '999999999' },
      ] as ChatTranscriptSource[])
        await assert.rejects(readStoredImage(adapter, source, images[0]!, resources, signal));
      await assert.rejects(
        readStoredImage(
          adapter,
          transcript.source,
          { ...images[0]!, revision: 'b'.repeat(64) },
          resources,
          signal,
        ),
      );
      await assert.rejects(
        readStoredImage(
          adapter,
          transcript.source,
          { ...images[0]!, partId: 'm99.b99' },
          resources,
          signal,
        ),
      );
      for (const corrupt of images.slice(1))
        await assert.rejects(
          readStoredImage(adapter, transcript.source, corrupt, resources, signal),
          /corrupt/,
        );
      resources.reserve(20 * 1024 * 1024, 16 * 1024 * 1024, 2).release();
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
