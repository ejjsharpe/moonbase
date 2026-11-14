import { execFileSync } from 'node:child_process';
import type { BrowserWindow, Clipboard, Dialog, Shell } from 'electron';
import { ApplicationError, type CheckoutTarget } from '@moonbase/contracts/workspace';
import type { NativeActions } from './editor-session.ts';

/** The raw pasteboard type under which Finder lists copied files, all of them in one plist. */
const finderFiles = 'electron application/osclipboard;format="NSFilenamesPboardType"';

export function createNativeActions({
  window,
  dialog,
  clipboard,
  shell,
  capture,
  release,
}: {
  window: BrowserWindow;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>;
  clipboard: Pick<Clipboard, 'has' | 'read' | 'writeText'>;
  shell: Pick<Shell, 'showItemInFolder'>;
  capture(input: {
    checkout: CheckoutTarget;
    clientId: string;
    paths: string[];
  }): Promise<string[]>;
  release: NativeActions['release'];
}): NativeActions {
  return {
    async chooseCheckout() {
      const result = await dialog.showOpenDialog(window, {
        title: 'Open a Git checkout',
        properties: ['openDirectory'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    async imports(
      checkout: CheckoutTarget,
      kind: 'picker' | 'clipboard',
      paths?: string[],
      signal?: AbortSignal,
    ) {
      if (!paths && kind === 'picker') {
        const result = await dialog.showOpenDialog(window, {
          title: 'Import files into ' + checkout.root,
          properties: ['openFile', 'openDirectory', 'multiSelections'],
        });
        if (result.canceled) return [];
        paths = result.filePaths;
      }
      if (kind === 'clipboard') {
        // Only Finder files import. Without them, such as after text was copied, there is
        // nothing to ask about, and the renderer pastes its own entries instead. Until consent,
        // only the type's presence is checked; nothing on the clipboard is read.
        if (!(await clipboard.has(finderFiles))) return [];
        const consent = await dialog.showMessageBox(window, {
          type: 'question',
          message: 'Import clipboard files?',
          detail: 'Copy files from Finder, then confirm import into ' + checkout.root,
          buttons: ['Cancel', 'Import files'],
          defaultId: 0,
          cancelId: 0,
        });
        // Declined: the renderer pastes nothing, rather than its own entries.
        if (consent.response !== 1) return null;
        const item = (await clipboard.read()).find((item) => item.types.includes(finderFiles));
        const payload = item && (await item.getType(finderFiles));
        const bytes =
          payload && 'arrayBuffer' in payload
            ? Buffer.from(await payload.arrayBuffer())
            : Buffer.alloc(0);
        if (!bytes.length)
          throw new ApplicationError({
            code: 'InvalidInput',
            message: 'Clipboard contains no Finder files.',
          });
        const parsed: unknown = JSON.parse(
          execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
            input: bytes,
            maxBuffer: 2 ** 20,
          }).toString(),
        );
        if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== 'string'))
          throw new ApplicationError({
            code: 'InvalidInput',
            message: 'Invalid Finder file list.',
          });
        paths = parsed;
      }
      if (signal?.aborted)
        throw new ApplicationError({ code: 'Cancelled', message: 'Native request cancelled.' });
      if (!paths?.length) return [];
      return capture({ checkout, clientId: 'desktop-primary', paths });
    },
    release(input: { checkout: CheckoutTarget; clientId: string; references: string[] }) {
      return release(input);
    },
    async copyText(text: string) {
      await clipboard.writeText(text);
    },
    async reveal(path: string) {
      shell.showItemInFolder(path);
    },
  };
}
