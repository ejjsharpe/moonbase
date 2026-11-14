// Controlled host behaviour: each reply calls a controlled tool that reports progress and is held
// until released or stopped. It replaces the coding tools, so nothing touches the real filesystem.
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { fauxModelOptions, installFaux } from './faux-model.ts';

export function createBehaviour(config) {
  const faux = fauxProvider({
    ...fauxModelOptions,
    tokensPerSecond: 100,
    tokenSize: { min: 4, max: 4 },
  });
  let tools = 0,
    release;
  const gate = config.hold ? new Promise((r) => (release = r)) : Promise.resolve();
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'chat-controlled',
      tools: [
        defineTool({
          name: 'inspect_remote_context',
          description: 'Controlled chat test tool; does not inspect the real filesystem',
          parameters: Type.Object({}),
          execute: async (_input, api, ctx) => {
            tools++;
            const advance = (message) => {
              if (message?.type === 'next-chunk') api.output('\nControlled remote next tool chunk');
            };
            process.on('message', advance);
            try {
              api.output(
                'Controlled remote tool activity\nFixed folder observed by the test tool.\n' +
                  'preview '.repeat(800),
              );
              await Promise.race([
                gate,
                new Promise((r) => {
                  if (ctx.abortSignal?.aborted) return r();
                  ctx.abortSignal?.addEventListener('abort', () => r(), {
                    once: true,
                  });
                }),
              ]);
            } finally {
              process.off('message', advance);
            }
            return {
              output: [{ type: 'text', text: 'Controlled inspection completed' }],
            };
          },
        }),
      ],
    }),
  );
  const responses = Array.from({ length: 30 }, () => [
    fauxAssistantMessage(
      [
        fauxText('Inspecting the configured remote context.'),
        fauxToolCall('inspect_remote_context', {}),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Remote response finished. The saved conversation remains on the host.'),
  ]).flat();
  faux.setResponses(responses);
  return {
    installProviders: (models) => installFaux(models, faux),
    registry,
    stats: () => ({ calls: faux.state.callCount, tools }),
    release: () => release?.(),
  };
}
