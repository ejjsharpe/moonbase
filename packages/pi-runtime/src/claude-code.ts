import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '@earendil-works/pi-ai/models';
// The package ships TypeScript source without an exports map; bundle hosts compile it.
import { createClaudeCodeProvider } from '@earendil-works/pi-claude-code/src/provider.ts';
import { closeClaudeProcesses } from '@earendil-works/pi-claude-code/src/claude-cli.ts';

export type ClaudeCodeConfiguration = {
  /**
   * Locates the Claude Code executable when `PI_CLAUDE_CODE_COMMAND` is unset in the process or auth
   * environment; defaults to its
   * usual install locations. When it returns undefined the library searches PATH.
   */
  findCommand?(): Promise<string | undefined>;
  /**
   * Added to the environment of Claude Code and the tool-inventory helper it starts with this
   * process's executable, e.g. `ELECTRON_RUN_AS_NODE` so an Electron host runs it as Node.
   */
  helperEnv?: Record<string, string>;
};

/** GUI apps and non-login SSH commands often get a PATH without Claude Code's install location. */
async function findInstalledClaudeCode() {
  for (const candidate of [
    join(homedir(), '.local/bin/claude'),
    join(homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ])
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  return undefined;
}

/** Claude Code keeps warm workers for up to five minutes; hosts close them when they shut down. */
export const closeClaudeCodeProcesses = (): Promise<void> => closeClaudeProcesses();

/**
 * A Claude Pro/Max subscription through the user's own Claude Code login. Claude Code owns
 * sign-in and credentials; Moonbase stores nothing and Pi still executes every tool.
 */
export function createClaudeCodeSubscription(config: ClaudeCodeConfiguration = {}): Provider {
  const provider = createClaudeCodeProvider() as Provider;
  const apiKey = provider.auth.apiKey!;
  type AuthInput = Parameters<typeof apiKey.resolve>[0];
  const findCommand = config.findCommand ?? findInstalledClaudeCode;
  const withCommand = async <T extends AuthInput>(input: T): Promise<T> => {
    // An explicit command wins; the library reads it from the process environment too.
    if (process.env.PI_CLAUDE_CODE_COMMAND || (await input.ctx.env('PI_CLAUDE_CODE_COMMAND')))
      return input;
    const command = await findCommand();
    if (!command) return input;
    return {
      ...input,
      ctx: {
        ...input.ctx,
        env: async (name: string) =>
          name === 'PI_CLAUDE_CODE_COMMAND' ? command : input.ctx.env(name),
      },
    };
  };
  const helperEnv = config.helperEnv ?? {};
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...apiKey,
        check: apiKey.check && (async (input) => apiKey.check!(await withCommand(input))),
        resolve: async (input) => apiKey.resolve(await withCommand(input)),
      },
    },
    stream: (model, context, options) =>
      provider.stream(model, context, {
        ...options,
        env: { ...options?.env, ...helperEnv },
      } as typeof options),
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, { ...options, env: { ...options?.env, ...helperEnv } }),
  };
}
