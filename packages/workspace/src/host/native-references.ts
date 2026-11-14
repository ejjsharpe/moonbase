import { Cause, Context, Deferred, Effect, Exit, FiberSet, Layer, Scope } from 'effect';
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
import { cancellationPoint } from './cancellation.ts';
import { Checkouts } from './checkouts.ts';
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
 */
export class References {
  private readonly unclaimed = new Map<string, NativeReference>();
  private activeNative = 0;
  private capturing = 0;
  private readonly checkouts: Checkouts['Service'];
  /** Where unclaimed references live; a failed release is reported when it closes. */
  private readonly scope: Scope.Scope;
  private readonly expiries: FiberSet.FiberSet<void, never>;
  constructor({
    checkouts,
    scope,
    expiries,
  }: {
    checkouts: Checkouts['Service'];
    scope: Scope.Scope;
    expiries: FiberSet.FiberSet<void, never>;
  }) {
    this.checkouts = checkouts;
    this.scope = scope;
    this.expiries = expiries;
  }
  getSourceName(token: string) {
    return this.unclaimed.get(token)?.source.source ?? '';
  }
  inspectReferences(tokens: string[], checkout: CheckoutTarget, clientId: string): NativeClaim[] {
    return tokens.map((token) => {
      const ref = this.unclaimed.get(token);
      if (!ref || ref.clientId !== clientId || !same(ref.checkout, checkout))
        throw new CheckoutAccessError({ refusal: 'native-reference-unusable' });
      ref.source.validate();
      return { token, ref };
    });
  }
  /**
   * Claims inspected references: no other operation can use them after this. Call it in the
   * same synchronous step as their inspection and the operation's durable reservation.
   */
  claimReferences(claims: NativeClaim[]) {
    for (const { token, ref } of claims) {
      this.unclaimed.delete(token);
      Deferred.doneUnsafe(ref.claimed, Effect.void);
    }
    this.activeNative += claims.length;
  }
  /** Hands claimed references' descriptors to the operation running in the current scope. */
  holdClaimedReferences(claims: NativeClaim[]): Effect.Effect<void, never, Scope.Scope> {
    return Effect.gen({ self: this }, function* () {
      for (const { ref } of claims)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            this.activeNative--;
            ref.source.close();
          }),
        );
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
      if (known.length) yield* attempt(() => this.checkouts.approval(input.checkout));
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
      if (!(this.unclaimed.size + this.activeNative + this.capturing + input.paths.length <= 256))
        return yield* new InvalidRequestError({ problem: 'native-limit' });
      const references: string[] = [];
      this.capturing += input.paths.length;
      return yield* Effect.gen({ self: this }, function* () {
        for (const p of input.paths) references.push(yield* this.captureOne(p, input, directory));
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
        Effect.ensuring(Effect.sync(() => (this.capturing -= input.paths.length))),
      );
    });
  }
  private captureOne(
    p: string,
    input: { checkout: CheckoutTarget; clientId: string },
    directory: Directory,
  ) {
    return Effect.gen({ self: this }, function* () {
      const source = yield* attempt(
        () => new NativeImport(p, (path) => this.checkouts.refuseReserved(path)),
      );
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
        Effect.sync(() => {
          // A claimed reference's descriptor belongs to the operation that claimed it.
          if (this.unclaimed.get(token) === entry) this.unclaimed.delete(token);
          else if (Deferred.isDoneUnsafe(claimed)) return;
          Deferred.doneUnsafe(claimed, Effect.void);
          source.close();
        }),
      );
      yield* Effect.interruptible(
        directory.io(['import-check', source.path, source.parents], undefined, [source.fd]),
      ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
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
      return new References({ checkouts, scope, expiries });
    }),
  );
}
