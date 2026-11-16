import { Effect, Layer, ManagedRuntime, Stream, SubscriptionRef } from 'effect';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';
import {
  MoonbaseApplication,
  toApplicationSnapshot,
  type ChatHostOptions,
} from '@moonbase/application';
import {
  editorLayer,
  EditorBuffers,
  EditorCheckouts,
  EditorPreservation,
  EditorSession,
  EditorTabs,
  RecoverySync,
  type ClosePrompt,
} from '@moonbase/application/editor';
import { WorkspaceService } from '@moonbase/contracts/services';
import type { FileTarget } from '@moonbase/contracts/workspace';

export const checkout = {
  hostId: 'local',
  checkoutId: 'checkout',
  projectId: 'project',
  root: '/memory/application',
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
export const target = { checkout, path: 'a.ts' };

type Options = Omit<ChatHostOptions, 'runner'> & { editor?: boolean };

/**
 * An application in one runtime, as a renderer root builds it: the composition over the editor
 * (over a faux workspace) when `editor` is set. Tests drive it through its services.
 */
export function makeApplication(options: Options) {
  const memory = fauxWorkspace([{ checkout, files: { 'a.ts': 'original', 'b.ts': 'second' } }]);
  const runner = {
    runPromiseExit: <A, E>(effect: Effect.Effect<A, E>, opts?: { signal?: AbortSignal }) =>
      runtime.runPromiseExit(effect, opts).then((exit) => {
        if (process.env.DEBUG_RUNNER && exit._tag === 'Failure') console.log(String(exit.cause));
        return exit;
      }),
  };
  const composition = MoonbaseApplication.layer({ ...options, runner });
  const layer = options.editor
    ? Layer.provideMerge(
        composition,
        Layer.provideMerge(editorLayer({ clientId: 'one' }), memory.layer),
      )
    : Layer.provideMerge(composition, memory.layer);
  const runtime: ManagedRuntime.ManagedRuntime<never, unknown> = ManagedRuntime.make(
    layer as Layer.Layer<never, unknown>,
  );
  const run = <A, E>(effect: Effect.Effect<A, E, never>) => runtime.runPromise(effect);
  const through = <A, E, I, S>(
    service: Effect.Effect<S, never, I>,
    f: (service: S) => Effect.Effect<A, E>,
  ) => run(Effect.flatMap(service as Effect.Effect<S>, f));
  const app = <A, E>(f: (app: MoonbaseApplication['Service']) => Effect.Effect<A, E>) =>
    through(MoonbaseApplication, f);
  return {
    memory,
    runtime,
    run,
    app,
    start: () => app((a) => a.start),
    snapshot: () =>
      app((a) =>
        Effect.map(
          Effect.all([SubscriptionRef.get(a.phase), SubscriptionRef.get(a.chat.state)]),
          ([phase, chat]) => toApplicationSnapshot(phase, chat, a.chat.targets),
        ),
      ),
    chat: () => app((a) => Effect.map(SubscriptionRef.get(a.chat.state), (s) => s.controller)),
    canUnload: () =>
      runtime.runSync(
        Effect.flatMap(
          MoonbaseApplication as unknown as Effect.Effect<MoonbaseApplication['Service']>,
          (a) => a.canUnload,
        ),
      ),
    prepareQuit: () => app((a) => a.prepareQuit),
    /** Waits until the chat's release has ended. */
    cleanupSettled: () =>
      app((a) =>
        SubscriptionRef.changes(a.chat.state).pipe(
          Stream.filter((s) => !s.cleanupPending),
          Stream.runHead,
        ),
      ),
    editor: {
      openCheckout: () => through(EditorCheckouts, (c) => c.openCheckout(checkout.root)),
      open: (file: FileTarget = target) => through(EditorTabs, (t) => t.open(file)),
      edit: (text: string, file: FileTarget = target) =>
        through(EditorTabs, (t) => t.edit(file, text)),
      flush: () => through(RecoverySync, (r) => r.flush),
      text: (file: FileTarget = target) =>
        through(EditorBuffers, (b) => Effect.map(b.find(file), (buffer) => buffer?.text)),
      admissionsOpen: () =>
        through(EditorSession, (s) => Effect.map(s.get, (state) => state.admissionsOpen)),
      /** The next close prompt, waiting for one if none is shown. */
      closePrompt: () =>
        through(EditorPreservation, (p) =>
          SubscriptionRef.changes(p.closePrompt).pipe(
            Stream.filter((prompt): prompt is ClosePrompt => prompt !== null),
            Stream.runHead,
            Effect.map((prompt) => (prompt._tag === 'Some' ? prompt.value : undefined)),
          ),
        ),
      answer: (id: string, choice: 'save' | 'discard' | 'cancel') =>
        through(EditorPreservation, (p) => p.answerClose(id, choice)),
      drafts: () =>
        through(WorkspaceService, (w) =>
          Effect.map(w.loadRecovery({ clientId: 'one' }), ({ state }) =>
            state.buffers.flatMap((b) => (b.draft ? [b.draft.text] : [])),
          ),
        ),
    },
    dispose: async () => {
      await app((a) => Effect.ignore(a.release)).catch(() => {});
      await runtime.dispose();
    },
  };
}

export { fauxChat } from '@moonbase/application/testing/faux-chat';
