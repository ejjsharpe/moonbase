import { Cause, Deferred, Effect, Exit, Fiber, Scope, type ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ObservationClose } from '@moonbase/contracts/common';
import { normalizeApplicationError, runApplicationEffect } from '../../runtime/effect-client.ts';
import { decodeChatInput } from '@moonbase/contracts/chat-schema';
import type {
  ChatClient,
  ChatCommand,
  ChatInput,
  ChatOutput,
  ChatHostConfiguration,
  ChatSession,
  ChatSnapshot,
  ChatSummary,
  ChatTarget,
  ChatStopTarget,
  ChatEntry,
} from '@moonbase/contracts/chat';
import type { ConnectionClient, ConnectionSnapshot } from '@moonbase/contracts/connection';
import { decodeSaved, sameSession, sameTarget, type Saved, type Pending } from './saved.ts';
export type { Pending } from './saved.ts';

export interface DraftStorage {
  read(): string | null;
  write(value: string): void;
}
export type ChatState = {
  connection: ConnectionSnapshot | null;
  host: ChatHostConfiguration | null;
  chats: ChatSummary[];
  nextChats: string | null;
  snapshot: ChatSnapshot | null;
  older: ChatEntry[];
  olderCursor: string | null;
  selected: ChatTarget | null;
  draft: string;
  pending: Pending[];
  active: string[];
  error: string | null;
  storageError: string | null;
  notice: string;
};
export type ChatDependencies = {
  chat: ChatClient;
  connection: ConnectionClient;
  context: ChatSession;
  storage: DraftStorage;
  newId?: () => string;
};
type Owner = {
  scope: Scope.Closeable;
  alive: boolean;
  observations: Set<Observation>;
  completion?: Promise<void>;
};
type Observation = {
  ready: Deferred.Deferred<Exit.Exit<ObservationClose>>;
  outcome?: Promise<Exit.Exit<void>>;
};
const maximumSavedBytes = 2 * 1024 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value).length;
const text = (value: string, limit: number) =>
  value.isWellFormed() && !value.includes('\0') && bytes(value) <= limit;
const sameStop = (a: ChatStopTarget, b: ChatStopTarget) =>
  sameTarget(a.target, b.target) && a.submissionId === b.submissionId && a.taskId === b.taskId;
const invalid = (message: string) => new ApplicationError({ code: 'InvalidInput', message });

class ChatModelState {
  private saved: Saved;
  private raw: string | null = null;
  private state: ChatState;
  private listeners = new Set<() => void>();
  private scope: Scope.Closeable;
  private attachment?: Owner;
  private detaching?: Promise<void>;
  private generation?: Owner;
  private selection?: Owner & { target: ChatTarget };
  private refreshOwner?: Owner;
  private observations = new Set<Observation>();
  private epoch = 0;
  private connectionRevision = 0;
  private closed = false;
  private actions = new Map<string, number>();
  private cleanup?: Promise<void>;
  private releasing = false;
  private released = Deferred.makeUnsafe<Exit.Exit<void>>();
  private runEffect!: <A>(effect: Effect.Effect<A, ApplicationError>) => Promise<A>;
  private bound = false;
  private readonly chat: ChatClient;
  private readonly connection: ConnectionClient;
  private readonly session: ChatSession;
  private storage: DraftStorage;
  private newId: () => string;

