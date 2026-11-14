import { Layer } from 'effect';
import { RemoteDaemonLive, RemoteWorkspaceHostLive } from '@moonbase/daemon-protocol/remote';
import type { ChatHostTarget } from '@moonbase/contracts/host';
import type { ConnectionService } from '@moonbase/contracts/services';
import { ProviderSetupUnavailableError } from '@moonbase/contracts/provider-errors';
import { readProviderSignInUrl } from '@moonbase/contracts/providers-schema';

/**
 * A daemon's clients over its connection, local or remote alike: chat, folders and provider
 * setup over one RPC link, and for a local daemon its file host. Provider sign-in links were
 * checked by the daemon and the client; main opens only such a link.
 */
export const DaemonServicesLive = <E, R>(options: {
  host: ChatHostTarget;
  connection: Layer.Layer<ConnectionService, E, R>;
  /** Opens a provider's sign-in page in the user's browser. */
  openUrl(url: string): Promise<void>;
  /** Whether the daemon runs on this Mac, so a provider's loopback sign-in callback reaches it. */
  sameMachine: boolean;
  /** Whether to bind the daemon's file host too. */
  workspace: boolean;
}) =>
  Layer.mergeAll(
    RemoteDaemonLive({
      host: options.host,
      openUrl: async (url) => {
        if (readProviderSignInUrl(url) !== url)
          throw new ProviderSetupUnavailableError({ reason: 'invalid-link' });
        await options.openUrl(url);
      },
      sameMachine: options.sameMachine,
    }),
    options.workspace ? RemoteWorkspaceHostLive({ host: options.host }) : Layer.empty,
  ).pipe(Layer.provideMerge(options.connection));
