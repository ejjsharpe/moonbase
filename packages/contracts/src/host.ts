import type { ChatHostTargetSchema, ChatHostHealthSchema } from './host-schema.ts';

/** Browser-safe identities; credentials and forwarded endpoints remain privileged. */
export const chatProtocolVersion = 2;
export const chatHostVersion = '0.1.0';
/** A host token: 16 to 4096 printable ASCII characters. */
export const hostTokenPattern = /^[\x21-\x7e]{16,4096}$/;
/**
 * Features a host advertises in its signed health. `chat` is every host's chat protocol; the
 * others are a daemon's: local-mode chat and its control, provider setup and folders, for a
 * host-mode daemon the approved roots a remote client chooses folders from, the authenticated
 * WebSocket (`socketPath`) and, for a daemon that composes the workspace file host, its operations
 * and subscription over that socket.
 */
export const chatHostCapabilities = {
  chat: 'chat-v0',
  local: 'daemon-local-v1',
  providers: 'providers-v1',
  folders: 'folders-v1',
  roots: 'roots-v1',
  socket: 'socket-v1',
  workspace: 'workspace-v1',
} as const;
export type ChatHostCapability = (typeof chatHostCapabilities)[keyof typeof chatHostCapabilities];
export type ChatHostTarget = typeof ChatHostTargetSchema.Type;
export type ChatHostHealth = typeof ChatHostHealthSchema.Type;
export type HostHealthReply = ChatHostHealth & { nonce: string; proof: string };
