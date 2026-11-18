import assert from 'node:assert/strict';
import type { WorkspaceHostError } from '@moonbase/contracts/workspace-host-errors';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect, ManagedRuntime } from 'effect';
import { TestClock } from 'effect/testing';
import { WorkspaceHostService } from '@moonbase/contracts/services';
import { WorkspaceHostLive, type RootPredicate } from '../src/index.ts';
import { makeGitGate } from '../src/git-gate.ts';
import { initRepository } from './repository-fixture.ts';

/** A file host over a temporary folder; `reserved` is given that folder to name paths in. */
function setup({
  reserved = () => [],
  allowRoot,
}: {
  reserved?: (base: string) => string[];
  allowRoot?: (real: string, requested: string) => boolean;
} = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'moonbase-roots-')));
  const calls: [string, string][] = [];
  const start = (paths: string[]) =>
    ManagedRuntime.make(
      WorkspaceHostLive({
        dataDirectory: join(base, 'state'),
        hostId: 'root-policy-host',
        reserved: paths,
        ...(allowRoot
          ? {
              allowRoot: ((real, requested) =>
                Effect.sync(() => {
                  calls.push([real, requested]);
                  return allowRoot(real, requested);
                })) satisfies RootPredicate,
            }
          : {}),
      }),
    );
  let runtime = start(reserved(base));
  return {
    base,
    calls,
    /** Starts the host again over the same state with other reserved paths. */
    async restart(paths: string[]) {
      await runtime.dispose();
      runtime = start(paths);
    },
    folder(...names: string[]) {
      const path = join(base, ...names);
      mkdirSync(path, { recursive: true });
      return path;
    },
    host: () => runtime.runPromise(WorkspaceHostService),
    async close() {
      await runtime.dispose();
      rmSync(base, { recursive: true, force: true });
    },
  };
}
/** The tag of the error `effect` fails with. */
const tag = async <A>(effect: Effect.Effect<A, WorkspaceHostError>) =>
  (await Effect.runPromise(Effect.flip(effect)))._tag;

test('a root that holds, is or sits inside a reserved path is refused, whether or not the path exists yet', async () => {
  const f = setup({
    reserved: (base) => [join(base, 'data', 'credentials'), join(base, 'data', 'later.key')],
  });
  try {
    const host = await f.host();
    const open = (root: string) => host.openCheckout({ root });
    f.folder('data', 'credentials', 'deeper');
    f.folder('data', 'other');
    assert.equal((await Effect.runPromise(open(f.folder('data', 'other')))).vcs, 'none');
    for (const root of [
      join(f.base, 'data'),
      join(f.base, 'data', 'credentials'),
      join(f.base, 'data', 'credentials', 'deeper'),
    ])
      assert.equal(await tag(open(root)), 'InvalidPathError');
    // A reserved path that does not exist yet is held by its folder all the same.
    f.folder('data', 'later.key', 'x');
    assert.equal(await tag(open(join(f.base, 'data', 'later.key', 'x'))), 'InvalidPathError');
    // A checkout approved before a path in it was reserved is refused on its next use.
    const checkout = await Effect.runPromise(open(f.folder('project')));
    await f.restart([join(f.base, 'project', 'key')]);
    assert.equal(await tag((await f.host()).verifyCheckout({ checkout })), 'InvalidPathError');
  } finally {
    await f.close();
  }
});

test('the root predicate sees the real and requested path, denies on refusal or error and is asked again on every use', async () => {
  let allowed = (real: string) => real.includes('allowed');
  const f = setup({ allowRoot: (real) => allowed(real) });
  try {
    const host = await f.host();
    const good = f.folder('allowed');
    const checkout = await Effect.runPromise(host.openCheckout({ root: good }));
    assert.deepEqual(f.calls[0], [good, good]);
    // A link names the same folder but is requested as itself, which a predicate can refuse.
    symlinkSync(good, join(f.base, 'link'));
    await Effect.runPromise(host.openCheckout({ root: join(f.base, 'link') }));
    assert.deepEqual(f.calls.at(-1), [good, join(f.base, 'link')]);
    assert.equal(await tag(host.openCheckout({ root: f.folder('denied') })), 'CheckoutAccessError');
    allowed = () => {
      throw Error('The policy failed.');
    };
    assert.equal(await tag(host.verifyCheckout({ checkout })), 'CheckoutAccessError');
    assert.equal(await tag(host.readFile({ checkout, path: 'x' })), 'CheckoutAccessError');
    allowed = (real) => real.includes('allowed');
    await Effect.runPromise(host.verifyCheckout({ checkout }));
  } finally {
    await f.close();
  }
});

test('a worktree location is made only inside a folder the predicate allows, and never through one swapped since', async () => {
  let swap = () => {};
  const f = setup({
    allowRoot: (real) => {
      if (real.endsWith('swapped')) swap();
      return !real.includes('forbidden');
    },
  });
  try {
    const host = await f.host(),
      root = f.folder('repo');
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', [
        '-C',
        root,
        '-c',
        'user.name=T',
        '-c',
        'user.email=t@e.invalid',
        ...args,
      ]);
    initRepository(root);
    writeFileSync(join(root, 'file.txt'), 'x');
    git('add', '.');
    git('commit', '-qm', 'initial');
    const checkout = await Effect.runPromise(host.openCheckout({ root }));
    const request = (location: string, branch: string) => ({
      installationId: 'alice',
      requestId: branch.replace('/', '-'),
      checkout,
      base: 'main',
      branch,
      location,
    });
    const forbidden = f.folder('forbidden');
    assert.equal(
      await tag(host.createWorktree(request(join(forbidden, 'wt'), 'f/one'))),
      'CheckoutAccessError',
    );
    assert.equal(existsSync(join(forbidden, 'wt')), false);
    assert.equal(git('branch', '--list', 'f/one').toString(), '');
    const created = await Effect.runPromise(
      host.createWorktree(request(join(f.base, 'wt'), 'f/two')),
    );
    assert.equal(created.root, join(f.base, 'wt'));
    // The parent becomes a link to a forbidden folder once the policy has allowed it.
    const swapped = f.folder('swapped');
    swap = () => {
      swap = () => {};
      renameSync(swapped, join(f.base, 'moved'));
      symlinkSync(forbidden, swapped);
    };
    assert.equal(
      await tag(host.createWorktree(request(join(swapped, 'wt'), 'f/three'))),
      'CheckoutChangedError',
    );
    assert.equal(existsSync(join(forbidden, 'wt')), false);
    assert.equal(git('branch', '--list', 'f/three').toString(), '');
  } finally {
    await f.close();
  }
});

test('a missing command-line tools install is Unavailable, is looked for again after a delay, and is remembered once found', async () => {
  let installed = false,
    probes = 0;
  const probe = Effect.sync(() => (probes++, installed));
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* makeGitGate('/usr/bin/git', probe);
      const missing = Effect.map(Effect.flip(gate), (error) => error._tag);
      assert.equal(yield* missing, 'WorkspaceUnavailableError');
      assert.equal(yield* missing, 'WorkspaceUnavailableError');
      assert.equal(probes, 1);
      installed = true;
      yield* TestClock.adjust('3 seconds');
      yield* gate;
      yield* TestClock.adjust('1 hour');
      yield* gate;
      assert.equal(probes, 2);
      // Only the system Git stub offers an installer; any other executable is run as given.
      yield* yield* makeGitGate(
        '/opt/homebrew/bin/git',
        Effect.sync(() => assert.fail('probed')),
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
