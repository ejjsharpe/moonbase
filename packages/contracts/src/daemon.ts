import type { CommandOptions } from './common.ts';
import type * as Contracts from './daemon-schema.ts';

/** A local-mode daemon's folder and control operations. */
export type LocalHostCommand = keyof typeof Contracts.localHostInputSchemas;
export type LocalHostInput<K extends LocalHostCommand> =
  (typeof Contracts.localHostInputSchemas)[K]['Type'];
export type LocalHostOutput<K extends LocalHostCommand> =
  (typeof Contracts.localHostOutputSchemas)[K]['Type'];
/** Provider setup as a host serves it: each operation names its host and owner. */
export type HostProviderCommand = keyof typeof Contracts.hostProviderInputSchemas;
/** Every operation a local-mode daemon serves beyond `ChatCommand`. */
export type DaemonCommand = LocalHostCommand | HostProviderCommand;
export type DaemonInput<K extends DaemonCommand> = (typeof Contracts.daemonInputSchemas)[K]['Type'];
export type DaemonOutput<K extends DaemonCommand> =
  (typeof Contracts.daemonOutputSchemas)[K]['Type'];
/** Privileged: a host's daemon operations, bound to its process root. */
export interface DaemonClient {
  command<K extends DaemonCommand>(
    operation: K,
    input: DaemonInput<K>,
    options?: CommandOptions,
  ): Promise<DaemonOutput<K>>;
}
