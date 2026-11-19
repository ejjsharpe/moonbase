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
import { callAbortable } from '../abortable-call.ts';
import { callHarness } from './harness-call.ts';
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
/** A refusal the create's commit made before writing anything, unlike any other failure of it. */
class CreateRefusal {
  readonly error: ChatError;
  constructor(error: ChatError) {
    this.error = error;
  }
}
const bindingOf = (d: ChatInput<'createChat'>) => JSON.stringify({ operation: 'createChat', ...d });
/** The reply for a chat this request made, read back from its metadata. */
const replyWith = (host: Host, d: ChatInput<'createChat'>, conversationId: string) =>
  Effect.gen(function* () {
    const meta = yield* host.metadata({ ...d.session, conversationId }, true);
    return { requestId: d.requestId, conversation: yield* host.summary(conversationId, meta) };
  });
/** The chat an earlier attempt of this request made; a request ID reused for another is refused. */
const findCreated = (host: Host, d: ChatInput<'createChat'>) =>
  Effect.gen(function* () {
    const existing = yield* callHarness(
      () => host.harness.snapshot(Request, key(d.session.actorId, d.requestId), context),
      true,
    );
    if (!existing) return undefined;
    yield* runCheck(() => decodeStoredRequest(existing, d.session.actorId, d.requestId), true);
    if (existing.binding !== bindingOf(d)) return yield* new RequestReusedError();
    if (!existing.conversationId) return undefined;
    return yield* replyWith(host, d, existing.conversationId);
  });
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
    // Only a refusal the commit itself made is definite: anything else, a typed failure Pi reports
    // included, may have followed the commit.
    const committed = yield* callAbortable(() =>
      host.harness.commit(async (tx) => {
        const request = await tx.doc(Request, key(d.session.actorId, d.requestId), binding);
        try {
          decodeStoredRequest(request, d.session.actorId, d.requestId);
        } catch (error) {
          throw new CreateRefusal(safeError(error));
        }
        if (request.binding !== binding) throw new CreateRefusal(new RequestReusedError());
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
      }, context),
    ).pipe(
      Effect.catch((error) =>
        error instanceof CreateRefusal
          ? // No chat was made, so its folder is still empty; a non-empty folder is left alone.
            Effect.andThen(
              ownFolder ? removeEmptyChatFolder(ownFolder) : Effect.void,
              Effect.fail(error.error),
            )
          : Effect.fail(new UncertainError({ operation: 'Creating the chat' })),
      ),
    );
    // A racing original or retry made this chat first, in a folder of its own: this one is unused.
    if (!committed.made && ownFolder) yield* removeEmptyChatFolder(ownFolder);
    return yield* replyWith(host, d, committed.conversationId).pipe(
      Effect.mapError(() => new UncertainError({ operation: 'Creating the chat' })),
    );
  });
