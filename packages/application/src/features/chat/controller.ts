import { Cause, Deferred, Effect, Exit, Fiber, Schema, Scope, type ManagedRuntime } from 'effect';
import { ApplicationError } from '@moonbase/contracts/errors';
import type { ObservationClose } from '@moonbase/contracts/common';
import { normalizeApplicationError, runApplicationEffect } from '../../runtime/effect-client.ts';
import { decodeChatInput, ChatModelPreferenceSchema } from '@moonbase/contracts/chat-schema';
import type {
  ChatCreationSettings,
  ChatModelPreference,
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
  ChatTranscriptSource,
  ChatTranscriptSelection,
} from '@moonbase/contracts/chat';
import type { ConnectionClient, ConnectionSnapshot } from '@moonbase/contracts/connection';
import { makeProviderSetupController, type ProviderSetupController } from './providers.ts';
import type { ProviderSetupClient } from '@moonbase/contracts/providers';
import { decodeSaved, sameSession, sameTarget, type Saved, type Pending } from './saved.ts';
export type { Pending } from './saved.ts';
import { TranscriptOwner, makeEmptyTranscriptState, type TranscriptState } from './transcript.ts';
import { TranscriptViewMemory, type TranscriptView } from './view-memory.ts';
import type { TranscriptReadProgress } from './transcript-read.ts';

