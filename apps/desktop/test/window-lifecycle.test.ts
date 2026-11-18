import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Cause, Deferred, Effect, Exit, Fiber, ManagedRuntime, Layer, Scope } from 'effect';
import type { App, Dialog } from 'electron';
import { WindowFailure } from '../src/ipc/ipc-errors.ts';
import type { WindowAction } from '../src/ipc/window-rpcs.ts';
import { installWindowEvents } from '../src/main/window-events.ts';
import {
  collectQuitFailures,
  makeWindowLifecycle,
  WindowLifecycle,
  type QuitAnswer,
} from '../src/main/window-lifecycle.ts';
import { makeIpcFixture, waitFor } from './fixtures/ipc-fixture.ts';
import { createTestWindow } from './fixtures/main-window.ts';

/** The window's lifecycle and events over a test window, with the answers the user gives. */
async function fixture(
  options: {
    deliver?: (action: WindowAction) => void;
    release?: Effect.Effect<void, unknown>;
  } = {},
) {
  const f = createTestWindow(),
    app = new EventEmitter(),
    actions: WindowAction[] = [];
  const prompts: string[] = [];
  let released = 0;
  /** The crash prompt's answer: 0 recovers the workbench, 1 quits. */
  let crashAnswer = 1;
  const runtime = ManagedRuntime.make(Layer.empty);
  const scope = Scope.makeUnsafe();
  const lifecycle = await runtime.runPromise(
    Scope.provide(
      makeWindowLifecycle({
        window: f.window,
        deliver: (action, publish) => {
          actions.push(action);
          options.deliver?.(action);
          publish(action);
        },
      }),
      scope,
    ),
  );
  await runtime.runPromise(
    installWindowEvents({
      app: app as unknown as App,
      window: f.window,
      dialog: {
        showMessageBox: async (_window: unknown, { message }: { message: string }) => {
          prompts.push(message);
          return { response: crashAnswer, checkboxChecked: false };
        },
      } as Pick<Dialog, 'showMessageBox'>,
      releaseDocument: options.release ?? Effect.sync(() => void released++),
    }).pipe(Scope.provide(scope), Effect.provideService(WindowLifecycle, lifecycle)),
  );
  const quit = runtime.runFork(lifecycle.awaitQuit);
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  return {
    ...f,
    app,
    actions,
    prompts,
    lifecycle,
    run,
    get released() {
      return released;
    },
    answerCrash: (response: number) => {
      crashAnswer = response;
    },
    ready: () => run(lifecycle.markReady),
    requestQuit: () => run(lifecycle.requestQuit),
    answer: (answer: QuitAnswer) => run(lifecycle.answerQuit(answer)),
    last: () => actions.at(-1) as Extract<WindowAction, { id: string }>,
    replace: () => f.contents.emit('did-frame-navigate', {}, '', 200, 'OK', true),
    /** Whether Quit may now release everything. */
    finished: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return quit.pollUnsafe() !== undefined;
    },
    isQuitting: () => run(lifecycle.isQuitting),
    async dispose() {
      await run(Fiber.interrupt(quit));
      await run(Scope.close(scope, Exit.void));
      await runtime.dispose();
    },
  };
}

for (const stage of ['preserve', 'dispose'])
  test(`replacement during ${stage} requires fresh ready, preservation and disposal IDs`, async () => {
    const f = await fixture();
    try {
      await f.requestQuit();
      // Quit waits for a document ready to answer it.
      assert.equal(f.actions.length, 0);
      await f.ready();
      const preserve = f.last().id;
      assert.equal(await f.isQuitting(), true);
      await f.requestQuit();
      assert.equal(f.actions.length, 1);
      if (stage === 'dispose') await f.answer({ id: preserve, consent: true });
      const obsolete = f.last().id;
      f.replace();
      await waitFor(() => f.released === 1);
      await f.answer({ id: obsolete, consent: true });
      assert.equal(await f.finished(), false);
      await f.ready();
      const fresh = f.last().id;
      assert.equal(f.last().action, 'quit');
      assert.notEqual(fresh, preserve);
      await f.answer({ id: obsolete, consent: false });
      assert.equal(f.last().id, fresh);
      await f.answer({ id: fresh, consent: true });
      const dispose = f.last().id;
      assert.equal(f.last().action, 'dispose');
      // Disposal cannot return to the live workbench.
      await f.answer({ id: dispose, consent: false });
      assert.equal(await f.finished(), false);
      await f.answer({ id: dispose, consent: true });
      assert.equal(await f.finished(), true);
    } finally {
      await f.dispose();
    }
  });

