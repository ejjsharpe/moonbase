import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope, type ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ObservationClose } from '@moonbase/contracts/common';
import { normalizeApplicationError, runApplicationEffect } from '../../runtime/effect-client.ts';
import { decodeChatInput, ChatModelPreferenceSchema } from '@moonbase/contracts/chat-schema';
import type {
  ChatCreationSettings,
  ChatMention,
  ChatModelPreference,
  ChatClient,
  ChatCommand,
  ChatInput,
  ChatListState,
  ChatOutput,
  ChatHostConfiguration,
  ChatSession,
  ChatSnapshot,
  ChatSummary,
  ChatTarget,
  ChatStopTarget,
  ChatTranscriptSource,
  ChatTranscriptSelection,
} from '@moonbase/contracts/chat';
import {
  findChatMentionStarts,
  isChatMentionPath,
  maximumChatMentions,
} from '@moonbase/contracts/chat';
import type { ConnectionClient, ConnectionSnapshot } from '@moonbase/contracts/connection';
import { makeProviderSetupController, type ProviderSetupController } from './providers.ts';
import type { ProviderSetupClient } from '@moonbase/contracts/providers';
import {
  decodeSaved,
  sameSession,
  sameTarget,
  seenLimit,
  type Saved,
  type Pending,
} from './saved.ts';
export type { Pending } from './saved.ts';
import { TranscriptOwner } from './transcript.ts';
import {
  makeEmptyTranscriptState,
  transcriptLimits,
  type TranscriptState,
} from './transcript-state.ts';
import { TranscriptViewMemory, type TranscriptView } from './view-memory.ts';
import { ChatFileSearch } from './file-search.ts';

export interface DraftStorage {
  read(): string | null;
  write(value: string): void;
}
export type ChatState = {
  /** Whether the host is reached through a connection that is connected explicitly. */
  remote: boolean;
  ready: boolean;
  connection: ConnectionSnapshot | null;
  host: ChatHostConfiguration | null;
  chats: ChatSummary[];
  nextChats: string | null;
  /** Chats you have looked at and the activity time you saw; absent before the first listing. */
  seen: readonly { conversationId: string; at: string }[] | undefined;
  snapshot: ChatSnapshot | null;
  transcript: TranscriptState;
  selected: ChatTarget | null;
  draft: string;
  /** Files the draft mentions; each is spelled in `draft` (`formatChatMention`). */
  mentions: ChatMention[];
  modelPreference: ChatModelPreference | null;
  pending: Pending[];
  /** Request IDs of pending commands this session is still sending; their outcome is not yet in doubt. */
  dispatching: string[];
  active: string[];
  error: string | null;
  storageError: string | null;
  notice: string;
};
export type ChatDependencies = {
  chat: ChatClient;
  /** How a host on another machine is connected; absent for one on this machine. */
  connection?: ConnectionClient;
  providers?: ProviderSetupClient;
  context: ChatSession;
  storage: DraftStorage;
  newId?: () => string;
  backendId?: string;
  transcriptMemory?: TranscriptViewMemory;
  /** How long closing a chat waits for cancelled reads; defaults to `transcriptLimits.closeGraceMs`. */
  transcriptCloseGraceMs?: number;
  /**
   * Backoff before each re-watch of the selected chat after a retryable stream failure; its length
   * caps consecutive attempts. Defaults to `transcriptLimits.watchRetryMs`.
   */
  transcriptWatchRetryMs?: readonly number[];
  /**
   * How long a watch must stay up after its first snapshot for its failure to renew the retry cap.
   * Defaults to `transcriptLimits.watchHealthyMs`.
   */
  transcriptWatchHealthyMs?: number;
};
/**
 * A unit of work that ends together. Owners nest: the attachment (Start until Detach) holds the
 * connection owner (one per connected host), which holds the refresh owner and the selection (the
 * open chat). Closing one closes its scope, interrupting its fibers and watches, and those beneath it.
 *
 * `alive` turns false the moment an owner closes, before its scope finishes closing. Callbacks from
 * watches run outside Effect and can't be interrupted, so they check it, as does code that resumes
 * between the close and the interruption.
 */
type Owner = {
  scope: Scope.Closeable;
  alive: boolean;
  observations: Set<Observation>;
  completion?: Promise<void>;
  transcript?: TranscriptOwner;
};
type Observation = {
  ready: Deferred.Deferred<Exit.Exit<ObservationClose>>;
  /** The connection the watch belongs to, so Disconnect can close exactly its watches. */
  connectionOwner?: Owner;
  outcome?: Promise<Exit.Exit<void>>;
};
/** One watch of the selected chat; it stops delivering once it fails. */
type WatchAttempt = {
  open: boolean;
  received: boolean;
  /** Monotonic time of the first snapshot this watch delivered. */
  firstSnapshotAt?: number;
  observation?: Observation;
};
const maximumSavedBytes = 2 * 1024 * 1024;
/** Pages a listing reads, so a chat that is active again is listed however long ago it started. */
const chatListPages = 16;
/** Most pages a background reload reads again; older chats Show older added past them stay as listed. */
const chatReloadPages = 64;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const text = (value: string, limit: number) =>
  value.isWellFormed() && !value.includes('\0') && bytes(value) <= limit;
const sameStop = (a: ChatStopTarget, b: ChatStopTarget) =>
  sameTarget(a.target, b.target) && a.submissionId === b.submissionId && a.taskId === b.taskId;
const invalid = (message: string) => new ApplicationError({ code: 'InvalidInput', message });
/**
 * Merges a fresh listing into the one on screen. Chats are never removed, so a chat the listing
 * did not return (one past its pages, or one created while it read) stays, after the chat it
 * followed on screen.
 */
function keepUnreachedChats(shown: readonly ChatSummary[], listed: readonly ChatSummary[]) {
  const reached = new Set(listed.map((chat) => chat.target.conversationId));
  const following = new Map<string | null, ChatSummary[]>();
  let anchor: string | null = null;
  for (const chat of shown) {
    const id = chat.target.conversationId;
    if (reached.has(id)) anchor = id;
    else following.set(anchor, [...(following.get(anchor) ?? []), chat]);
  }
  return [
    ...(following.get(null) ?? []),
    ...listed.flatMap((chat) => [chat, ...(following.get(chat.target.conversationId) ?? [])]),
  ];
}

class ChatModelState {
  private saved: Saved;
  private raw: string | null = null;
  private state: ChatState;
  private listeners = new Set<() => void>();
  private scope: Scope.Closeable;
  private attachment?: Owner;
  private detaching?: Promise<void>;
  private connectionOwner?: Owner;
  private selection?: Owner & { target: ChatTarget };
  private refreshOwner?: Owner;
  private observations = new Set<Observation>();
  // A closing child scope detaches from its parent, so disposal joins already-closing owners here.
  private transcripts = new Set<TranscriptOwner>();
  /** Bumped whenever what the view shows changes (connection, selection, close, detach). */
  private epoch = 0;
  /** Counts connection states the watch delivered, so a slower read never overwrites one. */
  private connectionRevision = 0;
  private closed = false;
  private admissionsOpen = true;
  private actions = new Map<string, number>();
  private cleanup?: Promise<void>;
  private releasing = false;
  private released = Deferred.makeUnsafe<Exit.Exit<void>>();
  private runEffect!: <A>(effect: Effect.Effect<A, ApplicationError>) => Promise<A>;
  private bound = false;
  private readonly chat: ChatClient;
  private readonly connection?: ConnectionClient;
  readonly providers: ProviderSetupController | null;
  private readonly session: ChatSession;
  private storage: DraftStorage;
  private newId: () => string;
  private readonly backend: string;
  private readonly transcriptMemory: TranscriptViewMemory;
  private readonly transcriptCloseGraceMs?: number;
  private readonly transcriptWatchRetryMs: readonly number[];
  private readonly transcriptWatchHealthyMs: number;

