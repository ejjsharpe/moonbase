import { Context, type Effect, Exit, Scope, SubscriptionRef } from 'effect';
import type * as Atom from 'effect/reactivity/Atom';
import type { AtomRegistry } from 'effect/reactivity/AtomRegistry';
import {
  ChatActions,
  ChatConfig,
  ChatConnection,
  ChatDrafts,
  ChatFileSearch,
  ChatLink,
  ChatList,
  ChatProviderSetup,
  ChatSelection,
  ChatSends,
  makeChatAtoms,
  toChatState,
  type ChatAtoms,
  type ChatFileSearchSnapshot,
  type ChatServices,
  type ChatState,
  type ProviderSetupSnapshot,
} from '@moonbase/application/chat';

// The open chat as the chat view, list, header, pending commands, Find bar, composer, provider
// setup, shell and browser demo use it: its services' actions bound to the root runtime, and its
// state read through the atom registry. It holds no state of its own. The transcript reads the
// chat's atoms and runs its selection's actions itself.

type Run = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
type RunSync = <A, E>(effect: Effect.Effect<A, E>) => A;
/** Runs a chat action: each shows its own failure in the chat's state, so a rejection is dropped. */
const quietly = (run: Run) => (effect: Effect.Effect<void, unknown>) => run(effect).catch(() => {});

/** A composer's file picker, until its owner disposes it. */
export type DesktopFileSearch = {
  readonly getSnapshot: () => ChatFileSearchSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly search: (query: string, cwd?: string) => void;
  readonly clear: () => void;
  readonly dispose: () => void;
};

/** Provider sign-in as the views use it. */
export type DesktopProviderSetup = {
  readonly getSnapshot: () => ProviderSetupSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refresh: () => Promise<void>;
  readonly login: (providerId: string) => Promise<void>;
  readonly answer: (flowId: string, promptId: string, answer: string) => Promise<void>;
  readonly cancel: (flowId: string) => Promise<void>;
  readonly openUrl: (flowId: string) => Promise<void>;
  readonly logout: (providerId: string) => Promise<void>;
};

const made = new WeakMap<Context.Context<ChatServices>, DesktopChat>();

/** The open chat's services, bound once per chat (so views keep one identity per chat). */
export function getDesktopChat(
  context: Context.Context<ChatServices>,
  runner: { run: Run; runSync: RunSync },
  registry: AtomRegistry,
): DesktopChat {
  let chat = made.get(context);
  if (!chat) made.set(context, (chat = makeDesktopChat(context, runner, registry)));
  return chat;
}

