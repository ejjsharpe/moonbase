import type { BrowserWindow, Clipboard, Dialog, OpenDialogOptions, Shell } from 'electron';
import { Effect, Ref, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import type { WorkspaceError } from '@moonbase/contracts/workspace-errors';
import { NativeActionError } from '@moonbase/contracts/ipc-errors';

/** What the editor's document may ask of this Mac, through main. */
export type NativeActions = {
  readonly chooseCheckout: Effect.Effect<string | null>;
  /** A folder for local chat to work in, or null when the picker is cancelled. */
  readonly chooseFolder: Effect.Effect<string | null>;
  /**
   * Shows the window if a picker is open on it. A picker can't be closed for the user, so Quit
   * surfaces it to be answered, and its request's cancellation waits for that.
   */
  readonly surfacePickers: Effect.Effect<void>;
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
/**
 * Shows a native dialog; every native dialog goes through here. A request cancelled meanwhile
 * aborts `signal` and waits for the dialog to close, ignoring its answer. A message box closes
 * on `signal`, as if cancelled; Electron's pickers can't, so they stay until the user answers.
 */
export const showDialog = <A>(show: (signal: AbortSignal) => Promise<A>) =>
  Effect.callback<A>((resume, signal) => {
    const answer = show(signal);
    answer.then(
      (value) => resume(Effect.succeed(value)),
      (cause: unknown) => resume(Effect.die(cause)),
    );
    return Effect.promise(() => answer.then(ignore, ignore));
  });
const ignore = () => {};

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
  isClosing,
}: {
  window: BrowserWindow;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showMessageBox'>;
  clipboard: Pick<Clipboard, 'has' | 'read' | 'writeText'>;
  shell: Pick<Shell, 'showItemInFolder'>;
  capture: NativeActions['capture'];
  release: NativeActions['release'];
  /** Whether Quit is releasing everything, after which no picker opens. */
  isClosing: Effect.Effect<boolean>;
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const openPickers = yield* Ref.make(0);
    /**
     * A picker on the window, counted while open. Once Quit is closing it answers as cancelled
     * without opening: counted first, then checked, so a picker either opens before Quit surfaces
     * the open ones or sees that Quit is closing.
     */
    const pick = (options: OpenDialogOptions) =>
      Effect.acquireUseRelease(
        Ref.update(openPickers, (count) => count + 1),
        () =>
          Effect.flatMap(isClosing, (closing) =>
            closing
              ? Effect.succeed({ canceled: true, filePaths: [] })
              : showDialog(() => dialog.showOpenDialog(window, options)),
          ),
        () => Ref.update(openPickers, (count) => count - 1),
      );
    const chooseDirectory = (title: string) =>
      Effect.map(pick({ title, properties: ['openDirectory'] }), (result) =>
        result.canceled ? null : (result.filePaths[0] ?? null),
      );
    const clipboardPaths = (checkout: CheckoutTarget) =>
      Effect.gen(function* () {
        // Only Finder files import. Without them, such as after text was copied, there is nothing
        // to ask about, and the renderer pastes its own entries instead. Until consent, only the
        // type's presence is checked; nothing on the clipboard is read.
        if (!(yield* Effect.promise(async () => clipboard.has(finderFiles)))) return [];
        const consent = yield* showDialog((signal) =>
          dialog.showMessageBox(window, {
            signal,
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
      chooseCheckout: chooseDirectory('Open a Git checkout'),
      chooseFolder: chooseDirectory('Choose a local chat working folder'),
      surfacePickers: Effect.flatMap(Ref.get(openPickers), (count) =>
        count > 0 && !window.isDestroyed()
          ? Effect.sync(() => {
              window.show();
              window.focus();
            })
          : Effect.void,
      ),
      choosePaths: (checkout, kind) =>
        kind === 'clipboard'
          ? clipboardPaths(checkout)
          : Effect.map(
              pick({
                title: 'Import files into ' + checkout.root,
                properties: ['openFile', 'openDirectory', 'multiSelections'],
              }),
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