test('close hides; activation shows; a Quit veto returns to the workbench; consent asks nothing about local agents', async () => {
  const f = await fixture();
  try {
    let prevented = false;
    f.window.emit('close', {
      preventDefault() {
        prevented = true;
      },
    });
    assert(prevented);
    assert(f.calls.includes('hide'));
    f.app.emit('activate');
    f.app.emit('second-instance');
    await waitFor(() => f.calls.filter((call) => call === 'show').length === 2);
    await f.ready();
    // Quit from the OS is asked of the document first.
    let quitPrevented = false;
    f.app.emit('before-quit', {
      preventDefault() {
        quitPrevented = true;
      },
    });
    assert(quitPrevented);
    await waitFor(() => f.actions.length === 1);
    await f.answer({ id: f.last().id, consent: false });
    assert.equal(await f.isQuitting(), false);
    await f.requestQuit();
    await f.answer({ id: f.last().id, consent: true });
    // Preservation consent moves straight to disposal: no local work prompt, nothing stopped.
    assert.equal(f.last().action, 'dispose');
    await f.answer({ id: f.last().id, consent: true });
    assert.equal(await f.finished(), true);
    assert.deepEqual(f.prompts, []);
  } finally {
    await f.dispose();
  }
});

test('a crashed renderer releases its document, then recovers it or quits as the user answers', async () => {
  const f = await fixture();
  try {
    await f.ready();
    f.answerCrash(0);
    f.contents.emit('render-process-gone', {}, { reason: 'crashed' });
    await waitFor(() => f.calls.includes('reload'));
    assert.equal(f.released, 1);
    assert.deepEqual(f.prompts, ['The workbench stopped unexpectedly.']);
    f.answerCrash(1);
    f.contents.emit('render-process-gone', {}, { reason: 'crashed' });
    await waitFor(() => f.prompts.length === 2);
    assert.equal(await f.finished(), true);
    assert.equal(f.calls.filter((call) => call === 'reload').length, 1);
  } finally {
    await f.dispose();
  }
});

test('Quit waits for a document release under way, and reports its failure, earlier ones and the disposal’s own', async () => {
  const held = Effect.runSync(Deferred.make<void>());
  const f = await fixture({
    release: Effect.andThen(
      Deferred.await(held),
      Effect.fail(new WindowFailure({ text: 'Old document failed' })),
    ),
  });
  try {
    await f.run(f.lifecycle.reportCleanup(Cause.fail(new WindowFailure({ text: 'Earlier' }))));
    await f.ready();
    // A ready document hears of earlier cleanup failures.
    assert.deepEqual(
      f.actions.map((action) => action.action),
      ['cleanup-error'],
    );
    f.replace();
    await f.ready();
    await f.requestQuit();
    await f.answer({ id: f.last().id, consent: true });
    await f.answer({
      id: f.last().id,
      consent: true,
      cleanupError: new WindowFailure({ text: 'Disposal failed' }),
    });
    assert.equal(await f.finished(), false);
    await f.run(Deferred.succeed(held, undefined));
    await waitFor(() => f.finished());
    const failures = await f.run(
      collectQuitFailures(f.lifecycle, Exit.die(new Error('Releasing failed'))),
    );
    assert.deepEqual(failures, [
      'Earlier',
      'Disposal failed',
      'Old document failed',
      'Releasing failed',
    ]);
  } finally {
    await f.dispose();
  }
});

test('Quit, its answer and a cleanup failure survive the actions watch’s connection ending', async () => {
  const f = await fixture();
  const owner: { loseAnswer?: boolean } = {};
  let readies = 0;
  const ipc = await makeIpcFixture({
    lifecycle: {
      actions: f.lifecycle.actions,
      markReady: Effect.suspend(() => {
        readies++;
        return f.lifecycle.markReady;
      }),
      answerQuit: f.lifecycle.answerQuit,
    },
    // Loses the first answer: its connection ends before main reads it.
    intercept: (request, handler) => {
      if (request.tag !== 'answerQuit' || !owner.loseAnswer) return handler;
      owner.loseAnswer = false;
      return Effect.andThen(
        Effect.sync(() => ipc.closeConnections()),
        Effect.never,
      );
    },
  });
  const shell = ipc.shell;
  const received: WindowAction[] = [];
  const close = shell.watchWindowActions((action) => void received.push(action));
  try {
    await waitFor(() => readies === 1);
    // The connection ends with the document still alive, as a ping timeout would end it.
    ipc.closeConnections();
    // More failures than main holds for its exit code.
    for (let index = 0; index < 9; index++)
      await f.run(
        f.lifecycle.reportCleanup(Cause.fail(new WindowFailure({ text: `Gap ${index}` }))),
      );
    await f.requestQuit();
    await waitFor(() => received.length > 9);
    assert.equal(readies, 2);
    const quit = f.last().id;
    const failures = Array<WindowAction['action']>(9).fill('cleanup-error');
    assert.deepEqual(
      received.map((action) => action.action),
      [...failures, 'quit'],
    );
    owner.loseAnswer = true;
    await shell.answerQuit(quit, true);
    // Main asks again on the next watch, and the document answers again without asking the user.
    await waitFor(() => received.some((action) => action.action === 'dispose'));
    assert.equal(owner.loseAnswer, false);
    // Each watch hears of the failure again, and the document takes it once.
    assert.equal(readies, 3);
    assert.deepEqual(
      received.map((action) => action.action),
      [...failures, 'quit', 'dispose'],
    );
  } finally {
    await close().catch(() => {});
    await ipc.dispose();
    await f.dispose();
  }
});
