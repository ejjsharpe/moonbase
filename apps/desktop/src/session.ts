import { Effect, Exit, Scope, type ManagedRuntime } from 'effect';
import {
  decodeWorkspaceInput,
  decodeWorkspaceOutput,
  decodeWorkspaceWatchInput,
  isWorkspaceCommand,
} from '@moonbase/contracts/workspace-schema';
import {
  normalizeApplicationError,
  runApplicationEffect,
} from '@moonbase/application/runtime/effect-client';
import {
  ApplicationError,
  type CheckoutTarget,
  type EditorClient,
  type WorkspaceCommand,
  type WorkspaceEvent,
  type ObservationClose,
} from '@moonbase/contracts/workspace';
import {
  checkout,
  errorDTO,
  invalid,
  keys,
  record,
  requestId,
  string,
  type Reply,
} from './wire.ts';

const exact = (a: CheckoutTarget, b: CheckoutTarget) =>
  ['hostId', 'checkoutId', 'projectId', 'root', 'branch'].every(
    (k) => a[k as keyof CheckoutTarget] === b[k as keyof CheckoutTarget],
  );
export type NativeActions = {
  chooseCheckout(): Promise<string | null>;
  imports(
    target: CheckoutTarget,
    kind: 'picker' | 'clipboard',
    paths?: string[],
    signal?: AbortSignal,
  ): Promise<string[]>;
  release(input: {
    checkout: CheckoutTarget;
    clientId: string;
    references: string[];
  }): Promise<void>;
};
type Request = {
  cancel: () => void | Promise<void>;
  watch: boolean;
  cancelled: boolean;
  completion: Promise<void>;
  complete: () => void;
  close?: Promise<void>;
  scope: Scope.Closeable;
  cleanupError?: ApplicationError;
};
/** Authority belongs to this main-frame session, never to an arbitrary renderer root or caller ID. */
export class EditorSession {
  readonly clientId = 'desktop-primary';
  private known = new Map<string, CheckoutTarget>();
  private rootGrants = new Set<string>();
  private operations = new Set<string>();
  private active = new Map<string, Request>();
  private generation = 0;
  private closing = new Map<string, Promise<Reply<null>>>();
  private cleanup: Promise<void> = Promise.resolve();
  private disposal?: Promise<void>;
  private runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>;
  private document: Scope.Closeable;
  private closed = false;
  private client: EditorClient;
  private native: NativeActions;
  private send: (id: string, result: Reply<WorkspaceEvent>) => void;
  constructor(
    runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>,
    client: EditorClient,
    native: NativeActions,
    send: (id: string, result: Reply<WorkspaceEvent>) => void,
  ) {
    this.runtime = runtime;
    this.document = Scope.forkUnsafe(runtime.scope, 'parallel');
    this.client = client;
    this.native = native;
    this.send = send;
  }
  private own(value: unknown) {
    if (value !== this.clientId)
      throw new ApplicationError({ code: 'Unauthorized', message: 'Foreign editor identity.' });
  }
  private approved(value: unknown) {
    checkout(value);
    const known = this.known.get(value.checkoutId);
    if (!known || !exact(known, value))
      throw new ApplicationError({
        code: 'Unauthorized',
        message: 'Choose this exact checkout with the native picker.',
      });
  }
  private inspect(value: unknown, depth = 0): void {
    if (depth > 24) invalid('Input nesting limit exceeded.');
    if (typeof value === 'string') {
      if (value.length > 2 ** 24) invalid('Input too large.');
      return;
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return;
    if (Array.isArray(value)) {
      if (value.length > 8192) invalid('Input array too large.');
      for (const item of value) this.inspect(item, depth + 1);
      return;
    }
    const object = record(value);
    for (const item of Object.values(object)) this.inspect(item, depth + 1);
  }
  private validate(operation: WorkspaceCommand, input: unknown) {
    const v = record(decodeWorkspaceInput(operation, input));
    // Domain/path/state validation remains in WorkspaceService; this boundary additionally binds caller and approval.
    if (JSON.stringify(v).length > 32 * 1024 * 1024) invalid('Command input is too large.');
    this.inspect(v);
    if ('checkout' in v) this.approved(v.checkout);
    if ('target' in v) {
      const target = record(v.target);
      keys(target, ['checkout', 'path']);
      this.approved(target.checkout);
    }
    if (operation === 'operationStatus') {
      requestId(v.clientId);
      requestId(v.id);
      if (v.clientId !== this.clientId && !this.operations.has(JSON.stringify([v.clientId, v.id])))
        this.own(v.clientId);
    } else if ('clientId' in v) this.own(v.clientId);
    if (operation === 'acknowledgeOperation') {
      requestId(v.operationClientId);
      requestId(v.id);
      if (
        v.operationClientId !== this.clientId &&
        !this.operations.has(JSON.stringify([v.operationClientId, v.id]))
      )
        this.own(v.operationClientId);
    }
    if (operation === 'persistRecovery') {
      const state = record(v.state);
      this.own(state.clientId);
      if (!Array.isArray(state.checkouts)) invalid('Invalid checkout registry.');
      for (const target of state.checkouts as unknown[]) this.approved(target);
    }
    if (operation === 'openCheckout') {
      string(v.root);
      if (
        !this.rootGrants.delete(v.root) &&
        ![...this.known.values()].some((t) => t.root === v.root)
      )
        throw new ApplicationError({
          code: 'Unauthorized',
          message: 'A renderer path is not native root approval.',
        });
    }
    return v;
  }
  async call(method: unknown, input: unknown, id: unknown): Promise<Reply> {
    let reserved: Request | undefined;
    const generation = this.generation,
      document = this.document;
    try {
      requestId(id);
      if (this.closed)
        throw new ApplicationError({ code: 'Unavailable', message: 'Editor session disposed.' });
      if (this.active.has(id) || this.closing.has(id)) invalid('Request is already active.');
      if (
        [...this.active.values()].filter((request) => request.watch === (method === 'watch'))
          .length >= 128
      )
        invalid('Too many active requests of this kind.');
      const abort = new AbortController(),
        completion = Promise.withResolvers<void>();
      reserved = {
        cancel: () => abort.abort(),
        watch: method === 'watch',
        cancelled: false,
        completion: completion.promise,
        complete: () => completion.resolve(),
        scope: Scope.forkUnsafe(this.document, 'parallel'),
      };
      const request = reserved;
      this.runtime.runSync(
        Scope.addFinalizer(
          request.scope,
          Effect.promise(async () => {
            request.cancelled = true;
            await request.cancel();
            if (!request.watch) await request.completion;
            if (request.cleanupError) throw request.cleanupError;
          }),
        ),
      );
      this.active.set(id, reserved);
      const live = () => !this.closed && generation === this.generation && !reserved?.cancelled;
      const requireLive = () => {
        if (!live())
          throw new ApplicationError({ code: 'Cancelled', message: 'Editor document released.' });
      };
      let value: unknown;
      if (method === 'command') {
        const envelope = record(input);
        keys(envelope, ['operation', 'input']);
        if (!isWorkspaceCommand(envelope.operation)) invalid('Unknown application command.');
        const operation = envelope.operation as WorkspaceCommand;
        const validated = this.validate(operation, envelope.input);
        value = decodeWorkspaceOutput(
          operation,
          await this.client.command(operation, validated as never, { signal: abort.signal }),
        );
        if (operation === 'openCheckout' && live()) {
          checkout(value);
          this.known.set(value.checkoutId, value);
        }
        if (operation === 'loadRecovery' && live()) {
          const load = value as Awaited<ReturnType<EditorClient['command']>> & {
            state: { checkouts: CheckoutTarget[] };
            operations: { clientId: string; id: string }[];
          };
          for (const target of load.state.checkouts) {
            checkout(target);
            this.known.set(target.checkoutId, target);
          }
          for (const fact of load.operations)
            this.operations.add(JSON.stringify([fact.clientId, fact.id]));
        }
      } else if (method === 'choose-checkout') {
        if (input !== null) invalid('Unexpected native picker input.');
        value = await this.native.chooseCheckout();
        requireLive();
        if (typeof value === 'string') this.rootGrants.add(value);
      } else if (
        method === 'choose-imports' ||
        method === 'clipboard-imports' ||
        method === 'dropped-imports'
      ) {
        const v = record(input);
        keys(v, method === 'dropped-imports' ? ['checkout', 'paths'] : ['checkout']);
        this.approved(v.checkout);
        if (
          v.paths !== undefined &&
          (!Array.isArray(v.paths) ||
            v.paths.length > 256 ||
            !v.paths.length ||
            v.paths.some((p) => typeof p !== 'string' || p.length > 4096))
        )
          invalid('Invalid native drop.');
        const checkout = v.checkout as CheckoutTarget;
        const references = await this.native.imports(
          checkout,
          method === 'clipboard-imports' ? 'clipboard' : 'picker',
          v.paths as string[] | undefined,
          abort.signal,
        );
        const capture = { checkout, clientId: this.clientId, references };
        // Install cleanup ownership before any successful capture is published to the renderer.
        try {
          await runApplicationEffect(
            this.runtime,
            Scope.addFinalizer(
              document,
              Effect.promise(() => this.native.release(capture)),
            ),
          );
          if (generation === this.generation && !live()) await this.native.release(capture);
        } catch (error) {
          // A closed document executes this finalizer here; its root still owns any release failure.
          reserved.cleanupError = normalizeApplicationError(error);
          throw reserved.cleanupError;
        }
        requireLive();
        value = references;
      } else if (method === 'watch') {
        const v = decodeWorkspaceWatchInput(input);
        this.inspect(v);
        this.approved(v.checkout);
        if (
          !Array.isArray(v.paths) ||
          v.paths.length > 8192 ||
          v.paths.some((p) => typeof p !== 'string')
        )
          invalid('Invalid watch paths.');
        const ready = Promise.withResolvers<
          { close: ObservationClose } | { error: ApplicationError }
        >();
        reserved.cancel = async () => {
          const acquired = await ready.promise;
          if ('error' in acquired) throw acquired.error;
          await acquired.close();
        };
        try {
          const stop = this.client.watch(
            v as never,
            (event) => {
              if (live() && this.active.get(id) === reserved)
                this.send(id, { ok: true, value: event });
            },
            (error) => {
              if (live() && this.active.get(id) === reserved)
                this.send(id, { ok: false, error: errorDTO(error) });
            },
          );
          ready.resolve({ close: stop });
        } catch (error) {
          ready.resolve({ error: normalizeApplicationError(error) });
          throw error;
        }
        if (!live()) await this.closeRequest(id, reserved);
        return { ok: true, value: null };
      } else invalid('Unknown desktop method.');
      return { ok: true, value };
    } catch (error) {
      if (reserved && !reserved.close) reserved.watch = false;
      return { ok: false, error: errorDTO(error) };
    } finally {
      if (reserved && !reserved.watch && this.active.get(id as string) === reserved)
        this.active.delete(id as string);
      if (reserved && !reserved.watch) {
        reserved.complete();
        await this.closeRequest(id as string, reserved);
      }
    }
  }
  private closeRequest(id: string, active: Request): Promise<void> {
    if (!active.close) {
      active.cancelled = true;
      active.close = runApplicationEffect(
        this.runtime,
        Scope.close(active.scope, Exit.void),
      ).finally(() => {
        if (this.active.get(id) === active) this.active.delete(id);
      });
    }
    return active.close;
  }
  cancel(id: unknown): Promise<Reply<null>> {
    requestId(id);
    const previous = this.closing.get(id);
    if (previous) return previous;
    const active = this.active.get(id);
    if (!active) return Promise.resolve({ ok: true, value: null });
    const completion = this.closeRequest(id, active).then<Reply<null>, Reply<null>>(
      () => ({ ok: true, value: null }),
      (error) => ({ ok: false, error: errorDTO(error) }),
    );
    this.closing.set(id, completion);
    void completion.then((reply) => {
      if (reply.ok && this.closing.get(id) === completion) this.closing.delete(id);
      if (this.closing.size >= 128) this.closed = true;
    });
    return completion;
  }
  releaseDocument() {
    this.generation++;
    this.rootGrants.clear();
    for (const request of this.active.values()) request.cancelled = true;
    this.active.clear();
    const acknowledgments = [...this.closing.values()];
    this.closing.clear();
    const document = this.document;
    this.document = Scope.forkUnsafe(this.runtime.scope, 'parallel');
    const previous = this.cleanup;
    this.cleanup = (async () => {
      const results = await Promise.allSettled([
        previous,
        runApplicationEffect(this.runtime, Scope.close(document, Exit.void)),
        ...acknowledgments.map(async (acknowledgment) => {
          const reply = await acknowledgment;
          if (!reply.ok) throw new ApplicationError(reply.error);
        }),
      ]);
      const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
      if (failures.length)
        throw new ApplicationError({
          code: normalizeApplicationError(failures[0]).code,
          message: failures.map((error) => normalizeApplicationError(error).message).join('; '),
        });
    })();
    return this.cleanup;
  }
  dispose() {
    if (!this.disposal) {
      this.closed = true;
      this.disposal = this.releaseDocument();
    }
    return this.disposal;
  }
}
