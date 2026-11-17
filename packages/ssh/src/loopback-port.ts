import { createServer, type AddressInfo, type Server } from 'node:net';
import { Effect } from 'effect';
import { ConnectionError } from '@moonbase/contracts/connection-errors';

const closeServer = (server: Server) =>
  Effect.callback<void>((resume) => {
    // A server that is not listening has nothing left to release.
    server.close(() => resume(Effect.void));
  });

/**
 * A free loopback port for an SSH forward: held exclusively while it is chosen, then released so
 * OpenSSH can bind it. Another listener may take it in between; OpenSSH then fails the forward
 * (`ExitOnForwardFailure`), and the connection reports it.
 */
export const reserveLoopbackPort: Effect.Effect<number, ConnectionError> = Effect.scoped(
  Effect.map(
    Effect.acquireRelease(
      Effect.callback<Server, ConnectionError>((resume) => {
        const server = createServer();
        const failed = () =>
          resume(Effect.fail(new ConnectionError({ reason: 'port-unavailable' })));
        server.once('error', failed);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
          server.off('error', failed);
          resume(Effect.succeed(server));
        });
        return closeServer(server);
      }),
      closeServer,
    ),
    (server) => (server.address() as AddressInfo).port,
  ),
);
