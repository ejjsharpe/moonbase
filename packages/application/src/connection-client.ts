import type { ApplicationError, CommandOptions } from "./client.ts";
import type { ChatHostHealth, ChatHostTarget } from "./host-client.ts";

/** The configured SSH destination is public; credentials and forwarded origins are not. */
export type ConnectionProfile = { id: string; label: string; destination: string; remotePort: number; expected: ChatHostTarget };
export type ConnectionSnapshot = { profile: ConnectionProfile; message?: string } & (
  | { state: "disconnected"; connectionId: null }
  | { state: "connecting"; connectionId: string }
  | { state: "disconnecting"; connectionId: string }
  | { state: "connected"; connectionId: string; health: ChatHostHealth }
  | { state: "failed"; connectionId: string | null }
);
export type ConnectionCommands = {
  getConnection: { input: Record<string, never>; output: ConnectionSnapshot };
  connect: { input: { profileId: string }; output: ConnectionSnapshot };
  disconnect: { input: { connectionId: string }; output: void };
};
export type ConnectionCommand = keyof ConnectionCommands;
export type ConnectionInput<K extends ConnectionCommand> = ConnectionCommands[K]["input"];
export type ConnectionOutput<K extends ConnectionCommand> = ConnectionCommands[K]["output"];
export interface ConnectionClient {
  command<K extends ConnectionCommand>(operation: K, input: ConnectionInput<K>, options?: CommandOptions): Promise<ConnectionOutput<K>>;
  watch(receive: (snapshot: ConnectionSnapshot) => void, onError: (error: ApplicationError) => void): () => void;
}
