import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, ManagedRuntime, Scope } from 'effect';
import { makeConnectionClient, makeEditorClient } from '@moonbase/application/runtime/clients';
import { makeEditorController, makeEditorModel } from '@moonbase/application/editor';
import { WorkspaceHostService } from '@moonbase/contracts/services';
import { LoopbackConnectionLive } from '@moonbase/daemon-protocol/loopback';
import { RemoteWorkspaceHostLive } from '@moonbase/daemon-protocol/remote';
import { WorkspaceRecoveryLive } from '@moonbase/workspace';
import { startDaemonCommand } from '../../apps/desktop/test/daemon-process.ts';
import {
  makeFauxDaemonCommand,
  prepareDaemonData,
  stopDaemon,
} from '../../apps/desktop/test/faux-daemon.mjs';

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, ms = 20000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw Error('Condition did not settle.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Two clients of one daemon, as two Macs or two windows would be: each has its own recovery store
 * and its own connection over the daemon's WebSocket, and neither shares a process with the file
 * host.
 */
test("two clients of one daemon share a checkout: a move re-paths the other draft, and a late save by B does not overwrite A's", async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-editor-daemon-')));
  const project = join(base, 'project');
  mkdirSync(project);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', [
      '-C',
      project,
      '-c',
      'user.name=Moonbase integration',
      '-c',
      'user.email=integration@example.invalid',
      ...args,
    ]);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(project, 'a.ts'), 'HEAD\n');
  writeFileSync(join(project, 'b.ts'), 'B\n');
  git('add', '.');
  git('commit', '-qm', 'Initial files');

  const directory = await prepareDaemonData(base, {});
  const daemon = startDaemonCommand(makeFauxDaemonCommand(directory));
  const disposers: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose().catch(() => {});
    await daemon.stop();
    await stopDaemon(directory);
    rmSync(base, { recursive: true, force: true });
  });
  const ready = await daemon.ready;

  async function client(name: string) {
    const connection = ManagedRuntime.make(
      RemoteWorkspaceHostLive({ host: ready.host }).pipe(
        Layer.provideMerge(LoopbackConnectionLive({ directory })),
      ),
    );
    disposers.push(() => connection.dispose());
    await makeConnectionClient(connection).command('connect', { profileId: 'loopback' });
    const host = await connection.runPromise(WorkspaceHostService);
    const runtime = ManagedRuntime.make(
      WorkspaceRecoveryLive(
        { dataDirectory: join(base, name), installationId: name, legacyHostIds: [] },
        host,
      ),
    );
    disposers.push(() => runtime.dispose());
    const model = await runtime.runPromise(
      makeEditorModel({ client: makeEditorClient(runtime), clientId: name }).pipe(
        Effect.provideService(Scope.Scope, runtime.scope),
      ),
    );
    const editor = makeEditorController(runtime, model);
    disposers.push(() => editor.dispose());
    await editor.load();
    return editor;
  }
  const a = await client('client-a'),
    b = await client('client-b');
  const checkout = await a.openCheckout(project);
  assert.deepEqual(await b.openCheckout(project), checkout);

  const moving = { checkout, path: 'b.ts' },
    shared = { checkout, path: 'a.ts' };
  await b.open(moving, { intent: 'keep' });
  b.edit(moving, 'B UNSAVED\n');
  await b.flush();
  await b.open(shared);
  // B's next load starts its feed cursor here, before A's move.
  await b.reconcileRecovery();

  // A moves the file B has an unsaved draft of; the draft follows it and keeps its text.
  mkdirSync(join(project, 'dest'));
  const move = a.createMutation({ checkout, kind: 'move', paths: ['b.ts'] });
  try {
    assert.equal(await move.apply('dest/b.ts', '', false), true, move.getSnapshot().error);
  } finally {
    await move.dispose();
  }
  const moved = { checkout, path: 'dest/b.ts' };
  await until(
    async () => {
      await b.reconcileRecovery();
      return b.buffer(moved)?.text;
    },
    (text) => text === 'B UNSAVED\n',
  );
  assert.equal(b.buffer(moving), undefined);
  assert.equal(readFileSync(join(project, 'dest/b.ts'), 'utf8'), 'B\n');

  // A saves.
  await a.open(shared);
  a.edit(shared, 'A SAVED\n');
  assert.equal(await a.save(shared), true);
  assert.equal(readFileSync(join(project, 'a.ts'), 'utf8'), 'A SAVED\n');
  // B still has the old text open: its save is checked against the daemon's version, so A's stays.
  b.edit(shared, 'B LATE\n');
  assert.equal(await b.save(shared), false);
  assert.equal(readFileSync(join(project, 'a.ts'), 'utf8'), 'A SAVED\n');
  assert.equal(b.buffer(shared)?.text, 'B LATE\n');
  assert.equal(await b.reload(shared), true);
  assert.equal(b.buffer(shared)?.text, 'A SAVED\n');
});
