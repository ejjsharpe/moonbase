import type { ChatClient } from '@moonbase/contracts/chat';
import type { DaemonClient } from '@moonbase/contracts/daemon';

export type IdleClock = {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
export const systemClock: IdleClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Calls `onIdle` once nothing has used the daemon for `idleMs`: no client request in flight, no
 * open watch and no active work. A client's request or watch resets the wait. Work is checked
 * every `pollMs` while otherwise idle, and counts as use whenever it is seen.
 */
export function createIdleMonitor({
  idleMs,
  pollMs,
  clock,
  hasActiveWork,
  onIdle,
}: {
  idleMs: number;
  pollMs: number;
  clock: IdleClock;
  hasActiveWork(): Promise<boolean>;
  onIdle(): void;
}) {
  let users = 0,
    last = clock.now(),
    timer: unknown,
    stopped = false;
  const cancel = () => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (ms: number) => {
    cancel();
    timer = clock.setTimeout(() => {
      timer = undefined;
      void check();
    }, ms);
  };
  async function check() {
    if (stopped || users) return;
    let active: boolean;
    try {
      active = await hasActiveWork();
    } catch {
      // Work that can't be ruled out keeps the daemon running.
      active = true;
    }
    if (stopped || users || timer !== undefined) return;
    const now = clock.now();
    if (active) last = now;
    const remaining = last + idleMs - now;
    if (remaining <= 0) {
      stopped = true;
      onIdle();
    } else schedule(Math.min(pollMs, remaining));
  }
  schedule(Math.min(pollMs, idleMs));
  return {
    /** A client request or watch began. */
    begin() {
      users++;
      last = clock.now();
      cancel();
    },
    /** A client request or watch ended. */
    end() {
      users = Math.max(0, users - 1);
      last = clock.now();
      if (!users && !stopped) schedule(Math.min(pollMs, idleMs));
    },
    /** Whether the monitor has stopped, by `stop` or by going idle. */
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
      cancel();
    },
  };
}
export type IdleMonitor = ReturnType<typeof createIdleMonitor>;

/** Counts each request and open watch as a client using the daemon. */
export function trackClientUse(client: ChatClient, idle: IdleMonitor): ChatClient {
  return {
    command: async (operation, input, options) => {
      idle.begin();
      try {
        return await client.command(operation, input, options);
      } finally {
        idle.end();
      }
    },
    watch: (input, receive, onError) => {
      idle.begin();
      let open = true;
      let close: ReturnType<ChatClient['watch']>;
      try {
        close = client.watch(input, receive, onError);
      } catch (error) {
        idle.end();
        throw error;
      }
      return async () => {
        if (open) {
          open = false;
          idle.end();
        }
        await close();
      };
    },
  };
}

/** Counts each daemon operation as a client using the daemon. */
export function trackDaemonUse(client: DaemonClient, idle: IdleMonitor): DaemonClient {
  return {
    command: async (operation, input, options) => {
      idle.begin();
      try {
        return await client.command(operation, input, options);
      } finally {
        idle.end();
      }
    },
  };
}
