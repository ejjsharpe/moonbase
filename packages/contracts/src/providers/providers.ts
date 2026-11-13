import type { CommandOptions, ObservationClose } from '../shared/common.ts';
import type { ApplicationError } from '../errors/errors.ts';
import type * as Contracts from './schema.ts';

export type ProviderState = typeof Contracts.ProviderStateSchema.Type;
export type ProviderCommand = keyof typeof Contracts.providerInputSchemas;
export type ProviderInput<K extends ProviderCommand> =
  (typeof Contracts.providerInputSchemas)[K]['Type'];
export type ProviderOutput<_K extends ProviderCommand> = ProviderState;
export interface ProviderSetupClient {
  command<K extends ProviderCommand>(
    operation: K,
    input: ProviderInput<K>,
    options?: CommandOptions,
  ): Promise<ProviderOutput<K>>;
  /** The setup state, then again after each change to it, so a sign-in's progress needs no polling. */
  watch(
    receive: (state: ProviderState) => void,
    onError: (error: ApplicationError) => void,
  ): ObservationClose;
}
