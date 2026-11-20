import type { ChatCommand, ChatInput, ChatOutput } from '@moonbase/contracts/chat';

// One request and a reply that answers it for every chat command.
export const host = { hostId: 'host', storeId: 'store' };
export const session = { host, actorId: 'owner' };
export const target = { ...session, conversationId: 'chat' };
export const stop = { target, submissionId: 'submission', taskId: null };
export const conversation = {
  target,
  title: 'Saved chat',
  createdAt: '2026-11-01T00:00:00Z',
  cwd: '/remote/project',
  model: 'configured-model',
};
export const entryTranscript = (entryId: string) => ({
  source: { kind: 'entry' as const, target, entryId },
  parts: [],
  nextCursor: null,
  thinking: 'none' as const,
});
export const snapshot = {
  entries: [
    {
      id: 'entry',
      role: 'user' as const,
      text: '',
      truncated: false,
      transcript: entryTranscript('entry'),
    },
  ],
  olderCursor: null,
  conversation,
  run: null,
  state: 'idle' as const,
  transcriptBoundary: 'entry',
};
export const inputs = {
  getChatHost: { host },
  listChats: { session },
  createChat: {
    session,
    requestId: 'create',
    title: '  Saved chat  ',
    settings: { model: { provider: 'faux', modelId: 'model' } },
  },
  getChat: { target },
  getChatHistory: { target, cursor: 'opaque cursor' },
  getChatTranscriptContent: { source: { kind: 'entry', target, entryId: 'entry' } },
  findChatTranscript: { target, query: '  literal  ' },
  getChatHistoryAround: { target, entryId: 'entry' },
  sendChat: { target, requestId: 'send', text: '  Keep original text  ' },
  getChatSend: { target, requestId: 'send' },
  stopChat: { stop, requestId: 'stop' },
  settleChat: { target, settled: true },
  findChatFiles: { target, query: 'src' },
} satisfies { [K in ChatCommand]: ChatInput<K> };
export const outputs = {
  getChatHost: { ...session, mode: 'local' },
  listChats: { conversations: [conversation], nextCursor: null },
  createChat: { requestId: 'create', conversation },
  getChat: snapshot,
  getChatHistory: { entries: snapshot.entries, olderCursor: null },
  getChatTranscriptContent: {
    kind: 'manifest',
    cursor: null,
    source: { kind: 'entry', target, entryId: 'entry' },
    parts: [],
    nextCursor: null,
    thinking: 'none',
  },
  findChatTranscript: {
    target,
    query: '  literal  ',
    cursor: null,
    startCursor: 'start',
    upperEntryId: null,
    matches: [],
    progress: { entries: 0, bytes: 0 },
    nextCursor: null,
  },
  getChatHistoryAround: {
    entries: [],
    olderCursor: null,
    target,
    entryId: 'entry',
    cursor: null,
    newerCursor: null,
    upperEntryId: 'entry',
  },
  sendChat: {
    target,
    requestId: 'send',
    admission: 'admitted' as const,
    submissionId: 'submission',
  },
  getChatSend: null,
  stopChat: { stop, requestId: 'stop', outcome: 'pending' as const },
  settleChat: { ...conversation, settledAt: '2026-11-02T00:00:00Z' },
  findChatFiles: {
    query: 'src',
    matches: [{ path: 'src/a.ts', positions: [0, 1, 2] }],
    partial: false,
  },
} satisfies { [K in ChatCommand]: ChatOutput<K> };
