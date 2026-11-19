import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { configure } from '@earendil-works/pi-durable';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import { DateTime, Effect, FileSystem } from 'effect';
import type { ChatInput, ChatOutput } from '@moonbase/contracts/chat';
import { InvalidChatRequestError, type ChatError } from '@moonbase/contracts/chat-errors';
import { UncertainError } from '@moonbase/contracts/errors';
import { RequestReusedError } from '@moonbase/contracts/host-errors';
import { checkCanonicalFolder } from '../canonical-folder.ts';
import { makeChatFolder, removeEmptyChatFolder } from '../chat-folders.ts';
import { Metadata, Request, key, type ChatSettings } from '../documents.ts';
import { decodeStoredRequest } from '../stored-records.ts';
import type { Host } from './chat-host.ts';
import { callHarness } from './harness-call.ts';
import { Refusal, commitChange, mayHaveCommitted } from './commit-boundary.ts';
import { runCheck, safeError } from './safe-error.ts';

/** Creates a chat once per request; a retry of the request returns the chat it made. */
export function createChat(
  host: Host,
  d: ChatInput<'createChat'>,
): Effect.Effect<ChatOutput<'createChat'>, ChatError> {
  return Effect.gen(function* () {
    yield* host.checkSession(d.session);
    const now = yield* DateTime.now;
    const created = yield* findCreated(host, d);
    if (created) return created;
    yield* checkRequested(host, d);
    // A folder the host does not approve is refused before anything is made.
    const { approveCreation } = host.config;
    if (approveCreation)
      yield* Effect.mapError(approveCreation(d.settings), (error) => safeError(error, true));
    return yield* createOnce(host, d, now);
  }).pipe(Effect.provideService(FileSystem.FileSystem, host.fileSystem));
}
const bindingOf = (d: ChatInput<'createChat'>) => JSON.stringify({ operation: 'createChat', ...d });
/** The reply for a chat this request made; it follows that chat's commit, so it fails uncertain. */
const replyWith = (host: Host, d: ChatInput<'createChat'>, conversationId: string) =>
  mayHaveCommitted(
    Effect.gen(function* () {
      const meta = yield* host.metadata({ ...d.session, conversationId });
      return { requestId: d.requestId, conversation: yield* host.summary(conversationId, meta) };
    }),
  );
/**
 * The chat an earlier attempt of this request made; a request ID reused for another is refused.
 * An earlier attempt may have committed, so any failure to read or decode its request is
 * uncertain.
 */
const findCreated = (host: Host, d: ChatInput<'createChat'>) =>
  mayHaveCommitted(
    Effect.gen(function* () {
      const existing = yield* callHarness(() =>
        host.harness.snapshot(Request, key(d.session.actorId, d.requestId), context),
      );
      if (!existing) return undefined;
      yield* runCheck(() => decodeStoredRequest(existing, d.session.actorId, d.requestId));
      if (existing.binding !== bindingOf(d))
        return yield* Effect.fail(new Refusal(new RequestReusedError()));
      return existing.conversationId ?? undefined;
    }),
  ).pipe(
    Effect.flatMap((conversationId) =>
      conversationId ? replyWith(host, d, conversationId) : Effect.succeed(undefined),
    ),
  );
/** Refuses a folder that is missing or not named by its real path, or an unknown model. */
const checkRequested = (host: Host, d: ChatInput<'createChat'>) =>
  Effect.gen(function* () {
    const requested = d.settings;
    if (requested.cwd !== undefined) {
      const folder = yield* checkCanonicalFolder(requested.cwd);
      if (folder === 'missing')
        return yield* new InvalidChatRequestError({ problem: 'folder-missing' });
      if (folder === 'not-canonical')
        return yield* new InvalidChatRequestError({ problem: 'folder-not-canonical' });
      // Nothing proves the folder wrong, so the request is not refused.
      if (folder === 'unreadable')
        return yield* new UncertainError({ operation: 'Creating the chat' });
    } else if (!host.config.chatFolders)
      return yield* new InvalidChatRequestError({ problem: 'folder-required' });
    const model = host.config.models.getModel(requested.model.provider, requested.model.modelId);
    if (!model) return yield* new InvalidChatRequestError({ problem: 'model' });
    if (
      requested.reasoningEffort &&
      !getSupportedThinkingLevels(model).includes(requested.reasoningEffort)
    )
      return yield* new InvalidChatRequestError({ problem: 'reasoning-effort' });
  });
const createOnce = (host: Host, d: ChatInput<'createChat'>, now: DateTime.Utc) =>
  Effect.gen(function* () {
    const binding = bindingOf(d);
    const requested = d.settings;
    const ownFolder =
      requested.cwd === undefined
        ? yield* makeChatFolder(host.config.chatFolders!, d.title, DateTime.toDate(now))
        : undefined;
    const settings: ChatSettings =
      ownFolder === undefined
        ? { ...requested, cwd: requested.cwd! }
        : { ...requested, cwd: ownFolder, ownFolder: true };
    // Only a conflicting binding is definite: anything else may have followed a commit.
    const committed = yield* commitChange(host.harness, async (tx) => {
      const request = await tx.doc(Request, key(d.session.actorId, d.requestId), binding);
      decodeStoredRequest(request, d.session.actorId, d.requestId);
      if (request.binding !== binding) throw new Refusal(new RequestReusedError());
      if (request.conversationId) return { conversationId: request.conversationId, made: false };
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      await configure(tx, conversation.id, {
        cwd: settings.cwd,
        model: settings.model,
        ...(settings.reasoningEffort ? { thinkingLevel: settings.reasoningEffort } : {}),
      });
      await tx.doc(Metadata, conversation.id, 'metadata', {
        identity: host.identity,
        title: d.title,
        createdAt: DateTime.formatIso(now),
        settings,
      });
      request.conversationId = String(conversation.id);
      return { conversationId: String(conversation.id), made: true };
    }).pipe(
      Effect.catch((error) =>
        error instanceof Refusal
          ? // No chat was made, so its folder is still empty; a non-empty folder is left alone.
            Effect.andThen(
              ownFolder ? removeEmptyChatFolder(ownFolder) : Effect.void,
              Effect.fail(error.error),
            )
          : Effect.fail(error),
      ),
    );
    // A racing original or retry made this chat first, in a folder of its own: this one is unused.
    if (!committed.made && ownFolder) yield* removeEmptyChatFolder(ownFolder);
    return yield* replyWith(host, d, committed.conversationId);
  });
