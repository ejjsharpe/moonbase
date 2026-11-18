import type { BrowserWindow, Clipboard, Dialog, Shell } from 'electron';
import { Effect, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { WorkspaceError } from '@moonbase/contracts/workspace-errors';
import { NativeActionError } from '@moonbase/contracts/ipc-errors';

/** What the editor's document may ask of this Mac, through main. */
export type NativeActions = {
  readonly chooseCheckout: Effect.Effect<string | null>;
  /**
   * The paths to import: the picker's, or the Finder files on the clipboard. None when there is
   * nothing to import, or null for a declined prompt.
   */
  choosePaths(
    checkout: CheckoutTarget,
    kind: 'picker' | 'clipboard',
  ): Effect.Effect<string[] | null, NativeActionError>;
  /** Captures `paths` for the editor, returning the references it may import. */
  capture(input: {
    checkout: CheckoutTarget;
    clientId: string;
    paths: string[];
  }): Effect.Effect<string[], WorkspaceError>;
  release(input: {
    checkout: CheckoutTarget;
    clientId: string;
    references: string[];
  }): Effect.Effect<void, WorkspaceError>;
  /** Writes text to the OS clipboard. */
  copyText(text: string): Effect.Effect<void>;
  /** Shows an absolute path in the OS file manager. */
  reveal(path: string): Effect.Effect<void>;
};

/** The raw pasteboard type under which Finder lists copied files, all of them in one plist. */
const finderFiles = 'electron application/osclipboard;format="NSFilenamesPboardType"';
/** The most `plutil` may print for one clipboard's Finder files. */
const maximumFileListBytes = 2 ** 20;
const invalid = (failure: NativeActionError['failure']) => new NativeActionError({ failure });

/** A Finder file list (a binary or XML plist) as its paths, converted by `/usr/bin/plutil`. */
const readFinderFiles = (plist: Uint8Array) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
          stdin: Stream.make(plist),
          // Closing the scope (a cancelled request, or too much output) kills it.
          killSignal: 'SIGKILL',
        }),
      );
      const [json, , status] = yield* Effect.all(
        [
          handle.stdout.pipe(
            Stream.decodeText,
            Stream.runFoldEffect(
              () => '',
              (text, chunk) =>
                text.length + chunk.length > maximumFileListBytes
                  ? Effect.fail(invalid('finder-files'))
                  : Effect.succeed(text + chunk),
            ),
          ),
          Stream.runDrain(handle.stderr),
          handle.exitCode,
        ],
        { concurrency: 'unbounded' },
      );
      if (status !== 0) return yield* Effect.fail(invalid('finder-files'));
      return json;
    }),
  ).pipe(
    Effect.mapError((error) =>
      error instanceof NativeActionError ? error : invalid('finder-files'),
    ),
    Effect.flatMap((json) =>
      Effect.try({
        try: () => JSON.parse(json) as unknown,
        catch: () => invalid('finder-files'),
      }),
    ),
    Effect.flatMap((parsed) =>
      Array.isArray(parsed) && parsed.every((path) => typeof path === 'string')
        ? Effect.succeed(parsed as string[])
        : Effect.fail(invalid('finder-files')),
    ),
  );

export const makeNativeActions = ({
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
  capture: NativeActions['capture'];
  release: NativeActions['release'];
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // A native dialog can't be withdrawn, so a request cancelled meanwhile waits for its answer.
    const ask = <A>(show: () => Promise<A>) => Effect.uninterruptible(Effect.promise(show));
    const clipboardPaths = (checkout: CheckoutTarget) =>
      Effect.gen(function* () {
        // Only Finder files import. Without them, such as after text was copied, there is nothing
        // to ask about, and the renderer pastes its own entries instead. Until consent, only the
        // type's presence is checked; nothing on the clipboard is read.
        if (!(yield* Effect.promise(async () => clipboard.has(finderFiles)))) return [];
        const consent = yield* ask(() =>
          dialog.showMessageBox(window, {
            type: 'question',
            message: 'Import clipboard files?',
            detail: 'Copy files from Finder, then confirm import into ' + checkout.root,
            buttons: ['Cancel', 'Import files'],
            defaultId: 0,
            cancelId: 0,
          }),
        );
        // Declined: the renderer pastes nothing, rather than its own entries.
        if (consent.response !== 1) return null;
        const bytes = yield* Effect.promise(async () => {
          const item = (await clipboard.read()).find((item) => item.types.includes(finderFiles));
          const payload = item && (await item.getType(finderFiles));
          return payload && 'arrayBuffer' in payload
            ? new Uint8Array(await payload.arrayBuffer())
            : new Uint8Array();
        });
        if (!bytes.length) return yield* Effect.fail(invalid('no-finder-files'));
        return yield* readFinderFiles(bytes).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
      });
    return {
      chooseCheckout: Effect.map(
        ask(() =>
          dialog.showOpenDialog(window, {
            title: 'Open a Git checkout',
            properties: ['openDirectory'],
          }),
        ),
        (result) => (result.canceled ? null : (result.filePaths[0] ?? null)),
      ),
      choosePaths: (checkout, kind) =>
        kind === 'clipboard'
          ? clipboardPaths(checkout)
          : Effect.map(
              ask(() =>
                dialog.showOpenDialog(window, {
                  title: 'Import files into ' + checkout.root,
                  properties: ['openFile', 'openDirectory', 'multiSelections'],
                }),
              ),
              (result) => (result.canceled ? [] : result.filePaths),
            ),
      capture,
      release,
      // A clipboard write under way is waited for, never left to finish unseen.
      copyText: (text) =>
        Effect.uninterruptible(Effect.promise(async () => clipboard.writeText(text))),
      reveal: (path) => Effect.sync(() => shell.showItemInFolder(path)),
    } satisfies NativeActions;
  });
