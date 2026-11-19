import { useContext, useMemo } from 'react';
import { Cause, Effect, Fiber } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import { RegistryContext, useAtomSet } from '@effect/atom-react';

/** Work a view starts: an Effect over services it was given, whose failure it has handled. */
export type ViewWork = Effect.Effect<unknown, unknown>;

/** One function atom that runs each Effect written to it, its failure left to the Effect. */
const makeRunAtom = (concurrent: boolean) =>
  Atom.setIdleTTL(
    Atom.fn((work: ViewWork) => Effect.ignore(work), { concurrent }),
    0,
  );

/**
 * Runs Effects for one view through an atom function. Unmounting the view interrupts what it
 * started; with `replace`, starting one also interrupts the one running. A synchronous Effect,
 * such as a service's state update in an event handler, has run once the call returns. The
 * services decide what outlives a caller: a send or an operation runs on as theirs.
 */
export function useRun({ replace = false } = {}) {
  const atom = useMemo(() => makeRunAtom(!replace), [replace]);
  return useAtomSet(atom) as (work: ViewWork | Atom.Interrupt) => void;
}

/**
 * Runs a synchronous Effect for one view and returns its value, as a DOM event handler that must
 * decide at once needs; undefined if it failed or was asynchronous.
 */
export function useRunNow<A>() {
  const registry = useContext(RegistryContext);
  const atom = useMemo(
    () =>
      Atom.setIdleTTL(
        Atom.fn((work: Effect.Effect<A, unknown>) => work),
        0,
      ),
    [],
  );
  useAtomSet(atom);
  return (work: Effect.Effect<A, unknown>): A | undefined => {
    registry.set(atom, work);
    const result = registry.get(atom);
    return AsyncResult.isSuccess(result) && !result.waiting ? result.value : undefined;
  };
}

/** `work`, its failure or defect passed to `report`; an interruption is no failure. */
export const reporting = (work: ViewWork, report: (error: unknown) => void): ViewWork =>
  Effect.catchCause(work, (cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.sync(() => {
          const failure = Cause.findErrorOption(cause);
          report(failure._tag === 'Some' ? failure.value : Cause.squash(cause));
        }),
  );

/**
 * `work` running on past an interruption of its caller, which only stops waiting for it: the
 * application's own lifecycle (opening or switching the chat), which no view may cut short.
 */
export const runOnPastCaller = <A, E>(work: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.flatMap(Effect.forkDetach(work, { startImmediately: true }), Fiber.join);
