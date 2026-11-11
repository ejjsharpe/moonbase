import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatSnapshot } from '@moonbase/contracts/chat';
import { controlledHostFixture, until } from './fixture.ts';
import { keyedModel } from './faux-model.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }, hold = false) {
  const f = await controlledHostFixture(new URL('./faux-reply.mjs', import.meta.url), hold);
  t.after(async () => {
    await f.close();
  });
  return f;
}

test('combined public root requires explicit verified Connect, then saves/lists/streams a chat through controlled forwarding', async (t) => {
  const f = await fixture(t),
    client = f.root();
  assert.equal((await client.connection.command('getConnection', {})).state, 'disconnected');
  await assert.rejects(client.chat.command('getChatHost', { host: f.session.host }), {
    code: 'Unavailable',
  });
  const connected = await client.connection.command('connect', { profileId: client.profile.id });
  assert.equal(connected.state, 'connected');
  assert(!JSON.stringify(connected).includes(f.token));
  assert(!JSON.stringify(connected).includes('http://'));
  // The host is the daemon in host mode: each chat chooses its folder and model.
  const host = await client.chat.command('getChatHost', { host: f.session.host });
  assert('mode' in host && host.mode === 'local');
  const input = {
    session: f.session,
    requestId: 'create-one',
    title: 'Saved remote chat',
    settings: f.settings,
  };
  const created = await client.chat.command('createChat', input);
  assert.deepEqual(await client.chat.command('createChat', input), created);
  assert.equal(
    (await client.chat.command('listChats', { session: f.session })).conversations.length,
    1,
  );
  const target = created.conversation.target,
    snapshots: ChatSnapshot[] = [],
    errors: ApplicationError[] = [];
  const unsubscribe = client.chat.watch(
    { target },
    (value) => snapshots.push(value),
    (error) => errors.push(error),
  );
  await client.chat.command('sendChat', { target, requestId: 'send-one', text: 'Send once' });
  await until(
    () => client.chat.command('getChat', { target }),
    (value) => !value.run && value.entries.some((entry) => entry.text === 'REMOTE COMPLETED'),
  );
  await until(
    async () => snapshots,
    (value) =>
      value.some((snapshot) => snapshot.entries.some((entry) => entry.text === 'REMOTE COMPLETED')),
  );
  await unsubscribe();
  assert.deepEqual(errors, []);
  assert.equal((await f.stats()).calls, 1);
  const children = (await readFile(f.log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { event: string });
  assert.equal(
    children.filter((row) => row.event === 'forward').length,
    1,
    'Chat and Connection clients share one acquired transport',
  );
});

test('through the forward, a remote client chooses host folders from approved roots, sets up a faux provider, chooses its model and searches with @', async (t) => {
  const f = await fixture(t),
    client = f.root();
  await client.connection.command('connect', { profileId: client.profile.id });
  const project = join(f.cwd, 'project'),
    outside = join(f.directory, 'outside');
  await mkdir(project);
  await mkdir(outside);
  await writeFile(join(project, 'notes.md'), 'remote notes');
  await symlink(outside, join(f.cwd, 'escape'));
  const folders = await client.folders();
  const host = f.session.host;
  // No native picker reaches the host's disk: the client offers the roots and their folders.
  assert.deepEqual(await client.runtime.runPromise(folders.listHostFolders({ host })), {
    folders: [f.cwd, project],
  });

  // Provider setup runs on the host; the faux key never reaches a real provider.
  const owner = client.providers('remote-document');
  const before = await owner.command('getProviders', {});
  assert.equal(before.providers.find((p) => p.id === keyedModel.provider)?.configured, false);
  const flow = (
    await owner.command('startProviderLogin', {
      providerId: keyedModel.provider,
    })
  ).flow!;
  const prompt = await until(
    () => owner.command('getProviders', {}),
    (state) => state.flow?.prompt?.type === 'secret',
  );
  await owner.command('answerProviderPrompt', {
    flowId: flow.id,
    promptId: prompt.flow!.prompt!.id,
    answer: 'faux-host-key',
  });
  await until(
    () => owner.command('getProviders', {}),
    (state) => state.providers.find((p) => p.id === keyedModel.provider)?.configured === true,
  );

  // The chat chooses a folder under the root, the newly set up model and its reasoning effort.
  const found = await client.chat.command('findChatFiles', {
    session: f.session,
    cwd: project,
    query: 'notes',
  });
  assert.deepEqual(
    found.matches.map((match) => match.path),
    ['notes.md'],
  );
  const created = await client.chat.command('createChat', {
    session: f.session,
    requestId: 'keyed',
    title: 'Keyed model',
    settings: { cwd: project, model: keyedModel, reasoningEffort: 'low' },
  });
  const target = created.conversation.target;
  assert.equal(created.conversation.cwd, project);
  await client.chat.command('sendChat', {
    target,
    requestId: 'keyed-send',
    text: 'Read @notes.md',
    mentions: [{ path: 'notes.md' }],
  });
  const done = await until(
    () => client.chat.command('getChat', { target }),
    (value) => !value.run && value.entries.some((entry) => entry.text === 'KEYED COMPLETED'),
  );
  assert.equal(done.conversation.model, `${keyedModel.provider}/${keyedModel.modelId}`);
  assert.equal(done.conversation.reasoningEffort, 'low');

  // Folders outside the roots, links out of them, and searches there are refused.
  for (const [requestId, cwd] of [
    ['outside', outside],
    ['escape', join(f.cwd, 'escape')],
  ] as const)
    await assert.rejects(
      client.chat.command('createChat', {
        session: f.session,
        requestId,
        title: 'Refused',
        settings: { cwd, model: f.model },
      }),
      (error: { code: string }) => ['Unauthorized', 'InvalidInput'].includes(error.code),
    );
  await assert.rejects(
    client.chat.command('findChatFiles', {
      session: f.session,
      cwd: outside,
      query: 'x',
    }),
    { code: 'Unauthorized' },
  );
  assert.equal((await f.stats()).calls, 1);
});

test('a lost Send response and client closure retain original receipt; reconnect/store reopen do not Send again', async (t) => {
  const f = await fixture(t, true),
    first = f.root();
  await first.connection.command('connect', { profileId: first.profile.id });
  const created = await first.chat.command('createChat', {
      session: f.session,
      settings: f.settings,
      requestId: 'create',
      title: 'Retained',
    }),
    target = created.conversation.target;
  const input = { target, requestId: 'immutable-send', text: 'Only one admitted input' };
  await f.loseNextSend();
  await assert.rejects(first.chat.command('sendChat', input), { code: 'Uncertain' });
  await until(f.stats, (value) => value.calls === 1);
  await first.runtime.dispose();
  f.release();
  const second = f.root();
  await second.connection.command('connect', { profileId: second.profile.id });
  const receipt = await second.chat.command('getChatSend', { target, requestId: input.requestId });
  assert.equal(receipt?.admission, 'admitted');
  await until(
    () => second.chat.command('getChat', { target }),
    (value) => !value.run && value.entries.some((entry) => entry.text === 'REMOTE COMPLETED'),
  );
  assert.equal((await f.stats()).commands.filter((name) => name === 'sendChat').length, 1);
  assert.equal(
    (await readFile(f.log, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('drop-send-response')).length,
    1,
  );
  await second.runtime.dispose();
  await f.stopHost();
  await f.startHost();
  const third = f.root();
  await third.connection.command('connect', { profileId: third.profile.id });
  assert.deepEqual(
    await third.chat.command('getChatSend', { target, requestId: input.requestId }),
    receipt,
  );
  const state = await third.chat.command('getChat', { target });
  assert.equal(
    state.entries.filter((entry) => entry.role === 'user' && entry.text === input.text).length,
    1,
  );
  assert.equal((await f.stats()).calls, 0);
});

test('disconnect denies commands without implicit reconnect; stale Disconnect and captured cooperative Stop preserve exact generations', async (t) => {
  const f = await fixture(t, true),
    first = f.root();
  const old = await first.connection.command('connect', { profileId: first.profile.id });
  assert.equal(old.state, 'connected');
  const created = await first.chat.command('createChat', {
      session: f.session,
      settings: f.settings,
      requestId: 'create',
      title: 'Stop exact work',
    }),
    target = created.conversation.target;
  await first.chat.command('sendChat', { target, requestId: 'send', text: 'Held work' });
  const run = await until(
      () => first.chat.command('getChat', { target }),
      (state) => !!state.run,
    ),
    stop = run.run!.stop;
  await first.connection.command('disconnect', { connectionId: old.connectionId! });
  await assert.rejects(first.chat.command('getChat', { target }), { code: 'Unavailable' });
  assert.equal((await first.connection.command('getConnection', {})).state, 'disconnected');
  const current = await first.connection.command('connect', { profileId: first.profile.id });
  assert.notEqual(current.connectionId, old.connectionId);
  await assert.rejects(
    first.connection.command('disconnect', { connectionId: old.connectionId! }),
    { code: 'Conflict' },
  );
  assert.equal((await first.connection.command('getConnection', {})).state, 'connected');
  const result = await first.chat.command('stopChat', { stop, requestId: 'stop-exact' });
  assert.deepEqual(result.stop, stop);
  assert(['pending', 'stopped', 'terminal'].includes(result.outcome));
  f.release();
  await until(
    () => first.chat.command('getChat', { target }),
    (value) => value.run === null,
  );
  assert.equal((await f.stats()).commands.filter((name) => name === 'sendChat').length, 1);
});

test('a signed health reply for another exact host cannot connect or expose a chat endpoint', async (t) => {
  const f = await fixture(t),
    wrong = f.root({ ...f.session.host, hostId: 'other-host' });
  await assert.rejects(wrong.connection.command('connect', { profileId: wrong.profile.id }), {
    code: 'Incompatible',
  });
  assert.equal((await wrong.connection.command('getConnection', {})).state, 'failed');
  await assert.rejects(wrong.chat.command('getChatHost', { host: wrong.profile.expected }));
  assert.equal((await f.stats()).calls, 0);
  assert((await f.stats()).commands.every((name) => name === 'getChatHost'));
});

for (const operation of ['createChat', 'sendChat', 'stopChat'] as const)
  test(`Disconnect after committed ${operation} preserves uncertainty and original identity across real forwarding teardown`, async (t) => {
    const f = await fixture(t, true),
      client = f.root();
    const connected = await client.connection.command('connect', { profileId: client.profile.id });
    const create = {
      session: f.session,
      settings: f.settings,
      requestId: 'captured-create',
      title: 'Captured conversation',
    };
    const created =
      operation === 'createChat' ? undefined : await client.chat.command('createChat', create);
    const target = created?.conversation.target;
    const send = {
      target: target!,
      requestId: 'captured-send',
      text: 'Exactly one admitted input',
    };
    const stop =
      operation === 'stopChat'
        ? await (async () => {
            await client.chat.command('sendChat', send);
            return (
              await until(
                () => client.chat.command('getChat', { target: target! }),
                (value) => !!value.run?.stop.taskId,
              )
            ).run!.stop;
          })()
        : undefined;
    await f.holdReply(operation);
    let work;
    if (operation === 'createChat') work = client.chat.command('createChat', create);
    else if (operation === 'sendChat') work = client.chat.command('sendChat', send);
    else work = client.chat.command('stopChat', { stop: stop!, requestId: 'captured-stop' });
    const outcome = work.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    await until(f.stats, (value) => value.heldReplies.includes(operation));
    assert.equal(
      (await client.connection.command('getConnection', {})).state,
      'connected',
      'unrelated commands remain responsive while the mutation reply is held',
    );
    await client.connection.command('disconnect', { connectionId: connected.connectionId! });
    assert.equal((await client.connection.command('getConnection', {})).state, 'disconnected');
    const result = await outcome;
    assert.equal(
      (result.error as ApplicationError)?.code,
      'Uncertain',
      'dispatch may have committed; retain the original identity',
    );
    assert.equal((await f.stats()).commands.filter((name) => name === operation).length, 1);
    await f.releaseReply();
    const next = await client.connection.command('connect', { profileId: client.profile.id });
    assert.notEqual(next.connectionId, connected.connectionId);
    if (operation === 'createChat') {
      const listed = await client.chat.command('listChats', { session: f.session });
      assert.equal(listed.conversations.length, 1);
      const retried = await client.chat.command('createChat', create);
      assert.deepEqual(retried.conversation.target, listed.conversations[0]!.target);
      assert.equal(
        (await client.chat.command('listChats', { session: f.session })).conversations.length,
        1,
      );
      assert.equal((await f.stats()).calls, 0);
    } else {
      const receipt = await client.chat.command('getChatSend', {
        target: target!,
        requestId: send.requestId,
      });
      assert.equal(receipt?.admission, 'admitted');
      if (operation === 'stopChat') {
        const retried = await client.chat.command('stopChat', {
          stop: stop!,
          requestId: 'captured-stop',
        });
        assert.deepEqual(retried.stop, stop);
      }
      f.release();
      await until(
        () => client.chat.command('getChat', { target: target! }),
        (value) => !value.run,
      );
      const snapshot = await client.chat.command('getChat', { target: target! });
      assert.equal(
        snapshot.entries.filter((entry) => entry.role === 'user' && entry.text === send.text)
          .length,
        1,
      );
      assert.equal(
        (await f.stats()).commands.filter((name) => name === 'sendChat').length,
        1,
        'reconnect and receipt lookup never resend',
      );
      assert.equal((await f.stats()).calls, 1);
    }
  });

test('transcript reads cross the real child/forwarding boundary with identity, lost/tampered/held replies, cancellation and independent Stop', async (t) => {
  const f = await fixture(t, true),
    client = f.root();
  const connected = await client.connection.command('connect', { profileId: client.profile.id });
  const target = (
    await client.chat.command('createChat', {
      session: f.session,
      settings: f.settings,
      requestId: 'transcript',
      title: 'Transcript',
    })
  ).conversation.target;
  await client.chat.command('sendChat', {
    target,
    requestId: 'run',
    text: 'Retained user content 😀',
  });
  const live = await until(
    () => client.chat.command('getChat', { target }),
    (view) => !!view.run && view.entries.some((entry) => entry.role === 'user'),
  );
  const source = live.entries.find((entry) => entry.role === 'user')!.transcript!.source;
  const parts = await client.chat.command('getChatTranscriptContent', { source });
  assert(parts.kind === 'manifest');
  const descriptor = parts.parts[0],
    selection = {
      partId: descriptor.partId,
      bytes: descriptor.bytes,
      revision: descriptor.revision,
    };
  const request = { source, selection };
  await f.loseNextReply('getChatTranscriptContent');
  await assert.rejects(client.chat.command('getChatTranscriptContent', request), {
    code: 'Unavailable',
  });
  const content = await client.chat.command('getChatTranscriptContent', request);
  assert(content.kind === 'content');
  assert.equal(content.data, 'Retained user content 😀');
  assert.deepEqual(content.source, source);
  await f.tamperNextReply('getChatTranscriptContent');
  await assert.rejects(client.chat.command('getChatTranscriptContent', request));
  const other = (
    await client.chat.command('createChat', {
      session: f.session,
      settings: f.settings,
      requestId: 'other',
      title: 'Other',
    })
  ).conversation.target;
  for (const wrong of [
    other,
    { ...target, actorId: 'other' },
    { ...target, host: { ...target.host, storeId: 'other' } },
  ])
    await assert.rejects(
      client.chat.command('getChatTranscriptContent', {
        ...request,
        source: { ...source, target: wrong },
      }),
    );
  assert(source.kind === 'entry');
  const around = await client.chat.command('getChatHistoryAround', {
    target,
    entryId: source.entryId,
  });
  assert.deepEqual(around.target, target);
  assert.equal(around.entryId, source.entryId);
  await f.holdReply('getChatTranscriptContent');
  const abort = new AbortController();
  const pending = client.chat.command('getChatTranscriptContent', request, {
    signal: abort.signal,
  });
  const cancelled = assert.rejects(pending, { code: 'Cancelled' });
  await until(f.stats, (stats) => stats.heldReplies.includes('getChatTranscriptContent'));
  assert.equal((await client.chat.command('getChat', { target: other })).state, 'idle');
  const stop = await client.chat.command('stopChat', { stop: live.run!.stop, requestId: 'stop' });
  assert.deepEqual(stop.stop, live.run!.stop);
  abort.abort();
  await cancelled;
  await f.releaseReply();
  await f.holdReply('getChatHistoryAround');
  const stale = client.chat.command('getChatHistoryAround', { target, entryId: source.entryId });
  const disconnected = assert.rejects(stale, { code: 'Unavailable' });
  await until(f.stats, (stats) => stats.heldReplies.includes('getChatHistoryAround'));
  await client.connection.command('disconnect', { connectionId: connected.connectionId! });
  await disconnected;
  await f.releaseReply();
  const reconnected = await client.connection.command('connect', { profileId: client.profile.id });
  assert.notEqual(reconnected.connectionId, connected.connectionId);
  assert.equal((await client.chat.command('getChatTranscriptContent', request)).kind, 'content');
  assert.equal(
    (await f.stats()).commands.filter((operation) => operation === 'sendChat').length,
    1,
  );
});

test('cross-process capable observation streams thinking/text before completion, reuses history and ignores unrelated B without recurring reads', async (t) => {
  const f = await controlledHostFixture(new URL('./faux-stream.mjs', import.meta.url), true);
  t.after(() => f.close().then(() => {}));
  const root = f.root();
  await root.connection.command('connect', { profileId: root.profile.id });
  const target = (
    await root.chat.command('createChat', {
      session: f.session,
      requestId: 'stream-A',
      title: 'A',
      settings: f.settings,
    })
  ).conversation.target;
  const other = (
    await root.chat.command('createChat', {
      session: f.session,
      requestId: 'stream-B',
      title: 'B',
      settings: f.settings,
    })
  ).conversation.target;
  const views: ChatSnapshot[] = [],
    errors: ApplicationError[] = [];
  const close = root.chat.watch(
    { target },
    (value) => views.push(value),
    (error) => errors.push(error),
  );
  t.after(() => close());
  await until(
    async () => views.at(-1),
    (v) => !!v && v.state === 'idle',
  );
  await root.chat.command('sendChat', { target, requestId: 'stream-send', text: 'Stream' });
  await until(
    async () => views.at(-1),
    (v) => v?.run?.text === 'first remote text 0',
  );
  const first = views.at(-1)!;
  assert.equal(first.run!.transcript!.thinking, 'available');
  assert(
    first.run!.transcript!.parts.some(
      (p) => p.kind === 'thinking' && p.text.includes('remote thinking'),
    ),
  );
  const before = (await f.stats()).reads;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(views.at(-1)!.run!.text, 'first remote text 0');
  f.nextChunk();
  await until(
    async () => views.at(-1),
    (v) => v?.run?.text === 'first remote text 4',
  );
  const after = await f.stats();
  assert.deepEqual(after.reads, before);
  assert.equal(after.commands.filter((c) => c === 'getChat').length, 0);
  assert.deepEqual(views.at(-1)!.run!.transcript!.source, first.run!.transcript!.source);
  assert.equal(views.at(-1)!.transcriptBoundary, first.transcriptBoundary);
  const publications = after.publications;
  await root.chat.command('sendChat', { target: other, requestId: 'unrelated-B', text: 'B' });
  await until(f.stats, (s) => s.calls === 2);
  await new Promise((r) => setTimeout(r, 300));
  const b = await f.stats();
  assert.equal(b.publications, publications);
  assert.deepEqual(b.reads, after.reads);
  f.release();
  const complete = await until(
    async () => views.at(-1),
    (v) => !!v && !v.run && v.entries.some((entry) => entry.text === 'REMOTE COMPLETED'),
  );
  assert.notEqual(complete!.transcriptBoundary, first.transcriptBoundary);
  assert.equal(complete!.entries.filter((entry) => entry.text === 'REMOTE COMPLETED').length, 1);
  await close();
  await until(f.stats, (s) => s.activeWatches === 0);
  assert.deepEqual(errors, []);
  assert.equal((await f.stats()).commands.filter((c) => c === 'sendChat').length, 2);
});

test('cross-process tool progress arrives while execution is held and independent Stop releases its observation', async (t) => {
  const f = await controlledHostFixture(new URL('./faux-tool.mjs', import.meta.url), true);
  t.after(() => f.close().then(() => {}));
  const root = f.root();
  await root.connection.command('connect', { profileId: root.profile.id });
  const target = (
    await root.chat.command('createChat', {
      session: f.session,
      settings: f.settings,
      requestId: 'tool-stream',
      title: 'Tool',
    })
  ).conversation.target;
  const views: ChatSnapshot[] = [],
    errors: ApplicationError[] = [];
  const close = root.chat.watch(
    { target },
    (v) => views.push(v),
    (e) => errors.push(e),
  );
  t.after(() => close());
  await root.chat.command('sendChat', { target, requestId: 'tool-stream-send', text: 'Tool' });
  await until(
    async () => views.at(-1),
    (v) =>
      !!v?.run?.transcript?.parts.some(
        (part) => part.kind === 'result' && part.text.includes('Controlled remote tool activity'),
      ),
  );
  assert.equal((await f.stats()).commands.filter((c) => c === 'getChat').length, 0);
  const started = Date.now();
  await root.chat.command('stopChat', {
    stop: views.at(-1)!.run!.stop,
    requestId: 'tool-stream-stop',
  });
  assert(Date.now() - started < 3000);
  await until(
    async () => views.at(-1),
    (v) => !!v && !v.run,
  );
  await close();
  await until(f.stats, (s) => s.activeWatches === 0);
  assert.deepEqual(errors, []);
});
