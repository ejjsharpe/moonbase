import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { Context, Effect, Exit, Layer, ManagedRuntime, Scope, SubscriptionRef } from 'effect';
import { RegistryProvider } from '@effect/atom-react';
import {
  MoonbaseApplication,
  describeApplicationFailure,
  makeApplicationAtoms,
} from '@moonbase/application';
import { EditorAlerts } from '@moonbase/application/editor';
import { makeWorkbenchEditor, type WorkbenchEditor } from '@moonbase/workbench';
import { configureMonacoWorkers } from '@moonbase/workbench/workers';
import { DesktopShell, type DesktopShellHandle, type ShellNative } from './shell/desktop-shell.tsx';
import type { DesktopApplication } from './shell/desktop-application.ts';
import { makeDesktopPlatform } from './shell/desktop-platform.ts';
import { WorkbenchStartupFailure } from './shell/startup-failure.tsx';
import type { DesktopBridge } from '../ipc/desktop-bridge.ts';
import { makeWindowFailure, type WindowFailure } from '../ipc/ipc-errors.ts';
import { DesktopNative } from './ipc/desktop-native.ts';
import { makeWindowActions } from './ipc/window-actions.ts';
import { makeDocumentLayer, makeIpcLayer } from './renderer-layer.ts';
import * as stylex from '@stylexjs/stylex';
import { workbench } from '@moonbase/ui/workbench';
import '@moonbase/ui/reset.css';
import '@moonbase/ui/fonts.css';

declare global {
  interface Window {
    moonbase: DesktopBridge;
  }
}
document.body.className = stylex.props(workbench.document).className ?? '';
const root = createRoot(document.getElementById('root')!);
// The renderer's one runtime: every request to main runs here, over this document's IPC port,
// and it holds the workspace, main's native capabilities, the editor and the application. Views
// run their actions through atom functions; only this root runs Effects itself.
const runtime = ManagedRuntime.make(makeIpcLayer(window.moonbase));
/** Where the editor and application live, closed as the document goes, before main is told. */
const documentScope = Scope.makeUnsafe();
/** A failure as the window's lifecycle reports it to main: Moonbase's text of it. */
const toWindowError = (error: unknown) => makeWindowFailure(describeApplicationFailure(error));
const windowActions = makeWindowActions();
/** Runs main's window actions through `on` for as long as the document lives, each once. */
function useWindowActions(
  on: (action: 'quit' | 'dispose' | 'cleanup-error', id: string, error?: WindowFailure) => void,
  dependency: unknown,
) {
  useEffect(() => {
    const watching = runtime.runFork(
      windowActions.watch((action) =>
        action.action === 'cleanup-error'
          ? on(action.action, '', action.error)
          : on(action.action, action.id),
      ),
    );
    // Interrupting stops delivery at once, then ends the watch.
    return () => watching.interruptUnsafe();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- one watch per dependency
  }, [dependency]);
}
/**
 * Answers main's Quit request, as a message: main may close the window before replying. A lost
 * answer is sent again while main can't be reached, and whenever main asks again.
 */
const answerQuit = (id: string, consent: boolean, cleanupError?: WindowFailure) =>
  void runtime.runFork(Effect.ignore(windowActions.answerQuit(id, consent, cleanupError)));
function Desktop({
  application,
  editor,
  native,
}: {
  application: DesktopApplication;
  editor: WorkbenchEditor;
  native: ShellNative;
}) {
  const handle = useRef<DesktopShellHandle>(null),
    [closing, setClosing] = useState(false),
    [releasing, setReleasing] = useState(false);
  function prepareQuit(id: string) {
    runtime.runPromise(handle.current!.prepareQuit).then(
      (consent) => {
        if (consent) flushSync(() => setClosing(true));
        answerQuit(id, consent);
      },
      (error: unknown) => {
        runtime.runFork(Context.get(editor.context, EditorAlerts).report(error));
        answerQuit(id, false);
      },
    );
  }
  useWindowActions((action, id, error) => {
    if (action === 'cleanup-error' && error)
      runtime.runFork(application.service.reportCleanup(error));
    if (action === 'quit') prepareQuit(id);
    if (action === 'dispose') {
      flushSync(() => {
        setClosing(true);
        setReleasing(true);
      });
      const acknowledge = (error?: WindowFailure) => {
        root.unmount();
        answerQuit(id, true, error);
      };
      void release().then(
        () => acknowledge(),
        (error: unknown) => acknowledge(toWindowError(error)),
      );
    }
  }, application);
  if (releasing)
    return (
      <main>
        <span role="status">Closing workbench…</span>
      </main>
    );
  return (
    <DesktopShell
      ref={handle}
      application={application}
      editor={editor}
      closing={closing}
      native={native}
    />
  );
}
function StartupFailure({ error }: { error: WindowFailure }) {
  useWindowActions((action, id) => {
    if (action === 'quit') answerQuit(id, true);
    if (action === 'dispose') {
      root.unmount();
      answerQuit(id, true, error);
    }
  }, error);
  return <WorkbenchStartupFailure message={error.message} />;
}

/**
 * Releases the application, then the editor with the document's scope; the IPC runtime stays to
 * answer main. Joins a release running.
 */
let released: Promise<void> | undefined;
let releaseApplication: Effect.Effect<void, unknown> = Effect.void;
const release = () =>
  (released ??= runtime
    .runPromise(releaseApplication)
    .finally(() => runtime.runPromise(Scope.close(documentScope, Exit.void))));

try {
  configureMonacoWorkers();
  const context = await runtime.runPromise(
    Layer.buildWithScope(makeDocumentLayer(), documentScope),
  );
  const service = Context.get(context, MoonbaseApplication);
  releaseApplication = service.release;
  await runtime.runPromise(service.start);
  const native = await runtime.runPromise(DesktopNative);
  /** Whether the application is live, so a project may still open or files arrive. */
  const live = Effect.map(SubscriptionRef.get(service.phase), (phase) => phase === 'live');
  const application: DesktopApplication = { service, atoms: makeApplicationAtoms(service) };
  const editor = makeWorkbenchEditor(context, makeDesktopPlatform(native, live));
  const shellNative: ShellNative = {
    ...native,
    chooseCheckout: Effect.flatMap(live, (isLive) =>
      isLive ? native.chooseCheckout : Effect.succeed(null),
    ),
  };
  window.addEventListener('beforeunload', (event) => {
    if (!runtime.runSync(service.canUnload)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.addEventListener('unload', () => {
    void release()
      .catch((error: unknown) => console.error(describeApplicationFailure(error)))
      .finally(() => runtime.dispose());
  });
  root.render(
    <RegistryProvider>
      <Desktop application={application} editor={editor} native={shellNative} />
    </RegistryProvider>,
  );
} catch (error) {
  root.render(<StartupFailure error={toWindowError(error)} />);
}