export interface DraftStorage {
  read(): string | null;
  write(value: string): void;
}
export type ChatState = {
  mode: 'local' | 'remote';
  ready: boolean;
  connection: ConnectionSnapshot | null;
  host: ChatHostConfiguration | null;
  chats: ChatSummary[];
  nextChats: string | null;
  snapshot: ChatSnapshot | null;
  transcript: TranscriptState;
  selected: ChatTarget | null;
  draft: string;
  modelPreference: ChatModelPreference | null;
  pending: Pending[];
  active: string[];
  error: string | null;
  storageError: string | null;
  notice: string;
};
export type ChatDependencies = {
  chat: ChatClient;
  mode?: 'local' | 'remote';
  connection?: ConnectionClient;
  providers?: ProviderSetupClient;
  context: ChatSession;
  storage: DraftStorage;
  newId?: () => string;
  backendId?: string;
  transcriptMemory?: TranscriptViewMemory;
};
type Owner = {
  scope: Scope.Closeable;
  alive: boolean;
  observations: Set<Observation>;
  completion?: Promise<void>;
  transcript?: TranscriptOwner;
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
  private transcripts = new Set<TranscriptOwner>();
  private epoch = 0;
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
  private readonly mode: 'local' | 'remote';
  private readonly session: ChatSession;
  private storage: DraftStorage;
  private newId: () => string;
  private readonly backend: string;
  private readonly transcriptMemory: TranscriptViewMemory;

  constructor(scope: Scope.Closeable, dependencies: ChatDependencies) {
    this.scope = scope;
    this.chat = dependencies.chat;
    this.backend = dependencies.backendId ?? 'standalone';
    this.transcriptMemory = dependencies.transcriptMemory ?? new TranscriptViewMemory();
    this.connection = dependencies.connection;
    this.mode = dependencies.mode ?? 'remote';
    if (this.mode === 'remote' && !this.connection)
      throw invalid('Remote chat requires a connection capability.');
    this.providers = dependencies.providers
      ? makeProviderSetupController(dependencies.providers)
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
        this.saved = decodeSaved(JSON.parse(this.raw), this.session, this.mode);
      }
    } catch {
      storageError =
        'Saved chat data or storage is unavailable. Preserve the original data; no new mutation can start.';
    }
    this.state = {
      mode: this.mode,
      ready: false,
      connection: null,
      host: null,
      chats: [],
      nextChats: null,
      snapshot: null,
      transcript: makeEmptyTranscriptState(),
      selected: this.saved.selected,
      draft: this.draft(),
      modelPreference: this.saved.modelPreference ?? null,
      pending: this.saved.pending,
      active: [],
      error: null,
      storageError,
      notice:
        this.mode === 'local'
          ? 'Local chat. Tools run on this computer; a working folder is not a filesystem sandbox.'
          : 'Disconnected. Connect explicitly; reconnect never resends a message.',
    };
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
  private commit(next: Saved) {
    if (this.closed) throw invalid('Chat model disposed.');
    if (this.state.storageError)
      throw new ApplicationError({ code: 'Persistence', message: this.state.storageError });
    decodeSaved(next, this.session, this.mode);
    const raw = JSON.stringify(next);
    try {
      if (bytes(raw) > maximumSavedBytes || this.storage.read() !== this.raw) throw Error();
      this.storage.write(raw);
      this.raw = raw;
      this.saved = next;
      this.update({
        selected: next.selected,
        draft: this.draft(),
        pending: next.pending,
        modelPreference: next.modelPreference ?? null,
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
    if (
      !this.admissionsOpen ||
      this.closed ||
      (owner && !owner.alive) ||
      (duplicate && this.actions.has(name))
    )
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
    if (!this.admissionsOpen || this.attachment?.alive || this.closed) return Promise.resolve();
    const owner = (this.attachment = this.owner());
    if (this.mode === 'local') {
      this.generation = this.owner(owner);
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
      (state.state === 'connected' && !this.generation?.alive);
    this.update({ connection: state, ready: state.state === 'connected' });
    if (!changed) return;
    this.epoch++;
    void this.selection?.transcript?.close();
    void this.closeOwner(this.generation);
    this.generation = state.state === 'connected' ? this.owner(this.attachment) : undefined;
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
  connect = () =>
    this.action(
      'connect',
      Effect.gen({ self: this }, function* () {
        if (this.mode === 'local') return;
        const state = this.state.connection;
        if (!state) return;
        const attachment = this.attachment,
          revision = this.connectionRevision;
        const connected = yield* Effect.tryPromise({
          try: (signal) =>
            this.connection!.command('connect', { profileId: state.profile.id }, { signal }),
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
        if (this.mode === 'local') return;
        const id = this.state.connection?.connectionId;
        if (!id) return;
        yield* Effect.tryPromise({
          try: (signal) => this.connection!.command('disconnect', { connectionId: id }, { signal }),
          catch: normalizeApplicationError,
        });
        const attachment = this.attachment,
          revision = this.connectionRevision;
        const state = yield* Effect.tryPromise({
          try: (signal) => this.connection!.command('getConnection', {}, { signal }),
          catch: normalizeApplicationError,
        });
        if (attachment === this.attachment && revision === this.connectionRevision)
          this.onConnection(state);
      }),
    );
  private connected() {
    if (
      this.mode === 'local' ? !this.generation?.alive : this.state.connection?.state !== 'connected'
    )
      throw new ApplicationError({
        code: 'Unavailable',
        message: 'Connect to the configured host first.',
      });
    return this.epoch;
  }
  refresh = (): Promise<void> => {
    if (!this.admissionsOpen || this.closed) return Promise.resolve();
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
        if ((this.mode === 'local') !== 'mode' in host)
          throw new ApplicationError({
            code: 'Incompatible',
            message: 'Chat backend mode does not match this controller.',
          });
        if (!sameSession(host, this.session))
          throw new ApplicationError({
            code: 'Incompatible',
            message: 'Host actor does not match the configured chat context.',
          });
        const page = yield* this.call('listChats', { session: this.session });
        if (!owner.alive || epoch !== this.epoch) return;
        this.update({
          host,
          ready: true,
          chats: page.conversations,
          nextChats: page.nextCursor,
          notice:
            this.mode === 'local'
              ? 'Local tools use this computer’s permissions. The selected folder is context, not a sandbox.'
              : 'Verified host. Reconnection reads saved state; it does not send.',
        });
        if (this.state.transcript.observation === 'failed') {
          void this.closeOwner(this.selection);
          this.selection = undefined;
        }
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
  setModelPreference(value: ChatModelPreference) {
    if (!this.admissionsOpen || this.closed) return;
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
  setDraft(value: string) {
    if (!this.admissionsOpen || this.closed) return;
    if (!text(value, 32768)) {
      this.update({ error: 'Message must contain valid Unicode and at most 32 KiB.' });
      return;
    }
    const target = this.saved.selected;
    this.update({ draft: value });
    try {
      const next = structuredClone(this.saved);
      if (!target) {
        if (value) next.newDraft = value;
        else delete next.newDraft;
      } else if (!value)
        next.drafts = next.drafts.filter((draft) => !sameTarget(draft.target, target));
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
    if (!this.admissionsOpen || this.closed) return Promise.resolve();
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
    if (!this.admissionsOpen || this.closed) return Promise.resolve();
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
      if (!this.attachment?.alive || !this.generation?.alive || this.closed) return;
      if (this.selection?.alive && sameTarget(this.selection.target, target)) return;
      void this.closeOwner(this.selection);
      const owner = (this.selection = Object.assign(this.owner(this.generation), {
        target: structuredClone(target),
      }));
      const epoch = this.epoch;
      this.update({ snapshot: null, transcript: makeEmptyTranscriptState() });
      let received = false;
      const transcript = (owner.transcript = new TranscriptOwner({
        chat: this.chat,
        target: structuredClone(target),
        backend: this.backend,
        memory: this.transcriptMemory,
        capable: this.state.host?.features?.includes('transcript-v1') ?? false,
        findCapable: this.state.host?.features?.includes('transcript-find-v1') ?? false,
        streaming: this.state.host?.features?.includes('chat-stream-v1') ?? false,
        local: this.mode === 'local',
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
            const stable = transcript.accept(snapshot);
            if (
              stable !== this.state.snapshot ||
              transcript.getSnapshot() !== this.state.transcript
            )
              this.update({ snapshot: stable, transcript: transcript.getSnapshot() });
          } catch (error) {
            transcript.fail(error);
            this.error(error);
          }
        }
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
              if (owner.alive && this.selection === owner) {
                transcript.fail(error);
                this.error(error);
              }
            },
          ),
        );
        const snapshot = yield* this.call('getChat', { target });
        if (!received) accept(snapshot);
        if (owner.alive && this.selection === owner)
          yield* Effect.promise(() => transcript.restore());
      });
      yield* Effect.flatMap(
        Effect.forkIn(read, owner.scope, { startImmediately: true }),
        Fiber.join,
      );
    });
  }
  private transcriptOwner() {
    if (!this.admissionsOpen || this.closed) return undefined;
    return this.selection?.alive ? this.selection.transcript : undefined;
  }
  openFind = () => this.transcriptOwner()?.openFind();
  cancelFindReveal = () => this.transcriptOwner()?.cancelFindReveal();
  closeFind = () => this.transcriptOwner()?.closeFind();
  findTranscript = (query: string) =>
    this.transcriptOwner()?.findTranscript(query) ?? Promise.resolve();
  nextFindMatch = () => this.transcriptOwner()?.moveFind('next') ?? Promise.resolve();
  previousFindMatch = () => this.transcriptOwner()?.moveFind('previous') ?? Promise.resolve();
  older = () => this.transcriptOwner()?.earlier() ?? Promise.resolve();
  later = () => this.transcriptOwner()?.later() ?? Promise.resolve();
  jumpToEntry = (entryId: string) => this.transcriptOwner()?.around(entryId) ?? Promise.resolve();
  jumpToLatest = () => this.transcriptOwner()?.latest() ?? Promise.resolve();
  setTranscriptView = (view: TranscriptView) => this.transcriptOwner()?.setView(view);
  loadTranscriptManifest = (source: ChatTranscriptSource, restart = false) =>
    this.transcriptOwner()?.loadManifest(source, restart) ?? Promise.resolve();
  loadTranscriptPart = (
    source: ChatTranscriptSource,
    selection: ChatTranscriptSelection,
    restart = false,
  ) => this.transcriptOwner()?.loadPart(source, selection, restart) ?? Promise.resolve();
  iterateTranscript(
    source: ChatTranscriptSource,
    options?: {
      selection?: ChatTranscriptSelection;
      signal?: AbortSignal;
      onProgress?: (progress: TranscriptReadProgress) => void;
    },
  ) {
    const owner = this.transcriptOwner();
    if (!owner)
      throw new ApplicationError({ code: 'Cancelled', message: 'Transcript view is inactive.' });
    return owner.iterate(source, options);
  }
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
        if ((this.mode === 'local') !== (settings !== undefined))
          throw invalid('Choose folder/model settings for local chats only.');
        const captured = decodeChatInput('createChat', {
          session: this.session,
          requestId: this.newId(),
          title,
          ...(settings ? { settings } : {}),
        });
        const pending: Pending = {
          operation: 'createChat',
          input: structuredClone(captured),
          message: 'Outcome pending. Original creation identity retained.',
        };
        this.reserve(pending);
        yield* this.dispatch(pending);
      }),
    );
  send = (settings?: ChatCreationSettings) =>
    this.action(
      'send',
      Effect.gen({ self: this }, function* () {
        this.connected();
        const target = this.saved.selected,
          value = this.state.draft;
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
          if ((this.mode === 'local') !== (settings !== undefined))
            throw invalid('Choose folder/model settings for local chats only.');
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
              ...(settings ? { settings } : {}),
            }),
            firstMessage: { requestId: this.newId(), text: value },
            message: 'Outcome pending. Original creation and first message retained.',
          };
          this.reserve(pending);
          yield* this.dispatch(pending);
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
          if (draft && next.drafts.length >= 32)
            throw invalid(
              'The conversation was created, but the draft limit was reached. Send or clear an existing draft, then retry the original Create.',
            );
          if (draft) next.drafts.push({ target: conversation.target, text: draft });
          delete next.newDraft;
        } else if (next.newDraft === pending.firstMessage.text) delete next.newDraft;
        if (!next.selected) next.selected = conversation.target;
      } else next.selected = conversation.target;
    }
    if (firstSend) next.pending.push(firstSend);
    this.commit(next);
  }
  private dispatch(pending: Pending): Effect.Effect<void, ApplicationError> {
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
        this.resolve(pending, receipt.conversation, firstSend);
        this.update({
          chats: [
            receipt.conversation,
            ...this.state.chats.filter(
              (chat) => !sameTarget(chat.target, receipt.conversation.target),
            ),
          ].slice(0, 32),
        });
        if (
          this.generation?.alive &&
          sameTarget(this.saved.selected, receipt.conversation.target)
        ) {
          const target = receipt.conversation.target;
          void this.action('open', this.openSelected(target), this.generation, false, () =>
            sameTarget(this.saved.selected, target),
          );
        }
        if (firstSend) yield* this.dispatch(firstSend);
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
    this.attachment = undefined;
    this.generation = undefined;
    this.selection = undefined;
    this.refreshOwner = undefined;
    this.update({
      snapshot: null,
      transcript: makeEmptyTranscriptState(),
      host: null,
      ready: false,
    });
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
  | 'setDraft'
  | 'setModelPreference'
  | 'select'
  | 'closeView'
  | 'older'
  | 'later'
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
  | 'iterateTranscript'
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
