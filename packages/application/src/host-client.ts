/** Browser-safe identities; credentials and forwarded endpoints remain privileged. */
export const chatProtocolVersion = 1;
export const chatHostVersion = "0.1.0";
export type ChatHostTarget = { hostId: string; storeId: string };
export type ChatHostHealth = ChatHostTarget & {
  protocol: typeof chatProtocolVersion;
  version: typeof chatHostVersion;
  capabilities: string[];
};
