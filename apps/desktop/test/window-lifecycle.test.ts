import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { App, Dialog } from 'electron';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { WindowAction } from '../src/ipc/window-rpcs.ts';
import { installWindowLifecycle } from '../src/main/window-lifecycle.ts';
import { createTestWindow } from './fixtures/main-window.ts';

function fixture() {
  const f = createTestWindow(),
    appEvents = new EventEmitter(),
    actions: WindowAction[] = [];
  const released: string[] = [],
    prompts: string[] = [];
  let failChat = false;
  let releaseGate: Promise<void> = Promise.resolve();
  const app = Object.assign(appEvents, {
    quit() {
      released.push('quit');
    },
    exit(code: number) {
      released.push(`exit:${code}`);
    },
  }) as unknown as App;
  const lifecycle = installWindowLifecycle({
    app,
    window: f.window,
    sendAction: (action) => void actions.push(action),
    dialog: {
      showMessageBox: async (_window: unknown, options: { message: string }) => {
        prompts.push(options.message);
        return { response: 1, checkboxChecked: false };
      },
    } as Pick<Dialog, 'showMessageBox'>,
    ipc: {
      releaseDocument: async () => {
        released.push('ipc-document');
      },
      dispose: async () => {
        released.push('ipc');
      },
    },
    chatBackends: {
      getSessions: () => [
        {
          dispose: async () => {
            released.push('chat');
            await releaseGate;
            if (failChat) throw Error('release failed');
          },
        },
      ],
      releaseDocument: async () => {
        released.push('chat-document');
      },
    },
    releaseRoot: async () => {
      released.push('root');
    },
    releaseTransport: () => {
      released.push('transport');
    },
  });
  const ready = () => lifecycle.markReady();
  const ack = (answer: { id: string; consent: boolean; cleanupError?: ApplicationError }) =>
    lifecycle.answerQuit(answer);
  const last = () => actions.at(-1) as Extract<WindowAction, { id: string }>;
  const replace = () => f.contents.emit('did-frame-navigate', {}, '', 200, 'OK', true);
  return {
    ...f,
    actions,
    appEvents,
    lifecycle,
    released,
    prompts,
    ready,
    ack,
    last,
    replace,
    failChat: () => {
      failChat = true;
    },
    holdRelease: (gate: Promise<void>) => {
      releaseGate = gate;
    },
  };
}

for (const stage of ['preserve', 'dispose'])
  test(`replacement during ${stage} requires fresh ready, preservation and disposal IDs`, async () => {
    const f = fixture();
    f.lifecycle.requestQuit();
    // Quit waits for a document ready to answer it.
    assert.equal(f.actions.length, 0);
    f.ready();
    const preserve = f.last().id;
    assert.equal(f.lifecycle.isQuitting(), true);
    f.lifecycle.requestQuit();
    assert.equal(f.actions.length, 1);
    if (stage === 'dispose') await f.ack({ id: preserve, consent: true });
    const obsolete = f.last().id;
    f.replace();
    assert.deepEqual(f.released, ['ipc-document', 'chat-document']);
    await f.ack({ id: obsolete, consent: true });
    assert.equal(f.released.includes('root'), false);
    f.ready();
    const fresh = f.last().id;
    assert.equal(f.last().action, 'quit');
    assert.notEqual(fresh, preserve);
    await f.ack({ id: obsolete, consent: false });
    assert.equal(f.last().id, fresh);
    await f.ack({ id: fresh, consent: true });
    const dispose = f.last().id;
    assert.equal(f.last().action, 'dispose');
    // Disposal cannot return to the live workbench.
    await f.ack({ id: dispose, consent: false });
    assert.equal(f.released.includes('root'), false);
    await f.ack({ id: dispose, consent: true });
    assert.deepEqual(f.released.slice(-5), ['chat', 'ipc', 'root', 'transport', 'quit']);
  });

test('Quit veto returns to the workbench; actual cleanup is awaited and a failing release cannot skip later owners', async () => {
  const f = fixture();
  f.ready();
  f.lifecycle.requestQuit();
  await f.ack({ id: f.last().id, consent: false });
  assert.equal(f.lifecycle.isQuitting(), false);
  f.lifecycle.requestQuit();
  await f.ack({ id: f.last().id, consent: true });
  let release!: () => void;
  f.holdRelease(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  f.failChat();
  const finishing = f.ack({ id: f.last().id, consent: true });
  await Promise.resolve();
  assert.deepEqual(f.released, ['chat']);
  f.lifecycle.requestQuit();
  assert.equal(f.actions.length, 3);
  release();
  await finishing;
  assert.deepEqual(f.released, ['chat', 'ipc', 'root', 'transport', 'exit:1']);
  assert(f.prompts.includes('Moonbase could not finish cleanup.'));
});

test('close hides; activation shows; Quit asks nothing about local agents and releases only clients', async () => {
  const f = fixture();
  let prevented = false;
  f.window.emit('close', {
    preventDefault() {
      prevented = true;
    },
  });
  assert(prevented);
  assert(f.calls.includes('hide'));
  f.appEvents.emit('activate');
  f.appEvents.emit('second-instance');
  assert.equal(f.calls.filter((call) => call === 'show').length, 2);
  f.ready();
  f.lifecycle.requestQuit();
  await f.ack({ id: f.last().id, consent: true });
  // Preservation consent moves straight to disposal: no local work prompt, nothing stopped.
  assert.equal(f.last().action, 'dispose');
  await f.ack({ id: f.last().id, consent: true });
  assert.deepEqual(f.prompts, []);
  assert.deepEqual(f.released, ['chat', 'ipc', 'root', 'transport', 'quit']);
});

test('a crashed renderer quits on request without asking about local agents', async () => {
  const f = fixture();
  f.ready();
  f.contents.emit('render-process-gone', {}, { reason: 'crashed' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.prompts, ['The workbench stopped unexpectedly.']);
  assert.deepEqual(f.released.slice(-5), ['chat', 'ipc', 'root', 'transport', 'quit']);
});

test('Quit retains a held document cleanup failure before releasing the root', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.lifecycle.reportCleanup(
    new Promise<void>((_resolve, fail) => {
      reject = fail;
    }),
  );
  f.ready();
  f.lifecycle.requestQuit();
  await f.ack({ id: f.last().id, consent: true });
  const closing = f.ack({ id: f.last().id, consent: true });
  await Promise.resolve();
  assert.deepEqual(f.released, []);
  reject(Error('old document failed'));
  await closing;
  assert.deepEqual(f.released, ['chat', 'ipc', 'root', 'transport', 'exit:1']);
});

test('a ready document hears of earlier cleanup failures, and a disposal’s own failure quits with code 1', async () => {
  const f = fixture();
  f.lifecycle.reportCleanup(
    Promise.reject(new ApplicationError({ code: 'Persistence', message: 'Old' })),
  );
  await new Promise((resolve) => setImmediate(resolve));
  f.ready();
  assert.deepEqual(f.actions[0], {
    action: 'cleanup-error',
    error: new ApplicationError({ code: 'Persistence', message: 'Old' }),
  });
  f.lifecycle.requestQuit();
  await f.ack({ id: f.last().id, consent: true });
  await f.ack({
    id: f.last().id,
    consent: true,
    cleanupError: new ApplicationError({ code: 'Persistence', message: 'Disposal failed' }),
  });
  assert.equal(f.released.at(-1), 'exit:1');
});
