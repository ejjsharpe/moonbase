import { defineExtension, section } from '@earendil-works/pi-durable';

/**
 * Claude Code runs in this process's working directory and tells the model so, but its library
 * offers no way to give it a chat's own; until it does, state the chat's to the model.
 */
export const ClaudeCodeWorkingDirectory = defineExtension({
  name: 'moonbase-claude-code-cwd',
  sections: [
    section('working-directory', ({ agent }) =>
      agent.model?.provider === 'claude-code' && agent.cwd
        ? `The working directory is ${agent.cwd}, and tools resolve relative paths against it. Use it instead of any other working directory you are told.`
        : undefined,
    ),
  ],
});
