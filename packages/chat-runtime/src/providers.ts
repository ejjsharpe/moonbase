import { randomUUID } from 'node:crypto';
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Exit,
  FiberMap,
  FiberSet,
  Layer,
  Ref,
  Stream,
  SubscriptionRef,
} from 'effect';
import type { Models } from '@earendil-works/pi-ai/models';
import { ProviderSetupService } from '@moonbase/contracts/services';
import type { ProviderCommand, ProviderState } from '@moonbase/contracts/providers';
import { decodeProviderOutput, readProviderSignInUrl } from '@moonbase/contracts/providers-schema';
import {
  isProviderSetupError,
  ProviderSetupRefusedError,
  ProviderSetupUnavailableError,
} from '@moonbase/contracts/provider-errors';
import { callAbortable } from './abortable-call.ts';
import { isClaudeCodeSignIn, isLocalProvider, listProviders } from './provider-catalog.ts';

export { localProviderIds } from './provider-catalog.ts';

type Interaction = Parameters<Models['login']>[2];
type AuthPrompt = Parameters<Interaction['prompt']>[0];
type AuthEvent = Parameters<Interaction['notify']>[0];

const refusal = (reason: ProviderSetupRefusedError['reason']) =>
  new ProviderSetupRefusedError({ reason });
/** Refuses the request for `reason`, before it changes anything. */
const refuse = (reason: ProviderSetupRefusedError['reason']) => Effect.fail(refusal(reason));
const unavailable = () => new ProviderSetupUnavailableError({ reason: 'setup' });
/** A provider setup failure safe to show; any other failure is hidden as unavailable. */
const safeError = (error: unknown) => (isProviderSetupError(error) ? error : unavailable());
/** How a prompt Pi is waiting on ends when its flow, or Pi, stops waiting for it. */
const cancelled = () => new Error('Cancelled');

type FlowState = NonNullable<ProviderState['flow']>;
/** The prompt a flow waits on: its answer completes `answer`. */
type Prompt = { id: string; options?: readonly string[]; answer: Deferred.Deferred<string> };
type Flow = { state: FlowState; url?: string; prompt?: Prompt };
/** Every owner's flow, the latest start each owner asked for, and the released owners. */
type Setup = {
  owners: ReadonlyMap<string, Flow>;
  revisions: ReadonlyMap<string, number>;
  /** In the order they were released, oldest first. */
  released: ReadonlySet<string>;
  /** Counts changes that leave the rest alone, such as a sign-out. */
  version: number;
};

export type ProviderSetupConfiguration = {
  models: Models;
  /**
   * Opens a validated sign-in URL in the user's browser; a failure is reported as unavailable.
   * Without it, `openProviderUrl` is refused and clients read the URL with `getProviderUrl` to open
   * it themselves.
   */
  openUrl?(url: string): Effect.Effect<void, unknown>;
  deviceId: string;
  /** Why the auth check made with `signal` couldn't tell whether a provider is configured, if it says. */
  getCheckProblem?(providerId: string, signal: AbortSignal): string | undefined;
};
/** An owner unheard from this long loses its flow, as when its client stopped without releasing it. */
export const inactiveProviderOwnerMs = 30 * 60 * 1000;
/** How many owners may hold a flow, and how many released owners stay refused. */
const maximumOwners = 64;
const maximumReleasedOwners = 256;

const validateProviderUrl = (value: string) => {
  const url = readProviderSignInUrl(value);
  if (url === undefined) throw refusal('unsupported-sign-in-url');
  return url;
};

const withFlow = (setup: Setup, owner: string, flow: Flow): Setup => ({
  ...setup,
  owners: new Map(setup.owners).set(owner, flow),
});
const isRunning = (flow: Flow | undefined, id: string): flow is Flow =>
  flow?.state.id === id && flow.state.state === 'running';

