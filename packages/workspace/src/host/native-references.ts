import { Cause, Context, Deferred, Effect, Exit, FiberSet, Layer, Scope, Semaphore } from 'effect';
import { randomUUID } from 'node:crypto';
import type { CheckoutTarget } from '@moonbase/contracts/workspace';
import {
  CheckoutAccessError,
  InvalidRequestError,
  WorkspaceUnavailableError,
} from '@moonbase/contracts/workspace-host-errors';
import { attempt } from '../attempt.ts';
import type { Directory } from '../filesystem.ts';
import { same } from '../validation.ts';
import { cancellationPoint } from '../cancellation.ts';
import { Checkouts } from './checkouts.ts';
import { findNativeHelperRefusal } from './native-helper-refusal.ts';
import { NativeImport } from './native-import.ts';

type NativeReference = {
  source: NativeImport;
  clientId: string;
  checkout: CheckoutTarget;
  claimed: Deferred.Deferred<void>;
  /** Owns the source's descriptor while the reference is unclaimed. */
  scope: Scope.Closeable;
};
type NativeClaim = { token: string; ref: NativeReference };

/** How many native references a host holds at once: unclaimed, claimed or being captured. */
const nativeReferenceLimit = 256;

/** Fails a release that went wrong as the fixed, safe text a client sees. */
const asReleaseFailure = Effect.catchCause((cause: Cause.Cause<unknown>) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.failCause(cause as Cause.Cause<never>)
    : Effect.fail(new WorkspaceUnavailableError({ cause: 'native-cleanup' })),
);

/**
 * Native files a picker or drop named, held as single-use references for five minutes, bound to
 * the client and checkout that captured them. An unclaimed reference owns its source's
 * descriptor in a scope of its own; a claimed one hands it to the operation that claimed it.
 * Each open descriptor holds one of the host's `nativeReferenceLimit` permits until it closes.
 */
