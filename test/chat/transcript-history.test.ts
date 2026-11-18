import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Harness } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { Effect, Layer, ManagedRuntime } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { openChatApplication } from './chat-application-fixture.ts';
import type { ChatPort } from '@moonbase/application/chat';
import { ChatService } from '@moonbase/contracts/services';
import { LocalPiRuntimeLive } from '@moonbase/chat-runtime';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlledHostFixture, until } from './controlled-host-fixture.ts';
import {
  instrumentTranscriptReads,
  seedTranscriptHistory,
  seedTranscriptLongText,
} from '../../packages/chat-runtime/test/transcript/transcript-history-fixture.ts';
import { scaledTranscriptLimits as limits } from '../../packages/application/test/chat/transcript/transcript-limits-fixture.ts';

/**
 * The client keeps an eighth of production's transcript limits, so history a little past its
 * record budget and one part a little past its content budget are evicted from.
 */
const records = 141,
  repeats = 200_000;

for (const mode of ['local', 'remote'] as const)
  test(`integrated ${mode} controller reveals evicted Find and around targets across real mixed records past the record budget`, async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-around-')));
    const remote =
      mode === 'remote'
        ? await controlledHostFixture(new URL('./faux-stream.mjs', import.meta.url), true)
        : undefined;
    let harness!: Harness, reads!: ReturnType<typeof instrumentTranscriptReads>;
    if (!remote) {
      const open = Harness.open;
      t.mock.method(Harness, 'open', async (...args: Parameters<typeof open>) => {
        harness = await open(...args);
        reads = instrumentTranscriptReads(harness);
        return harness;
      });
    }
    const faux = fauxProvider(),
      models = createModels();
    models.setProvider(faux.provider);
    const session = remote?.session ?? {
      host: { hostId: 'qualification-local', storeId: 'temporary' },
      actorId: 'owner',
    };
    const local = remote
      ? undefined
      : ManagedRuntime.make(
          LocalPiRuntimeLive({
            ...session,
            databasePath: join(directory, 'chat.sqlite'),
            models,
          }).pipe(Layer.provide(NodeServices.layer)),
        );
    const root = remote?.root(),
      chat = root?.ports.chat ?? ((await local!.runPromise(ChatService)) as ChatPort);
    /** One command of the chat's port, as a Promise. */
    const command = <I, A, E>(call: (input: I) => Effect.Effect<A, E>, input: I) =>
      Effect.runPromise(call(input));
    let saved: string | null = null;
    const app = await openChatApplication(() => ({
      chat,
      context: session,
      // The remote host is the daemon in host mode: local-mode chats over a connection.
      transcriptLimits: limits,
      ...(root ? { connection: root.ports.connection } : {}),
      storage: {
        read: () => saved,
        write: (value: string) => {
          saved = value;
        },
      },
    }));
    const controller = app.chat;
    t.after(async () => {
      try {
        await app.dispose();
      } finally {
        try {
          if (remote) await remote.close();
          else await local!.dispose();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    });
    await controller.start();
    if (remote) await controller.connect();
    await until(
      async () => controller.getSnapshot(),
      (state) => state.ready && !!state.host,
    );
    await controller.create(
      'Integrated range qualification',
      remote
        ? remote.settings
        : {
            cwd: directory,
            model: { provider: faux.provider.id, modelId: faux.getModel().id },
          },
    );
    const target = controller.getSnapshot().selected!;
    const ids = remote
      ? await remote.seedHistory(target, records)
      : await seedTranscriptHistory(harness, target, records);
    await until(
      async () => controller.getSnapshot(),
      (state) =>
        state.snapshot !== null &&
        state.snapshot.transcriptBoundary === ids.at(-1) &&
        (!remote || state.snapshot.observationStatus === 'connected'),
    );
    const counters = async () => (remote ? (await remote.stats()).reads! : structuredClone(reads));
    for (const index of [1, 70, 139, 1]) {
      const before = await counters();
      await controller.jumpToEntry(ids[index]);
      const state = controller.getSnapshot().transcript;
      assert.equal(state.error, null);
      assert(state.entries.some((entry) => entry.id === ids[index]));
      assert.equal(new Set(state.entries.map((entry) => entry.id)).size, state.entries.length);
      assert(state.entries.length <= limits.summaryRecords);
      const after = await counters(),
        ranges = after.ranges!.slice(before.ranges!.length);
      assert(ranges.length <= 35, `distance-independent around read: ${ranges.length}`);
      assert(ranges.every((range) => range.limit === 1 && range.rows <= 1));
      assert(ranges.filter((range) => range.min === null && range.max === null).length <= 1);
    }
    for (const index of [1, 70, 139]) {
      await controller.findTranscript(`record ${index} 🌔`);
      await until(
        async () => controller.getSnapshot().transcript,
        (state) =>
          state.view.anchor?.key === `entry:${ids[index]}` &&
          state.entries.some((entry) => entry.id === ids[index]),
      );
      const state = controller.getSnapshot().transcript;
      assert.equal(state.find.error, null);
      assert.equal(state.find.status, 'complete');
      assert.equal(state.find.count, 1);
      assert.equal(state.find.upperEntryId, ids.at(-1));
      assert.equal(state.find.active?.source.entryId, ids[index]);
      assert(state.entries.some((entry) => entry.id === ids[index]));
      assert.equal(
        state.find.active!.snippet.text.slice(
          state.find.active!.start - state.find.active!.snippet.start,
          state.find.active!.end - state.find.active!.snippet.start,
        ),
        `record ${index} 🌔`,
      );
    }
    controller.closeFind();
    const input = { target, entryId: ids[70] };
    const first = await command(chat.getChatHistoryAround, input);
    assert(first.olderCursor && first.newerCursor);
    const seen = new Set(first.entries.map((entry) => entry.id));
    assert.equal(seen.size, first.entries.length);
    for (const direction of ['olderCursor', 'newerCursor'] as const) {
      let cursor = first[direction];
      while (cursor) {
        const page = await command(chat.getChatHistoryAround, { ...input, cursor });
        assert.equal(page.upperEntryId, first.upperEntryId);
        assert.equal(page.cursor, cursor);
        assert(page.entries.length <= 32);
        assert(Buffer.byteLength(JSON.stringify(page)) < 256 * 1024);
        for (const entry of page.entries) {
          assert(!seen.has(entry.id), 'inclusive bounds cannot duplicate an emitted entry');
          seen.add(entry.id);
        }
        cursor = page[direction];
      }
    }
    assert.deepEqual([...seen].sort(), [...ids].sort());
    await controller.jumpToEntry('999999999');
    // A remote host's refusal shows the client's own text for its reason, as a local one does.
    assert.match(
      controller.getSnapshot().transcript.error!,
      /Entry does not belong to this conversation/,
    );
    await assert.rejects(
      command(chat.getChatHistoryAround, {
        target: { ...target, actorId: 'different' },
        entryId: ids[70],
      }),
    );
    await assert.rejects(
      command(chat.getChatHistoryAround, {
        target: { ...target, conversationId: '999999998' },
        entryId: ids[70],
      }),
    );
    const long = remote
      ? await remote.seedLongText(target, repeats)
      : await seedTranscriptLongText(harness, target, repeats);
    await until(
      async () => controller.getSnapshot(),
      (state) => state.snapshot?.transcriptBoundary === long.entryId,
    );
    await controller.findTranscript('needle');
    await controller.nextFindMatch();
    await until(
      async () => controller.getSnapshot().transcript,
      (state) => state.view.anchor?.key === `entry:${long.entryId}`,
    );
    const row = controller
      .getSnapshot()
      .transcript.entries.find((entry) => entry.id === long.entryId)!;
    const source = row.transcript!.source,
      part = row.transcript!.parts[0];
    const selection = { partId: part.partId, bytes: part.bytes, revision: part.revision };
    assert.equal(part.bytes, long.bytes);
    const content = () =>
      controller
        .getSnapshot()
        .transcript.content.find(
          (item) => item.source.kind === 'entry' && item.source.entryId === long.entryId,
        );
    let peak = 0;
    while ((content()?.loadedText ?? 0) < long.late + 6) {
      const before = content()?.loadedBytes ?? 0;
      await controller.loadTranscriptPart(source, selection);
      assert.equal(content()?.error, null);
      assert(content()!.loadedBytes > before);
      peak = Math.max(
        peak,
        controller
          .getSnapshot()
          .transcript.content.reduce(
            (total, item) => total + Buffer.byteLength(JSON.stringify(item)),
            0,
          ),
      );
      assert(peak <= limits.contentBytes);
    }
    const tail = content()!,
      near = controller.getSnapshot().transcript.find;
    assert.equal(near.error, null);
    assert.equal(near.count, 2);
    assert.equal(near.active?.start, long.late);
    assert.equal(near.upperEntryId, long.entryId);
    const retainedUTF16Base = tail.chunks[0].textOffset;
    assert(tail.retainedFrom > 0 && retainedUTF16Base !== undefined && retainedUTF16Base > 0);
    const marked = tail.chunks.find(
      (chunk) =>
        chunk.textOffset !== undefined &&
        chunk.textOffset <= long.late &&
        chunk.textOffset + chunk.data.length >= long.late + 6,
    );
    assert(marked && marked.textOffset !== undefined);
    assert.equal(
      marked.data.slice(long.late - marked.textOffset, long.late - marked.textOffset + 6),
      'NEEDLE',
    );
    await controller.previousFindMatch();
    await controller.loadTranscriptPart(source, selection, true);
    // The host may serve the prefix from its built-parts cache, so the reread
    // is proven by the controller's retained range rather than SDK entry reads.
    assert.equal(content()!.retainedFrom, 0);
    assert.equal(content()!.chunks[0].textOffset, 0);
    assert(content()!.chunks[0].data.startsWith('early NEEDLE 😀\r\n'));
    assert.equal(controller.getSnapshot().transcript.find.active?.start, 6);
    assert.equal(controller.getSnapshot().transcript.find.upperEntryId, near.upperEntryId);
    controller.closeFind();
    assert(!JSON.stringify(saved).includes('qualification record'));
    assert(!JSON.stringify(saved).includes('NEEDLE'));
    if (remote)
      assert(
        !(await remote.stats()).commands.some((command) =>
          ['sendChat', 'stopChat'].includes(command),
        ),
      );
  });
