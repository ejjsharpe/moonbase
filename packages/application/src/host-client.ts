import type { ChatHostTargetSchema, ChatHostHealthSchema } from './host-schema.ts';

/** Browser-safe identities; credentials and forwarded endpoints remain privileged. */
export const chatProtocolVersion = 1;
export const chatHostVersion = '0.1.0';
export type ChatHostTarget = typeof ChatHostTargetSchema.Type;
export type ChatHostHealth = typeof ChatHostHealthSchema.Type;
