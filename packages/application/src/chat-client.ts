import type { ApplicationError, CommandOptions } from "./client.ts";
import type { ChatHostTarget } from "./host-client.ts";

export const maximumChatInputBytes = 32 * 1024;
export const maximumChatReplyBytes = 256 * 1024;
export const chatPageSize = 32;
export const chatPreviewBytes = 4096;
export type ChatSession = { host: ChatHostTarget; actorId: string };
export type ChatTarget = ChatSession & { conversationId: string };
export type ChatHostConfiguration = ChatSession & { cwd: string; model: string };
export type ChatSummary = { target: ChatTarget; title: string; createdAt: string; cwd: string; model: string };
export type ChatEntry = {
  id: string; role: "user" | "assistant" | "tool" | "system";
  text: string; truncated: boolean; toolName?: string; isError?: boolean;
};
/** Newest first, with an opaque cursor for the next older page. */
export type ChatHistoryPage = { entries: ChatEntry[]; olderCursor: string | null };
export type ChatStopTarget = { target: ChatTarget; submissionId: string; taskId: string | null };
export type ChatToolActivity = { taskId: string; name: string; state: "running" | "completed" | "failed"; text: string; truncated: boolean };
export type ChatRun = {
  stop: ChatStopTarget; state: "running" | "stopping" | "deferred";
  text: string; truncated: boolean; tools: ChatToolActivity[];
};
/** A bounded replacement snapshot, never an unbounded append-only event feed. */
export type ChatSnapshot = ChatHistoryPage & {
  conversation: ChatSummary; run: ChatRun | null;
  state: "idle" | "running" | "stopped" | "failed" | "uncertain"; message?: string;
};
export type ChatSendReceipt = { target: ChatTarget; requestId: string } & (
  | { admission: "reserved"; submissionId: null }
  | { admission: "admitted"; submissionId: string }
);
export type ChatCommands = {
  getChatHost: {
    input: {
      host: ChatHostTarget;
    };
    output: ChatHostConfiguration;
  };
  listChats: {
    input: {
      session: ChatSession;
      cursor?: string;
    };
    output: {
      conversations: ChatSummary[];
      nextCursor: string | null;
    };
  };
  createChat: {
    input: {
      session: ChatSession;
      requestId: string;
      title: string;
    };
    output: {
      requestId: string;
      conversation: ChatSummary;
    };
  };
  getChat: {
    input: {
      target: ChatTarget;
    };
    output: ChatSnapshot;
  };
  getChatHistory: {
    input: {
      target: ChatTarget;
      cursor: string;
    };
    output: ChatHistoryPage;
  };
  sendChat: {
    input: {
      target: ChatTarget;
      requestId: string;
      text: string;
    };
    output: ChatSendReceipt;
  };
  getChatSend: {
    input: {
      target: ChatTarget;
      requestId: string;
    };
    output: ChatSendReceipt | null;
  };
  stopChat: {
    input: {
      stop: ChatStopTarget;
      requestId: string;
    };
    output: {
      stop: ChatStopTarget;
      requestId: string;
      outcome: "stopped" | "terminal" | "superseded" | "pending";
    };
  };
};
export type ChatCommand = keyof ChatCommands;
export type ChatInput<K extends ChatCommand> = ChatCommands[K]["input"];
export type ChatOutput<K extends ChatCommand> = ChatCommands[K]["output"];
export interface ChatClient {
  command<K extends ChatCommand>(operation: K, input: ChatInput<K>, options?: CommandOptions): Promise<ChatOutput<K>>;
  watch(input: { target: ChatTarget }, receive: (snapshot: ChatSnapshot) => void, onError: (error: ApplicationError) => void): () => void;
}
