import type { ChatHostTargetSchema } from './chat-schema.ts';

/** Browser-safe identities; credentials and forwarded endpoints remain privileged. */
export const chatProtocolVersion = 1;
export const chatHostVersion = '0.1.0';
export type ChatHostTarget = typeof ChatHostTargetSchema.Type;
export type ChatHostHealth = ChatHostTarget & {
  protocol: typeof chatProtocolVersion;
  version: typeof chatHostVersion;
  capabilities: string[];
};
