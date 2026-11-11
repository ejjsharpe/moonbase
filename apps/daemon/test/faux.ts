import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { createMemoryKeySource } from '@moonbase/pi-runtime/credentials';
import { localProviderIds } from '@moonbase/pi-runtime/providers';
import type { DaemonProviders } from '../src/daemon.ts';

export const fauxProviderId = 'moonbase-faux';
export const fauxModelId = 'faux-model';

/**
 * A step a faux model call takes: reply with `reply` (after `thinking`, if given), call `tool`
 * with `args`, or `hold` until the run is interrupted. The test writes the steps to `faux.json`
 * in the data directory, and may change them while the daemon runs; calls past them reply
 * "Faux reply". Every model of every provider takes the same steps in turn.
 */
export type FauxStep =
  | { reply: string; thinking?: string }
  | { tool: string; args: Record<string, unknown> }
  | { hold: true };
export type FauxScript = {
  steps?: FauxStep[];
  idleMs?: number;
  pollMs?: number;
  /** The sign-in URL the faux ChatGPT login offers; a valid one by default. */
  signInUrl?: string;
};
/** The pasted code the faux ChatGPT login accepts. */
export const fauxSignInCode = 'faux-redirect-code';

export function readFauxScript(directory: string): FauxScript {
  try {
    return JSON.parse(readFileSync(join(directory, 'faux.json'), 'utf8')) as FauxScript;
  } catch {
    return {};
  }
}

/**
 * Faux providers and an in-memory credential key, for a daemon that never reaches a real provider
 * or the Keychain. Each model call is recorded in `faux-calls.jsonl` in the data directory.
 */
export function createFauxProviders(directory: string): DaemonProviders {
  const faux = fauxProvider({
    provider: fauxProviderId,
    models: [{ id: fauxModelId }],
    tokensPerSecond: 100000,
  });
  let calls = 0;
  const step = async (options: { signal?: AbortSignal } | undefined) => {
    const steps = readFauxScript(directory).steps ?? [];
    const current = steps[calls++];
    appendFileSync(
      join(directory, 'faux-calls.jsonl'),
      JSON.stringify({ pid: process.pid }) + '\n',
    );
    if (current && 'hold' in current) {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
      throw Error('Faux model interrupted');
    }
    if (current && 'tool' in current)
      return fauxAssistantMessage(
        fauxToolCall(current.tool, current.args as Parameters<typeof fauxToolCall>[1]),
        {
          stopReason: 'toolUse',
        },
      );
    const reply = current?.reply ?? 'Faux reply';
    return fauxAssistantMessage(
      current?.thinking ? [fauxThinking(current.thinking), fauxText(reply)] : reply,
    );
  };
  const script = (provider: ReturnType<typeof fauxProvider>) =>
    provider.setResponses(Array.from({ length: 256 }, () => (_context, options) => step(options)));
  script(faux);
  return {
    keySource: createMemoryKeySource(),
    installProviders: (models) => {
      models.setProvider(faux.provider);
      // Every provider setup offers is faux too: sign-ins prompt and store a credential, and none
      // reaches a provider, the callback port or the Claude Code CLI.
      for (const id of localProviderIds) {
        const scripted = fauxProvider({
          provider: id,
          models: [{ id: `${id}-faux`, name: `Faux ${id}`, reasoning: true }],
          tokensPerSecond: 100000,
        });
        script(scripted);
        const provider = scripted.provider;
        const auth = (): typeof provider.auth => {
          if (id === 'claude-code') return {};
          if (id !== 'openai')
            return {
              apiKey: {
                name: 'Faux API key',
                login: async (interaction) => ({
                  type: 'api_key',
                  key: await interaction.prompt({
                    type: 'secret',
                    message: 'Enter API key',
                  }),
                }),
                resolve: async ({ credential }) =>
                  credential?.key ? { auth: { apiKey: credential.key } } : undefined,
              },
            };
          return {
            oauth: {
              name: 'Faux ChatGPT',
              login: async (interaction) => {
                interaction.notify({
                  type: 'auth_url',
                  url:
                    readFauxScript(directory).signInUrl ??
                    'https://auth.openai.com/api/accounts/authorize?state=faux',
                });
                const code = await interaction.prompt({
                  type: 'manual_code',
                  message: 'Paste the final redirect URL here:',
                });
                if (code !== fauxSignInCode) throw Error('Faux sign-in refused the code');
                return {
                  type: 'oauth',
                  access: 'faux-access',
                  refresh: 'faux-refresh',
                  expires: Date.now() + 3_600_000,
                };
              },
              refresh: async () => {
                throw Error('Faux sign-in never refreshes');
              },
              toAuth: async (value) => ({ apiKey: value.access }),
            },
          };
        };
        models.setProvider({
          ...provider,
          name: id,
          auth: auth(),
        });
      }
      return undefined;
    },
  };
}
