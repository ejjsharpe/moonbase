import type { ChatClient } from '@moonbase/contracts/chat';
import type { DaemonClient } from '@moonbase/contracts/daemon';
import { ApplicationError } from '@moonbase/contracts/errors';

/**
 * Refuses new requests and watches once `isStopping()` is true, in either mode: the daemon is then
 * shutting down, so nothing new is admitted. Requests and watches already open carry on.
 */
export function refuseWhileStopping(client: ChatClient, isStopping: () => boolean): ChatClient {
  const refuse = () => {
    if (isStopping())
      throw new ApplicationError({ code: 'Unavailable', message: 'The daemon is stopping.' });
  };
  return {
    command: async (operation, input, options) => {
      refuse();
      return client.command(operation, input, options);
    },
    watch: (input, receive, onError) => {
      refuse();
      return client.watch(input, receive, onError);
    },
  };
}

/** Refuses new daemon operations once `isStopping()` is true, as `refuseWhileStopping` does. */
export function refuseDaemonWhileStopping(
  client: DaemonClient,
  isStopping: () => boolean,
): DaemonClient {
  return {
    command: async (operation, input, options) => {
      if (isStopping())
        throw new ApplicationError({ code: 'Unavailable', message: 'The daemon is stopping.' });
      return client.command(operation, input, options);
    },
  };
}
