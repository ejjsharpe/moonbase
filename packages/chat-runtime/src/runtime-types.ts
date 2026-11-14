import type { Registry } from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai/models';
import type { Effect, Fiber } from 'effect';
import type { ApplicationError } from '@moonbase/contracts/workspace';
import type { ChatCreationSettings, ChatSession } from '@moonbase/contracts/chat';

export type LocalPiRuntimeConfiguration = ChatSession & {
  databasePath: string;
  models: Models;
  registry?: Registry;
  approveCreation?: (settings: ChatCreationSettings) => Promise<void>;
  /** Where each chat without a project gets a new folder of its own; absent refuses such chats. */
  chatFolders?: string;
  /** Refuses a working folder a new chat may not search before it exists; absent allows any. */
  approveFolder?: (cwd: string) => Promise<void>;
  /** Absolute ripgrep for chat file search; otherwise `rg` on PATH, then Git. */
  ripgrepExecutable?: string;
};
export type RetainedWork = {
  run<A>(
    effect: Effect.Effect<A, ApplicationError>,
  ): Effect.Effect<Fiber.Fiber<A, ApplicationError>>;
};
