import { Context, Effect, Fiber, type ManagedRuntime, Stream } from 'effect';
import { ChatConnection } from '../chat/connection/connection-service.ts';
import { ChatDrafts } from '../chat/drafts/drafts-service.ts';
import { ChatList } from '../chat/chat-list/chat-list-service.ts';
import { ChatSelection } from '../chat/selection/selection-service.ts';
import { ChatSends } from '../chat/sends/sends-service.ts';
import type { ChatServices } from '../chat/chat-layer.ts';
import { readChatState, watchChatState } from '../chat/chat-state.ts';

/**
 * An open chat as a test drives it: its services' actions on `runtime`, each resolving once it
 * settles, and its state read from the services.
 */
export function driveChat(
  runtime: Pick<
    ManagedRuntime.ManagedRuntime<never, unknown>,
    'runPromise' | 'runSync' | 'runFork'
  >,
  context: Context.Context<ChatServices>,
) {
  const run = <A, E>(effect: Effect.Effect<A, E, ChatServices>) =>
    runtime.runPromise(Effect.provideContext(effect, context));
  const connection = Context.get(context, ChatConnection);
  const drafts = Context.get(context, ChatDrafts);
  const list = Context.get(context, ChatList);
  const selection = Context.get(context, ChatSelection);
  const sends = Context.get(context, ChatSends);
  return {
    getSnapshot: () => runtime.runSync(Effect.provideContext(readChatState, context)),
    subscribe: (listener: () => void) => {
      const fiber = runtime.runFork(
        Effect.provideContext(
          Stream.runForEach(watchChatState, () => Effect.sync(listener)),
          context,
        ),
      );
      return () => void runtime.runFork(Fiber.interrupt(fiber));
    },
    start: () => run(connection.start),
    connect: () => run(connection.connect),
    disconnect: () => run(connection.disconnect),
    closeView: () => run(selection.closeView),
    select: (target: Parameters<typeof selection.select>[0]) => run(selection.select(target)),
    setDraft: (...args: Parameters<typeof drafts.setDraft>) => run(drafts.setDraft(...args)),
    preserve: () => run(drafts.preserve),
    send: () => run(sends.send()),
    create: (...args: Parameters<typeof sends.create>) => run(sends.create(...args)),
    stop: () => run(sends.stop),
    settle: (...args: Parameters<typeof list.settle>) => run(list.settle(...args)),
    loadTranscriptPart: (...args: Parameters<typeof selection.loadTranscriptPart>) =>
      run(selection.loadTranscriptPart(...args)),
    loadTranscriptManifest: (...args: Parameters<typeof selection.loadTranscriptManifest>) =>
      run(selection.loadTranscriptManifest(...args)),
    showEarlier: () => run(selection.showEarlier),
    jumpToEntry: (entryId: string) => run(selection.jumpToEntry(entryId)),
    jumpToLatest: () => run(selection.jumpToLatest),
    setTranscriptView: (...args: Parameters<typeof selection.setTranscriptView>) =>
      run(selection.setTranscriptView(...args)),
    findTranscript: (query: string) => run(selection.findTranscript(query)),
    closeFind: () => run(selection.closeFind),
    nextFindMatch: () => run(selection.nextFindMatch),
    previousFindMatch: () => run(selection.previousFindMatch),
  };
}
