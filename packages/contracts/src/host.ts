import type { ChatHostTargetSchema, ChatHostHealthSchema } from './host-schema.ts';

/** Browser-safe identities; credentials and forwarded endpoints remain privileged. */
export const chatProtocolVersion = 2;
export const chatHostVersion = '0.1.0';
/**
 * Features a host advertises in its signed health. `chat` is every host's chat protocol; the
 * others are a local-mode daemon's: local-mode chat and its control, provider setup and folders.
 */
export const chatHostCapabilities = {
  chat: 'chat-v0',
  local: 'daemon-local-v1',
  providers: 'providers-v1',
  folders: 'folders-v1',
} as const;
export type ChatHostCapability = (typeof chatHostCapabilities)[keyof typeof chatHostCapabilities];
export type ChatHostTarget = typeof ChatHostTargetSchema.Type;
export type ChatHostHealth = typeof ChatHostHealthSchema.Type;
export type HostHealthReply = ChatHostHealth & { nonce: string; proof: string };
