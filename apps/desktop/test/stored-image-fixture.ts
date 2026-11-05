import { readFileSync } from 'node:fs';
import { ManagedRuntime } from 'effect';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { PiRuntimeLive, LocalPiRuntimeLive } from '@moonbase/pi-runtime';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import type { ChatSession } from '@moonbase/contracts/chat';

export const retainedImage = readFileSync(
  new URL('./fixtures/images/retained.png', import.meta.url),
);
export function createImageRuntime(
  config: ChatSession & { cwd: string; databasePath: string },
  local = false,
) {
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 100000 });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('retained_images', {}), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Retained images completed'),
  ]);
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'retained-images',
      tools: [
        defineTool({
          name: 'retained_images',
          description: 'Controlled retained bytes; no file or network authority',
          parameters: Type.Object({}),
          execute: async () => ({
            output: [
              { type: 'image', data: retainedImage.toString('base64'), mimeType: 'image/png' },
              {
                type: 'image',
                data: retainedImage.subarray(0, -1).toString('base64'),
                mimeType: 'image/png',
              },
              {
                type: 'image',
                data: Buffer.from('<html><script>alert(1)</script></html>').toString('base64'),
                mimeType: 'image/png',
              },
            ],
          }),
        }),
      ],
    }),
  );
  const model = { provider: faux.provider.id, modelId: faux.getModel().id };
  const runtime = ManagedRuntime.make(
    local
      ? LocalPiRuntimeLive({
          host: config.host,
          actorId: config.actorId,
          databasePath: config.databasePath,
          models,
          registry,
        })
      : PiRuntimeLive({ ...config, models, registry, model }),
  );
  return { runtime, model, client: makeChatClient(runtime) };
}
