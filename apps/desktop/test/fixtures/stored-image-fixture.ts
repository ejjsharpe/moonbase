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
import { LocalPiRuntimeLive } from '@moonbase/chat-runtime';
import { fauxModel, fauxModelOptions, installFaux } from '../../../../tests/chat/faux-model.ts';
import { makeChatClient } from '@moonbase/application/runtime/clients';
import type { ChatSession } from '@moonbase/contracts/chat';

export const retainedImage = readFileSync(new URL('./images/retained.png', import.meta.url));
/**
 * A faux model that calls `retained_images` once, then replies, with the controlled tool that
 * returns retained bytes: a real PNG, a truncated one and HTML labelled as a PNG.
 */
export function createImageProviders() {
  const faux = fauxProvider({ ...fauxModelOptions, tokensPerSecond: 100000 });
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
  return { faux, registry, model: fauxModel };
}

/** A local runtime in this process with the image providers. */
export function createImageRuntime(config: ChatSession & { databasePath: string }) {
  const models = createModels(),
    { faux, registry, model } = createImageProviders();
  installFaux(models, faux);
  const runtime = ManagedRuntime.make(
    LocalPiRuntimeLive({
      host: config.host,
      actorId: config.actorId,
      databasePath: config.databasePath,
      models,
      registry,
    }),
  );
  return { runtime, model, client: makeChatClient(runtime) };
}
