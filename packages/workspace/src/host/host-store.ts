import { Context, Effect, Layer } from 'effect';
import {
  InvalidRequestError,
  WorkspaceUnsupportedError,
} from '@moonbase/contracts/workspace-host-errors';
import { Store } from '../store.ts';
import { attempt } from '../attempt.ts';
import { hostDecoders } from '../schema.ts';
import { journalSchema } from './journal-tables.ts';
import { HostSettings } from './host-settings.ts';

/**
 * macOS on exactly Bun 1.4.4, the daemon's runtime and the only one that composes the file host.
 * Bun is qualified exactly, so upgrading it is a deliberate change.
 */
const requireQualifiedRuntime = Effect.suspend(() =>
  process.platform !== 'darwin' || process.versions.bun !== '1.4.4'
    ? Effect.fail(new WorkspaceUnsupportedError({ feature: 'runtime' }))
    : Effect.void,
);

/** The file host's store of approvals and journals, `workspace-host.sqlite`, open while it runs. */
export class HostStore extends Context.Service<HostStore, Store>()('moonbase/workspace/HostStore') {
  static readonly layer = Layer.effect(
    HostStore,
    Effect.gen(function* () {
      const { config } = yield* HostSettings;
      yield* requireQualifiedRuntime;
      const store = yield* Effect.acquireRelease(
        attempt(
          () =>
            new Store(config.dataDirectory, {
              file: 'workspace-host.sqlite',
              applicationId: 1296193364,
              schema:
                "CREATE INDEX IF NOT EXISTS approval_root ON records(json_extract(body, '$.target.root')) WHERE bucket='approvals';" +
                journalSchema,
              decoders: hostDecoders,
            }),
        ),
        (store) => Effect.sync(() => store.close()),
      );
      yield* attempt(() =>
        store.claim('host', config.hostId, new InvalidRequestError({ problem: 'store-host' })),
      );
      return store;
    }),
  );
}
