import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { Context, Effect, Exit, Layer, ManagedRuntime, Scope, SubscriptionRef } from 'effect';
import { RegistryProvider } from '@effect/atom-react';
import {
  MoonbaseApplication,
  ApplicationLifecycleError,
  describeApplicationFailure,
  makeApplicationAtoms,
} from '@moonbase/application';
import type { ChatRunner } from '@moonbase/application/chat';
import { EditorAlerts, getFailureCode } from '@moonbase/application/editor';
import { makeWorkbenchEditor, type WorkbenchEditor } from '@moonbase/workbench';
import { configureMonacoWorkers } from '@moonbase/workbench/workers';
import { ApplicationError, CancelledError } from '@moonbase/contracts/errors';
import { DesktopShell, type DesktopShellHandle } from './shell/desktop-shell.tsx';
import type { DesktopApplication } from './shell/desktop-application.ts';
import { WorkbenchStartupFailure } from './shell/startup-failure.tsx';
import type { DesktopBridge } from '../ipc/desktop-bridge.ts';
import { boundApplicationError } from '../ipc/ipc-errors.ts';
import { makeChatTargetClients, makeShellClients } from './ipc/application-clients.ts';
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
const targetClients = new Map<string, ReturnType<typeof makeChatTargetClients>>();
/** Captured per target once, so a selected target change cannot reroute a pending action. */
function getTargetClients(target: 'local' | 'remote'): ReturnType<typeof makeChatTargetClients> {
  let clients = targetClients.get(target);
  if (!clients) targetClients.set(target, (clients = makeChatTargetClients(runtime, target)));
  return clients;
}
// The renderer's one runtime: every request to main runs here, over this document's IPC port,
// and it holds the workspace, the editor and the application.
const runner: ChatRunner = {
  runPromiseExit: (effect, options) => runtime.runPromiseExit(effect, options),
};
const runtime = ManagedRuntime.make(makeIpcLayer(window.moonbase));
/** Where the editor and application live, closed as the document goes, before main is told. */
const documentScope = Scope.makeUnsafe();
/** A failure as the window's lifecycle reports it to main: the legacy error, Moonbase's text. */
const toWindowError = (error: unknown) =>
  ApplicationError.is(error)
    ? error
    : new ApplicationError({
        code:
          getFailureCode(error) ??
          (error instanceof ApplicationLifecycleError ? error.code : undefined) ??
          'Unavailable',
        message: describeApplicationFailure(error),
      });
const shell = makeShellClients(runtime, window.moonbase);
/** Runs main's window actions through `on` for as long as the document lives, each once. */
function useWindowActions(
  on: (action: 'quit' | 'dispose' | 'cleanup-error', id: string, error?: ApplicationError) => void,
  dependency: unknown,
) {
  useEffect(() => {
    const close = shell.watchWindowActions((action) =>
      action.action === 'cleanup-error'
        ? on(action.action, '', action.error)
        : on(action.action, action.id),
    );
    return () => void close().catch(() => {});
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- one watch per dependency
  }, [dependency]);
}
/**
 * Answers main's Quit request, as a message: main may close the window before replying. A lost
 * answer is sent again while main can't be reached, and whenever main asks again.
 */
const answerQuit = (id: string, consent: boolean, cleanupError?: ApplicationError) =>
  void shell
    .answerQuit(id, consent, cleanupError && boundApplicationError(cleanupError))
    .catch(() => {});
function Desktop({
  application,
  editor,
}: {
  application: DesktopApplication;
  editor: WorkbenchEditor;
}) {
  const handle = useRef<DesktopShellHandle>(null),
    [closing, setClosing] = useState(false),
    [releasing, setReleasing] = useState(false);
  async function prepareQuit(id: string) {
    try {
      const consent = await handle.current!.prepareQuit();
      if (consent) flushSync(() => setClosing(true));
      answerQuit(id, consent);
    } catch (error) {
      void editor.run(Context.get(editor.context, EditorAlerts).report(error));
      answerQuit(id, false);
    }
  }
  useWindowActions((action, id, error) => {
    if (action === 'cleanup-error' && error)
      void application.run(application.service.reportCleanup(error));
    if (action === 'quit') void prepareQuit(id);
    if (action === 'dispose') {
      flushSync(() => {
        setClosing(true);
        setReleasing(true);
      });
      const acknowledge = (error?: ApplicationError) => {
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
      transcriptNative={(target) => getTargetClients(target as 'local' | 'remote').transcript}
      chooseChatFolder={shell.chooseChatFolder}
      recentChatFolders={(target) => shell.listChatFolders(target as 'local' | 'remote')}
      createChatWorktree={shell.createChatWorktree}
      turnChatIntoProject={shell.turnChatIntoProject}
      selectCheckout={async () => (isLive() ? shell.chooseCheckout() : null)}
      selectClipboardImports={async (checkout) => (isLive() ? shell.pasteImports(checkout) : [])}
      copyPaths={shell.copyPaths}
      revealPath={shell.revealPath}
      selectDroppedImports={async (checkout, files) =>
        isLive() ? ((await shell.dropImports(checkout, files)) ?? []) : []
      }
    />
  );
}
function StartupFailure({ error }: { error: ApplicationError }) {
  useWindowActions((action, id) => {
    if (action === 'quit') answerQuit(id, true);
    if (action === 'dispose') {
      root.unmount();
      answerQuit(id, true, error);
    }
  }, error);
  return <WorkbenchStartupFailure message={error.message} />;
}

const cancelled = () => new CancelledError({ operation: 'The action' });
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
let isLive = () => false;

try {
  configureMonacoWorkers();
  const context = await runtime.runPromise(
    Layer.buildWithScope(makeDocumentLayer(runner, getTargetClients), documentScope),
  );
  const service = Context.get(context, MoonbaseApplication);
  releaseApplication = service.release;
  await runtime.runPromise(service.start);
  /**
   * Runs an action on the root runtime. One interrupted, or run once the runtime has gone (the
   * document closing), rejects as cancelled, which is never reported: no runtime text reaches
   * the view.
   */
  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
    runtime.runPromiseExit(effect).then(
      (exit) => {
        if (Exit.isSuccess(exit)) return exit.value;
        const reason = exit.cause.reasons.find(
          (item) => item._tag === 'Fail' || item._tag === 'Die',
        );
        if (reason?._tag === 'Fail') throw reason.error;
        throw reason?._tag === 'Die' ? reason.defect : cancelled();
      },
      () => {
        throw cancelled();
      },
    );
  const application: DesktopApplication = {
    service,
    atoms: makeApplicationAtoms(service),
    run,
    runSync: (effect) => runtime.runSync(effect),
  };
  const editor = makeWorkbenchEditor(context, run);
  isLive = () => SubscriptionRef.getUnsafe(service.phase) === 'live';
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
      <Desktop application={application} editor={editor} />
    </RegistryProvider>,
  );
} catch (error) {
  root.render(<StartupFailure error={boundApplicationError(toWindowError(error))} />);
}
