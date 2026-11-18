import { Context, Effect, FiberHandle, Layer, type Scope, SubscriptionRef } from 'effect';
import type { ChatInput, ChatOutput } from '@moonbase/contracts/chat';
import type { ApplicationError } from '@moonbase/contracts/errors';
import type { ChatServiceError } from '@moonbase/contracts/services';
import { ChatConfig } from '../chat-config.ts';
import { ChatRefusedError, describeChatFailure } from '../chat-errors.ts';
import { ChatDrafts } from '../drafts/drafts-service.ts';
import { ChatLink } from '../link/link-service.ts';
import { idleFileSearch, type ChatFileSearchSnapshot } from './file-search.ts';

/** One composer's file picker. */
export type FileSearch = {
  readonly state: SubscriptionRef.SubscriptionRef<ChatFileSearchSnapshot>;
  /** Searches, cancelling the search before it; earlier matches stay until the answer arrives. */
  readonly search: (query: string, cwd?: string) => Effect.Effect<void>;
  /** Cancels any search and forgets its matches. */
  readonly clear: Effect.Effect<void>;
};

export type ChatFileSearchShape = {
  /**
   * Searches the selected chat's working folder on its host, or, for a new chat, `cwd` (a local
   * chat's chosen folder) or the remote host's fixed folder.
   */
  readonly findFiles: (
    query: string,
    cwd?: string,
  ) => Effect.Effect<
    ChatOutput<'findChatFiles'>,
    ChatRefusedError | ChatServiceError | ApplicationError
  >;
  /** A composer's file picker, for as long as its scope. */
  readonly make: Effect.Effect<FileSearch, never, Scope.Scope>;
};

/** File search in a chat's working folder. Results are not retained. */
export class ChatFileSearch extends Context.Service<ChatFileSearch, ChatFileSearchShape>()(
  'moonbase/chat/ChatFileSearch',
) {
  static readonly layer = Layer.effect(
    ChatFileSearch,
    Effect.gen(function* () {
      const { chat, session } = yield* ChatConfig;
      const drafts = yield* ChatDrafts;
      const link = yield* ChatLink;
      const findFiles = (query: string, cwd?: string) =>
        Effect.gen(function* () {
          yield* link.current;
          const target = (yield* drafts.get).saved.selected;
          if (!target && !cwd) return yield* new ChatRefusedError({ reason: 'no-folder' });
          const input: ChatInput<'findChatFiles'> = target
            ? { target, query }
            : { session, cwd: cwd!, query };
          return yield* chat.findChatFiles(input);
        });
      return {
        findFiles,
        make: Effect.gen(function* () {
          const state = yield* SubscriptionRef.make(idleFileSearch);
          const running = yield* FiberHandle.make<void, never>();
          return {
            state,
            search: (query, cwd) =>
              Effect.gen(function* () {
                yield* SubscriptionRef.update(state, (s) => ({ ...s, busy: true }));
                yield* FiberHandle.run(
                  running,
                  findFiles(query, cwd).pipe(
                    Effect.matchEffect({
                      onSuccess: (result) =>
                        SubscriptionRef.set(state, {
                          query,
                          matches: result.matches,
                          partial: result.partial,
                          busy: false,
                          error: null,
                        }),
                      onFailure: (error) =>
                        SubscriptionRef.set(state, {
                          ...idleFileSearch,
                          query,
                          error: describeChatFailure(error),
                        }),
                    }),
                  ),
                );
              }),
            clear: Effect.andThen(
              FiberHandle.clear(running),
              SubscriptionRef.set(state, idleFileSearch),
            ),
          } satisfies FileSearch;
        }),
      } satisfies ChatFileSearchShape;
    }),
  );
}