export class References {
  private readonly unclaimed = new Map<string, NativeReference>();
  private readonly checkouts: Checkouts['Service'];
  /** Where unclaimed references live; a failed release is reported when it closes. */
  private readonly scope: Scope.Scope;
  private readonly expiries: FiberSet.FiberSet<void, never>;
  private readonly permits: Semaphore.Semaphore;
  constructor({
    checkouts,
    scope,
    expiries,
    permits,
  }: {
    checkouts: Checkouts['Service'];
    scope: Scope.Scope;
    expiries: FiberSet.FiberSet<void, never>;
    permits: Semaphore.Semaphore;
  }) {
    this.checkouts = checkouts;
    this.scope = scope;
    this.expiries = expiries;
    this.permits = permits;
  }
  getSourceName(token: string) {
    return this.unclaimed.get(token)?.source.source ?? '';
  }
  /**
   * The client's unclaimed references to `tokens` in `checkout`, each source checked unchanged
   * since its capture. Synchronous and throwing, to run in one step with claiming them (see
   * `claimReferences`); `inspectReferences` is the same as an Effect.
   */
  findReferences(tokens: string[], checkout: CheckoutTarget, clientId: string): NativeClaim[] {
    return tokens.map((token) => {
      const ref = this.unclaimed.get(token);
      if (!ref || ref.clientId !== clientId || !same(ref.checkout, checkout))
        throw new CheckoutAccessError({ refusal: 'native-reference-unusable' });
      ref.source.validate();
      return { token, ref };
    });
  }
  /** The client's unclaimed references to `tokens` in `checkout`, each checked unchanged. */
  inspectReferences(tokens: string[], checkout: CheckoutTarget, clientId: string) {
    return attempt(() => this.findReferences(tokens, checkout, clientId));
  }
  /**
   * Claims found references: no other operation can use them after this. Call it in the same
   * synchronous step as finding them (`findReferences`) and the operation's durable reservation.
   */
  claimReferences(claims: NativeClaim[]) {
    for (const { token, ref } of claims) {
      this.unclaimed.delete(token);
      Deferred.doneUnsafe(ref.claimed, Effect.void);
    }
  }
  /** Hands claimed references' descriptors to the operation running in the current scope. */
  holdClaimedReferences(claims: NativeClaim[]): Effect.Effect<void, never, Scope.Scope> {
    return Effect.gen({ self: this }, function* () {
      for (const { ref } of claims) yield* Effect.addFinalizer(() => this.closeSource(ref.source));
    });
  }
  /** Releases references the client no longer needs; unknown ones are already gone. */
  release(input: { checkout: CheckoutTarget; clientId: string; references: string[] }) {
    return Effect.gen({ self: this }, function* () {
      const known = input.references.filter((token) => this.unclaimed.has(token));
      for (const token of known) {
        const entry = this.unclaimed.get(token)!;
        if (entry.clientId !== input.clientId || !same(entry.checkout, input.checkout))
          return yield* new CheckoutAccessError({ refusal: 'native-reference-owner' });
      }
      if (known.length) yield* this.checkouts.approval(input.checkout);
      // Every reference is released, whichever fail.
      yield* Effect.scoped(
        Effect.forEach(known, (token) => Effect.addFinalizer(() => this.releaseUnclaimed(token)), {
          discard: true,
        }),
      ).pipe(asReleaseFailure);
    });
  }
  capture(input: { checkout: CheckoutTarget; clientId: string; paths: string[] }) {
    return Effect.gen({ self: this }, function* () {
      const directory = yield* this.checkouts.directory(input.checkout);
      // The capture holds a permit for each path until that path's source opens and holds it.
      const held = { permits: input.paths.length };
      if (!(yield* Semaphore.takeIfAvailable(this.permits, held.permits)))
        return yield* new InvalidRequestError({ problem: 'native-limit' });
      const references: string[] = [];
      return yield* Effect.gen({ self: this }, function* () {
        for (const p of input.paths)
          references.push(yield* this.captureOne(p, input, directory, held));
        // A capture cancelled before it hands its references over keeps none of them.
        yield* cancellationPoint;
        return references;
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.forEach(references, (token) => this.releaseUnclaimed(token), {
                discard: true,
              }).pipe(Effect.catchCause((cause) => this.report(cause))),
        ),
        Effect.ensuring(Effect.suspend(() => Semaphore.release(this.permits, held.permits))),
      );
    });
  }
  private captureOne(
    p: string,
    input: { checkout: CheckoutTarget; clientId: string },
    directory: Directory,
    held: { permits: number },
  ) {
    return Effect.gen({ self: this }, function* () {
      // Opening the source and handing it the capture's permit are one step, so the permit is
      // returned once: by the capture, or by the source when it closes.
      const { source, scope, token, claimed, entry } = yield* Effect.uninterruptible(
        Effect.gen({ self: this }, function* () {
          const source = yield* attempt(() => new NativeImport(p, this.checkouts.isReserved));
          const scope = yield* Scope.fork(this.scope);
          const token = randomUUID();
          const claimed = Deferred.makeUnsafe<void>();
          const entry: NativeReference = {
            source,
            clientId: input.clientId,
            checkout: input.checkout,
            claimed,
            scope,
          };
          yield* Scope.addFinalizer(
            scope,
            Effect.suspend(() => {
              // A claimed reference's descriptor belongs to the operation that claimed it.
              if (this.unclaimed.get(token) === entry) this.unclaimed.delete(token);
              else if (Deferred.isDoneUnsafe(claimed)) return Effect.void;
              Deferred.doneUnsafe(claimed, Effect.void);
              return this.closeSource(source);
            }),
          );
          held.permits--;
          return { source, scope, token, claimed, entry };
        }),
      );
      yield* Effect.interruptible(
        directory.io(['import-check', source.path, source.parents], undefined, [source.fd]),
      ).pipe(
        // A folder holding a hard link or other unsupported entry is refused with its reason.
        Effect.catchTag('HelperFailure', (failure) =>
          Effect.fail(findNativeHelperRefusal(failure) ?? failure),
        ),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
      this.unclaimed.set(token, entry);
      yield* FiberSet.run(
        this.expiries,
        Effect.raceFirst(Effect.sleep('5 minutes'), Deferred.await(claimed)).pipe(
          Effect.ensuring(
            Scope.close(scope, Exit.void).pipe(Effect.catchCause((cause) => this.report(cause))),
          ),
        ),
      );
      return token;
    });
  }
  /** Closes a source's descriptor and returns its permit. */
  private closeSource(source: NativeImport) {
    return Effect.sync(() => source.close()).pipe(
      Effect.ensuring(Semaphore.release(this.permits, 1)),
    );
  }
  /** Closes an unclaimed reference's descriptor; a claimed one's is its operation's to close. */
  private releaseUnclaimed(token: string) {
    return Effect.suspend(() => {
      const entry = this.unclaimed.get(token);
      if (!entry) return Effect.void;
      return Scope.close(entry.scope, Exit.void);
    });
  }
  /** Keeps a release that failed outside any request, to fail the host's close with it. */
  private report(cause: Cause.Cause<unknown>) {
    return Scope.addFinalizer(this.scope, Effect.failCause(cause).pipe(Effect.orDie));
  }
}

/** The host's native import references. */
export class NativeReferences extends Context.Service<NativeReferences, References>()(
  'moonbase/workspace/NativeReferences',
) {
  static readonly layer = Layer.effect(
    NativeReferences,
    Effect.gen(function* () {
      const checkouts = yield* Checkouts;
      const scope = yield* Effect.scope;
      const expiries = yield* FiberSet.make<void, never>();
      const permits = yield* Semaphore.make(nativeReferenceLimit);
      return new References({ checkouts, scope, expiries, permits });
    }),
  );
}
