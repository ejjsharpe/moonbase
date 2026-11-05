import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Harness } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { ManagedRuntime } from 'effect';
import { createMoonbaseApplication } from '@moonbase/application';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import { LocalPiRuntimeLive } from '@moonbase/pi-runtime';
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlledHostFixture, until } from './fixture.ts';
import {
  instrumentTranscriptReads,
  seedTranscriptHistory,
} from '../../packages/pi-runtime/test/transcript-history-fixture.ts';

for (const mode of ['local', 'remote'] as const)
  test(`integrated ${mode} controller reveals evicted Find and around targets across 1,121 real mixed records`, async (t) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'moonbase-around-')));
    const remote =
      mode === 'remote'
        ? await controlledHostFixture(new URL('./stream-host.mjs', import.meta.url), true)
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
          }),
        );
    const root = remote?.root(),
      chat = root?.chat ?? makeChatClient(local!);
    let saved: string | null = null;
    const app = await createMoonbaseApplication({
      chat: async () => ({
        chat,
        context: session,
        mode,
        ...(root ? { connection: root.connection } : {}),
        storage: {
          read: () => saved,
          write: (value: string) => {
            saved = value;
          },
        },
      }),
    });
    const controller = app.chat!;
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
        ? undefined
        : {
            cwd: directory,
            model: { provider: faux.provider.id, modelId: faux.getModel().id },
          },
    );
    const target = controller.getSnapshot().selected!;
    const ids = remote
      ? await remote.seedHistory(target)
      : await seedTranscriptHistory(harness, target);
    await until(
      async () => controller.getSnapshot(),
      (state) =>
        state.snapshot !== null &&
        state.snapshot.transcriptBoundary === ids.at(-1) &&
        (!remote || state.snapshot.observationStatus === 'connected'),
    );
    const counters = async () => (remote ? (await remote.stats()).reads! : structuredClone(reads));
    const work: unknown[] = [];
    for (const index of [1, 561, 1119, 1]) {
      const before = await counters();
      await controller.jumpToEntry(ids[index]);
      const state = controller.getSnapshot().transcript;
      assert.equal(state.error, null);
      assert(state.entries.some((entry) => entry.id === ids[index]));
      assert.equal(new Set(state.entries.map((entry) => entry.id)).size, state.entries.length);
      assert(state.entries.length <= 128);
      const after = await counters(),
        ranges = after.ranges!.slice(before.ranges!.length);
      assert(ranges.length <= 35, `distance-independent around read: ${ranges.length}`);
      assert(ranges.every((range) => range.limit === 1 && range.rows <= 1));
      assert(ranges.filter((range) => range.min === null && range.max === null).length <= 1);
      work.push({ index, ranges });
    }
    for (const index of [1, 561, 1119]) {
      await controller.findTranscript(`record ${index} 🌔`);
      await until(
        async () => controller.getSnapshot().transcript,
        (state) =>
          state.view.anchor?.entryId === ids[index] &&
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
    const input = { target, entryId: ids[561] };
    const first = await chat.command('getChatHistoryAround', input);
    assert(first.olderCursor && first.newerCursor);
    const seen = new Set(first.entries.map((entry) => entry.id));
    assert.equal(seen.size, first.entries.length);
    for (const direction of ['olderCursor', 'newerCursor'] as const) {
      let cursor = first[direction];
      while (cursor) {
        const page = await chat.command('getChatHistoryAround', { ...input, cursor });
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
    assert.match(
      controller.getSnapshot().transcript.error!,
      remote
        ? /Chat request is invalid or differs from its original identity/
        : /Entry does not belong to this conversation/,
    );
    await assert.rejects(
      chat.command('getChatHistoryAround', {
        target: { ...target, actorId: 'different' },
        entryId: ids[561],
      }),
    );
    await assert.rejects(
      chat.command('getChatHistoryAround', {
        target: { ...target, conversationId: '999999998' },
        entryId: ids[561],
      }),
    );
    await mkdir('test-results/qualification-116', { recursive: true });
    await writeFile(
      `test-results/qualification-116/around-${mode}.json`,
      JSON.stringify(
        {
          mode,
          rows: ids.length,
          work,
          traversed: seen.size,
          commands: remote ? (await remote.stats()).commands : undefined,
        },
        null,
        2,
      ),
    );
    assert(!JSON.stringify(saved).includes('qualification record'));
    if (remote)
      assert(
        !(await remote.stats()).commands.some((command) =>
          ['sendChat', 'stopChat'].includes(command),
        ),
      );
  });
