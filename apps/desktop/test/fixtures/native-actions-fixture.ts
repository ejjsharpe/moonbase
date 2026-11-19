import type { BrowserWindow, Dialog } from 'electron';
import { Effect } from 'effect';
import type { makeNativeActions } from '../../src/main/native-actions.ts';

const finderFiles = 'electron application/osclipboard;format="NSFilenamesPboardType"';

/** Native actions' OS capabilities as fakes: a picker, a consent prompt and a clipboard holding `plist`. */
export function nativeActionsFixture(plist: Uint8Array) {
  const state = {
    consent: 0,
    cancelled: false,
    finderFiles: false,
    prompts: 0,
    reads: 0,
    /** Whether Quit is releasing everything. */
    closing: false,
    checkout: {
      hostId: 'local',
      checkoutId: 'c',
      projectId: 'p',
      root: '/checkout',
      vcs: 'git' as const,
      branch: 'main',
      worktree: 'main' as 'main' | 'linked',
    },
    options: undefined as unknown as Parameters<typeof makeNativeActions>[0],
  };
  state.options = {
    window: {} as BrowserWindow,
    dialog: {
      showOpenDialog: async () => ({ canceled: state.cancelled, filePaths: ['/picked'] }),
      showMessageBox: async () => {
        state.prompts++;
        return { response: state.consent, checkboxChecked: false };
      },
    } as Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>,
    clipboard: {
      // Finder's file list, under the raw type Electron names it by.
      has: (format: string) => state.finderFiles && format === finderFiles,
      read: async () => {
        state.reads++;
        return state.finderFiles
          ? [
              {
                types: [finderFiles],
                getType: async () => new Blob([plist as Uint8Array<ArrayBuffer>]),
              } as unknown as Electron.ClipboardItem,
            ]
          : [];
      },
      writeText: async () => {},
    } as never,
    shell: { showItemInFolder: () => {} },
    capture: () => Effect.succeed(['reference']),
    release: () => Effect.void,
    isClosing: Effect.sync(() => state.closing),
  };
  return state;
}
