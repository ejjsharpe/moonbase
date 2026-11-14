import { Context } from 'effect';
import { systemSocketClock, type SocketClock } from './socket-protocol.ts';

/**
 * The clock a daemon link's sockets and reconnect backoff run on: the system's unless a test
 * provides one.
 */
export const DaemonLinkClock = Context.Reference<SocketClock>('moonbase/DaemonLinkClock', {
  defaultValue: () => systemSocketClock,
});
