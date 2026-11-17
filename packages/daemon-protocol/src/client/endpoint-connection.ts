import { randomUUID } from 'node:crypto';
import { Effect, Layer, Stream } from 'effect';
import type { ConnectionSnapshot } from '@moonbase/contracts/connection';
import type { HostVerificationError } from '@moonbase/contracts/connection-errors';
import { ConnectionService, type ChatHostEndpoint } from '@moonbase/contracts/services';
import { checkHostHealth } from '../health.ts';

/**
 * A `ConnectionService` for one known endpoint, checked once when built: for a process that
 * already holds the daemon's origin and token, such as a test or a script on the daemon's machine.
 */
export const EndpointConnectionLive = (
  endpoint: ChatHostEndpoint,
): Layer.Layer<ConnectionService, HostVerificationError> =>
  Layer.effect(
    ConnectionService,
    Effect.map(checkHostHealth(endpoint), (health) => {
      const connectionId = randomUUID();
      const snapshot: ConnectionSnapshot = {
        profile: {
          id: 'endpoint',
          label: 'Endpoint',
          destination: '127.0.0.1',
          expected: endpoint.expected,
        },
        state: 'connected',
        connectionId,
        health,
      };
      return {
        getConnection: () => Effect.succeed(snapshot),
        connect: () => Effect.succeed(snapshot),
        disconnect: () => Effect.void,
        watch: () => Stream.concat(Stream.make(snapshot), Stream.never),
        endpoint: () => Effect.succeed({ ...endpoint, connectionId, health }),
      };
    }),
  );
