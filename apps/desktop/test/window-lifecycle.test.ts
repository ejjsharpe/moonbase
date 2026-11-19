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
import { makeIpcFixture, settleWithin, waitFor } from './fixtures/ipc-fixture.ts';
import { createTestWindow } from './fixtures/main-window.ts';

/** The window's lifecycle and events over a test window, with the answers the user gives. */
async function fixture(
  options: {
    deliver?: (action: WindowAction) => void;
    release?: Effect.Effect<void, unknown>;
    /** The window's document, as the IPC server takes it out; by default one counted release. */
    detach?: Effect.Effect<Effect.Effect<void, unknown>>;
  } = {},
) {
  const f = createTestWindow(),
    app = new EventEmitter(),
    actions: WindowAction[] = [];
  const prompts: string[] = [];
  let released = 0;
  /** The crash prompt's answer: 0 recovers the workbench, 1 quits, null waits to be closed. */
  let crashAnswer: number | null = 1;
  let dismissed = 0;
  /** Finishes closing a dismissed prompt, which Electron does asynchronously. */
  let closePrompt = () => {};
  /** Once the test is over, a dismissed prompt closes at once. */
  let tearingDown = false;
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
        showMessageBox: async (
          _window: unknown,
          { message, signal }: { message: string; signal: AbortSignal },
        ) => {
          prompts.push(message);
          const response =
            crashAnswer ??
            (await new Promise<number>((resolve) =>
              signal.addEventListener('abort', () => {
                dismissed++;
                // Closed by its signal, a box answers with its cancel button: here, Quit.
                closePrompt = () => resolve(1);
                if (tearingDown) closePrompt();
              }),
            ));
          return { response, checkboxChecked: false };
        },
      } as Pick<Dialog, 'showMessageBox'>,
      detachDocument:
        options.detach ?? Effect.succeed(options.release ?? Effect.sync(() => void released++)),
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
    get dismissed() {
      return dismissed;
    },
    answerCrash: (response: number | null) => {
      crashAnswer = response;
    },
    closePrompt: () => closePrompt(),
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
      // A prompt a failed assertion left closing still closes.
      tearingDown = true;
      closePrompt();
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
  const ipc = await makeIpcFixture();
  // Each release defects after it is done, which mustn't cut short the wait for a closing prompt.
  const f = await fixture({
    detach: Effect.map(ipc.detachDocument, (release) =>
      Effect.andThen(release, Effect.die(new Error('Finalizer failed'))),
    ),
  });
  try {
    const crashed = (await settleWithin(ipc.connectRaw(), 'The first connection'))!;
    await f.ready();
    f.answerCrash(0);
    f.contents.emit('render-process-gone', {}, { reason: 'crashed' });
    await waitFor(() => f.calls.includes('reload'));
    await settleWithin(crashed.closed, 'The crashed document’s release');
    assert.deepEqual(f.prompts, ['The workbench stopped unexpectedly.']);
    // A document that replaces the crashed one closes its prompt, whose answer is then ignored.
    // Electron finishes closing it later; meanwhile the new document connects and is ready, and
    // neither its connection nor its readiness is the old document's to release.
    f.answerCrash(null);
    await settleWithin(ipc.connectRaw(), 'The recovered connection');
    f.contents.emit('render-process-gone', {}, { reason: 'crashed' });
    await waitFor(() => f.prompts.length === 2);
    f.replace();
    await waitFor(() => f.dismissed === 1);
    const replacing = (await settleWithin(ipc.connectRaw(), 'The replacing connection'))!;
    await f.ready();
    await f.requestQuit();
    await f.answer({ id: f.last().id, consent: true });
    await f.answer({ id: f.last().id, consent: true });
    assert.equal(await f.finished(), false);
    f.closePrompt();
    await waitFor(() => f.finished());
    replacing.send({ _tag: 'Ping' });
    const reply = await settleWithin(
      Promise.race([replacing.next(), replacing.closed.then(() => 'closed')]),
      'The replacing connection’s ping',
    );
    assert.deepEqual(reply, { _tag: 'Pong' });
    assert.equal(f.calls.filter((call) => call === 'reload').length, 1);
  } finally {
    // Closing the window's scope waits for no prompt.
    await f.dispose();
    await ipc.dispose();
  }
  const g = await fixture();
  try {
    await g.ready();
    g.contents.emit('render-process-gone', {}, { reason: 'crashed' });
    await waitFor(() => g.finished());
    assert.equal(g.calls.includes('reload'), false);
  } finally {
    await g.dispose();
  }
});

test('Quit runs each step once despite a failing one, waits for a document release under way, and reports its failure, the step’s, earlier ones and the disposal’s own', async () => {
  const held = Effect.runSync(Deferred.make<void>());
  const f = await fixture({
    release: Effect.andThen(
      Deferred.await(held),
      Effect.fail(new WindowFailure({ text: 'Old document failed' })),
    ),
  });
  let surfaced = 0;
  try {
    // Surfacing an open picker, say, which a release may be waiting on. A step that fails is
    // reported, and the next still runs.
    await f.run(f.lifecycle.addQuitStep(Effect.die(new Error('Showing failed'))));
    await f.run(f.lifecycle.addQuitStep(Effect.sync(() => void surfaced++)));
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
    assert.equal(surfaced, 1);
    // Another waiter runs no step again, and also waits for the release.
    const again = f.run(f.lifecycle.awaitQuit);
    await f.run(Deferred.succeed(held, undefined));
    await waitFor(() => f.finished());
    await settleWithin(again, 'The second wait for Quit');
    assert.equal(surfaced, 1);
    const failures = await f.run(
      collectQuitFailures(f.lifecycle, Exit.die(new Error('Releasing failed'))),
    );
    assert.deepEqual(failures, [
      'Earlier',
      'Disposal failed',
      'Showing failed',
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
