import type { ModelRef, Registry } from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai/models';
import type { Effect, Fiber } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/workspace';
import type { ChatCreationSettings, ChatSession } from '@moonbase/contracts/chat';

export type PiRuntimeConfiguration = ChatSession & {
  databasePath: string;
  cwd: string;
  model: ModelRef;
  models: Models;
  registry?: Registry;
};
export type LocalPiRuntimeConfiguration = ChatSession & {
  databasePath: string;
  models: Models;
  registry?: Registry;
  approveCreation?: (settings: ChatCreationSettings) => Promise<void>;
};
export type RuntimeConfiguration =
  | PiRuntimeConfiguration
  | (LocalPiRuntimeConfiguration & { mode: 'local' });
export type RetainedWork = {
  run<A>(
    effect: Effect.Effect<A, ApplicationError>,
  ): Effect.Effect<Fiber.Fiber<A, ApplicationError>>;
};
