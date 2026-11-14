import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { App, Dialog, IpcMain } from 'electron';
import { installWindowLifecycle } from '../src/main/window-lifecycle.ts';
import { channels } from '../src/ipc/wire.ts';
import { createTestWindow } from './fixtures/main-window.ts';

function fixture() {
  const f = createTestWindow(),
    ipc = new EventEmitter(),
    appEvents = new EventEmitter();
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
    ipcMain: ipc as IpcMain,
    requireTrusted: f.requireTrusted,
    dialog: {
      showMessageBox: async (_window: unknown, options: { message: string }) => {
        prompts.push(options.message);
        return { response: 1, checkboxChecked: false };
      },
    } as Pick<Dialog, 'showMessageBox'>,
    editorSession: {
      releaseDocument: async () => {
        released.push('editor-document');
      },
      dispose: async () => {
        released.push('editor');
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
  const ready = (event = f.event) => ipc.emit(channels.ready, event);
  const ack = async (value: unknown, event = f.event) => {
    await ipc.listeners(channels.quit)[0]!(event, value);
  };
  const last = () => f.actions.at(-1)!;
  const replace = () => f.contents.emit('did-frame-navigate', {}, '', 200, 'OK', true);
  return {
    ...f,
    ipc,
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
    for (const event of f.badEvents()) f.ready(event);
    assert.equal(f.actions.length, 0);
    f.ready();
    const preserve = f.last().id;
    for (const event of f.badEvents()) await f.ack({ id: preserve, consent: false }, event);
    f.contents.mainFrame.url += '?asset=1';
    await f.ack({ id: preserve, consent: false });
    f.contents.mainFrame.url = 'moonbase://editor/index.html';
    assert.equal(f.lifecycle.isQuitting(), true);
    f.lifecycle.requestQuit();
    assert.equal(f.actions.length, 1);
    if (stage === 'dispose') await f.ack({ id: preserve, consent: true });
    const obsolete = f.last().id;
    f.replace();
    assert.deepEqual(f.released, ['editor-document', 'chat-document']);
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
    for (const event of f.badEvents()) await f.ack({ id: dispose, consent: true }, event);
    for (const cleanupError of [
      { code: 'Persistence', message: 'x'.repeat(513) },
      { code: 'Unknown', message: 'bad' },
      { code: 'Persistence', message: 'bad', private: true },
    ])
      await f.ack({ id: dispose, consent: true, cleanupError });
    await f.ack({ id: dispose, consent: false });
    assert.equal(f.released.includes('root'), false);
    await f.ack({ id: dispose, consent: true });
    assert.deepEqual(f.released.slice(-5), ['chat', 'editor', 'root', 'transport', 'quit']);
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
  const unrelated = () => {};
  f.ipc.on(channels.ready, unrelated);
  const finishing = f.ack({ id: f.last().id, consent: true });
  await Promise.resolve();
  assert.deepEqual(f.released, ['chat']);
  f.lifecycle.requestQuit();
  assert.equal(f.actions.length, 3);
  release();
  await finishing;
  assert.deepEqual(f.released, ['chat', 'editor', 'root', 'transport', 'exit:1']);
  assert(f.prompts.includes('Moonbase could not finish cleanup.'));
  assert.deepEqual(f.ipc.listeners(channels.ready), [unrelated]);
  assert.equal(f.ipc.listenerCount(channels.quit), 0);
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
  assert.deepEqual(f.released, ['chat', 'editor', 'root', 'transport', 'quit']);
});

test('a crashed renderer quits on request without asking about local agents', async () => {
  const f = fixture();
  f.ready();
  f.contents.emit('render-process-gone', {}, { reason: 'crashed' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.prompts, ['The workbench stopped unexpectedly.']);
  assert.deepEqual(f.released.slice(-5), ['chat', 'editor', 'root', 'transport', 'quit']);
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
  assert.deepEqual(f.released, ['chat', 'editor', 'root', 'transport', 'exit:1']);
});
