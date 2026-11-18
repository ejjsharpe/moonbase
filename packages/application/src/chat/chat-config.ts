import { Context, Layer } from 'effect';
import type { ChatSession } from '@moonbase/contracts/chat';
import type {
  ChatDependencies,
  ChatPort,
  ConnectionPort,
  DraftStorage,
  ProviderSetupPort,
} from './chat-ports.ts';
import { defaultTranscriptLimits, type TranscriptLimits } from './transcript/transcript-state.ts';
import { TranscriptViewMemory } from './transcript/transcript-view-memory.ts';

export type ChatConfigShape = {
  readonly chat: ChatPort;
  readonly connection: ConnectionPort | undefined;
  readonly providers: ProviderSetupPort | undefined;
  /** The configured host, store and actor every chat of this target belongs to. */
  readonly session: ChatSession;
  readonly storage: DraftStorage;
  readonly newId: () => string;
  readonly backendId: string;
  readonly memory: TranscriptViewMemory;
  readonly limits: TranscriptLimits;
};

/** What one chat target's chat was built from, with its defaults filled in. */
export class ChatConfig extends Context.Service<ChatConfig, ChatConfigShape>()(
  'moonbase/chat/ChatConfig',
) {
  static readonly layer = (dependencies: ChatDependencies) =>
    Layer.succeed(ChatConfig, {
      chat: dependencies.chat,
      connection: dependencies.connection,
      providers: dependencies.providers,
      session: structuredClone(dependencies.context),
      storage: dependencies.storage,
      newId: dependencies.newId ?? (() => crypto.randomUUID()),
      backendId: dependencies.backendId ?? 'chat',
      memory: dependencies.transcriptMemory ?? new TranscriptViewMemory(),
      limits: { ...defaultTranscriptLimits, ...dependencies.transcriptLimits },
    });
}
