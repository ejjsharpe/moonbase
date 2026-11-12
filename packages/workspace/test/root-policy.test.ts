import assert from 'node:assert/strict';
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
import { WorkspaceHostService } from '@moonbase/contracts/services';
import { WorkspaceHostLive, type RootPredicate } from '../src/index.ts';
import { createGitGate } from '../src/filesystem.ts';

/** A file host over a temporary folder; `reserved` is given that folder to name paths in. */
function setup({
  reserved = () => [],
  allowRoot,
}: { reserved?: (base: string) => string[]; allowRoot?: RootPredicate } = {}) {
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
              allowRoot: (real, requested) => {
                calls.push([real, requested]);
                return allowRoot(real, requested);
              },
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
const code = async <A>(effect: Effect.Effect<A, { code: string }>) =>
  (await Effect.runPromise(Effect.flip(effect))).code;

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
      assert.equal(await code(open(root)), 'InvalidInput');
    // A reserved path that does not exist yet is held by its folder all the same.
    f.folder('data', 'later.key', 'x');
    assert.equal(await code(open(join(f.base, 'data', 'later.key', 'x'))), 'InvalidInput');
    // A checkout approved before a path in it was reserved is refused on its next use.
    const checkout = await Effect.runPromise(open(f.folder('project')));
    await f.restart([join(f.base, 'project', 'key')]);
    assert.equal(await code((await f.host()).verifyCheckout({ checkout })), 'InvalidInput');
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
    assert.equal(await code(host.openCheckout({ root: f.folder('denied') })), 'Unauthorized');
    allowed = () => {
      throw Error('The policy failed.');
    };
    assert.equal(await code(host.verifyCheckout({ checkout })), 'Unauthorized');
    assert.equal(await code(host.readFile({ checkout, path: 'x' })), 'Unauthorized');
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
    git('init', '-q', '-b', 'main');
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
      await code(host.createWorktree(request(join(forbidden, 'wt'), 'f/one'))),
      'Unauthorized',
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
      await code(host.createWorktree(request(join(swapped, 'wt'), 'f/three'))),
      'InvalidInput',
    );
    assert.equal(existsSync(join(forbidden, 'wt')), false);
    assert.equal(git('branch', '--list', 'f/three').toString(), '');
  } finally {
    await f.close();
  }
});

test('a missing command-line tools install is Unavailable, is looked for again after a delay, and is remembered once found', async () => {
  let installed = false,
    probes = 0,
    clock = 0;
  const gate = createGitGate('/usr/bin/git', async () => (probes++, installed), {
    retryMs: 1000,
    now: () => clock,
  });
  await assert.rejects(gate(), { code: 'Unavailable' });
  await assert.rejects(gate(), { code: 'Unavailable' });
  assert.equal(probes, 1);
  installed = true;
  clock = 1000;
  await gate();
  await gate();
  assert.equal(probes, 2);
  // Only the system Git stub offers an installer; any other executable is run as given.
  await createGitGate('/opt/homebrew/bin/git', async () => assert.fail('probed'))();
});
