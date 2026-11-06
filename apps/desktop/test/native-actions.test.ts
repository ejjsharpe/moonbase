import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserWindow, Dialog } from 'electron';
import { createNativeActions } from '../src/main/native-actions.ts';

test('native imports require consent, preserve capture identity and cancel before capture', async () => {
  let consent = 0,
    cancelled = false,
    clipboardReads = 0;
  let finishPicker!: () => void;
  let holdPicker = false;
  const captured: unknown[] = [],
    released: unknown[] = [];
  const actions = createNativeActions({
    window: {} as BrowserWindow,
    dialog: {
      showOpenDialog: async () => {
        if (holdPicker)
          await new Promise<void>((resolve) => {
            finishPicker = resolve;
          });
        return { canceled: cancelled, filePaths: ['/picked'] };
      },
      showMessageBox: async () => ({ response: consent, checkboxChecked: false }),
    } as Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>,
    clipboard: {
      read: async () => {
        clipboardReads++;
        return [];
      },
    },
    capture: async (input) => {
      captured.push(input);
      return ['reference'];
    },
    release: async (input) => {
      released.push(input);
    },
  });
  const checkout = {
    hostId: 'local',
    checkoutId: 'c',
    projectId: 'p',
    root: '/checkout',
    branch: 'main',
    worktree: 'main' as 'main' | 'linked',
  };
  assert.deepEqual(await actions.imports(checkout, 'clipboard'), []);
  assert.equal(clipboardReads, 0);
  consent = 1;
  await assert.rejects(actions.imports(checkout, 'clipboard'), { code: 'InvalidInput' });
  assert.equal(await actions.chooseCheckout(), '/picked');
  assert.deepEqual(await actions.imports(checkout, 'picker'), ['reference']);
  assert.deepEqual(captured, [{ checkout, clientId: 'desktop-primary', paths: ['/picked'] }]);
  cancelled = true;
  assert.equal(await actions.chooseCheckout(), null);
  assert.deepEqual(await actions.imports(checkout, 'picker'), []);
  cancelled = false;
  holdPicker = true;
  const abort = new AbortController();
  const pending = actions.imports(checkout, 'picker', undefined, abort.signal);
  abort.abort();
  finishPicker();
  await assert.rejects(pending, { code: 'Cancelled' });
  assert.equal(captured.length, 1);
  const input = { checkout, clientId: 'desktop-primary', references: ['reference'] };
  await actions.release(input);
  assert.deepEqual(released, [input]);
});
