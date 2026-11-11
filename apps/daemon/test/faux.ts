import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createMemoryKeySource } from '@moonbase/pi-runtime/credentials';
import type { LocalProviders } from '../src/daemon.ts';

export const fauxProviderId = 'moonbase-faux';
export const fauxModelId = 'faux-model';

/**
 * A step a faux model call takes: reply with `reply`, or `hold` until the run is interrupted. The
 * test writes the steps to `faux.json` in the data directory; calls past them reply "Faux reply".
 */
export type FauxStep = { reply: string } | { hold: true };
export type FauxScript = { steps?: FauxStep[]; idleMs?: number; pollMs?: number };

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
export function createFauxProviders(directory: string): LocalProviders {
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
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      throw Error('Faux model interrupted');
    }
    return fauxAssistantMessage(current?.reply ?? 'Faux reply');
  };
  faux.setResponses(Array.from({ length: 256 }, () => (_context, options) => step(options)));
  return {
    keySource: createMemoryKeySource(),
    installProviders: (models) => {
      models.setProvider(faux.provider);
      return undefined;
    },
  };
}
