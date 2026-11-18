import { Context, Effect, Layer, Semaphore, SubscriptionRef } from 'effect';
import type { ChatCreationSettings } from '@moonbase/contracts/chat';
import { ChatConfig } from '../chat-config.ts';
import { ChatActions } from '../actions/actions-service.ts';
import { countAction } from '../actions/actions.ts';
import { ChatDrafts } from '../drafts/drafts-service.ts';
import { isSameTarget, type Pending } from '../drafts/drafts.ts';
import { ChatLink } from '../link/link-service.ts';
import { ChatList } from '../chat-list/chat-list-service.ts';
import { ChatSelection } from '../selection/selection-service.ts';
import {
  describePendingFailure,
  isPending,
  makeCreate,
  makeFirstSend,
  makeSend,
  makeStop,
  notePending,
  reservePending,
  resolvePending,
} from './sends.ts';

export type SendsState = {
  /** How many dispatches of each request are in flight; their outcome is not yet in doubt. */
  dispatching: Readonly<Record<string, number>>;
};

export type ChatSendsShape = {
  readonly state: SubscriptionRef.SubscriptionRef<SendsState>;
  /** Creates a chat titled `title` with its folder and model. */
  readonly create: (title: string, settings?: ChatCreationSettings) => Effect.Effect<void>;
  /**
   * Sends the draft: to the selected chat, or for none a new chat (with `settings`) whose first
   * message it is. Each command is reserved in the drafts before it is sent.
   */
  readonly send: (settings?: ChatCreationSettings) => Effect.Effect<void>;
  /** Stops exactly the open chat's running submission and task. */
  readonly stop: Effect.Effect<void>;
  /** Queries a retained command, then sends it again under its original identity if still unresolved. */
  readonly retry: (requestId: string) => Effect.Effect<void>;
  /** Queries a retained command's outcome without sending anything. */
  readonly query: (requestId: string) => Effect.Effect<void>;
  /** Queries every retained Send, as refresh does once the host is verified. */
  readonly queryAll: Effect.Effect<void, unknown>;
};

