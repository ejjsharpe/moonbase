import { normalizeApplicationError } from '@moonbase/effect';
import { Effect, Exit, Scope, type ManagedRuntime } from 'effect';
import { runApplicationEffect } from '@moonbase/application/runtime/effect-client';
import { ApplicationError, type ObservationClose } from '@moonbase/contracts/workspace';
import type { ErrorDTO, Reply } from '../../shared/ipc/wire.ts';

export type IpcRequest = {
  signal: AbortSignal;
  isLive(): boolean;
  acquireWatch(acquire: () => ObservationClose): Promise<void>;
  retainDocumentRelease(release: () => Promise<void>): Promise<() => Promise<void>>;
  fail(): void;
  finish(): Promise<void>;
};
type Request = {
  cancel: () => void | Promise<void>;
  watch: boolean;
  cancelled: boolean;
  completion: Promise<void>;
  close?: Promise<void>;
  scope: Scope.Closeable;
  cleanupError?: ApplicationError;
};

/** Desktop-private ownership of one session's document, requests and retained cleanup outcomes. */
export class IpcLifetime {
  private active = new Map<string, Request>();
  private generation = 0;
  private closing = new Map<string, Promise<Reply<null>>>();
  private cleanup: Promise<void> = Promise.resolve();
  private disposal?: Promise<void>;
  private document: Scope.Closeable;
  private closed = false;
  private runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>;
  private capacity: number;
  private failure: (error: unknown) => { ok: false; error: ErrorDTO };
  constructor(
    runtime: ManagedRuntime.ManagedRuntime<never, ApplicationError>,
    capacity: number,
    failure: (error: unknown) => { ok: false; error: ErrorDTO },
  ) {
    this.runtime = runtime;
    this.capacity = capacity;
    this.failure = failure;
    this.document = Scope.forkUnsafe(runtime.scope, 'parallel');
  }
  getAdmissionError(id: string, watch: boolean) {
    if (this.closed) return 'closed';
    if (this.active.has(id) || this.closing.has(id)) return 'active';
    if (
      [...this.active.values()].filter((request) => request.watch === watch).length >= this.capacity
    )
      return 'capacity';
  }
  reserveRequest(id: string, watch: boolean): IpcRequest {
    const abort = new AbortController(),
      completion = Promise.withResolvers<void>();
    const generation = this.generation,
      document = this.document;
    const request: Request = {
      cancel: () => abort.abort(),
      watch,
      cancelled: false,
      completion: completion.promise,
      scope: Scope.forkUnsafe(document, 'parallel'),
    };
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
    this.active.set(id, request);
    const isLive = () =>
      !this.closed &&
      generation === this.generation &&
      !request.cancelled &&
      this.active.get(id) === request;
    return {
      signal: abort.signal,
      isLive,
      acquireWatch: (acquire) => {
        // Cancellation can reenter during a synchronous callback before acquisition returns its close.
        const ready = Promise.withResolvers<
          { close: ObservationClose } | { error: ApplicationError }
        >();
        request.cancel = async () => {
          const acquired = await ready.promise;
          if ('error' in acquired) throw acquired.error;
          await acquired.close();
        };
        try {
          ready.resolve({ close: acquire() });
        } catch (error) {
          ready.resolve({ error: normalizeApplicationError(error) });
          throw error;
        }
        return isLive() ? Promise.resolve() : this.closeRequest(id, request);
      },
      retainDocumentRelease: async (release) => {
        const retained = async () => {
          try {
            await release();
          } catch (error) {
            request.cleanupError = normalizeApplicationError(error);
            throw request.cleanupError;
          }
        };
        // Capture the admitting document even if replacement closes it before acquisition completes.
        try {
          await runApplicationEffect(
            this.runtime,
            Scope.addFinalizer(document, Effect.promise(retained)),
          );
          if (generation === this.generation && !isLive()) await retained();
          return retained;
        } catch (error) {
          // A late finalizer can fail after document close; keep that failure even if its reply is lost.
          request.cleanupError = normalizeApplicationError(error);
          throw request.cleanupError;
        }
      },
      fail: () => {
        if (!request.close) request.watch = false;
      },
      finish: async () => {
        if (!request.watch) {
          if (this.active.get(id) === request) this.active.delete(id);
          completion.resolve();
          await this.closeRequest(id, request);
        }
      },
    };
  }
  private closeRequest(id: string, request: Request): Promise<void> {
    if (!request.close) {
      request.cancelled = true;
      request.close = runApplicationEffect(
        this.runtime,
        Scope.close(request.scope, Exit.void),
      ).finally(() => {
        if (this.active.get(id) === request) this.active.delete(id);
      });
    }
    return request.close;
  }
  cancel(id: string): Promise<Reply<null>> {
    const previous = this.closing.get(id);
    if (previous) return previous;
    const request = this.active.get(id);
    if (!request) return Promise.resolve({ ok: true, value: null });
    const completion = this.closeRequest(id, request).then<Reply<null>, Reply<null>>(
      () => ({ ok: true, value: null }),
      this.failure,
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
  get count() {
    return this.active.size;
  }
}
