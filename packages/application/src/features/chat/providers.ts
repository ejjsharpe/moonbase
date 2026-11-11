import type {
  ProviderCommand,
  ProviderInput,
  ProviderSetupClient,
  ProviderState,
} from '@moonbase/contracts/providers';
import type { ObservationClose } from '@moonbase/contracts/common';
import { normalizeApplicationError } from '../../runtime/effect-client.ts';

export type ProviderSetupSnapshot = {
  status: ProviderState | null;
  busy: boolean;
  error: string | null;
};
/**
 * Transient setup state only: answers never enter snapshots or draft storage. The state comes from
 * the client's watch once it delivers, so a sign-in's progress appears without polling; until then
 * command replies supply it. A watch that fails retryably opens again after the chat list's
 * backoff (renewed once a watch stays up `healthyMs`); once that runs out, or after another
 * failure, the next refresh, login or answer opens it again.
 */
export function makeProviderSetupController(
  client: ProviderSetupClient,
  { retryMs, healthyMs }: { retryMs: readonly number[]; healthyMs: number },
) {
  let snapshot: ProviderSetupSnapshot = { status: null, busy: false, error: null };
  let closed = false,
    admissionsOpen = true;
  /** The open watch, and when it first delivered; it is the state's source once it has. */
  type Watching = { close?: ObservationClose; deliveredAt?: number };
  let watching: Watching | undefined;
  let failures = 0,
    retry: ReturnType<typeof setTimeout> | undefined;
  let disposal: Promise<void> | undefined;
  const cleanupErrors: Error[] = [];
  let revision = 0,
    mutations = 0;
  const listeners = new Set<() => void>(),
    work = new Set<Promise<void>>();
  const publish = (change: Partial<ProviderSetupSnapshot>) => {
    if (closed) return;
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Presentation owns no setup work. */
      }
    }
  };
  const command = <K extends ProviderCommand>(
    operation: K,
    input: ProviderInput<K>,
  ): Promise<void> => {
    if (closed || !admissionsOpen) return Promise.resolve();
    const read = operation === 'getProviders';
    if (read && mutations) return Promise.resolve();
    const captured = read ? revision : ++revision;
    if (!read) mutations++;
    publish({ busy: true, error: null });
    const task = client
      .command(operation, input)
      .then(async (status) => {
        if (closed) {
          if (status.flow?.state === 'running')
            await client.command('cancelProviderLogin', { flowId: status.flow.id });
          return;
        }
        if (captured !== revision || watching?.deliveredAt !== undefined) return;
        publish({ status });
      })
      .catch((error) => {
        if (closed) cleanupErrors.push(normalizeApplicationError(error));
        else if (captured === revision)
          publish({ error: normalizeApplicationError(error).message });
      })
      .finally(() => {
        if (!read) mutations--;
        work.delete(task);
        publish({ busy: work.size > 0 });
      });
    work.add(task);
    return task;
  };
  const closeWatch = () => {
    const current = watching;
    watching = undefined;
    void current?.close?.().catch(() => {});
  };
  /** Opens the watch unless one is open or waiting to reopen. */
  const watch = () => {
    if (closed || !admissionsOpen || watching || retry) return;
    const current: Watching = {};
    watching = current;
    try {
      current.close = client.watch(
        (status) => {
          if (closed || watching !== current) return;
          current.deliveredAt ??= performance.now();
          publish({ status });
        },
        (error) => {
          if (watching !== current) return;
          closeWatch();
          reopen(error, current);
        },
      );
    } catch (error) {
      if (watching === current) watching = undefined;
      reopen(error, current);
    }
  };
  const reopen = (error: unknown, failed: Watching) => {
    if (closed) return;
    if (failed.deliveredAt !== undefined && performance.now() - failed.deliveredAt >= healthyMs)
      failures = 0;
    const delay = retryMs[failures];
    if (normalizeApplicationError(error).code !== 'Unavailable' || delay === undefined) {
      failures = 0;
      return;
    }
    failures++;
    retry = setTimeout(() => {
      retry = undefined;
      watch();
    }, delay);
  };
  /** Commands that start or continue a sign-in first make sure its progress is being watched. */
  const watched = <T>(run: () => T) => {
    watch();
    return run();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: () => watched(() => command('getProviders', {})),
    login: (providerId: string) => watched(() => command('startProviderLogin', { providerId })),
    answer: (flowId: string, promptId: string, answer: string) =>
      watched(() => command('answerProviderPrompt', { flowId, promptId, answer })),
    cancel: (flowId: string) => command('cancelProviderLogin', { flowId }),
    openUrl: (flowId: string) => command('openProviderUrl', { flowId }),
    logout: (providerId: string) => command('logoutProvider', { providerId }),
    setAdmissionsOpen(open: boolean) {
      admissionsOpen = open;
    },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      closed = true;
      clearTimeout(retry);
      closeWatch();
      listeners.clear();
      disposal = (async () => {
        await Promise.all(work);
        const flow = snapshot.status?.flow;
        if (flow?.state === 'running')
          await client.command('cancelProviderLogin', { flowId: flow.id });
        if (cleanupErrors.length) throw cleanupErrors[0];
      })();
      return disposal;
    },
  };
}
export type ProviderSetupController = ReturnType<typeof makeProviderSetupController>;
