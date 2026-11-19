import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context, Deferred, Effect, Layer } from 'effect';
import * as Atom from 'effect/reactivity/Atom';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { EditorAlerts } from '@moonbase/application/editor';
import { makeWorkAtom, type WorkbenchServices } from '../src/workbench-editor.ts';

/** A runtime whose editor alerts record what they were asked to report. */
const makeRuntime = (reported: unknown[]) =>
  Atom.runtime(
    Layer.succeedContext(
      Context.make(EditorAlerts, {
        report: (error: unknown) => Effect.sync(() => void reported.push(error)),
      } as unknown as EditorAlerts['Service']),
    ),
  ) as unknown as Atom.AtomRuntime<WorkbenchServices>;

/** Work that runs until interrupted, then resolves `stopped`. */
const runUntilInterrupted = (stopped: Deferred.Deferred<void>) =>
  Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)));

test("a view's work is interrupted by newer work, or by the view unmounting, and its failure reported", async () => {
  const reported: unknown[] = [];
  const registry = AtomRegistry.make();
  const runtime = makeRuntime(reported);
  const replacing = makeWorkAtom(runtime, false);
  const unmount = registry.mount(replacing);
  const first = Deferred.makeUnsafe<void>();
  registry.set(replacing, runUntilInterrupted(first));
  // A newer open replaces the older one.
  registry.set(replacing, Effect.fail('refused'));
  await Effect.runPromise(Deferred.await(first));
  assert.deepEqual(reported, ['refused']);

  const concurrent = makeWorkAtom(runtime, true);
  const unmountConcurrent = registry.mount(concurrent);
  const second = Deferred.makeUnsafe<void>(),
    third = Deferred.makeUnsafe<void>();
  registry.set(concurrent, runUntilInterrupted(second));
  registry.set(concurrent, runUntilInterrupted(third));
  assert.equal(Deferred.isDoneUnsafe(second), false);
  // Unmounting the view ends everything it started; an interruption is no failure.
  unmountConcurrent();
  await Effect.runPromise(Effect.all([Deferred.await(second), Deferred.await(third)]));
  assert.deepEqual(reported, ['refused']);
  unmount();
  registry.dispose();
});
