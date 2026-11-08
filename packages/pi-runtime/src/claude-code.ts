import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import type { Provider } from '@earendil-works/pi-ai/models';
// The package ships TypeScript source without an exports map; bundle hosts compile it.
import { createClaudeCodeProvider } from '@earendil-works/pi-claude-code/src/provider.ts';
import {
  closeClaudeProcesses,
  getClaudeStatus,
  POWERSHELL_ENV,
} from '@earendil-works/pi-claude-code/src/claude-cli.ts';

export type ClaudeCodeConfiguration = {
  /**
   * Locates the Claude Code executable when `PI_CLAUDE_CODE_COMMAND` is unset in the process or auth
   * environment; defaults to searching PATH, then its usual install locations.
   */
  findCommand?(): Promise<string | undefined>;
  /**
   * Added to the environment of Claude Code and the tool-inventory helper it starts with this
   * process's executable, e.g. `ELECTRON_RUN_AS_NODE` so an Electron host runs it as Node.
   */
  helperEnv?: Record<string, string>;
};

export type ClaudeCodeSubscription = Provider & {
  /**
   * Why the sign-in check made with `signal` couldn't tell whether Claude Code is signed in, such as
   * a CLI that failed to start; undefined after a definite answer. Pass a fresh signal per check.
   */
  getCheckProblem(signal: AbortSignal): string | undefined;
};

/**
 * GUI apps and non-login SSH commands often get a PATH without these. Without an absolute home
 * they'd resolve against the cwd, which on a host is a chat folder, so they're left out.
 */
function listInstallDirectories() {
  const home = homedir();
  return [
    ...(isAbsolute(home) ? [join(home, '.local/bin'), join(home, '.claude/local')] : []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}
const pathDirectories = () => (process.env.PATH ?? '').split(delimiter).filter(isAbsolute);

/** The caller's PATH wins, so a stale copy in an install location can't shadow the user's own. */
async function findInstalledClaudeCode() {
  for (const directory of new Set([...pathDirectories(), ...listInstallDirectories()])) {
    const candidate = join(directory, 'claude');
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

/**
 * PATH for Claude Code's own processes. An npm install is a `#!/usr/bin/env node` script, which a
 * GUI app's PATH can't run, so the executable's directory (where npm puts its `node`) comes first.
 */
function findClaudeCodePath(command: string | undefined) {
  return [
    ...new Set([
      ...(command && isAbsolute(command) ? [dirname(command)] : []),
      ...pathDirectories(),
      ...listInstallDirectories(),
    ]),
  ].join(delimiter);
}

/** Claude Code keeps warm workers for up to five minutes; hosts close them when they shut down. */
export const closeClaudeCodeProcesses = (): Promise<void> => closeClaudeProcesses();

/** Settings the library reads through the auth context. */
const providerEnvNames = [
  'PI_CLAUDE_CODE_COMMAND',
  'PI_CLAUDE_CODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  POWERSHELL_ENV,
] as const;

/**
 * A Claude Pro/Max subscription through the user's own Claude Code login. Claude Code owns
 * sign-in and credentials; Moonbase stores nothing and Pi still executes every tool.
 */
export function createClaudeCodeSubscription(
  config: ClaudeCodeConfiguration = {},
): ClaudeCodeSubscription {
  const provider = createClaudeCodeProvider() as Provider;
  const apiKey = provider.auth.apiKey!;
  type AuthInput = Parameters<typeof apiKey.resolve>[0];
  const findCommand = config.findCommand ?? findInstalledClaudeCode;
  // An explicit command wins; the library reads it from the process environment too.
  const resolveCommand = async (input: AuthInput) =>
    process.env.PI_CLAUDE_CODE_COMMAND ||
    (await input.ctx.env('PI_CLAUDE_CODE_COMMAND')) ||
    (await findCommand());
  // Keyed by each check's own signal, so concurrent checks can't swap answers.
  const checkProblems = new WeakMap<AbortSignal, string>();
  const helperEnv = config.helperEnv ?? {};
  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        ...apiKey,
        // The library's own check runs `claude auth status` with this process's PATH, which can't
        // start an npm install from a GUI app, so check with the same environment requests get.
        check: async (input) => {
          const command = await resolveCommand(input);
          const env: Record<string, string | undefined> = { ...process.env };
          for (const name of providerEnvNames) {
            const value = await input.ctx.env(name);
            if (value !== undefined) env[name] = value;
          }
          if (command) env.PI_CLAUDE_CODE_COMMAND = command;
          env.PATH = findClaudeCodePath(command);
          const status = await getClaudeStatus(env, input.signal);
          if (status.diagnostic && status.detail) checkProblems.set(input.signal, status.detail);
          if (!status.available || !status.loggedIn) return undefined;
          return status.subscription
            ? { type: 'oauth', source: `Claude Code ${status.plan ?? 'subscription'}` }
            : { type: 'api_key', source: 'Claude Code CLI' };
        },
        resolve: async (input) => {
          const command = await resolveCommand(input);
          const resolved = await apiKey.resolve(
            command
              ? {
                  ...input,
                  ctx: {
                    ...input.ctx,
                    env: async (name: string) =>
                      name === 'PI_CLAUDE_CODE_COMMAND' ? command : input.ctx.env(name),
                  },
                }
              : input,
          );
          // Pi passes this environment to the request, which spawns Claude Code with it.
          return (
            resolved && { ...resolved, env: { ...resolved.env, PATH: findClaudeCodePath(command) } }
          );
        },
      },
    },
    stream: (model, context, options) =>
      provider.stream(model, context, {
        ...options,
        env: { ...options?.env, ...helperEnv },
      } as typeof options),
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, { ...options, env: { ...options?.env, ...helperEnv } }),
    getCheckProblem: (signal) => checkProblems.get(signal),
  };
}