function makeDesktopChat(
  context: Context.Context<ChatServices>,
  { run, runSync }: { run: Run; runSync: RunSync },
  registry: AtomRegistry,
) {
  const config = Context.get(context, ChatConfig);
  const connection = Context.get(context, ChatConnection);
  const drafts = Context.get(context, ChatDrafts);
  const list = Context.get(context, ChatList);
  const selection = Context.get(context, ChatSelection);
  const sends = Context.get(context, ChatSends);
  const files = Context.get(context, ChatFileSearch);
  const setup = Context.get(context, ChatProviderSetup);
  const atoms: ChatAtoms = makeChatAtoms(context);
  const refs = [
    Context.get(context, ChatActions).state,
    drafts.state,
    Context.get(context, ChatLink).state,
    list.state,
    selection.state,
    sends.state,
  ] as const;
  let last: { parts: readonly unknown[]; state: ChatState } | undefined;
  /**
   * The chat's state now, as a controller read it: synchronously from the services' refs (the
   * atoms follow them a tick later), the same object while no part changed.
   */
  const getSnapshot = (): ChatState => {
    const parts = refs.map((ref) => SubscriptionRef.getUnsafe(ref as never));
    if (last && parts.every((part, index) => part === last!.parts[index])) return last.state;
    const [actions, draftsState, link, listed, selected, sent] = parts as never[];
    const state = toChatState({
      actions,
      drafts: draftsState,
      link,
      list: listed,
      selection: selected,
      sends: sent,
    });
    last = { parts, state };
    return state;
  };
  const act = quietly(run);
  /** Subscribes to `atom`, read first: a subscription follows its ref only once it was read. */
  const follow = (atom: Atom.Atom<unknown>, listener: () => void) => {
    registry.get(atom);
    return registry.subscribe(atom, listener);
  };
  const providers: DesktopProviderSetup | null = setup.available
    ? {
        getSnapshot: () => registry.get(atoms.providers)!,
        subscribe: (listener) => follow(atoms.providers, listener),
        refresh: () => act(setup.refresh),
        login: (id) => act(setup.login(id)),
        answer: (flowId, promptId, answer) => act(setup.answer(flowId, promptId, answer)),
        cancel: (flowId) => act(setup.cancel(flowId)),
        openUrl: (flowId) => act(setup.openUrl(flowId)),
        logout: (id) => act(setup.logout(id)),
      }
    : null;
  return {
    context,
    atoms,
    /** The chat's host, store and actor. */
    session: config.session,
    backendId: config.backendId,
    providers,
    getSnapshot,
    subscribe: (listener: () => void) => follow(atoms.state, listener),
    start: () => act(connection.start),
    connect: () => act(connection.connect),
    disconnect: () => act(connection.disconnect),
    refresh: () => act(connection.refresh),
    firstChats: () => act(connection.refresh),
    moreChats: () => act(list.more),
    reloadChats: (options?: { latest?: boolean }) => act(list.reload(options)),
    watchChats: () => act(list.watch),
    settle: (...args: Parameters<typeof list.settle>) => act(list.settle(...args)),
    markSeen: (conversationId: string, at: string) => void act(drafts.markSeen(conversationId, at)),
    setDraft: (...args: Parameters<typeof drafts.setDraft>) => void act(drafts.setDraft(...args)),
    setModelPreference: (...args: Parameters<typeof drafts.setModelPreference>) =>
      void act(drafts.setModelPreference(...args)),
    select: (...args: Parameters<typeof selection.select>) => act(selection.select(...args)),
    closeView: () => act(selection.closeView),
    showEarlier: () => act(selection.showEarlier),
    showLater: () => act(selection.showLater),
    openFind: () => void act(selection.openFind),
    closeFind: () => void act(selection.closeFind),
    cancelFindReveal: () => void act(selection.cancelFindReveal),
    findTranscript: (query: string) => act(selection.findTranscript(query)),
    nextFindMatch: () => act(selection.nextFindMatch),
    previousFindMatch: () => act(selection.previousFindMatch),
    jumpToEntry: (entryId: string) => act(selection.jumpToEntry(entryId)),
    jumpToLatest: () => act(selection.jumpToLatest),
    setTranscriptView: (...args: Parameters<typeof selection.setTranscriptView>) =>
      void act(selection.setTranscriptView(...args)),
    loadTranscriptManifest: (...args: Parameters<typeof selection.loadTranscriptManifest>) =>
      act(selection.loadTranscriptManifest(...args)),
    loadTranscriptPart: (...args: Parameters<typeof selection.loadTranscriptPart>) =>
      act(selection.loadTranscriptPart(...args)),
    create: (...args: Parameters<typeof sends.create>) => act(sends.create(...args)),
    send: (...args: Parameters<typeof sends.send>) => act(sends.send(...args)),
    stop: () => act(sends.stop),
    retry: (requestId: string) => act(sends.retry(requestId)),
    query: (requestId: string) => act(sends.query(requestId)),
    /** A file picker for a composer; the caller disposes it. */
    createFileSearch: (): DesktopFileSearch => {
      const scope = Scope.makeUnsafe();
      const search = runSync(Scope.provide(files.make, scope));
      const state = atoms.fileSearch.state(search);
      return {
        getSnapshot: () => SubscriptionRef.getUnsafe(search.state),
        subscribe: (listener) => follow(state, listener),
        search: (query, cwd) => void act(search.search(query, cwd)),
        clear: () => void act(search.clear),
        dispose: () => void run(Scope.close(scope, Exit.void)),
      };
    },
  };
}
export type DesktopChat = ReturnType<typeof makeDesktopChat>;