  constructor(scope: Scope.Closeable, dependencies: ChatDependencies) {
    this.scope = scope;
    this.chat = dependencies.chat;
    this.connection = dependencies.connection;
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
      connection: null,
      host: null,
      chats: [],
      nextChats: null,
      snapshot: null,
      older: [],
      olderCursor: null,
      selected: this.saved.selected,
      draft: this.draft(),
      pending: this.saved.pending,
      active: [],
      error: null,
      storageError,
      notice: 'Disconnected. Connect explicitly; reconnect never resends a message.',
    };
  }
  bind<R, E extends ApplicationError>(runtime: ManagedRuntime.ManagedRuntime<R, E>) {
    if (this.bound) throw invalid('Chat model already bound.');
    this.bound = true;
    this.runEffect = (effect) => runApplicationEffect(runtime, effect);
    return this;
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
    for (const listener of this.listeners) listener();
  }
  private draft() {
    return (
      this.saved.drafts.find((draft) => sameTarget(draft.target, this.saved.selected))?.text ?? ''
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
      this.update({ selected: next.selected, draft: this.draft(), pending: next.pending });
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
  ): Effect.Effect<void, ApplicationError> {
    return Effect.gen({ self: this }, function* () {
      if (!owner.alive || this.closed) return;
      // A synchronous watch callback can reenter disposal before acquisition returns.
      const observation: Observation = { ready: Deferred.makeUnsafe() };
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
    }).pipe(Effect.uninterruptible);
  }
  private closeOwner(owner?: Owner): Promise<void> {
    if (!owner) return Promise.resolve();
    if (!owner.completion) {
      owner.alive = false;
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
    if (this.closed || (owner && !owner.alive) || (duplicate && this.actions.has(name)))
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
    if (this.attachment?.alive || this.closed) return Promise.resolve();
    const owner = (this.attachment = this.owner());
    let received = false;
    return this.action(
      'status',
      Effect.gen({ self: this }, function* () {
        yield* this.observe(owner, () =>
          this.connection.watch(
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
          try: (signal) => this.connection.command('getConnection', {}, { signal }),
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
      (state.state === 'connected' && !this.generation?.alive);
    this.update({ connection: state });
    if (!changed) return;
    this.epoch++;
    void this.closeOwner(this.generation);
    this.generation = state.state === 'connected' ? this.owner(this.attachment) : undefined;
    this.selection = undefined;
    this.refreshOwner = undefined;
    this.update({ snapshot: null, older: [], olderCursor: null, host: null });
    if (state.state === 'connected') void this.refresh();
  }
  connect = () =>
    this.action(
      'connect',
      Effect.gen({ self: this }, function* () {
        const state = this.state.connection;
        if (!state) return;
        const attachment = this.attachment,
          revision = this.connectionRevision;
        const connected = yield* Effect.tryPromise({
          try: (signal) =>
            this.connection.command('connect', { profileId: state.profile.id }, { signal }),
          catch: normalizeApplicationError,
        });
        if (attachment === this.attachment && revision === this.connectionRevision)
          this.onConnection(connected);
      }),
    );
  disconnect = () =>
    this.action(
      'disconnect',
      Effect.gen({ self: this }, function* () {
        const id = this.state.connection?.connectionId;
        if (!id) return;
        yield* Effect.tryPromise({
          try: (signal) => this.connection.command('disconnect', { connectionId: id }, { signal }),
          catch: normalizeApplicationError,
        });
        const attachment = this.attachment,
          revision = this.connectionRevision;
        const state = yield* Effect.tryPromise({
          try: (signal) => this.connection.command('getConnection', {}, { signal }),
          catch: normalizeApplicationError,
        });
        if (attachment === this.attachment && revision === this.connectionRevision)
          this.onConnection(state);
      }),
    );
  private connected() {
    if (this.state.connection?.state !== 'connected')
      throw new ApplicationError({
        code: 'Unavailable',
        message: 'Connect to the configured host first.',
      });
    return this.epoch;
  }
  refresh = (): Promise<void> => {
    if (!this.generation?.alive)
      return this.action(
        'refresh',
        Effect.sync(() => {
          this.connected();
        }),
      );
    void this.closeOwner(this.refreshOwner);
    const owner = (this.refreshOwner = this.owner(this.generation));
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
        const page = yield* this.call('listChats', { session: this.session });
        if (!owner.alive || epoch !== this.epoch) return;
        this.update({
          host,
          chats: page.conversations,
          nextChats: page.nextCursor,
          notice: 'Verified host. Reconnection reads saved state; it does not send.',
        });
        if (this.saved.selected && !this.selection?.alive)
          yield* this.openSelected(this.saved.selected);
        for (const pending of this.saved.pending)
          if (pending.operation === 'sendChat') yield* this.queryPending(pending);
      }),
      owner,
      false,
    );
  };
  moreChats = () => {
    const owner = this.generation;
    return this.action(
      'chats',
      Effect.gen({ self: this }, function* () {
        const epoch = this.connected(),
          cursor = this.state.nextChats;
        if (!cursor) return;
        const page = yield* this.call('listChats', { session: this.session, cursor });
        if (owner?.alive && epoch === this.epoch)
          this.update({ chats: page.conversations, nextChats: page.nextCursor });
      }),
      owner,
    );
  };
  firstChats = () => this.refresh();
  setDraft(value: string) {
    if (this.closed) return;
    if (!text(value, 32768)) {
      this.update({ error: 'Message must contain valid Unicode and at most 32 KiB.' });
      return;
    }
    const target = this.saved.selected;
    if (!target) return;
    this.update({ draft: value });
    try {
      const next = structuredClone(this.saved);
      if (!value) next.drafts = next.drafts.filter((draft) => !sameTarget(draft.target, target));
      else {
        const entry = next.drafts.find((draft) => sameTarget(draft.target, target));
        if (entry) entry.text = value;
        else next.drafts.push({ target, text: value });
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
  select = (target: ChatTarget): Promise<void> => {
    if (this.closed) return Promise.resolve();
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
      // A selection supersedes an old list read without suppressing the new view's refresh.
      if (this.refreshOwner?.alive && this.actions.has('refresh')) void this.refresh();
      const epoch = this.epoch;
      return this.action(
        'open',
        this.openSelected(captured),
        this.generation,
        false,
        () => epoch === this.epoch && sameTarget(this.saved.selected, captured),
      );
    } catch (error) {
      this.error(error);
      return Promise.resolve();
    }
  };
  closeView(): Promise<void> {
    if (this.closed) return Promise.resolve();
    try {
      this.commit({ ...structuredClone(this.saved), selected: null });
      this.epoch++;
      if (this.refreshOwner?.alive && this.actions.has('refresh')) void this.refresh();
      const closing = this.closeOwner(this.selection);
      this.selection = undefined;
      this.update({ snapshot: null, older: [], olderCursor: null });
      return closing;
    } catch (error) {
      this.error(error);
      return Promise.resolve();
    }
  }
  private openSelected(target: ChatTarget): Effect.Effect<void, ApplicationError> {
    return Effect.gen({ self: this }, function* () {
      if (!this.attachment?.alive || !this.generation?.alive || this.closed) return;
      if (this.selection?.alive && sameTarget(this.selection.target, target)) return;
      void this.closeOwner(this.selection);
      const owner = (this.selection = Object.assign(this.owner(this.generation), {
        target: structuredClone(target),
      }));
      const epoch = this.epoch;
      this.update({ snapshot: null, older: [], olderCursor: null });
      let received = false;
      const accept = (snapshot: ChatSnapshot) => {
        if (
          owner.alive &&
          this.selection === owner &&
          epoch === this.epoch &&
          sameTarget(this.saved.selected, target)
        )
          this.update({
            snapshot,
            ...(this.state.older.length ? {} : { olderCursor: snapshot.olderCursor }),
          });
      };
      const read = Effect.gen({ self: this }, function* () {
        yield* this.observe(owner, () =>
          this.chat.watch(
            { target },
            (snapshot) => {
              received = true;
              accept(snapshot);
            },
            (error) => {
              if (owner.alive && this.selection === owner) this.error(error);
            },
          ),
        );
        const snapshot = yield* this.call('getChat', { target });
        if (!received) accept(snapshot);
      });
      yield* Effect.flatMap(
        Effect.forkIn(read, owner.scope, { startImmediately: true }),
        Fiber.join,
      );
    });
  }
  older = () => {
    const owner = this.selection;
    return this.action(
      'history',
      Effect.gen({ self: this }, function* () {
        const target = this.saved.selected,
          cursor = this.state.olderCursor,
          epoch = this.connected();
        if (!target || !cursor) return;
        const page = yield* this.call('getChatHistory', { target, cursor });
        if (
          owner?.alive &&
          this.selection === owner &&
          epoch === this.epoch &&
          sameTarget(target, this.saved.selected)
        )
          this.update({ older: page.entries, olderCursor: page.olderCursor });
      }),
      owner,
    );
  };
  private reserve(pending: Pending) {
    const next = structuredClone(this.saved);
    if (next.pending.length >= 16)
      throw invalid('Resolve an existing pending command before creating another.');
    next.pending.push(pending);
    this.commit(next);
  }
  create = (title: string) =>
    this.action(
      'create',
      Effect.gen({ self: this }, function* () {
        this.connected();
        if (!text(title, 200) || !title.trim())
          throw invalid('Use a chat title of 1–200 UTF-8 bytes.');
        const pending: Pending = {
          operation: 'createChat',
          input: { session: structuredClone(this.session), requestId: this.newId(), title },
          message: 'Outcome pending. Original creation identity retained.',
        };
        this.reserve(pending);
        yield* this.dispatch(pending);
      }),
    );
  send = () =>
    this.action(
      'send',
      Effect.gen({ self: this }, function* () {
        this.connected();
        const target = this.saved.selected,
          value = this.state.draft;
        if (!target || !text(value, 32768) || !value.trim())
          throw invalid('Write a message before sending.');
        if (
          this.saved.pending.some(
            (pending) =>
              pending.operation === 'sendChat' && sameTarget(pending.input.target, target),
          )
        )
          throw invalid('Resolve the retained Send before starting another in this chat.');
        const pending: Pending = {
          operation: 'sendChat',
          input: { target: structuredClone(target), requestId: this.newId(), text: value },
          message: 'Outcome pending. Original Send identity and text retained.',
        };
        this.reserve(pending);
        yield* this.dispatch(pending);
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
        this.reserve(pending);
        yield* this.dispatch(pending);
      }),
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
      this.generation,
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
  private resolve(pending: Pending, conversation?: ChatSummary) {
    const next = structuredClone(this.saved);
    next.pending = next.pending.filter((item) => item.input.requestId !== pending.input.requestId);
    if (pending.operation === 'sendChat')
      next.drafts = next.drafts.filter(
        (draft) =>
          !sameTarget(draft.target, pending.input.target) || draft.text !== pending.input.text,
      );
    if (conversation) next.selected = conversation.target;
    this.commit(next);
  }
  private dispatch(pending: Pending): Effect.Effect<void, ApplicationError> {
    return Effect.gen({ self: this }, function* () {
      this.commit(structuredClone(this.saved));
      if (pending.operation === 'createChat') {
        const receipt = yield* this.call(pending.operation, pending.input);
        this.resolve(pending, receipt.conversation);
        this.update({
          chats: [
            receipt.conversation,
            ...this.state.chats.filter(
              (chat) => !sameTarget(chat.target, receipt.conversation.target),
            ),
          ].slice(0, 32),
        });
        if (this.generation?.alive) {
          const target = receipt.conversation.target;
          void this.action('open', this.openSelected(target), this.generation, false, () =>
            sameTarget(this.saved.selected, target),
          );
        }
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
    if (!owner) return this.detaching ?? Promise.resolve();
    this.attachment = undefined;
    this.generation = undefined;
    this.selection = undefined;
    this.refreshOwner = undefined;
    this.update({ snapshot: null, older: [], olderCursor: null, host: null });
    return (this.detaching = this.closeOwner(owner));
  }
  private beginDisposal() {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.state = {
      ...this.state,
      host: null,
      snapshot: null,
      older: [],
      olderCursor: null,
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
  | 'getSnapshot'
  | 'subscribe'
  | 'start'
  | 'connect'
  | 'disconnect'
  | 'refresh'
  | 'moreChats'
  | 'firstChats'
  | 'setDraft'
  | 'select'
  | 'closeView'
  | 'older'
  | 'create'
  | 'send'
  | 'stop'
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