/** The chat's outbox: Create, Send and Stop, each retained until its outcome is known. */
export class ChatSends extends Context.Service<ChatSends, ChatSendsShape>()(
  'moonbase/chat/ChatSends',
) {
  static readonly layer = Layer.effect(
    ChatSends,
    Effect.gen(function* () {
      const { chat, session, newId } = yield* ChatConfig;
      const actions = yield* ChatActions;
      const drafts = yield* ChatDrafts;
      const link = yield* ChatLink;
      const list = yield* ChatList;
      const selection = yield* ChatSelection;
      const state = yield* SubscriptionRef.make<SendsState>({ dispatching: {} });
      /** Replies to a Create are recorded one at a time: an original's and a retry's can't both. */
      const replies = yield* Semaphore.make(1);
      const count = (requestId: string, change: 1 | -1) =>
        SubscriptionRef.update(state, (s) => ({
          dispatching: countAction(s.dispatching, requestId, change),
        }));
      const note = (pending: Pending, message: string) =>
        drafts.commit((saved) => notePending(saved, pending.input.requestId, message));
      const resolve = (
        ...args: Parameters<typeof resolvePending> extends [unknown, ...infer R] ? R : never
      ) => drafts.commit((saved) => resolvePending(saved, ...args));

      /** Sends a retained command and records its outcome; a failure is noted on it. */
      const sendPending = (pending: Pending): Effect.Effect<void, unknown> =>
        Effect.gen(function* () {
          // Only a command whose outcome can be recorded is sent.
          yield* drafts.commit((saved) => saved);
          if (pending.operation === 'createChat') {
            const receipt = yield* chat.createChat(pending.input);
            const firstSend = makeFirstSend(pending, receipt);
            // The exact first Send is reserved with the Create's receipt before it is shown, unless
            // another original or retry reply already resolved this Create.
            const publish = replies.withPermits(1)(
              Effect.gen(function* () {
                if (!isPending((yield* drafts.get).saved, pending.input.requestId)) return false;
                yield* resolve(pending, receipt.conversation, firstSend);
                yield* list.addCreated(receipt.conversation);
                const target = receipt.conversation.target;
                if (
                  (yield* link.isOpen) &&
                  isSameTarget((yield* drafts.get).saved.selected, target)
                )
                  yield* actions.fork(
                    actions.run('open', link.run(selection.open(target)), { duplicate: false }),
                  );
                return true;
              }),
            );
            if (!firstSend) return yield* Effect.asVoid(publish);
            // The first message is in flight from before it is published.
            yield* Effect.acquireUseRelease(
              count(firstSend.input.requestId, 1),
              () =>
                Effect.flatMap(publish, (published) =>
                  published ? sendPending(firstSend) : Effect.void,
                ),
              () => count(firstSend.input.requestId, -1),
            );
          } else if (pending.operation === 'sendChat') {
            const receipt = yield* chat.sendChat(pending.input);
            if (receipt.admission === 'admitted') yield* resolve(pending);
            else
              yield* note(
                pending,
                'Reserved; admission is unconfirmed. Query before an explicit matching retry.',
              );
          } else {
            const receipt = yield* chat.stopChat(pending.input);
            if (receipt.outcome === 'pending')
              yield* note(
                pending,
                'Stop remains pending; cooperative cancellation is not confirmed.',
              );
            else {
              yield* resolve(pending);
              yield* actions.setNotice(`Captured Stop: ${receipt.outcome}.`);
            }
          }
        }).pipe(
          Effect.tapError((error) => Effect.ignore(note(pending, describePendingFailure(error)))),
        );
      /**
       * Sends `pending`, counting it as in flight from before `prepare` (which reserves or
       * publishes it) until its reply or failure is recorded.
       */
      const dispatch = (pending: Pending, prepare?: Effect.Effect<void, unknown>) =>
        Effect.acquireUseRelease(
          count(pending.input.requestId, 1),
          () => Effect.andThen(prepare ?? Effect.void, sendPending(pending)),
          () => count(pending.input.requestId, -1),
        );
      /** Reserves and sends a command the current state builds. */
      const reserveAndSend = (pending: Pending | Error) =>
        pending instanceof Error
          ? Effect.fail(pending)
          : dispatch(
              pending,
              drafts.commit((saved) => reservePending(saved, pending)),
            );

      const queryPending = (pending: Pending) =>
        Effect.gen(function* () {
          if (pending.operation === 'sendChat') {
            const receipt = yield* chat.getChatSend({
              target: pending.input.target,
              requestId: pending.input.requestId,
            });
            if (receipt?.admission === 'admitted') {
              yield* resolve(pending);
              yield* actions.setNotice('Original Send admission recovered without resending.');
            } else
              yield* actions.setNotice(
                'No confirmed admission. Keep the original ID; only an explicit matching retry may send.',
              );
          } else if (pending.operation === 'createChat') {
            yield* chat.listChats({ session: pending.input.session });
            yield* actions.setNotice(
              'Saved chats read. Creation identity cannot be proven by title; explicitly retry the original creation ID.',
            );
          } else {
            yield* chat.getChat({ target: pending.input.stop.target });
            yield* actions.setNotice(
              'Current state read. The retained Stop still targets its original task; retry never adopts its successor.',
            );
          }
        });
      const findPending = (requestId: string) =>
        Effect.map(drafts.get, ({ saved }) =>
          saved.pending.find((item) => item.input.requestId === requestId),
        );

      return {
        state,
        create: (title, settings) =>
          actions.run(
            'create',
            Effect.gen(function* () {
              yield* link.current;
              yield* reserveAndSend(makeCreate(session, newId(), title, settings));
            }),
          ),
        send: (settings) =>
          actions.run(
            'send',
            Effect.gen(function* () {
              yield* link.current;
              const { saved, draft, mentions } = yield* drafts.get;
              yield* reserveAndSend(
                makeSend(saved, { text: draft, mentions }, session, settings, newId),
              );
            }),
          ),
        stop: actions.run(
          'stop',
          Effect.gen(function* () {
            yield* link.current;
            const stop = (yield* SubscriptionRef.get(selection.state)).snapshot?.run?.stop;
            if (!stop) return;
            yield* reserveAndSend(makeStop((yield* drafts.get).saved, stop, newId()));
          }),
        ),
        retry: (requestId) =>
          actions.run(
            requestId,
            Effect.gen(function* () {
              yield* link.current;
              const pending = yield* findPending(requestId);
              // A command still being sent is never sent again alongside itself.
              if (!pending || (yield* SubscriptionRef.get(state)).dispatching[requestId]) return;
              yield* queryPending(pending);
              if (isPending((yield* drafts.get).saved, requestId)) yield* dispatch(pending);
            }),
          ),
        query: (requestId) =>
          actions.run(
            'query:' + requestId,
            link.run(
              Effect.gen(function* () {
                const pending = yield* findPending(requestId);
                if (pending) yield* queryPending(pending);
              }),
            ),
          ),
        queryAll: Effect.gen(function* () {
          for (const pending of (yield* drafts.get).saved.pending)
            if (pending.operation === 'sendChat') yield* queryPending(pending);
        }),
      } satisfies ChatSendsShape;
    }),
  );
}
