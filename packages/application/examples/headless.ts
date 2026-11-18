import { Effect, Layer, ManagedRuntime, SubscriptionRef } from 'effect';
import { MoonbaseApplication } from '@moonbase/application';
import {
  editorLayer,
  EditorBuffers,
  EditorCheckouts,
  EditorSaves,
  EditorTabs,
  RecoverySync,
} from '@moonbase/application/editor';
import {
  ChatConnection,
  ChatDrafts,
  ChatSelection,
  ChatSends,
  readChatState,
  type ChatServices,
} from '@moonbase/application/chat';
import { fauxChat } from '@moonbase/application/testing/faux-chat';
import { fauxWorkspace } from '@moonbase/application/testing/faux-workspace';

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

const checkout = {
  hostId: 'local',
  checkoutId: 'headless',
  projectId: 'example',
  root: '/memory/headless',
  vcs: 'git' as const,
  branch: 'main',
  worktree: 'main' as 'main' | 'linked',
};
const target = { checkout, path: 'example.txt' };

/**
 * A direct public consumer, the root of its own process: it builds one runtime per composition
 * (editor-only, chat-only and combined) and drives the services alone, with no atom or view.
 */
export async function checkHeadlessApplication() {
  const completed: string[] = [];
  for (const mode of ['editor', 'chat', 'combined'] as const) {
    const chat = fauxChat();
    const workspace = fauxWorkspace([{ checkout, files: { 'example.txt': 'original' } }]).layer;
    const application = MoonbaseApplication.layer({
      chat: mode === 'editor' ? undefined : Effect.succeed(chat.dependencies),
    });
    const layer =
      mode === 'chat'
        ? Layer.provideMerge(application, workspace)
        : Layer.provideMerge(
            application,
            Layer.provideMerge(editorLayer({ clientId: `example-${mode}` }), workspace),
          );
    const runtime: ManagedRuntime.ManagedRuntime<MoonbaseApplication, unknown> =
      ManagedRuntime.make(layer as Layer.Layer<MoonbaseApplication, unknown>);
    try {
      const app = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* MoonbaseApplication;
        }),
      );
      await runtime.runPromise(app.start as Effect.Effect<void, unknown>);
      invariant(chat.calls.length === 0, 'Starting invoked a remote command');
      if (mode !== 'chat')
        await runtime.runPromise(
          Effect.gen(function* () {
            yield* (yield* EditorCheckouts).openCheckout(checkout.root);
            const tabs = yield* EditorTabs;
            invariant(yield* tabs.open(target), 'Explicit Open did not complete');
            yield* tabs.edit(target, 'edited');
            const buffer = yield* (yield* EditorBuffers).find(target);
            invariant(buffer?.text === 'edited', 'Edit lagged');
            invariant(yield* (yield* EditorSaves).save(target), 'Explicit Save did not complete');
            yield* (yield* RecoverySync).flush;
          }) as Effect.Effect<void, unknown>,
        );
      const conversation = (await runtime.runPromise(SubscriptionRef.get(app.chat.state))).chat;
      // The chat's services alone: no atom, controller or view.
      const inChat = <A>(effect: Effect.Effect<A, never, ChatServices>) =>
        runtime.runPromise(Effect.provideContext(effect, conversation!));
      if (mode !== 'editor') {
        invariant(conversation, 'Chat did not open');
        await inChat(Effect.flatMap(ChatConnection, (c) => c.start));
        invariant(!chat.calls.includes('connect'), 'Observation connected automatically');
        await inChat(Effect.flatMap(ChatConnection, (c) => c.connect));
        await inChat(Effect.flatMap(ChatSelection, (s) => s.select(chat.target)));
        await inChat(Effect.flatMap(ChatDrafts, (d) => d.setDraft('portable draft')));
        invariant(
          await inChat(Effect.flatMap(ChatDrafts, (d) => d.preserve)),
          'Preservation vetoed',
        );
        invariant(chat.storage.value?.includes('portable draft'), 'Draft was not written');
        await inChat(Effect.flatMap(ChatSends, (s) => s.send()));
        invariant(chat.calls.includes('sendChat'), 'Explicit Send did not complete');
        const state = await inChat(readChatState);
        invariant(state.pending.length === 0 && state.draft === '', 'Send was not resolved');
      }
      invariant(runtime.runSync(app.canUnload), 'Preserved application vetoed unload');
      invariant(await runtime.runPromise(app.prepareQuit), 'Preserved application vetoed Quit');
      const raw = chat.storage.value;
      if (conversation)
        await inChat(Effect.flatMap(ChatDrafts, (d) => d.setDraft('blocked after consent')));
      invariant(chat.storage.value === raw, 'Prepared application admitted a draft edit');
      const opened = await runtime.runPromiseExit(app.openChat);
      invariant(opened._tag === 'Failure', 'Prepared application opened a chat');
      await runtime.runPromise(app.release);
      invariant(
        (await runtime.runPromise(SubscriptionRef.get(app.phase))) === 'disposed',
        'Release did not complete',
      );
      invariant(chat.controls.closed === chat.controls.observations, 'Observation was not closed');
      completed.push(mode);
    } finally {
      await runtime.dispose();
    }
  }
  return completed;
}
