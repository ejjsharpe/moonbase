import type { Registry } from '@earendil-works/pi-durable';
import type { Models } from '@earendil-works/pi-ai/models';
import type { Effect, Fiber } from 'effect';
import type { ChatError } from '@moonbase/contracts/chat-errors';
import type { ChatCreationSettings, ChatSession } from '@moonbase/contracts/chat';
import type { ChatFileListingTiming } from './files.ts';

export type LocalPiRuntimeConfiguration = ChatSession & {
  databasePath: string;
  models: Models;
  registry?: Registry;
  /** Refuses a new chat's settings the host does not allow; absent allows any. */
  approveCreation?: (settings: ChatCreationSettings) => Effect.Effect<void, unknown>;
  /** Where each chat without a project gets a new folder of its own; absent refuses such chats. */
  chatFolders?: string;
  /** Refuses a working folder a new chat may not search before it exists; absent allows any. */
  approveFolder?: (cwd: string) => Effect.Effect<void, unknown>;
  /** Absolute ripgrep for chat file search; otherwise `rg` on PATH, then Git. */
  ripgrepExecutable?: string;
  /** Replaces the file listing time budget and shortens its stop grace; tests only. */
  fileListingTiming?: Partial<ChatFileListingTiming>;
};
export type RetainedWork = {
  run<A>(effect: Effect.Effect<A, ChatError>): Effect.Effect<Fiber.Fiber<A, ChatError>>;
};
