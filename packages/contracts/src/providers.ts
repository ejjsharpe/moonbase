import type * as Contracts from './providers-schema.ts';

export type ProviderState = typeof Contracts.ProviderStateSchema.Type;
export type ProviderCommand = keyof typeof Contracts.providerInputSchemas;
export type ProviderInput<K extends ProviderCommand> =
  (typeof Contracts.providerInputSchemas)[K]['Type'];
export type ProviderOutput<_K extends ProviderCommand> = ProviderState;