/** Provider callbacks remain privileged; only status and live prompt identities leave this layer. */
export const ProviderSetupLive = (
  config: ProviderSetupConfiguration,
): Layer.Layer<ProviderSetupService> =>
  Layer.effect(
    ProviderSetupService,
    Effect.gen(function* () {
      // Pi's prompts wait on Effects; its callbacks get Promises from here.
      const runForPi = yield* FiberSet.makeRuntimePromise<never>();
      const setup = yield* SubscriptionRef.make<Setup>({
        owners: new Map(),
        revisions: new Map(),
        released: new Set(),
        version: 0,
      });
      /** When each owner holding a flow last used provider setup; reading it changes nothing. */
      const usage = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
      // Each owner's running sign-in; closing the layer interrupts each and waits for Pi to settle.
      const flows = yield* FiberMap.make<string, void>();
      const changed = SubscriptionRef.update(setup, (s) => ({ ...s, version: s.version + 1 }));
      const updateFlow = (owner: string, id: string, change: (flow: Flow) => Flow) =>
        SubscriptionRef.update(setup, (s) => {
          const flow = s.owners.get(owner);
          return flow?.state.id === id ? withFlow(s, owner, change(flow)) : s;
        });
      const isLive = (owner: string, id: string, signal: AbortSignal) =>
        !signal.aborted && isRunning(SubscriptionRef.getUnsafe(setup).owners.get(owner), id);

      /** Cancels the owner's flow, if it runs, and waits for its sign-in to settle. */
      const cancelFlow = (owner: string) =>
        SubscriptionRef.update(setup, (s) => {
          const flow = s.owners.get(owner);
          return flow?.state.state === 'running'
            ? withFlow(s, owner, settleFlow(flow, 'cancelled'))
            : s;
        }).pipe(Effect.andThen(FiberMap.remove(flows, owner)));
      const cancel = (owner: string, flowId?: string) =>
        Effect.gen(function* () {
          const flow = (yield* SubscriptionRef.get(setup)).owners.get(owner);
          if (flowId && flow?.state.id !== flowId) return yield* refuse('sign-in-inactive');
          yield* cancelFlow(owner);
        });
      /** Forgets an owner's flow, cancelling it. */
      const dropOwner = (owner: string) =>
        SubscriptionRef.update(setup, (s) => {
          const owners = new Map(s.owners),
            revisions = new Map(s.revisions);
          owners.delete(owner);
          revisions.delete(owner);
          return { ...s, owners, revisions };
        }).pipe(
          Effect.andThen(
            Ref.update(usage, (used) => {
              const next = new Map(used);
              next.delete(owner);
              return next;
            }),
          ),
          Effect.andThen(FiberMap.remove(flows, owner)),
        );
      /**
       * Marks `owner` as heard from and drops other owners that went quiet or exceed the bound,
       * least recently used first, so a daemon outliving its clients does not keep their flows.
       */
      const sweepOwners = (owner: string) =>
        Effect.gen(function* () {
          const time = yield* Clock.currentTimeMillis;
          const { owners } = yield* SubscriptionRef.get(setup);
          const used = yield* Ref.updateAndGet(usage, (used) =>
            owners.has(owner) ? new Map(used).set(owner, time) : used,
          );
          const usedAt = (other: string) => used.get(other) ?? 0;
          const stale = [...owners.keys()]
            .filter((other) => other !== owner)
            .sort((a, b) => usedAt(b) - usedAt(a))
            .filter(
              (other, index) =>
                time - usedAt(other) >= inactiveProviderOwnerMs || index >= maximumOwners - 1,
            );
          yield* Effect.forEach(stale, dropOwner, { concurrency: 'unbounded', discard: true });
        });
      const requireHeld = (owner: string) =>
        Effect.flatMap(SubscriptionRef.get(setup), (s) =>
          s.released.has(owner) ? refuse('owner-released') : Effect.void,
        );
      const getCurrentFlow = (owner: string, id: string) =>
        Effect.flatMap(SubscriptionRef.get(setup), (s) => {
          const flow = s.owners.get(owner);
          return isRunning(flow, id) ? Effect.succeed(flow) : refuse('sign-in-inactive');
        });
      const getProviderUrl = (owner: string, flowId: string) =>
        requireHeld(owner).pipe(
          Effect.andThen(getCurrentFlow(owner, flowId)),
          Effect.flatMap((flow) =>
            flow.url
              ? Effect.try({ try: () => validateProviderUrl(flow.url!), catch: safeError })
              : refuse('no-sign-in-url'),
          ),
        );

      /** Shows Pi's prompt as the flow's, until it is answered or the flow stops waiting. */
      const askPrompt = (owner: string, id: string, prompt: AuthPrompt, signal: AbortSignal) =>
        // Publishing and its cleanup are one step: an abort cannot leave the prompt shown.
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const answer = yield* Deferred.make<string>();
            const promptId = randomUUID();
            const shown = yield* SubscriptionRef.modify(setup, (s): [boolean, Setup] => {
              const flow = s.owners.get(owner);
              if (!isRunning(flow, id) || signal.aborted || prompt.signal?.aborted)
                return [false, s];
              const options = prompt.type === 'select' ? prompt.options : [];
              return [
                true,
                withFlow(s, owner, {
                  ...flow,
                  prompt: {
                    id: promptId,
                    answer,
                    ...(prompt.type === 'select' ? { options: options.map(({ id }) => id) } : {}),
                  },
                  state: {
                    ...flow.state,
                    prompt: {
                      id: promptId,
                      type: prompt.type,
                      message: prompt.message,
                      options: options.map(({ id, label }) => ({ id, label })),
                    },
                  },
                }),
              ];
            });
            if (!shown) return yield* Effect.fail(cancelled());
            return yield* restore(Deferred.await(answer)).pipe(
              Effect.ensuring(
                updateFlow(owner, id, (flow) =>
                  flow.prompt?.id === promptId
                    ? { ...flow, prompt: undefined, state: { ...flow.state, prompt: null } }
                    : flow,
                ),
              ),
            );
          }),
        );
      const notify = (owner: string, id: string, event: AuthEvent, signal: AbortSignal) => {
        if (!isLive(owner, id, signal)) return;
        // An unsupported URL fails Pi's sign-in, as the refusal it is.
        const url = event.type === 'auth_url' ? validateProviderUrl(event.url) : undefined;
        void runForPi(
          updateFlow(owner, id, (flow) =>
            url === undefined
              ? {
                  ...flow,
                  state: { ...flow.state, message: 'Waiting for the provider to finish sign-in…' },
                }
              : {
                  ...flow,
                  url,
                  state: {
                    ...flow.state,
                    canOpenUrl: true,
                    message: 'Open the provider sign-in page to continue.',
                  },
                },
          ),
        ).catch(() => {});
      };
      const signIn = (owner: string, id: string, providerId: string) =>
        Effect.gen(function* () {
          // Cancelled before it started.
          if (!isRunning(SubscriptionRef.getUnsafe(setup).owners.get(owner), id))
            return yield* Effect.interrupt;
          // Interrupting aborts Pi's sign-in and waits for `models.login` to settle. Pi races the
          // provider's own login against the signal, so the provider's cleanup (such as ChatGPT's
          // 127.0.0.1:1455 loopback listener) may still be running when the next flow starts (#395).
          yield* callAbortable((signal) =>
            config.models.login(
              providerId,
              providerId === 'openai' ? 'oauth' : 'api_key',
              {
                signal,
                // The prompt waits until the sign-in, or Pi, stops waiting for it.
                prompt: (prompt) =>
                  runForPi(askPrompt(owner, id, prompt, signal), {
                    signal: prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal,
                  }),
                notify: (event) => notify(owner, id, event, signal),
              },
              { agentName: 'Moonbase', getDeviceId: () => config.deviceId },
            ),
          );
        }).pipe(
          Effect.onExit((exit) => {
            let outcome: 'completed' | 'cancelled' | 'failed' = 'completed';
            if (Exit.isFailure(exit))
              outcome = Cause.hasInterrupts(exit.cause) ? 'cancelled' : 'failed';
            // A flow cancelled while Pi settled already says so.
            return updateFlow(owner, id, (flow) =>
              flow.state.state === 'running' ? settleFlow(flow, outcome) : flow,
            );
          }),
        );

      /** Starts the owner's sign-in once no other owner's runs for the provider; its flow's id. */
      const startFlow = (owner: string, providerId: string) =>
        Effect.gen(function* () {
          if (!isLocalProvider(providerId)) return yield* refuse('unknown-provider');
          if (isClaudeCodeSignIn(providerId)) return yield* refuse('claude-code-sign-in');
          const revision = yield* SubscriptionRef.modify(setup, (s): [number, Setup] => {
            const next = (s.revisions.get(owner) ?? 0) + 1;
            return [next, { ...s, revisions: new Map(s.revisions).set(owner, next) }];
          });
          yield* cancelFlow(owner);
          const id = randomUUID();
          const time = yield* Clock.currentTimeMillis;
          // One sign-in per provider at a time: a provider's loopback callback (ChatGPT's
          // 127.0.0.1:1455) serves only one flow, and an abandoned client's flow must not hold it.
          // A newer start or a release while waiting supersedes this one.
          for (;;) {
            const step = yield* SubscriptionRef.modify(
              setup,
              (s): [{ superseded: true } | { contenders: string[] }, Setup] => {
                if (s.released.has(owner) || s.revisions.get(owner) !== revision)
                  return [{ superseded: true }, s];
                const contenders = [...s.owners]
                  .filter(
                    ([other, flow]) =>
                      other !== owner &&
                      flow.state.providerId === providerId &&
                      flow.state.state === 'running',
                  )
                  .map(([other]) => other);
                if (contenders.length) return [{ contenders }, s];
                const state: FlowState = {
                  id,
                  providerId,
                  state: 'running',
                  message: 'Complete provider setup.',
                  canOpenUrl: false,
                  prompt: null,
                };
                return [{ contenders }, withFlow(s, owner, { state })];
              },
            );
            if ('superseded' in step) return yield* refuse('sign-in-superseded');
            if (!step.contenders.length) break;
            yield* Effect.forEach(step.contenders, cancelFlow, {
              concurrency: 'unbounded',
              discard: true,
            });
          }
          yield* Ref.update(usage, (used) => new Map(used).set(owner, time));
          yield* FiberMap.run(flows, owner, signIn(owner, id, providerId));
          return id;
        });

      /** The owner's setup state; the provider SDK's catalog and sign-in prompts enter here. */
      const getStatus = (owner: string, operation: ProviderCommand) =>
        Effect.gen(function* () {
          const providers = yield* listProviders(config.models, config.getCheckProblem);
          const flow = (yield* SubscriptionRef.get(setup)).owners.get(owner)?.state ?? null;
          return yield* Effect.try({
            try: () => decodeProviderOutput(operation, { providers, flow }),
            catch: safeError,
          });
        });
      /** Cancels and forgets the flow `started` if it is still the owner's. */
      const forgetFlow = (owner: string, started: string) =>
        Effect.gen(function* () {
          if ((yield* SubscriptionRef.get(setup)).owners.get(owner)?.state.id !== started) return;
          yield* cancelFlow(owner);
          yield* SubscriptionRef.update(setup, (s) => {
            if (s.owners.get(owner)?.state.id !== started) return s;
            const owners = new Map(s.owners);
            owners.delete(owner);
            return { ...s, owners };
          });
        });
      /**
       * Runs one of an owner's commands: refused for a released owner, then `run`, announcing a
       * change if `changes`, then the owner's state. A flow `run` started whose state can't be
       * read is cancelled and forgotten.
       */
      const respond = <E>(
        owner: string,
        operation: ProviderCommand,
        run: Effect.Effect<string | void, E>,
        changes: boolean,
      ) =>
        Effect.gen(function* () {
          yield* requireHeld(owner);
          yield* sweepOwners(owner);
          const started = yield* run;
          if (changes) yield* changed;
          return yield* getStatus(owner, operation).pipe(
            Effect.tapError(() =>
              typeof started === 'string' ? forgetFlow(owner, started) : Effect.void,
            ),
          );
        }).pipe(Effect.mapError(safeError));
      /** Answers the flow's prompt: taken in the same step that checks it, so it is answered once. */
      const answerPrompt = (owner: string, flowId: string, promptId: string, answer: string) =>
        Effect.gen(function* () {
          const taken = yield* SubscriptionRef.modify(
            setup,
            (s): [Prompt | ProviderSetupRefusedError, Setup] => {
              const flow = s.owners.get(owner);
              if (!isRunning(flow, flowId)) return [refusal('sign-in-inactive'), s];
              const pending = flow.prompt;
              if (!pending || pending.id !== promptId) return [refusal('prompt-obsolete'), s];
              if (!answer.trim() || (pending.options && !pending.options.includes(answer)))
                return [refusal('invalid-answer'), s];
              return [
                pending,
                withFlow(s, owner, {
                  ...flow,
                  prompt: undefined,
                  state: { ...flow.state, prompt: null },
                }),
              ];
            },
          );
          if (taken instanceof ProviderSetupRefusedError) return yield* Effect.fail(taken);
          yield* Deferred.succeed(taken.answer, answer);
        });
      /** Opens the flow's sign-in URL through the injected opener; a throw is its failure. */
      const openFlowUrl = (owner: string, flowId: string) =>
        Effect.gen(function* () {
          const url = yield* getProviderUrl(owner, flowId);
          const { openUrl } = config;
          if (!openUrl)
            return yield* Effect.fail(
              new ProviderSetupUnavailableError({ reason: 'client-opens-links' }),
            );
          yield* Effect.flatten(Effect.try({ try: () => openUrl(url), catch: safeError }));
        });
      const logout = (owner: string, providerId: string) =>
        Effect.gen(function* () {
          if (!isLocalProvider(providerId)) return yield* refuse('unknown-provider');
          if (isClaudeCodeSignIn(providerId)) return yield* refuse('claude-code-sign-in');
          yield* cancel(owner);
          yield* Effect.tryPromise({
            try: () => config.models.logout(providerId),
            catch: safeError,
          });
        });
      const getProviders = (owner: string) => respond(owner, 'getProviders', Effect.void, false);

      return {
        forOwner: (owner) => ({
          getProviders: () => getProviders(owner),
          startProviderLogin: ({ providerId }) =>
            respond(owner, 'startProviderLogin', startFlow(owner, providerId), true),
          answerProviderPrompt: ({ flowId, promptId, answer }) =>
            respond(
              owner,
              'answerProviderPrompt',
              answerPrompt(owner, flowId, promptId, answer),
              true,
            ),
          cancelProviderLogin: ({ flowId }) =>
            respond(owner, 'cancelProviderLogin', cancel(owner, flowId), true),
          openProviderUrl: ({ flowId }) =>
            respond(owner, 'openProviderUrl', openFlowUrl(owner, flowId), false),
          logoutProvider: ({ providerId }) =>
            respond(owner, 'logoutProvider', logout(owner, providerId), true),
        }),
        releaseOwner: (owner) =>
          SubscriptionRef.update(setup, (s) => {
            const released = new Set(s.released);
            released.add(owner);
            for (const old of released) {
              if (released.size <= maximumReleasedOwners) break;
              released.delete(old);
            }
            return { ...s, released };
          }).pipe(Effect.andThen(dropOwner(owner)), Effect.andThen(changed)),
        watch: (owner) =>
          SubscriptionRef.changes(setup).pipe(
            // Changes during a read start one more; a consumer behind holds only the latest.
            Stream.buffer({ capacity: 1, strategy: 'sliding' }),
            Stream.mapEffect(() => getProviders(owner)),
            Stream.buffer({ capacity: 1, strategy: 'sliding' }),
          ),
        getProviderUrl: (owner, flowId) =>
          requireHeld(owner).pipe(
            // Reading the URL is use: the owner keeps its flow as when it polls.
            Effect.andThen(sweepOwners(owner)),
            Effect.andThen(getProviderUrl(owner, flowId)),
            Effect.mapError(safeError),
          ),
      } satisfies ProviderSetupService['Service'];
    }),
  );

/** A flow whose sign-in ended `as`: nothing left to answer or open. */
function settleFlow(flow: Flow, as: 'completed' | 'cancelled' | 'failed'): Flow {
  const messages = {
    completed: 'Provider is configured.',
    cancelled: 'Setup cancelled.',
    failed: unavailable().message,
  };
  return {
    state: { ...flow.state, state: as, prompt: null, canOpenUrl: false, message: messages[as] },
  };
}
