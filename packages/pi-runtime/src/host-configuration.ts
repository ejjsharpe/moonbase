import { createModels, type Models } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { createRegistry, type ModelRef, type Registry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';

import { createClaudeCodeSubscription } from './claude-code.ts';
import * as V from './validation.ts';
import * as S from './private-schema.ts';

/**
 * A daemon's optional `daemon.json`: a local-mode daemon (the default) with the source of its
 * credential key, or a host-mode daemon with one fixed working folder, model and port.
 */
export type DaemonSettings = S.DaemonSettings;
/** Decodes `daemon.json` strictly; unknown fields are refused, and errors name no input. */
export const decodeDaemonSettings = (value: unknown): DaemonSettings => S.daemonSettings(value);

/**
 * Prepares a fixed-settings host for a process root: changes to its working folder, installs the
 * host-side providers and coding tools, and refuses a model without host-side credentials.
 */
export async function prepareFixedSettingsHost({
  cwd,
  model,
}: {
  cwd: string;
  model: ModelRef;
}): Promise<{ models: Models; registry: Registry }> {
  // Every chat here shares this cwd, and Claude Code runs (and tells the model it runs) in this
  // process's own working directory, which the library has no option to change.
  try {
    process.chdir(cwd);
  } catch {
    V.fail('InvalidInput', 'Chat working directory must exist.');
  }
  const models = createModels();
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  models.setProvider(createClaudeCodeSubscription());
  const configured = models.getModel(model.provider, model.modelId);
  // Claude Code resolves without a stored key, so its check is what proves a host-side login.
  if (
    !configured ||
    !(await models.getAuth(configured)) ||
    !(await models.checkAuth(model.provider))
  )
    V.fail(
      'Unavailable',
      'Configure an installed model and existing host-side provider credentials.',
    );
  const registry = createRegistry();
  registry.install(CodingTools);
  return { models, registry };
}
