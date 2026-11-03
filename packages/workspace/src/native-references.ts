import { normalizeApplicationError, releaseResource } from '@moonbase/effect';
import { Cause, Deferred, Effect, Exit, type Fiber } from 'effect';
import { randomUUID } from 'node:crypto';
import { ApplicationError, type CheckoutTarget } from '@moonbase/contracts/workspace';
import type { Directory } from './filesystem.ts';
import { NativeImport } from './native-import.ts';
import { checkout, ensure, fail, identifier, same } from './validation.ts';

type NativeReference = {
  source: NativeImport;
  clientId: string;
  checkout: CheckoutTarget;
  claimed: Deferred.Deferred<void>;
};
type NativeClaim = { token: string; ref: NativeReference };

export class NativeReferences {
  private readonly unclaimed = new Map<string, NativeReference>();
  private activeNative = 0;
  private capturing = 0;
  private readonly directory: (target: CheckoutTarget) => Promise<Directory>;
  private readonly approveCheckout: (target: CheckoutTarget) => void;
  private readonly validateProtectedPath: (path: string) => void;
  private readonly startExpiry: (effect: Effect.Effect<void>) => Fiber.Fiber<void>;
  private readonly isClosed: () => boolean;
  private readonly reportCleanup: (cause: Cause.Cause<never>) => void;
  constructor(
    directory: (target: CheckoutTarget) => Promise<Directory>,
    approveCheckout: (target: CheckoutTarget) => void,
    validateProtectedPath: (path: string) => void,
    startExpiry: (effect: Effect.Effect<void>) => Fiber.Fiber<void>,
    isClosed: () => boolean,
    reportCleanup: (cause: Cause.Cause<never>) => void,
  ) {
    this.directory = directory;
    this.approveCheckout = approveCheckout;
    this.validateProtectedPath = validateProtectedPath;
    this.startExpiry = startExpiry;
    this.isClosed = isClosed;
    this.reportCleanup = reportCleanup;
  }
  getSourceName(token: string) {
    return this.unclaimed.get(token)?.source.source ?? '';
  }
  inspectReferences(tokens: string[], checkout: CheckoutTarget, clientId: string): NativeClaim[] {
    return tokens.map((token) => {
      const ref = this.unclaimed.get(token);
      if (!ref || ref.clientId !== clientId || !same(ref.checkout, checkout))
        fail(
          'Unauthorized',
          'Native reference expired, used or belongs to another client/checkout.',
        );
      ref!.source.validate();
      return { token, ref: ref! };
    });
  }
  // Call synchronously after durable reservation, with no yield since inspection.
  claimReferences(claims: NativeClaim[]) {
    for (const { token, ref } of claims) {
      this.unclaimed.delete(token);
      Deferred.doneUnsafe(ref.claimed, Effect.void);
    }
    this.activeNative += claims.length;
  }
  releaseClaimedReferences(claims: NativeClaim[]) {
    this.activeNative -= claims.length;
    const failures: string[] = [];
    for (const { ref } of claims) {
      try {
        ref.source.close();
      } catch {
        failures.push('Claimed native reference cleanup failed.');
      }
    }
    if (failures.length)
      this.reportCleanup(
        Cause.die(new ApplicationError({ code: 'Unavailable', message: failures.join('; ') })),
      );
    if (failures.length) fail('Unavailable', failures.join('; '));
  }
  release(input: { checkout: CheckoutTarget; clientId: string; references: string[] }) {
    identifier(input.clientId);
    checkout(input.checkout);
    ensure(
      Array.isArray(input.references) &&
        input.references.length <= 128 &&
        new Set(input.references).size === input.references.length &&
        input.references.every(
          (token) => typeof token === 'string' && token.length > 0 && token.length <= 160,
        ),
      'Invalid native release references.',
    );
    const known = input.references.filter((token) => this.unclaimed.has(token));
    for (const token of known) {
      const entry = this.unclaimed.get(token)!;
      if (entry.clientId !== input.clientId || !same(entry.checkout, input.checkout))
        fail('Unauthorized', 'Native reference belongs to another client/checkout.');
    }
    if (known.length) this.approveCheckout(input.checkout);
    const failures: string[] = [];
    for (const token of known) {
      try {
        this.releaseUnclaimed(token);
      } catch {
        failures.push('Native reference cleanup failed.');
      }
    }
    if (failures.length) {
      const error = new ApplicationError({ code: 'Unavailable', message: failures.join('; ') });
      this.reportCleanup(Cause.die(error));
      throw error;
    }
  }
  async capture(
    input: { checkout: CheckoutTarget; clientId: string; paths: string[] },
    signal: AbortSignal,
  ) {
    identifier(input.clientId);
    const directory = await this.directory(input.checkout);
    ensure(
      Array.isArray(input.paths) &&
        input.paths.length > 0 &&
        input.paths.length <= 128 &&
        this.unclaimed.size + this.activeNative + this.capturing + input.paths.length <= 256,
      'Native import selection limit reached.',
    );
    const references: string[] = [];
    this.capturing += input.paths.length;
    try {
      for (const p of input.paths) {
        const source = new NativeImport(p, (p) => this.validateProtectedPath(p));
        try {
          await directory.io(['import-check', source.path, source.parents], undefined, signal, [
            source.fd,
          ]);
          const token = randomUUID();
          const claimed = Deferred.makeUnsafe<void>();
          this.unclaimed.set(token, {
            source,
            clientId: input.clientId,
            checkout: input.checkout,
            claimed,
          });
          references.push(token);
          this.startExpiry(
            Effect.raceFirst(Effect.sleep('5 minutes'), Deferred.await(claimed)).pipe(
              Effect.ensuring(
                releaseResource(() => this.releaseUnclaimed(token)).pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      if (Exit.isFailure(exit)) this.reportCleanup(exit.cause);
                    }),
                  ),
                ),
              ),
            ),
          );
        } catch (error) {
          try {
            source.close();
          } catch {
            this.reportCleanup(
              Cause.die(
                new ApplicationError({
                  code: 'Unavailable',
                  message: 'Native capture cleanup failed.',
                }),
              ),
            );
          }
          throw error;
        }
      }
      if (signal.aborted || this.isClosed())
        fail('Cancelled', 'Native capture cancelled before handoff.');
      return references;
    } catch (error) {
      for (const token of references) {
        try {
          this.releaseUnclaimed(token);
        } catch (error) {
          this.reportCleanup(Cause.die(normalizeApplicationError(error)));
        }
      }
      throw error;
    } finally {
      this.capturing -= input.paths.length;
    }
  }
  private releaseUnclaimed(token: string) {
    const entry = this.unclaimed.get(token);
    if (entry) {
      this.unclaimed.delete(token);
      Deferred.doneUnsafe(entry.claimed, Effect.void);
      entry.source.close();
    }
  }
}
