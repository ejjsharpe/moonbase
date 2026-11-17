import type { ChatModelPreference, ChatReasoningEffort } from '@moonbase/contracts/chat';
import type { ProviderSetupSnapshot } from '@moonbase/application/chat';

export const effortLabels: Record<ChatReasoningEffort, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/**
 * A new chat's model choice: the set-up providers' models, the one preferred (the saved
 * preference, else a provider's default) and its effort, and the `selection` a Send uses, which is
 * missing while the preferred model or effort is unavailable.
 */
export function readModelChoice(
  providers: ProviderSetupSnapshot | null,
  saved: ChatModelPreference | null,
) {
  const models =
    providers?.status?.providers
      .filter((provider) => provider.configured)
      .flatMap((provider) =>
        provider.models.map((model) => ({
          value: JSON.stringify({ provider: provider.id, modelId: model.modelId }),
          label: `${model.name} · ${provider.name}`,
          model: { provider: provider.id, modelId: model.modelId },
          reasoningEfforts: model.reasoningEfforts,
          defaultReasoningEffort: model.defaultReasoningEffort,
        })),
      ) ?? [];
  const preference =
    saved ??
    providers?.status?.providers.find((provider) => provider.configured && provider.defaultModel)
      ?.defaultModel;
  const entry =
    preference &&
    models.find(
      (model) =>
        model.model.provider === preference.model.provider &&
        model.model.modelId === preference.model.modelId,
    );
  const effort = preference?.reasoningEffort ?? entry?.defaultReasoningEffort;
  const effortUnavailable =
    !!effort && !!entry?.reasoningEfforts && !entry.reasoningEfforts.includes(effort);
  const selection: ChatModelPreference | undefined =
    entry && !effortUnavailable
      ? { model: entry.model, ...(effort ? { reasoningEffort: effort } : {}) }
      : undefined;
  return {
    models,
    preference,
    entry: entry || undefined,
    effort,
    effortUnavailable,
    selection,
  };
}
export type ModelChoice = ReturnType<typeof readModelChoice>;
