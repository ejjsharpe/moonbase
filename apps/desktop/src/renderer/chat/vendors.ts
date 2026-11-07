import type { ProviderState } from '@moonbase/contracts/providers';

export type Provider = ProviderState['providers'][number];

/** The company behind a provider, so its subscription and API key sit together. */
export function vendorOf(provider: Pick<Provider, 'id' | 'name'>) {
  if (provider.id.startsWith('openai')) return 'OpenAI';
  if (provider.id === 'anthropic' || provider.id.startsWith('claude')) return 'Anthropic';
  if (provider.id === 'google') return 'Google';
  if (provider.id === 'openrouter') return 'OpenRouter';
  return provider.name;
}

/** A provider's short name: its vendor, unless another listed provider shares that vendor. */
export function providerLabel(provider: Provider, listed: readonly Provider[]) {
  const vendor = vendorOf(provider);
  const shared = listed.some((other) => other.id !== provider.id && vendorOf(other) === vendor);
  return shared ? provider.name : vendor;
}