  constructor(scope: Scope.Closeable, dependencies: ChatDependencies) {
    this.scope = scope;
    this.chat = dependencies.chat;
    this.backend = dependencies.backendId ?? 'chat';
    this.transcriptMemory = dependencies.transcriptMemory ?? new TranscriptViewMemory();
    this.transcriptCloseGraceMs = dependencies.transcriptCloseGraceMs;
    this.transcriptWatchRetryMs =
      dependencies.transcriptWatchRetryMs ?? transcriptLimits.watchRetryMs;
    this.transcriptWatchHealthyMs =
      dependencies.transcriptWatchHealthyMs ?? transcriptLimits.watchHealthyMs;
    this.connection = dependencies.connection;
    this.providers = dependencies.providers
      ? makeProviderSetupController(dependencies.providers, {
          retryMs: this.transcriptWatchRetryMs,
          healthyMs: this.transcriptWatchHealthyMs,
        })
      : null;
    this.session = structuredClone(
      decodeChatInput('listChats', { session: dependencies.context }).session,
    );
    this.storage = dependencies.storage;
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
    this.saved = {
      version: 1,
      session: structuredClone(this.session),
      selected: null,
      drafts: [],
      pending: [],
    };
    let storageError: string | null = null;
    try {
      this.raw = this.storage.read();
      if (this.raw !== null) {
        if (bytes(this.raw) > maximumSavedBytes)
          throw invalid('Saved chat data exceeds its bound. Preserve it for recovery.');
        this.saved = decodeSaved(JSON.parse(this.raw), this.session);
      }
    } catch {
      storageError =
        'Saved chat data or storage is unavailable. Preserve the original data; no new mutation can start.';
    }
    this.state = {
      remote: !!this.connection,
      ready: false,
      connection: null,
      host: null,
      chats: [],
      nextChats: null,
      seen: this.saved.seen,
      snapshot: null,
      transcript: makeEmptyTranscriptState(),
      selected: this.saved.selected,
      draft: this.draft(),
      mentions: this.draftMentions(),
      modelPreference: this.saved.modelPreference ?? null,
      pending: this.saved.pending,
      dispatching: [],
      active: [],
      error: null,
      storageError,
      notice: this.connection
        ? 'Disconnected. Connect explicitly; reconnect never resends a message.'
        : 'Local chat. Tools run on this computer; a working folder is not a filesystem sandbox.',
    };
  }
  /** Whether new work may start: admissions are open and the model is not disposed. */
  private get accepting() {
    return this.admissionsOpen && !this.closed;
  }
  /** Composition fences admissions; retained command results may still reconcile. */
  setAdmissionsOpen(open: boolean) {
    if (!this.closed) {
      this.admissionsOpen = open;
      this.providers?.setAdmissionsOpen(open);
    }
  }
  bind<R, E extends ApplicationError>(runtime: ManagedRuntime.ManagedRuntime<R, E>) {
    if (this.bound) throw invalid('Chat model already bound.');
    this.bound = true;
    this.runEffect = (effect) => runApplicationEffect(runtime, effect);
    return this;
  }
  get backendId(): string {
    return this.backend;
  }
  get context(): ChatSession {
    return structuredClone(this.session);
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(change: Partial<ChatState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A view cannot interrupt draft preservation or owned chat work. */
      }
    }
  }
  private draft() {
    if (!this.saved.selected) return this.saved.newDraft ?? '';
    return (
      this.saved.drafts.find((draft) => sameTarget(draft.target, this.saved.selected))?.text ?? ''
    );
  }
  private draftMentions(): ChatMention[] {
    if (!this.saved.selected) return this.saved.newDraftMentions ?? [];
    return (
      this.saved.drafts.find((draft) => sameTarget(draft.target, this.saved.selected))?.mentions ??
      []
    );
  }
  private commit(next: Saved) {
    if (this.closed) throw invalid('Chat model disposed.');
    if (this.state.storageError)
      throw new ApplicationError({ code: 'Persistence', message: this.state.storageError });
    decodeSaved(next, this.session);
    const raw = JSON.stringify(next);
    try {
      if (bytes(raw) > maximumSavedBytes || this.storage.read() !== this.raw) throw Error();
      this.storage.write(raw);
      this.raw = raw;
      this.saved = next;
      this.update({
        selected: next.selected,
        draft: this.draft(),
        mentions: this.draftMentions(),
        pending: next.pending,
        modelPreference: next.modelPreference ?? null,
        seen: next.seen,
      });
    } catch {
      this.update({
        storageError:
          'Draft preservation failed or another client changed it. Keep this window open; no new mutation can start.',
      });
      throw new ApplicationError({ code: 'Persistence', message: 'Draft preservation failed.' });
    }
  }
  private error = (error: unknown) => {
    const failure = normalizeApplicationError(error);
    this.update({ error: `${failure.code}: ${failure.message}` });
  };
  private owner(parent?: Owner): Owner {
    let alive = true;
    return {
      scope: Scope.forkUnsafe(parent?.scope ?? this.scope),
      get alive() {
        return alive && (parent?.alive ?? true);
      },
      set alive(value) {
        alive = value;
      },
      observations: new Set(),
    };
  }
  private closeObservation(observation: Observation): Promise<Exit.Exit<void>> {
    return (observation.outcome ??= this.runEffect(
      Effect.exit(
        Effect.flatMap(Deferred.await(observation.ready), (acquired) =>
          Effect.flatMap(acquired, (close) => Effect.promise(close)),
        ),
      ).pipe(Effect.uninterruptible),
    ).then(
      (exit) => {
        if (Exit.isSuccess(exit)) this.observations.delete(observation);
        return exit;
      },
      (error) => Exit.die(error),
    ));
  }
  private observe(
    owner: Owner,
    acquire: () => ObservationClose,
    connectionOwner?: Owner,
  ): Effect.Effect<Observation | undefined, ApplicationError> {
    return Effect.gen({ self: this }, function* () {
      if (!owner.alive || this.closed) return undefined;
      // A synchronous watch callback can reenter disposal before acquisition returns.
      const observation: Observation = { ready: Deferred.makeUnsafe(), connectionOwner };
      this.observations.add(observation);
      owner.observations.add(observation);
      const acquired = yield* Effect.exit(
        Effect.try({ try: acquire, catch: normalizeApplicationError }).pipe(Effect.orDie),
      );
      yield* Deferred.succeed(observation.ready, acquired);
      yield* Scope.addFinalizer(
        owner.scope,
        Effect.flatMap(
          Effect.promise(() => this.closeObservation(observation)),
          (exit) => exit,
        ),
      );
      if (Exit.isFailure(acquired)) yield* acquired;
      return observation;
    }).pipe(Effect.uninterruptible);
  }
  private closeOwner(owner?: Owner): Promise<void> {
    if (!owner) return Promise.resolve();
    if (!owner.completion) {
      owner.alive = false;
      void owner.transcript?.close();
      for (const observation of owner.observations) this.closeObservation(observation);
      owner.completion = this.runEffect(
        Scope.close(owner.scope, Exit.void).pipe(Effect.uninterruptible),
      );
      void owner.completion.catch(this.error);
    }
    return owner.completion;
  }
  private call<K extends ChatCommand>(
    operation: K,
    input: ChatInput<K>,
  ): Effect.Effect<ChatOutput<K>, ApplicationError> {
    return Effect.tryPromise({
      try: (signal) => this.chat.command(operation, input, { signal }),
      catch: normalizeApplicationError,
    });
  }
  private action(
    name: string,
    work: Effect.Effect<void, ApplicationError>,
    owner?: Owner,
    duplicate = true,
    current: () => boolean = () => true,
  ): Promise<void> {
    if (!this.accepting || (owner && !owner.alive) || (duplicate && this.actions.has(name)))
      return Promise.resolve();
    this.actions.set(name, (this.actions.get(name) ?? 0) + 1);
    this.update({ active: [...this.actions.keys()], error: null });
    return this.runEffect(
      Effect.flatMap(
        Effect.forkIn(work, owner?.scope ?? this.scope, { startImmediately: true }),
        Fiber.join,
      ),
    )
      .catch((error) => {
        if ((!owner || owner.alive) && current()) this.error(error);
      })
      .finally(() => {
        const count = this.actions.get(name)! - 1;
        if (count) this.actions.set(name, count);
        else this.actions.delete(name);
        this.update({ active: [...this.actions.keys()] });
      });
  }
  start(): Promise<void> {
    if (!this.accepting || this.attachment?.alive) return Promise.resolve();
    const owner = (this.attachment = this.owner());
    if (!this.connection) {
      this.connectionOwner = this.owner(owner);
      return Promise.all([this.refresh(), this.providers?.refresh()]).then(() => {});
    }
    let received = false;
    return this.action(
      'status',
      Effect.gen({ self: this }, function* () {
        yield* this.observe(owner, () =>
          this.connection!.watch(
            (state) => {
              if (owner.alive && this.attachment === owner) {
                received = true;
                this.connectionRevision++;
                this.onConnection(state);
              }
            },
            (error) => {
              if (owner.alive && this.attachment === owner) this.error(error);
            },
          ),
        );
        const state = yield* Effect.tryPromise({
          try: (signal) => this.connection!.command('getConnection', {}, { signal }),
          catch: normalizeApplicationError,
        });
        if (owner.alive && !received) this.onConnection(state);
      }),
      owner,
      false,
    ).then(async () => {
      if (owner.alive && this.state.connection?.state === 'connected' && !this.state.host)
        await this.refresh();
    });
  }
  private onConnection(state: ConnectionSnapshot) {
    if (!this.attachment?.alive || this.closed) return;
    const previous = this.state.connection;
    const changed =
      previous?.connectionId !== state.connectionId ||
      previous?.state !== state.state ||
      (state.state === 'connected' && !this.connectionOwner?.alive);
    // A repeated event is ready only once refresh has verified this connection's host.
    this.update({ connection: state, ready: state.state === 'connected' && !!this.state.host });
    if (!changed) return;
    this.epoch++;
    void this.selection?.transcript?.close();
    void this.closeOwner(this.connectionOwner);
    if (state.state === 'connected') this.connectionOwner = this.owner(this.attachment);
    this.selection = undefined;
    this.refreshOwner = undefined;
    this.update({
      snapshot: null,
      transcript: makeEmptyTranscriptState(),
      host: null,
      ready: false,
    });
    if (state.state === 'connected') void this.refresh();
  }
  /**
   * Whether a connection state read now is still the latest when its reply arrives: the same
   * attachment, and no watch event delivered in between.
   */
  private captureConnectionState() {
    const attachment = this.attachment,
      revision = this.connectionRevision;
    return () => attachment === this.attachment && revision === this.connectionRevision;
  }
  connect = () =>
    this.action(
      'connect',
      Effect.gen({ self: this }, function* () {
        if (!this.connection) return;
        const state = this.state.connection;
        if (!state) return;
        const isLatest = this.captureConnectionState();
        const connected = yield* Effect.tryPromise({
          try: (signal) =>
            this.connection!.command('connect', { profileId: state.profile.id }, { signal }),
          catch: normalizeApplicationError,
        });
        if (isLatest()) this.onConnection(connected);
      }),
    );
  disconnect = () => {
    const connection = this.connectionOwner,
      id = this.state.connection?.connectionId;
    return this.action(
      'disconnect',
      Effect.gen({ self: this }, function* () {
        if (
          !this.connection ||
          !id ||
          this.connectionOwner !== connection ||
          this.state.connection?.connectionId !== id
        )
          return;
        const selection = this.selection;
        void this.closeOwner(connection);
        void selection?.transcript?.close();
        if (this.connectionOwner === connection) this.update({ ready: false });
        const outcomes = yield* Effect.promise(() =>
          Promise.all(
            [...this.observations]
              .filter(
                (observation) =>
                  observation.connectionOwner !== undefined &&
                  observation.connectionOwner === connection,
              )
              .map((observation) => this.closeObservation(observation)),
          ),
        );
        for (const outcome of outcomes) yield* outcome;
        if (this.connectionOwner !== connection || this.state.connection?.connectionId !== id)
          return;
        yield* Effect.tryPromise({
          try: (signal) => this.connection!.command('disconnect', { connectionId: id }, { signal }),
          catch: normalizeApplicationError,
        });
        const isLatest = this.captureConnectionState();
        const state = yield* Effect.tryPromise({
          try: (signal) => this.connection!.command('getConnection', {}, { signal }),
          catch: normalizeApplicationError,
        });
        if (isLatest()) this.onConnection(state);
      }),
      undefined,
      true,
      () => this.connectionOwner === connection,
    );
  };
  private connected() {
    if (
      !this.connectionOwner?.alive ||
      (this.connection && this.state.connection?.state !== 'connected')
    )
      throw new ApplicationError({
        code: 'Unavailable',
        message: 'Connect to the configured host first.',
      });
    return this.epoch;
  }
  refresh = (): Promise<void> => {
    if (!this.accepting) return Promise.resolve();
    if (!this.connectionOwner?.alive)
      return this.action(
        'refresh',
        Effect.sync(() => {
          this.connected();
        }),
      );
    void this.closeOwner(this.refreshOwner);
    const owner = (this.refreshOwner = this.owner(this.connectionOwner));
    const epoch = this.epoch;
    return this.action(
      'refresh',
      Effect.gen({ self: this }, function* () {
        const host = yield* this.call('getChatHost', { host: this.session.host });
        if (!sameSession(host, this.session))
          throw new ApplicationError({
            code: 'Incompatible',
            message: 'Host actor does not match the configured chat context.',
          });
        if (!owner.alive || epoch !== this.epoch) return;
        // Opening a chat needs only the verified host, so a failed chat list cannot block it.
        this.update({
          host,
          ready: true,
          notice: this.connection
            ? 'Verified host. Reconnection reads saved state; it does not send.'
            : 'Local tools use this computer’s permissions. The selected folder is context, not a sandbox.',
        });
        // A connected host's providers are read once it is verified; a local one's at start.
        if (this.connection) void this.providers?.refresh();
        // The watch opens first, so the host follows changes past the first page the listing
        // could read too early; its pages wait for the listing and the latest merges after it.
        // Changes to the list arrive from the watch from here on; nothing lists on a timer.
        const watched = this.chatPagesWatched;
        this.listingChats = owner;
        yield* this.followChats(owner);
        const listed = yield* Effect.exit(this.listChats());
        if (this.listingChats === owner) this.listingChats = undefined;
        if (!owner.alive) return;
        if (Exit.isSuccess(listed) && epoch === this.epoch) {
          this.chatPages = listed.value.pages;
          this.listed(listed.value);
        }
        if (this.chatsFollowed === owner && this.chatPagesWatched !== watched && this.lastChatPage)
          this.mergeChats(this.lastChatPage);
        if (epoch !== this.epoch) return;
        if (this.state.transcript.observation === 'failed') {
          void this.closeOwner(this.selection);
          this.selection = undefined;
        }
        if (this.saved.selected && !this.selection?.alive)
          yield* this.openSelected(this.saved.selected);
        for (const pending of this.saved.pending)
          if (pending.operation === 'sendChat') yield* this.queryPending(pending);
        if (Exit.isFailure(listed)) yield* listed;
      }),
      owner,
      false,
    );
  };
  moreChats = () => {
    const owner = this.connectionOwner;
    return this.action(
      'chats',
      Effect.gen({ self: this }, function* () {
        const epoch = this.connected(),
          cursor = this.state.nextChats;
        if (!cursor) return;
        const page = yield* this.call('listChats', { session: this.session, cursor });
        if (owner?.alive && epoch === this.epoch) {
          this.chatPages++;
          this.listed({
            chats: [...this.state.chats, ...page.conversations],
            next: page.nextCursor,
          });
        }
      }),
      owner,
    );
  };
  /** Pages the chat list on screen spans: the first listing's, plus one per Show older. */
  private chatPages = 0;
  /** Up to `limit` first pages of chats; `next` continues past the `pages` it read. */
  private listChats(
    limit = chatListPages,
  ): Effect.Effect<{ chats: ChatSummary[]; next: string | null; pages: number }, ApplicationError> {
    return Effect.gen({ self: this }, function* () {
      const chats: ChatSummary[] = [];
      let cursor: string | null = null,
        pages = 0;
      while (pages < limit) {
        const listed: ChatOutput<'listChats'> = yield* this.call('listChats', {
          session: this.session,
          ...(cursor ? { cursor } : {}),
        });
        pages++;
        chats.push(...listed.conversations);
        cursor = listed.nextCursor;
        if (!cursor) break;
      }
      return { chats, next: cursor, pages };
    });
  }
  private listed({ chats, next }: { chats: ChatSummary[]; next: string | null }) {
    const unique = [...new Map(chats.map((chat) => [chat.target.conversationId, chat])).values()];
    this.update({ chats: unique, nextChats: next });
    // Before anything was marked, every listed chat counts as seen, so old work is not all Ready.
    if (this.saved.seen === undefined && !this.state.storageError)
      try {
        this.commit({
          ...this.saved,
          seen: unique
            .map((chat) => ({
              conversationId: chat.target.conversationId,
              at: chat.activity?.at ?? chat.createdAt,
            }))
            .slice(0, seenLimit),
        });
      } catch {
        /* commit reports storage failures in state. */
      }
  }
  private reloading?: Promise<void>;
  private reloadQueued = false;
  /**
   * Lists chats again in the background, through the pages on screen (at most `chatReloadPages`),
   * keeping the last list if it fails. Unlike Refresh it neither re-verifies the host nor clears an
   * error on screen, and it keeps listed chats it did not reach. A call during a reload joins it;
   * with `latest` (the list must show a change made since that reload began) one more runs after it.
   */
  reloadChats = ({ latest = false }: { latest?: boolean } = {}): Promise<void> => {
    if (this.reloading) {
      if (latest) this.reloadQueued = true;
      return this.reloading;
    }
    const listing = this.listAgain();
    if (!listing) return Promise.resolve();
    return (this.reloading = listing.then(() => {
      this.reloading = undefined;
      if (!this.reloadQueued) return;
      this.reloadQueued = false;
      return this.reloadChats();
    }));
  };
  private listAgain(): Promise<void> | undefined {
    const owner = this.connectionOwner;
    if (!this.accepting || !owner?.alive || !this.state.ready) return;
    let epoch: number;
    try {
      epoch = this.connected();
    } catch {
      return;
    }
    const watched = this.chatPagesWatched;
    return this.runEffect(
      Effect.flatMap(
        Effect.forkIn(
          this.listChats(Math.min(Math.max(this.chatPages, chatListPages), chatReloadPages)),
          owner.scope,
          { startImmediately: true },
        ),
        Fiber.join,
      ),
    )
      .then((listed) => {
        if (!owner.alive || epoch !== this.epoch || this.closed) return;
        const kept = keepUnreachedChats(this.state.chats, listed.chats);
        // The list reaches past the pages read only when a chat it did not reach comes last.
        const past = kept.length > 0 && !listed.chats.includes(kept.at(-1)!);
        if (!past) this.chatPages = listed.pages;
        this.listed({ chats: kept, next: past ? this.state.nextChats : listed.next });
        // A watch page that landed while this read is newer than the rows it returned.
        if (this.chatPagesWatched !== watched && this.lastChatPage)
          this.mergeChats(this.lastChatPage);
      })
      .catch(() => {});
  }
  /** The owner whose chat list watch is open or waiting to reconnect. */
  private chatsFollowed?: Owner;
  /** The latest state the chat list's watch delivered, and how many it has delivered. */
  private lastChatPage?: ChatListState;
  private chatPagesWatched = 0;
  /** The owner whose Refresh is reading the first listing; its watch pages wait for it. */
  private listingChats?: Owner;
  /**
   * Follows the chat list's watch for `owner`: each first page it delivers merges into the list
   * on screen with the changed chats past it, and a reset, a growing count of changed chats the
   * watch let go (or the first page after a failed watch) lists again in the background, since
   * chats past the first page may have changed unseen. A retryable failure watches
   * again after the transcript's backoff; once that runs out, the list stays as it is until
   * `watchChats` or Refresh.
   */
  private followChats(owner: Owner, recovering = false): Effect.Effect<void, ApplicationError> {
    type Attempt = {
      open: boolean;
      firstAt?: number;
      dropped?: number;
      observation?: Observation;
    };
    let failures = 0;
    if (this.chatsFollowed !== owner) this.lastChatPage = undefined;
    this.chatsFollowed = owner;
    // A selection changes the epoch but not the list, so only the owner bounds the watch.
    const current = () => owner.alive && this.chatsFollowed === owner;
    const follow = (reload: boolean): Effect.Effect<void, ApplicationError> =>
      Effect.gen({ self: this }, function* () {
        const attempt: Attempt = { open: true };
        attempt.observation = yield* this.observe(
          owner,
          () =>
            this.chat.watchChatList(
              { session: this.session },
              (update) => {
                if (!attempt.open || !current()) return;
                attempt.firstAt ??= performance.now();
                const dropped = attempt.dropped !== undefined && update.dropped !== attempt.dropped;
                attempt.dropped = update.dropped;
                this.lastChatPage = update;
                this.chatPagesWatched++;
                if (this.listingChats !== owner) this.mergeChats(update);
                if (update.reset || reload || dropped) {
                  reload = false;
                  void this.reloadChats({ latest: true });
                }
              },
              (error) => {
                if (!attempt.open) return;
                attempt.open = false;
                recover(error, attempt);
              },
            ),
          this.connectionOwner,
        );
        if (!attempt.open && attempt.observation) void this.closeObservation(attempt.observation);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (!Cause.hasInterruptsOnly(cause)) recover(Cause.squash(cause), { open: false });
          }),
        ),
      );
    const recover = (error: unknown, failed: Attempt) => {
      if (failed.observation) void this.closeObservation(failed.observation);
      if (!current()) return;
      if (
        failed.firstAt !== undefined &&
        performance.now() - failed.firstAt >= this.transcriptWatchHealthyMs
      )
        failures = 0;
      const delay = this.transcriptWatchRetryMs[failures];
      if (normalizeApplicationError(error).code !== 'Unavailable' || delay === undefined) {
        this.chatsFollowed = undefined;
        return;
      }
      failures++;
      const again = Effect.gen({ self: this }, function* () {
        yield* Effect.sleep(delay);
        if (current()) yield* follow(true);
      });
      void this.runEffect(Effect.forkIn(again, owner.scope)).catch(this.error);
    };
    return follow(recovering);
  }
  /**
   * Merges the chat list's first page into the list on screen, keeping chats it did not reach,
   * and replaces listed chats past it with their changed rows.
   */
  private mergeChats({ list: page, changed }: ChatListState) {
    const kept = keepUnreachedChats(this.state.chats, page.conversations);
    // The list reaches past the page only when a chat it did not reach comes last.
    const past = kept.length > 0 && !page.conversations.includes(kept.at(-1)!);
    if (!past) this.chatPages = 1;
    const rows = new Map(changed.map((chat) => [chat.target.conversationId, chat]));
    this.listed({
      chats: kept.map((chat) => rows.get(chat.target.conversationId) ?? chat),
      next: past ? this.state.nextChats : page.nextCursor,
    });
  }
  /**
   * Watches the chat list again if its watch stopped (as a window becomes visible), listing it
   * again once the watch delivers. A watch that is open or reconnecting is left alone.
   */
  watchChats = (): Promise<void> => {
    const owner = this.refreshOwner;
    if (!this.accepting || !owner?.alive || !this.state.ready) {
      return Promise.resolve();
    }
    if (this.chatsFollowed === owner) return Promise.resolve();
    return this.runEffect(this.followChats(owner, true)).catch(this.error);
  };
  /** Records that you saw a chat as of its activity time; an older look never replaces a newer one. */
  markSeen(conversationId: string, at: string) {
    if (!this.accepting || this.state.storageError) return;
    const seen = this.saved.seen ?? [];
    const current = seen.find((item) => item.conversationId === conversationId);
    if (current && Date.parse(current.at) >= Date.parse(at)) return;
    try {
      this.commit({
        ...this.saved,
        seen: [
          { conversationId, at },
          ...seen.filter((item) => item.conversationId !== conversationId),
        ].slice(0, seenLimit),
      });
    } catch {
      /* commit reports storage failures in state. */
    }
  }
  firstChats = () => this.refresh();
  setModelPreference(value: ChatModelPreference) {
    if (!this.accepting) return;
    try {
      const preference = Schema.decodeUnknownSync(ChatModelPreferenceSchema, {
        onExcessProperty: 'error',
        reportInput: false,
      })(value);
      this.commit({ ...structuredClone(this.saved), modelPreference: structuredClone(preference) });
    } catch (error) {
      this.error(
        ApplicationError.is(error) ? error : invalid('Choose a valid model and reasoning effort.'),
      );
    }
  }
  /**
   * Replaces the draft. `mentions` replaces its mentioned files; otherwise the draft keeps the ones
   * its text still spells, so deleting a mention's text drops the mention.
   */
  setDraft(value: string, mentions?: readonly ChatMention[]) {
    if (!this.accepting) return;
    if (!text(value, 32768)) {
      this.update({ error: 'Message must contain valid Unicode and at most 32 KiB.' });
      return;
    }
    const kept = [
      ...new Map(
        (mentions ?? this.state.mentions)
          .filter((mention) => findChatMentionStarts(value, mention.path).length)
          .map((mention) => [mention.path, { path: mention.path }]),
      ).values(),
    ];
    if (kept.length > maximumChatMentions) {
      this.update({ error: `A message can mention at most ${maximumChatMentions} files.` });
      return;
    }
    // A mention the saved format rejects is refused before it is shown, so it never blocks storage.
    if (kept.some((mention) => !isChatMentionPath(mention.path))) {
      this.update({
        error:
          'Mention a file by a relative path of at most 1 KiB, without quotes, backslashes, control characters or ./.. segments.',
      });
      return;
    }
    const target = this.saved.selected;
    this.update({ draft: value, mentions: kept });
    try {
      const next = structuredClone(this.saved);
      if (!target) {
        if (value) next.newDraft = value;
        else delete next.newDraft;
        if (kept.length) next.newDraftMentions = kept;
        else delete next.newDraftMentions;
      } else if (!value)
        next.drafts = next.drafts.filter((draft) => !sameTarget(draft.target, target));
      else {
        const index = next.drafts.findIndex((draft) => sameTarget(draft.target, target));
        const draft = { target, text: value, ...(kept.length ? { mentions: kept } : {}) };
        if (index >= 0) next.drafts[index] = draft;
        else next.drafts.push(draft);
      }
      this.commit(next);
    } catch (error) {
      this.update({
        storageError:
          this.state.storageError ??
          'This live edit could not be preserved within the draft bound. Copy it before closing; mutations and Quit are blocked.',
      });
      this.error(error);
    }
  }
  /**
   * Searches the selected chat's working folder on its host, or, for a new chat, `cwd` (a local
   * chat's chosen folder) or the remote host's fixed folder. Results are not retained.
   */
  findFiles(
    query: string,
    options: { cwd?: string; signal?: AbortSignal } = {},
  ): Promise<ChatOutput<'findChatFiles'>> {
    return this.runEffect(
      Effect.gen({ self: this }, function* () {
        this.connected();
        const target = this.saved.selected,
          cwd = options.cwd;
        if (!target && !cwd) throw invalid('Choose a working folder to search its files.');
        const input = decodeChatInput(
          'findChatFiles',
          target ? { target, query } : { session: this.session, cwd, query },
        );
        return yield* Effect.tryPromise({
          try: (signal) => {
            return this.chat.command('findChatFiles', input, {
              signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
            });
          },
          catch: normalizeApplicationError,
        });
      }),
    );
  }
  /** A composer's file picker over `findFiles`; the caller disposes it. */
  createFileSearch() {
    return new ChatFileSearch((query, options) => this.findFiles(query, options));
  }
  select = (target: ChatTarget): Promise<void> => {
    if (!this.accepting) return Promise.resolve();
    try {
      const captured = decodeChatInput('getChat', { target }).target;
      if (!sameSession(captured, this.session)) throw invalid('Chat belongs to another context.');
      const next = structuredClone(this.saved);
      next.selected = captured;
      this.commit(next);
      this.connected();
      this.epoch++;
      void this.closeOwner(this.selection);
      this.selection = undefined;
      // A selection supersedes an old list read without suppressing the new view's refresh. Until
      // refresh verifies the host, it owns opening the selection, and Select awaits it.
      const verifying = !this.state.host;
      let refreshing: Promise<void> | undefined;
      if (verifying || (this.refreshOwner?.alive && this.actions.has('refresh')))
        refreshing = this.refresh();
      const epoch = this.epoch;
      const opening = this.action(
        'open',
        this.openSelected(captured),
        this.connectionOwner,
        false,
        () => epoch === this.epoch && sameTarget(this.saved.selected, captured),
      );
      return verifying ? Promise.all([opening, refreshing]).then(() => {}) : opening;
    } catch (error) {
      this.error(error);
      return Promise.resolve();
    }
  };
  closeView(): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    try {
      this.commit({ ...structuredClone(this.saved), selected: null });
      this.epoch++;
      if (this.refreshOwner?.alive && this.actions.has('refresh')) void this.refresh();
      const closing = this.closeOwner(this.selection);
      this.selection = undefined;
      this.update({ snapshot: null, transcript: makeEmptyTranscriptState() });
      return closing;
    } catch (error) {
      this.error(error);
      return Promise.resolve();
    }
  }
  private openSelected(target: ChatTarget): Effect.Effect<void, ApplicationError> {
    return Effect.gen({ self: this }, function* () {
      if (!this.attachment?.alive || !this.connectionOwner?.alive || this.closed) return;
      // A chat opens only on a host that refresh has verified.
      if (!this.state.host) return;
      if (this.selection?.alive && sameTarget(this.selection.target, target)) return;
      void this.closeOwner(this.selection);
      const owner = (this.selection = Object.assign(this.owner(this.connectionOwner), {
        target: structuredClone(target),
      }));
      const epoch = this.epoch;
      this.update({ snapshot: null, transcript: makeEmptyTranscriptState() });
      const transcript = (owner.transcript = new TranscriptOwner({
        chat: this.chat,
        target: structuredClone(target),
        backend: this.backend,
        memory: this.transcriptMemory,
        // A chat on this machine is read in place; one over a connection streams.
        local: !this.connection,
        scope: owner.scope,
        closeGraceMs: this.transcriptCloseGraceMs,
        publish: (state, snapshot) => {
          if (owner.alive && this.selection === owner)
            this.update({ transcript: state, ...(snapshot ? { snapshot } : {}) });
        },
      }));
      this.transcripts.add(transcript);
      yield* Scope.addFinalizer(
        owner.scope,
        Effect.promise(() =>
          transcript.close().then(() => {
            this.transcripts.delete(transcript);
          }),
        ),
      );
      const accept = (snapshot: ChatSnapshot) => {
        if (
          owner.alive &&
          this.selection === owner &&
          epoch === this.epoch &&
          sameTarget(this.saved.selected, target) &&
          transcript.getSnapshot().observation !== 'failed'
        ) {
          try {
            transcript.acceptSnapshot(snapshot);
          } catch (error) {
            transcript.fail(error);
            this.error(error);
          }
        }
      };
      // A watch delivers until it fails, so a late result from a failed watch never reaches its
      // successor. Hosts send a snapshot as soon as a watch subscribes, so only a watch that stayed
      // up for the healthy period after its first snapshot renews the count of failed watches.
      let failures = 0;
      const watch = (attempt: WatchAttempt) =>
        Effect.gen({ self: this }, function* () {
          attempt.observation = yield* this.observe(
            owner,
            () =>
              this.chat.watch(
                { target },
                (snapshot) => {
                  if (!attempt.open) return;
                  attempt.received = true;
                  attempt.firstSnapshotAt ??= performance.now();
                  accept(snapshot);
                },
                (error) => {
                  if (!attempt.open || !owner.alive || this.selection !== owner) return;
                  attempt.open = false;
                  recover(error, attempt);
                },
              ),
            this.connectionOwner,
          );
          // A watch that failed while subscribing still holds its subscription.
          if (!attempt.open && attempt.observation) void this.closeObservation(attempt.observation);
          const snapshot = yield* this.call('getChat', { target });
          if (attempt.open && !attempt.received) accept(snapshot);
        });
      // Retryable stream failures re-watch after a bounded backoff; reads only, never a resend.
      const recover = (error: unknown, failed: WatchAttempt) => {
        // Release the failed subscription now, so it holds no host observer through the backoff.
        if (failed.observation) void this.closeObservation(failed.observation);
        // A transcript that already failed stays failed until Refresh or reopening.
        if (transcript.getSnapshot().observation === 'failed') return;
        if (
          failed.firstSnapshotAt !== undefined &&
          performance.now() - failed.firstSnapshotAt >= this.transcriptWatchHealthyMs
        )
          failures = 0;
        const failure = normalizeApplicationError(error);
        const delay = this.transcriptWatchRetryMs[failures];
        if (failure.code !== 'Unavailable' || delay === undefined) {
          const stopped =
            failure.code === 'Unavailable'
              ? new ApplicationError({
                  code: 'Unavailable',
                  message:
                    'Live updates stopped and could not reconnect. Refresh or reopen the conversation to retry.',
                })
              : error;
          transcript.fail(stopped);
          this.error(stopped);
          return;
        }
        failures++;
        transcript.markReconnecting();
        const rewatch = Effect.gen({ self: this }, function* () {
          yield* Effect.sleep(delay);
          if (!owner.alive || this.selection !== owner) return;
          const attempt: WatchAttempt = { open: true, received: false };
          // A watch that throws while subscribing fails with a defect; it is a failure too.
          yield* watch(attempt).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                if (Cause.hasInterruptsOnly(cause)) return;
                if (!attempt.open || !owner.alive || this.selection !== owner) return;
                attempt.open = false;
                recover(Cause.squash(cause), attempt);
              }),
            ),
          );
        });
        // The selection's scope ends the backoff on switch, close or disconnect.
        void this.runEffect(Effect.forkIn(rewatch, owner.scope)).catch(this.error);
      };
      const read = Effect.gen({ self: this }, function* () {
        yield* watch({ open: true, received: false });
        if (owner.alive && this.selection === owner)
          yield* Effect.promise(() => transcript.restoreView());
      });
      yield* Effect.flatMap(
        Effect.forkIn(read, owner.scope, { startImmediately: true }),
        Fiber.join,
      );
    });
  }
  private transcriptOwner() {
    if (!this.accepting) return undefined;
    return this.selection?.alive ? this.selection.transcript : undefined;
  }
  openFind = () => this.transcriptOwner()?.openFind();
  cancelFindReveal = () => this.transcriptOwner()?.cancelFindReveal();
  closeFind = () => this.transcriptOwner()?.closeFind();
  findTranscript = (query: string) =>
    this.transcriptOwner()?.findTranscript(query) ?? Promise.resolve();
  nextFindMatch = () => this.transcriptOwner()?.moveFind('next') ?? Promise.resolve();
  previousFindMatch = () => this.transcriptOwner()?.moveFind('previous') ?? Promise.resolve();
  showEarlier = () => this.transcriptOwner()?.showEarlier() ?? Promise.resolve();
  showLater = () => this.transcriptOwner()?.showLater() ?? Promise.resolve();
  jumpToEntry = (entryId: string) =>
    this.transcriptOwner()?.jumpToEntry(entryId) ?? Promise.resolve();
  jumpToLatest = () => this.transcriptOwner()?.jumpToLatest() ?? Promise.resolve();
  setTranscriptView = (view: TranscriptView) => this.transcriptOwner()?.setView(view);
  loadTranscriptManifest = (source: ChatTranscriptSource, restart = false) =>
    this.transcriptOwner()?.loadManifest(source, restart) ?? Promise.resolve();
  loadTranscriptPart = (
    source: ChatTranscriptSource,
    selection: ChatTranscriptSelection,
    restart = false,
  ) => this.transcriptOwner()?.loadPart(source, selection, restart) ?? Promise.resolve();
  private reserve(pending: Pending) {
    const next = structuredClone(this.saved);
    if (next.pending.length >= 16)
      throw invalid('Resolve an existing pending command before creating another.');
    next.pending.push(pending);
    this.commit(next);
  }
  create = (title: string, settings?: ChatCreationSettings) =>
    this.action(
      'create',
      Effect.gen({ self: this }, function* () {
        this.connected();
        if (!text(title, 200) || !title.trim())
          throw invalid('Use a chat title of 1–200 UTF-8 bytes.');
        if (!settings) throw invalid('Choose a folder and model for this chat.');
        const captured = decodeChatInput('createChat', {
          session: this.session,
          requestId: this.newId(),
          title,
          settings,
        });
        const pending: Pending = {
          operation: 'createChat',
          input: structuredClone(captured),
          message: 'Outcome pending. Original creation identity retained.',
        };
        yield* this.dispatch(pending, () => this.reserve(pending));
      }),
    );
  send = (settings?: ChatCreationSettings) =>
    this.action(
      'send',
      Effect.gen({ self: this }, function* () {
        this.connected();
        const target = this.saved.selected,
          value = this.state.draft,
          message = {
            text: value,
            ...(this.state.mentions.length
              ? { mentions: structuredClone(this.state.mentions) }
              : {}),
          };
        if (!text(value, 32768) || !value.trim()) throw invalid('Write a message before sending.');
        if (!target) {
          if (this.saved.drafts.length >= 32)
            throw invalid(
              '32 conversation drafts are retained. Send or clear an existing draft before starting another conversation.',
            );
          if (
            this.saved.pending.some(
              (pending) => pending.operation === 'createChat' && pending.firstMessage,
            )
          )
            throw invalid('Resolve the retained new conversation before sending another.');
          if (!settings) throw invalid('Choose a folder and model for this chat.');
          let title = '';
          for (const character of value.trim().split('\n')[0]!) {
            if (bytes(title + character) > 80) break;
            title += character;
          }
          const pending: Pending = {
            operation: 'createChat',
            input: decodeChatInput('createChat', {
              session: this.session,
              requestId: this.newId(),
              title: title || 'New conversation',
              settings,
            }),
            firstMessage: { requestId: this.newId(), ...message },
            message: 'Outcome pending. Original creation and first message retained.',
          };
          yield* this.dispatch(pending, () => this.reserve(pending));
          return;
        }
        if (
          this.saved.pending.some(
            (pending) =>
              pending.operation === 'sendChat' && sameTarget(pending.input.target, target),
          )
        )
          throw invalid('Resolve the retained Send before starting another in this chat.');
        const pending: Pending = {
          operation: 'sendChat',
          input: decodeChatInput('sendChat', {
            target: structuredClone(target),
            requestId: this.newId(),
            ...message,
          }),
          message: 'Outcome pending. Original Send identity and text retained.',
        };
        yield* this.dispatch(pending, () => this.reserve(pending));
      }),
    );
  stop = () =>
    this.action(
      'stop',
      Effect.gen({ self: this }, function* () {
        this.connected();
        const stop = this.state.snapshot?.run?.stop;
        if (!stop) return;
        if (
          this.saved.pending.some(
            (pending) => pending.operation === 'stopChat' && sameStop(pending.input.stop, stop),
          )
        )
          throw invalid('Resolve the captured Stop before requesting it again.');
        const pending: Pending = {
          operation: 'stopChat',
          input: { stop: structuredClone(stop), requestId: this.newId() },
          message: 'Outcome pending. Exact submission/task retained.',
        };
        yield* this.dispatch(pending, () => this.reserve(pending));
      }),
    );
  /**
   * Settles or unsettles a chat on its host. The listed chat and the open snapshot take the host's
   * reply, so the chat moves group at once. The list's watch then delivers the change; without an
   * open watch a reload lists it again, after any listing that began before the reply.
   */
  settle = (target: ChatTarget, settled: boolean) =>
    this.action(
      'settle',
      Effect.gen({ self: this }, function* () {
        this.connected();
        const input = decodeChatInput('settleChat', { target, settled });
        if (!sameSession(input.target, this.session))
          throw invalid('Chat belongs to another context.');
        const summary = yield* this.call('settleChat', input);
        const listed = this.state.chats.findIndex((chat) =>
          sameTarget(chat.target, summary.target),
        );
        if (listed >= 0) {
          const chats = [...this.state.chats],
            activity = chats[listed]!.activity;
          chats[listed] = { ...summary, ...(activity ? { activity } : {}) };
          this.update({ chats });
        }
        if (this.selection?.alive && sameTarget(this.selection.target, summary.target))
          this.selection.transcript?.updateConversation(summary);
        if (this.chatsFollowed !== this.refreshOwner) void this.reloadChats({ latest: true });
      }),
      this.connectionOwner,
    );
  retry = (id: string) =>
    this.action(
      id,
      Effect.gen({ self: this }, function* () {
        this.connected();
        const pending = this.saved.pending.find((item) => item.input.requestId === id);
        if (!pending) return;
        yield* this.queryPending(pending);
        if (this.saved.pending.some((item) => item.input.requestId === id))
          yield* this.dispatch(pending);
      }),
    );
  query = (id: string) =>
    this.action(
      'query:' + id,
      Effect.gen({ self: this }, function* () {
        this.connected();
        const pending = this.saved.pending.find((item) => item.input.requestId === id);
        if (pending) yield* this.queryPending(pending);
      }),
      this.connectionOwner,
    );
  private queryPending(pending: Pending): Effect.Effect<void, ApplicationError> {
    return Effect.gen({ self: this }, function* () {
      if (pending.operation === 'sendChat') {
        const receipt = yield* this.call('getChatSend', {
          target: pending.input.target,
          requestId: pending.input.requestId,
        });
        if (receipt?.admission === 'admitted') {
          this.resolve(pending);
          this.update({ notice: 'Original Send admission recovered without resending.' });
        } else
          this.update({
            notice:
              'No confirmed admission. Keep the original ID; only an explicit matching retry may send.',
          });
      } else if (pending.operation === 'createChat') {
        yield* this.call('listChats', { session: pending.input.session });
        this.update({
          notice:
            'Saved chats read. Creation identity cannot be proven by title; explicitly retry the original creation ID.',
        });
      } else {
        yield* this.call('getChat', { target: pending.input.stop.target });
        this.update({
          notice:
            'Current state read. The retained Stop still targets its original task; retry never adopts its successor.',
        });
      }
    });
  }
  private resolve(pending: Pending, conversation?: ChatSummary, firstSend?: Pending) {
    const next = structuredClone(this.saved);
    next.pending = next.pending.filter((item) => item.input.requestId !== pending.input.requestId);
    if (pending.operation === 'sendChat')
      next.drafts = next.drafts.filter(
        (draft) =>
          !sameTarget(draft.target, pending.input.target) || draft.text !== pending.input.text,
      );
    if (conversation) {
      if (pending.operation === 'createChat' && pending.firstMessage) {
        const existing = next.drafts.find((draft) => sameTarget(draft.target, conversation.target));
        if (!existing) {
          const draft = next.newDraft ?? pending.firstMessage.text;
          const mentions = next.newDraft ? next.newDraftMentions : pending.firstMessage.mentions;
          if (draft && next.drafts.length >= 32)
            throw invalid(
              'The conversation was created, but the draft limit was reached. Send or clear an existing draft, then retry the original Create.',
            );
          if (draft)
            next.drafts.push({
              target: conversation.target,
              text: draft,
              ...(mentions?.length ? { mentions } : {}),
            });
          delete next.newDraft;
          delete next.newDraftMentions;
        } else if (next.newDraft === pending.firstMessage.text) {
          delete next.newDraft;
          delete next.newDraftMentions;
        }
        if (!next.selected) next.selected = conversation.target;
      } else next.selected = conversation.target;
    }
    if (firstSend) next.pending.push(firstSend);
    this.commit(next);
  }
  private sending = new Map<string, number>();
  private countSending(requestId: string, change: 1 | -1) {
    const count = (this.sending.get(requestId) ?? 0) + change;
    if (count > 0) this.sending.set(requestId, count);
    else this.sending.delete(requestId);
    this.update({ dispatching: [...this.sending.keys()] });
  }
  /**
   * Sends a pending command, counting it as in flight from before `prepare` (which reserves or
   * publishes it) until its reply or failure is recorded.
   */
  private dispatch(pending: Pending, prepare?: () => void): Effect.Effect<void, ApplicationError> {
    const requestId = pending.input.requestId;
    return Effect.acquireUseRelease(
      Effect.sync(() => this.countSending(requestId, 1)),
      () =>
        Effect.gen({ self: this }, function* () {
          prepare?.();
          yield* this.sendPending(pending);
        }),
      () => Effect.sync(() => this.countSending(requestId, -1)),
    );
  }
  private sendPending(pending: Pending): Effect.Effect<void, ApplicationError> {
    return Effect.gen({ self: this }, function* () {
      this.commit(structuredClone(this.saved));
      if (pending.operation === 'createChat') {
        const receipt = yield* this.call(pending.operation, pending.input);
        // Another original/retry reply may already have resolved this Create.
        if (
          !this.saved.pending.some(
            (item) =>
              item.operation === 'createChat' && item.input.requestId === pending.input.requestId,
          )
        )
          return;
        const firstSend: Pending | undefined = pending.firstMessage
          ? {
              operation: 'sendChat',
              input: { ...pending.firstMessage, target: receipt.conversation.target },
              message: 'Outcome pending. Original first message retained.',
            }
          : undefined;
        // Publish the exact Send with the Create receipt before disclosing the message.
        const publish = () => {
          this.resolve(pending, receipt.conversation, firstSend);
          this.update({
            chats: [
              receipt.conversation,
              ...this.state.chats.filter(
                (chat) => !sameTarget(chat.target, receipt.conversation.target),
              ),
            ],
          });
          if (
            this.connectionOwner?.alive &&
            sameTarget(this.saved.selected, receipt.conversation.target)
          ) {
            const target = receipt.conversation.target;
            void this.action('open', this.openSelected(target), this.connectionOwner, false, () =>
              sameTarget(this.saved.selected, target),
            );
          }
        };
        if (firstSend) yield* this.dispatch(firstSend, publish);
        else publish();
      } else if (pending.operation === 'sendChat') {
        const receipt = yield* this.call(pending.operation, pending.input);
        if (receipt.admission === 'admitted') this.resolve(pending);
        else
          this.note(
            pending,
            'Reserved; admission is unconfirmed. Query before an explicit matching retry.',
          );
      } else {
        const receipt = yield* this.call(pending.operation, pending.input);
        if (receipt.outcome === 'pending')
          this.note(pending, 'Stop remains pending; cooperative cancellation is not confirmed.');
        else {
          this.resolve(pending);
          this.update({ notice: `Captured Stop: ${receipt.outcome}.` });
        }
      }
    }).pipe(
      Effect.onError((cause) =>
        Effect.sync(() => {
          const error = cause.reasons.find(Cause.isFailReason)?.error;
          if (!error) return;
          const message = `${error.code}: ${error.message}`;
          this.note(
            pending,
            text(message, 1024) ? message : `${error.code}: Original command outcome retained.`,
          );
        }),
      ),
    );
  }
  private note(pending: Pending, message: string) {
    if (this.closed) return;
    const next = structuredClone(this.saved),
      item = next.pending.find((item) => item.input.requestId === pending.input.requestId);
    if (item) item.message = message;
    this.commit(next);
  }
  preserve() {
    if (this.closed || this.state.storageError) return false;
    try {
      this.commit(structuredClone(this.saved));
      return true;
    } catch {
      return false;
    }
  }
  detach(): Promise<void> {
    this.epoch++;
    const owner = this.attachment;
    void this.selection?.transcript?.close();
    if (!owner) return this.detaching ?? Promise.resolve();
    const closing = this.closeOwner(owner);
    if (this.attachment !== owner) return closing;
    this.detaching = closing;
    this.attachment = undefined;
    this.selection = undefined;
    this.refreshOwner = undefined;
    this.update({
      snapshot: null,
      transcript: makeEmptyTranscriptState(),
      host: null,
      ready: false,
    });
    return closing;
  }
  private beginDisposal() {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.state = {
      ...this.state,
      host: null,
      snapshot: null,
      transcript: makeEmptyTranscriptState(),
      active: [],
    };
    void this.detach();
  }
  release(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.beginDisposal();
      if (this.releasing) return Effect.flatMap(Deferred.await(this.released), (exit) => exit);
      this.releasing = true;
      // Detached scopes can already be closing; join their actual observation outcomes too.
      return Effect.gen({ self: this }, function* () {
        const exits = yield* Effect.all(
          [
            Effect.exit(Scope.close(this.scope, Exit.void)),
            ...[...this.transcripts].map((transcript) =>
              Effect.exit(Effect.promise(() => transcript.close())),
            ),
            Effect.exit(Effect.promise(() => this.providers?.dispose() ?? Promise.resolve())),
            ...[...this.observations].map((observation) =>
              Effect.promise(() => this.closeObservation(observation)),
            ),
          ],
          { concurrency: 'unbounded' },
        );
        const cause = exits.reduce(
          (cause, exit) => (Exit.isFailure(exit) ? Cause.combine(cause, exit.cause) : cause),
          Cause.empty,
        );
        if (cause.reasons.length) yield* Effect.failCause(cause);
      }).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Deferred.succeed(this.released, exit).pipe(Effect.flatMap(() => exit)),
        ),
        Effect.uninterruptible,
      );
    });
  }
  dispose(): Promise<void> {
    this.beginDisposal();
    return (this.cleanup ??= this.runEffect(this.release()));
  }
}
export type ChatModel = ChatModelState;
export type ChatController = Pick<
  ChatModelState,
  | 'context'
  | 'backendId'
  | 'providers'
  | 'getSnapshot'
  | 'subscribe'
  | 'start'
  | 'connect'
  | 'disconnect'
  | 'refresh'
  | 'moreChats'
  | 'firstChats'
  | 'reloadChats'
  | 'watchChats'
  | 'markSeen'
  | 'setDraft'
  | 'findFiles'
  | 'createFileSearch'
  | 'setModelPreference'
  | 'select'
  | 'closeView'
  | 'showEarlier'
  | 'showLater'
  | 'openFind'
  | 'closeFind'
  | 'cancelFindReveal'
  | 'findTranscript'
  | 'nextFindMatch'
  | 'previousFindMatch'
  | 'jumpToEntry'
  | 'jumpToLatest'
  | 'setTranscriptView'
  | 'loadTranscriptManifest'
  | 'loadTranscriptPart'
  | 'create'
  | 'send'
  | 'stop'
  | 'settle'
  | 'retry'
  | 'query'
  | 'preserve'
  | 'detach'
  | 'dispose'
>;
export const makeChatModel = (
  dependencies: ChatDependencies,
): Effect.Effect<ChatModel, ApplicationError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const model = yield* Effect.try({
      try: () => new ChatModelState(scope, dependencies),
      catch: normalizeApplicationError,
    });
    yield* Effect.addFinalizer(() => model.release());
    return model;
  });
export function makeChatController<R, E extends ApplicationError>(
  runtime: ManagedRuntime.ManagedRuntime<R, E>,
  model: ChatModel,
): ChatController {
  return model.bind(runtime);
}
