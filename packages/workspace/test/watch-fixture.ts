import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs, { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { Layer, ManagedRuntime, type Duration } from 'effect';
import { TestClock } from 'effect/testing';
import { makeWorkspaceClient } from './workspace-client-fixture.ts';
import { WorkspaceLive } from './workspace-live-fixture.ts';

/**
 * A workspace on a `TestClock`, so a test closes each watch's 100 ms coalescing window itself
 * (`advance`) instead of waiting for it.
 */
export function startOnTestClock(dataDirectory: string) {
  const runtime = ManagedRuntime.make(
    WorkspaceLive({ dataDirectory, hostId: 'local-test' }).pipe(
      Layer.provideMerge(TestClock.layer()),
    ),
  );
  return {
    runtime,
    client: makeWorkspaceClient(runtime),
    advance: (duration: Duration.Input) => runtime.runPromise(TestClock.adjust(duration)),
  };
}

/**
 * Records every path the host's native watchers report, after the host's own listener has taken
 * it, so a test knows a change reached a watch before it closes the watch's window. The host calls
 * `fs.watch` through the default `node:fs` import, so wrapping it here sees every watcher.
 */
export function recordWatchDeliveries() {
  const actual = fs.watch;
  const deliveries: string[] = [];
  const waiters = new Set<() => void>();
  let open = 0;
  const spy = mock.method(
    fs,
    'watch',
    (path: string, options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
      const watcher: fs.FSWatcher = Reflect.apply(actual, fs, [
        path,
        options,
        (kind: fs.WatchEventType, name: string | null) => {
          listener(kind, name);
          if (name) deliveries.push(resolve(path, name));
          for (const waiter of waiters) waiter();
        },
      ]);
      open++;
      watcher.once('close', () => open--);
      return watcher;
    },
  );
  syncBuiltinESMExports();
  const count = (path: string) => deliveries.filter((delivered) => delivered === path).length;
  /** Resolves true once watchers reported `path` `times` times in all, or false after `ms`. */
  const delivered = (path: string, times: number, ms: number) =>
    new Promise<boolean>((done) => {
      const check = () => {
        if (count(path) < times) return;
        finish(true);
      };
      const finish = (outcome: boolean) => {
        clearTimeout(timer);
        waiters.delete(check);
        done(outcome);
      };
      const timer = setTimeout(() => finish(false), ms);
      waiters.add(check);
      check();
    });
  /**
   * Writes `text` to `path` and waits until a watcher reported it. FSEvents may miss a write made
   * as its stream starts, so a missed one is written again.
   */
  const write = async (path: string, text: string) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const prior = count(path);
      writeFileSync(path, text);
      if (await delivered(path, prior + 1, 250)) return;
    }
    assert.fail('The watchers never reported ' + path);
  };
  let barriers = 0;
  return {
    /** Native watchers opened and not yet closed. */
    open: () => open,
    count,
    delivered,
    write,
    /**
     * Writes a lock file in `folder` (one the watches skip, such as the repository's Git folder)
     * and waits until `watchers` watchers reported it: every change made before it has then
     * reached them. A missed one is written again under a new name.
     */
    async barrier(folder: string, watchers: number) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const path = join(folder, `moonbase-barrier-${++barriers}.lock`);
        writeFileSync(path, '');
        if (await delivered(path, watchers, 250)) return;
      }
      assert.fail('The watchers never reported the barrier');
    },
    restore() {
      spy.mock.restore();
      syncBuiltinESMExports();
    },
  };
}
