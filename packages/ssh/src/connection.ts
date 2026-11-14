import { Cause, Deferred, Effect, Exit, Fiber, Layer, Queue, Stream, type Scope } from 'effect';
import { createServer, type Server, type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { CancelledError } from '@moonbase/contracts/errors';
import {
  ConnectionError,
  type ConnectionErrorReason,
  type HostVerificationError,
} from '@moonbase/contracts/connection-errors';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import type { ChatHostHealth } from '@moonbase/contracts/host';
import { releaseResource } from '@moonbase/effect';
import {
  ConnectionService,
  type ChatHostEndpoint,
  type ConnectionServiceShape,
} from '@moonbase/contracts/services';
import { SshProcess } from './process.ts';
import {
  defaultSshExecutable,
  type DecodedSshConfiguration,
  type SshConfiguration,
} from './configuration.ts';

/** What an SSH connection fails with. */
type SshFailure = ConnectionError | HostVerificationError | CancelledError;
const error = (reason: ConnectionErrorReason) => new ConnectionError({ reason });
const cancelled = () => new CancelledError({ operation: 'SSH connection' });
const ensure: (condition: unknown, reason: ConnectionErrorReason) => asserts condition = (
  condition,
  reason,
) => {
  if (!condition) throw error(reason);
};
const command = <A>(run: () => A): Effect.Effect<A, ConnectionError> =>
  Effect.try({
    try: run,
    catch: (e) => (e instanceof ConnectionError ? e : error('closed')),
  });
type Generation = {
  id: string;
  ready: Deferred.Deferred<ConnectionSnapshot, SshFailure>;
  fiber?: Fiber.Fiber<void, SshFailure>;
  processes: Set<SshProcess>;
  forward?: SshProcess;
  origin?: string;
  health?: ChatHostHealth;
  reason?: 'disconnect' | 'cancel' | 'root';
};
export type SshOptions = {
  /**
   * Checks the chat host's signed health on the forwarded port. The consumer supplies the
   * protocol's check (`checkHostHealth` from `@moonbase/daemon-protocol/health`); SSH only
   * forwards the port. An `unreachable` failure is retried until the startup deadline.
   */
  verify: (endpoint: ChatHostEndpoint) => Effect.Effect<ChatHostHealth, HostVerificationError>;
  /** How long a connection may take to verify its host; 20 seconds unless a test shortens it. */
  startupMs?: number;
};
/**
 * Root-scoped capability only. The consumer composes the process runtime and shared handlers, and
 * decodes the configuration where it reads it (`decodeSshConfiguration`).
 */
export function SshLive(input: SshConfiguration, options: SshOptions) {
  return Layer.effect(
    ConnectionService,
    Effect.gen(function* () {
      // Process groups are POSIX; on any other platform this layer is a defect, not an outcome.
      if (process.platform === 'win32') return yield* Effect.die(error('platform'));
      const config = { ...input, sshExecutable: input.sshExecutable ?? defaultSshExecutable },
        scope = yield* Effect.scope;
      const owner = yield* Effect.acquireRelease(
        Effect.sync(
          () => new Connection(config, scope, options.verify, options.startupMs ?? 20_000),
        ),
        (c) => c.dispose(),
      );
      return owner.service;
    }),
  );
}
class Connection {
  readonly config: DecodedSshConfiguration;
  readonly scope: Scope.Scope;
  readonly service: ConnectionServiceShape;
  private state: ConnectionSnapshot;
  private current: Generation | undefined;
  private readonly generations = new Set<Generation>();
  private readonly observers = new Set<Queue.Queue<ConnectionSnapshot, Cause.Done>>();
  private closed = false;
  readonly startupMs: number;
  readonly verify: SshOptions['verify'];
  constructor(
    config: DecodedSshConfiguration,
    scope: Scope.Scope,
    verify: SshOptions['verify'],
    startupMs: number,
  ) {
    this.config = config;
    this.verify = verify;
    this.startupMs = startupMs;
    this.scope = scope;
    this.state = { profile: config.profile, state: 'disconnected', connectionId: null };
    this.service = {
      getConnection: () =>
        command(() => {
          this.open();
          return this.snapshot();
        }),
      connect: ({ profileId }) =>
        Effect.flatMap(
          command(() => {
            ensure(profileId === config.profile.id, 'wrong-profile');
            this.open();
          }),
          () => this.connect(),
        ),
      disconnect: ({ connectionId }) =>
        Effect.flatMap(
          command(() => this.open()),
          () => this.disconnect(connectionId),
        ),
      endpoint: ({ host }) =>
        command(() => {
          this.open();
          if (
            host.hostId !== config.profile.expected.hostId ||
            host.storeId !== config.profile.expected.storeId
          )
            throw error('host-mismatch');
          const g = this.current;
          if (!g?.origin || !g.health || g.forward?.exited || this.state.state !== 'connected')
            throw error('not-verified');
          return structuredClone({
            origin: g.origin,
            token: config.token,
            expected: config.profile.expected,
            connectionId: g.id,
            health: g.health,
          });
        }),
      watch: () => this.watch(),
    };
  }
  private open() {
    if (this.closed) throw error('closed');
  }
  private snapshot() {
    return structuredClone(this.state);
  }
  private publish(state: ConnectionSnapshot) {
    this.state = state;
    for (const q of this.observers) Queue.offerUnsafe(q, this.snapshot());
  }
  private watch() {
    // oxlint-disable-next-line no-this-alias -- The Effect generator retains the connection owner.
    const self = this;
    return Stream.unwrap(
      Effect.gen(function* () {
        const q = yield* Queue.sliding<ConnectionSnapshot, Cause.Done>(1);
        yield* Effect.acquireRelease(
          command(() => {
            self.open();
            if (self.observers.size >= 64) throw error('observer-limit');
            self.observers.add(q);
            Queue.offerUnsafe(q, self.snapshot());
            return q;
          }),
          (queue) =>
            releaseResource(() => {
              self.observers.delete(queue);
              Queue.endUnsafe(queue);
            }),
        );
        return Stream.fromQueue(q);
      }),
    );
  }
  private connect(): Effect.Effect<ConnectionSnapshot, SshFailure> {
    // oxlint-disable-next-line no-this-alias -- The Effect generator retains the connection owner.
    const self = this;
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        let g = self.current;
        if (g && self.state.state !== 'connecting' && self.state.state !== 'connected')
          return yield* Effect.fail(error('releasing'));
        if (!g) {
          g = { id: randomUUID(), ready: Deferred.makeUnsafe(), processes: new Set() };
          self.current = g;
          self.generations.add(g);
          self.publish({ profile: self.config.profile, state: 'connecting', connectionId: g.id });
          g.fiber = yield* Effect.forkIn(self.attempt(g), self.scope);
        }
        if (g.forward?.exited) return yield* Effect.fail(error('generation-exited'));
        const captured = g;
        return yield* restore(Deferred.await(captured.ready)).pipe(
          Effect.map((value) => structuredClone(value)),
          Effect.onInterrupt(() => self.cancelConnecting(captured)),
        );
      }),
    );
  }
  private cancelConnecting(g: Generation) {
    return Effect.suspend(() => {
      if (this.current !== g || this.state.state !== 'connecting') return Effect.void;
      g.reason = 'cancel';
      this.publish({ profile: this.config.profile, state: 'disconnecting', connectionId: g.id });
      return this.release(g);
    });
  }
  private disconnect(id: string) {
    return Effect.suspend(() => {
      const g = this.current;
      if (!g) return Effect.void;
      if (g.id !== id) return Effect.fail(error('stale-generation'));
      g.reason = 'disconnect';
      this.publish({ profile: this.config.profile, state: 'disconnecting', connectionId: g.id });
      return this.release(g);
    });
  }
  private release(g: Generation) {
    // oxlint-disable-next-line no-this-alias -- The Effect generator retains the connection owner.
    const self = this;
    return Effect.uninterruptible(
      Effect.gen(function* () {
        const interrupted = g.fiber && g.fiber.pollUnsafe() === undefined;
        if (g.fiber) yield* Fiber.interrupt(g.fiber);
        const exit = g.fiber?.pollUnsafe();
        // An interrupted attempt already spent its release budget; retry only on a later explicit release.
        if (
          interrupted &&
          exit &&
          Exit.isFailure(exit) &&
          exit.cause.reasons.some(Cause.isDieReason)
        )
          return yield* Effect.failCause(exit.cause).pipe(Effect.orDie);
        const cleanup = yield* Effect.exit(
          releaseResource(async () => {
            await Promise.all([...g.processes].map((child) => child.stop()));
          }),
        );
        if (Exit.isFailure(cleanup)) {
          yield* Deferred.failCause(g.ready, Cause.combine(Cause.fail(cancelled()), cleanup.cause));
          return yield* Effect.failCause(cleanup.cause);
        }
        self.finished(g);
        // The owning path also settles admissions whose attempt fiber never started.
        yield* Deferred.fail(g.ready, cancelled());
      }),
    );
  }
  private finished(g: Generation, failure?: SshFailure) {
    this.generations.delete(g);
    if (this.current !== g) return;
    this.current = undefined;
    this.publish(
      g.reason
        ? { profile: this.config.profile, state: 'disconnected', connectionId: null }
        : {
            profile: this.config.profile,
            state: 'failed',
            connectionId: g.id,
            message: failure?.message ?? 'SSH connection ended.',
          },
    );
  }
  private arguments() {
    return [
      '-N',
      '-T',
      '-n',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'ControlPersist=no',
      '-o',
      'ForkAfterAuthentication=no',
      '-o',
      'GatewayPorts=no',
      '-o',
      'PermitLocalCommand=no',
      '-o',
      'RemoteCommand=none',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ForwardX11=no',
    ];
  }
  private spawn(g: Generation, args: string[], captureOutput = false) {
    return Effect.try({
      try: () => {
        const child = new SshProcess(
          this.config.sshExecutable,
          args,
          this.config.token,
          captureOutput,
        );
        g.processes.add(child);
        void child.terminal.then(() => {
          if (this.current === g && g.forward === child && !g.reason)
            this.publish({
              profile: this.config.profile,
              state: 'failed',
              connectionId: g.id,
              message: child.failure().message,
            });
        });
        return child;
      },
      catch: () => error('process-start'),
    });
  }
  private port() {
    return Effect.acquireUseRelease(
      Effect.sync(() => ({ server: createServer(), abort: new AbortController() })),
      ({ server, abort }) =>
        Effect.tryPromise({
          try: (signal) =>
            new Promise<number>((resolve, reject) => {
              const failed = () => {
                clean();
                reject(error('port-unavailable'));
              };
              const clean = () => {
                server.off('error', failed);
                signal.removeEventListener('abort', failed);
              };
              server.once('error', failed);
              signal.addEventListener('abort', failed, { once: true });
              if (signal.aborted) return failed();
              server.listen(
                { host: '127.0.0.1', port: 0, exclusive: true, signal: abort.signal },
                () => {
                  clean();
                  resolve((server.address() as AddressInfo).port);
                },
              );
            }),
          catch: () => error('port-unavailable'),
        }),
      ({ server, abort }) =>
        releaseResource(async () => {
          abort.abort();
          await closeServer(server);
        }),
    );
  }
  private attempt(g: Generation): Effect.Effect<void, SshFailure> {
    // oxlint-disable-next-line no-this-alias -- The Effect generator retains the connection owner.
    const self = this;
    const establish = Effect.gen(function* () {
      if (g.reason || self.closed || self.current !== g) return yield* Effect.fail(cancelled());
      const preflight = yield* self.spawn(
        g,
        [...self.arguments(), '-G', '--', self.config.profile.destination],
        true,
      );
      const configured = yield* Effect.promise(() => preflight.terminal);
      yield* releaseResource(() => preflight.stop());
      if (configured.spawnFailed || configured.code !== 0 || preflight.overflow)
        return yield* Effect.fail(preflight.failure());
      if (/^(localforward|remoteforward|dynamicforward)\s+/im.test(preflight.output))
        return yield* Effect.fail(error('policy-forwards'));
      if (/^stricthostkeychecking\s+(false|no|off)\s*$/im.test(preflight.output))
        return yield* Effect.fail(error('policy-host-key'));
      if (
        /^nohostauthenticationfor(?:localhost|proxycommand)\s+(?!no\s*$|false\s*$|off\s*$)\S+/im.test(
          preflight.output,
        )
      )
        return yield* Effect.fail(error('policy-host-authentication'));
      if (
        /^clearallforwardings\s+yes\s*$/im.test(preflight.output) ||
        /^tunnel\s+(?!false\s*$|no\s*$|none\s*$)\S+/im.test(preflight.output)
      )
        return yield* Effect.fail(error('policy-tunnel'));
      preflight.output = '';
      preflight.stderr = '';
      const port = yield* self.port();
      g.origin = `http://127.0.0.1:${port}`;
      const child = yield* self.spawn(g, [
        ...self.arguments(),
        '-L',
        `127.0.0.1:${port}:127.0.0.1:${self.config.profile.remotePort}`,
        '--',
        self.config.profile.destination,
      ]);
      g.forward = child;
      const exited = Effect.flatMap(
        Effect.promise(() => child.terminal),
        () => Effect.fail(child.failure()),
      );
      const verify: Effect.Effect<ChatHostHealth, HostVerificationError> = Effect.gen(function* () {
        while (true) {
          const result = yield* Effect.result(
            self.verify({
              origin: g.origin!,
              token: self.config.token,
              expected: self.config.profile.expected,
            }),
          );
          if (result._tag === 'Success') return result.success;
          if (result.failure.reason !== 'unreachable') return yield* Effect.fail(result.failure);
          yield* Effect.sleep('50 millis');
        }
      });
      const health = yield* Effect.raceFirst(verify, exited);
      g.health = structuredClone(health);
      self.publish({
        profile: self.config.profile,
        state: 'connected',
        connectionId: g.id,
        health,
      });
      yield* Deferred.succeed(g.ready, self.snapshot());
      return child;
    }).pipe(
      Effect.timeoutOrElse({
        duration: self.startupMs,
        orElse: () => Effect.fail(error('startup-deadline')),
      }),
    );
    return Effect.gen(function* () {
      const child = yield* establish;
      yield* Effect.promise(() => child.terminal);
      return yield* Effect.fail(child.failure());
    }).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const cause = Exit.isFailure(exit) ? exit.cause : undefined;
          const ended: SshFailure = g.reason ? cancelled() : error('ended');
          let failure =
            (cause && !Cause.hasInterruptsOnly(cause)
              ? cause.reasons.find(Cause.isFailReason)?.error
              : undefined) ?? ended;
          // A cleanup defect is reported beside the attempt's own end, not in place of it.
          if (cause?.reasons.some(Cause.isDieReason))
            failure = g.reason ? ended : error('cleanup-failed');
          if (self.current === g)
            self.publish(
              g.reason
                ? { profile: self.config.profile, state: 'disconnecting', connectionId: g.id }
                : {
                    profile: self.config.profile,
                    state: 'failed',
                    connectionId: g.id,
                    message: failure.message,
                  },
            );
          const cleanup = yield* Effect.exit(
            releaseResource(async () => {
              await Promise.all([...g.processes].map((child) => child.stop()));
            }),
          );
          if (Exit.isFailure(cleanup)) {
            yield* Deferred.failCause(g.ready, Cause.combine(Cause.fail(failure), cleanup.cause));
            return yield* Effect.failCause(cleanup.cause);
          }
          self.finished(g, failure);
          yield* Deferred.fail(g.ready, failure);
        }),
      ),
    );
  }
  dispose() {
    // oxlint-disable-next-line no-this-alias -- The Effect generator retains the connection owner.
    const self = this;
    return Effect.gen(function* () {
      self.closed = true;
      for (const g of self.generations) {
        g.reason = 'root';
        yield* self.release(g);
      }
      self.current = undefined;
      self.generations.clear();
      for (const queue of self.observers) Queue.endUnsafe(queue);
      self.observers.clear();
    });
  }
}
async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((e) =>
      e && (e as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
        ? reject(error('port-release'))
        : resolve(),
    ),
  );
}
