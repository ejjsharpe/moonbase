import {
  isAccessRefusal,
  isCancelled,
  isKnownError,
  isUncertain,
} from '@moonbase/contracts/error-groups';
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Ref,
  type Scope,
  Stream,
  SubscriptionRef,
} from 'effect';
import type {
  ChatCreationSettings,
  ChatMention,
  ChatModelPreference,
  ChatTarget,
} from '@moonbase/contracts/chat';
import { isEditorError } from '../../editor/editor-errors.ts';
import { describeChatOutcome, NewChatDraftError } from '../chat-errors.ts';
import type { ChatDraftsShape, DraftOrigin } from '../drafts/drafts-service.ts';
import type { ChatState } from '../chat-state.ts';
import { rebaseMentions } from './mention-text.ts';
import { chatWorktreeBranch } from './worktree-branch.ts';
import {
  describeMentionCheck,
  emptyComposer,
  findChatFolder,
  joinNewChatDraft,
  keepMentionedFolders,
  planFileMentions,
  readChoices,
  type ChatComposerSnapshot,
  type ComposerChoices,
  type ComposerMessage,
  type ComposerPlace,
} from './composer.ts';

/** What the composer uses of its chat. */
export type ComposerChat = {
  readonly state: Effect.Effect<ChatState>;
  /** Signals each change to the chat's state. */
  readonly changes: Stream.Stream<void>;
  readonly setDraft: (value: string, mentions?: readonly ChatMention[]) => Effect.Effect<void>;
  /** Moves a draft to the new chat in one write (`ChatDrafts.moveToNewChat`). */
  readonly moveToNewChat: ChatDraftsShape['moveToNewChat'];
  readonly send: (settings?: ChatCreationSettings) => Effect.Effect<void>;
  /** Closes a chat the drafts' move deselected (`ChatSelection.closeDeselected`). */
  readonly closeDeselected: (target: ChatTarget) => Effect.Effect<void>;
  readonly select: (target: ChatTarget) => Effect.Effect<void>;
};
/** Makes a linked worktree of `root` on `branch` under `requestId`, succeeding with its root. */
export type CreateWorktree = (
  root: string,
  branch: string,
  requestId: string,
) => Effect.Effect<string, unknown>;

/**
 * One chat's composer, beside its services: what each place chose for the new chat, the folder
 * each new-chat mention was picked in, a worktree being made, and the one message it shows.
 */
export type ChatComposer = {
  readonly state: SubscriptionRef.SubscriptionRef<ChatComposerSnapshot>;
  readonly choose: (place: ComposerPlace, change: Partial<ComposerChoices>) => Effect.Effect<void>;
  /** Shows `message` where it applies, replacing the one shown. */
  readonly report: (message: ComposerMessage) => Effect.Effect<void>;
  /** Clears the message if it is for `chat` and, given a `place`, for that place or every one. */
  readonly dismiss: (where: { chat: string; place?: string }) => Effect.Effect<void>;
  /** Records that the new chat draft's mentions of `paths` were picked in `folder`. */
  readonly noteMentions: (paths: readonly string[], folder: string) => Effect.Effect<void>;
  /** Mentions files from the file tree (absolute paths) in the chat's draft, saying why not. */
  readonly mention: (place: ComposerPlace, files: readonly string[]) => Effect.Effect<void>;
  /**
   * Makes the new chat draft's mentions relative to `folder`, the one it is about to send in.
   * Returns why the Send should wait (some were written out in full, or had no known folder);
   * the next Send goes ahead.
   */
  readonly checkMentions: (folder: string) => Effect.Effect<string | null>;
  /**
   * Sends the draft: the open chat's, or the new chat's with `selection` in the place's folder,
   * in a new worktree of it when the place chose one and `createWorktree` is given.
   */
  readonly send: (
    place: ComposerPlace,
    options: { selection?: ChatModelPreference; createWorktree?: CreateWorktree },
  ) => Effect.Effect<void>;
  /**
   * Opens a new chat with `text`, carried from the chat `from` typed `/new` in (with lines after
   * it), whose mentions were picked in the open chat's `folder`. The open chat's draft is cleared
   * and the text joins the new chat's draft; false when it can't, and stays in the open chat
   * instead, or when the chat or its draft is no longer `from` (a repeated command), which moves
   * nothing. It belongs to the composer: a caller that is interrupted only stops waiting.
   */
  readonly startNewChat: (
    from: DraftOrigin,
    text: string,
    mentions: readonly ChatMention[],
    folder: string | undefined,
  ) => Effect.Effect<boolean>;
  /**
   * Turns chat `id` into a project with `turn` (its folder opened as one where it is) as the
   * composer's own work, listed in `turning` until it settles: a view that goes away meanwhile
   * leaves it running, and why it failed is the chat's message. A chat already turning is left to
   * it.
   */
  readonly turnIntoProject: (id: string, turn: Effect.Effect<void, unknown>) => Effect.Effect<void>;
};

/**
 * Why a chat couldn't become a project: a shared outcome's fixed text, or the message main, the
 * workspace or the editor built from an error's fields; anything else adds nothing to the fixed
 * text, so no text a host or defect wrote reaches the view.
 */
function describeTurnFailure(error: unknown): string {
  const why =
    describeChatOutcome(error) ??
    (isKnownError(error) || isEditorError(error) ? (error as Error).message : '');
  return `The chat could not become a project. ${why}`.trim();
}

type WorktreeRequest = { key: string; cwd: string; branch: string; requestId: string };
type MadeWorktree = { place: ComposerPlace; root: string; from: string };

/**
 * A chat's composer, for as long as `scope`: one chat view at a time is mounted (in Agents or a
 * project's dock), so what one chose survives switching between them, and a worktree still being
 * made sends its chat once Git finishes, whichever view shows it then.
 *
 * The new chat's draft is shared by every view, but each view has its own folder, so the composer
 * remembers the folder each mention was picked in. Showing the draft never changes it; Send makes
 * its mentions relative to the folder it sends in. The folders last as long as the composer, so a
 * mention whose folder isn't known, as after a restart, holds the first Send until the user
 * confirms it as a file in the folder sent in.
 */
const makeComposer = (chat: ComposerChat): Effect.Effect<ChatComposer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make(emptyComposer);
    /** The new chat send whose worktree's outcome is unknown, which a repeat asks for again. */
    const unknownRequest = yield* Ref.make<WorktreeRequest | undefined>(undefined);
    /** Worktrees a place made, kept as its folder until a chat is created in one. */
    const made = yield* Ref.make<Readonly<Record<string, MadeWorktree>>>({});
    const selected = yield* Ref.make((yield* chat.state).selected?.conversationId ?? null);
    /** Worktrees and projects being made, which outlive the view that asked. */
    const creations = yield* FiberSet.make<void, never>();
    /** Commands the composer runs for a view, which outlive it. */
    const commands = yield* FiberSet.make<boolean, never>();
    /** Sends the composer started: each runs as the chat's action, which shows its outcome. */
    const sending = yield* FiberSet.make<void, never>();
    const startSend = (settings?: ChatCreationSettings) =>
      FiberSet.run(sending, chat.send(settings)).pipe(Effect.asVoid);
    const update = (f: (s: ChatComposerSnapshot) => ChatComposerSnapshot) =>
      SubscriptionRef.update(state, f);

    const choose = (place: ComposerPlace, change: Partial<ComposerChoices>) =>
      update((s) => ({
        ...s,
        choices: { ...s.choices, [place.key]: { ...readChoices(s, place), ...change } },
      }));
    const report = (message: ComposerMessage) => update((s) => ({ ...s, message }));
    const dismiss = (where: { chat: string; place?: string }) =>
      update((s) =>
        s.message &&
        s.message.chat === where.chat &&
        (where.place === undefined ||
          s.message.place === undefined ||
          s.message.place === where.place)
          ? { ...s, message: null }
          : s,
      );
    const noteMentions = (paths: readonly string[], folder: string) =>
      Effect.flatMap(chat.state, (current) => {
        if (current.selected || !folder) return Effect.void;
        const mentioned = new Set(current.mentions.map((mention) => mention.path));
        return update((s) => {
          const folders = { ...s.folders };
          for (const path of paths) if (mentioned.has(path)) folders[path] = folder;
          return { ...s, folders: keepMentionedFolders(folders, current.mentions) };
        });
      });

    const checkMentions = (folder: string) =>
      Effect.gen(function* () {
        const current = yield* chat.state;
        if (current.selected) return null;
        const { folders } = yield* SubscriptionRef.get(state);
        const unknown = current.mentions.filter((m) => !Object.hasOwn(folders, m.path)).length;
        const folderOf = (path: string) => folders[path] ?? folder;
        let mentions = current.mentions,
          dropped = 0;
        if (current.mentions.some((mention) => folderOf(mention.path) !== folder)) {
          const rebased = rebaseMentions(current.draft, current.mentions, folderOf, folder);
          yield* chat.setDraft(rebased.text, rebased.mentions);
          if ((yield* chat.state).draft !== rebased.text)
            return "The draft's mentions couldn't be made relative to its folder, so it wasn't sent.";
          mentions = rebased.mentions;
          dropped = rebased.dropped;
        }
        yield* update((s) => ({
          ...s,
          folders: Object.fromEntries(mentions.map((mention) => [mention.path, folder])),
        }));
        return describeMentionCheck(dropped, unknown, folder);
      });

    /** What became of a worktree made for the new chat's first message in `place`. */
    const finishWorktree = (
      place: ComposerPlace,
      from: string,
      settings: ChatModelPreference,
      exit: Exit.Exit<string, unknown>,
    ) =>
      Effect.gen(function* () {
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          if (Option.isNone(error)) return;
          // A worktree that may have been made keeps its request, so a retry asks for it again.
          if (!isUncertain(error.value) && !isCancelled(error.value))
            yield* Ref.set(unknownRequest, undefined);
          // A folder the host refused shows the chat's fixed text; any other failure its own.
          const detail =
            (isAccessRefusal(error.value) && describeChatOutcome(error.value)) ||
            (error.value instanceof Error ? error.value.message : '');
          return yield* report({
            chat: '',
            text: `The worktree could not be created. ${detail}`.trim(),
          });
        }
        const root = exit.value;
        yield* Ref.set(unknownRequest, undefined);
        yield* Ref.update(made, (m) => ({ ...m, [place.key]: { place, root, from } }));
        yield* choose(place, { cwd: root, newWorktree: false });
        // `from` is a repository root (main refuses others), and the worktree holds its committed
        // files at the same relative paths, so mentions picked in `from` are in the worktree.
        yield* update((s) => ({
          ...s,
          folders: Object.fromEntries(
            Object.entries(s.folders).map(([path, folder]) => [
              path,
              folder === from ? root : folder,
            ]),
          ),
        }));
        if ((yield* chat.state).selected)
          return yield* report({
            chat: '',
            text: `The worktree is ready at ${root}. Send from a new chat there to start it.`,
          });
        // Mentions can't be added while it is made, but check them as any Send does.
        const problem = yield* checkMentions(root);
        if (problem) return yield* report({ chat: '', text: problem });
        // Sent before the worktree stops being made, so a view shown again sees the send under
        // way rather than an idle draft.
        yield* startSend({ cwd: root, ...settings });
      });

    /**
     * Makes a linked worktree of the place's folder and sends the new chat's first message in it.
     * Until a chat is created there the place keeps the worktree as its folder, so a retried send
     * never makes a second one; then the place goes back to the folder it was made from. A send
     * whose worktree's outcome is unknown is retried under the same request.
     */
    const sendInWorktree = (
      place: ComposerPlace,
      create: CreateWorktree,
      settings: ChatModelPreference,
    ) =>
      Effect.gen(function* () {
        const reserved = yield* SubscriptionRef.modify(state, (s) =>
          s.creatingWorktree ? [false, s] : [true, { ...s, creatingWorktree: true }],
        );
        if (!reserved) return;
        const cwd = readChoices(yield* SubscriptionRef.get(state), place).cwd;
        const branch = chatWorktreeBranch((yield* chat.state).draft);
        const request = yield* Ref.modify(unknownRequest, (unknown) => {
          const next =
            unknown && unknown.key === place.key && unknown.cwd === cwd && unknown.branch === branch
              ? unknown
              : { key: place.key, cwd, branch, requestId: crypto.randomUUID() };
          return [next, next];
        });
        yield* dismiss({ chat: '', place: place.key });
        // The worktree outlives the view that asked for it: it belongs to the composer's scope.
        yield* FiberSet.run(creations)(
          Effect.exit(create(cwd, branch, request.requestId)).pipe(
            Effect.flatMap((exit) => finishWorktree(place, cwd, settings, exit)),
            Effect.ensuring(update((s) => ({ ...s, creatingWorktree: false }))),
          ),
        );
      });

    /**
     * `/new`: the drafts move in one write before the transcript closes, so nothing the view does
     * meanwhile (closing it, say) can leave the text in neither chat. The write checks that the
     * chat and its draft are still the ones the command was typed in, so a repeated or stale
     * command never writes over what an earlier one moved.
     */
    const startNewChat = (
      from: DraftOrigin,
      text: string,
      mentions: readonly ChatMention[],
      folder: string | undefined,
    ) =>
      Effect.gen(function* () {
        const target = from.selected;
        // The new chat's folders cover only what its draft mentions before the text joins it,
        // not a sent draft's. `/new` in the new chat only drops its command line.
        let folders = (yield* SubscriptionRef.get(state)).folders;
        const moved = yield* chat
          .moveToNewChat(from, (draft) => {
            if (!target) return { text, mentions: [...mentions] };
            folders = keepMentionedFolders(folders, draft.mentions);
            return joinNewChatDraft(draft, folders, text, mentions, folder);
          })
          .pipe(Effect.catch((error) => Effect.succeed(error)));
        // A stale `/new` fails silently on purpose: the first command already ran and moved the draft.
        if (moved instanceof NewChatDraftError && moved.reason === 'stale') return false;
        // A chat whose drafts couldn't move keeps its draft without the command.
        if (moved !== true) yield* chat.setDraft(text, mentions);
        if (moved instanceof NewChatDraftError) {
          yield* report({ chat: target?.conversationId ?? '', draft: text, text: moved.message });
          return false;
        }
        if (!moved || !target) return true;
        yield* update((s) => ({ ...s, folders }));
        if (text && folder)
          yield* noteMentions(
            mentions.map((mention) => mention.path),
            folder,
          );
        // The move deselected the chat; closing its transcript writes nothing more.
        yield* chat.closeDeselected(target);
        return true;
      });

    /** Follows the chat: what a sent draft or another chat leaves behind goes. */
    const observe = Effect.gen(function* () {
      const current = yield* chat.state;
      const now = current.selected?.conversationId ?? null;
      const leftNewChat = (yield* Ref.getAndSet(selected, now)) === null && now !== null;
      // The folders cover only what the new chat draft mentions, so a sent or emptied one has none.
      // Leaving the new chat for a chat leaves its messages behind: they were about what it would
      // do. The state changes only when one of those does: the chat changes far more often (a
      // live reply), and each change would draw the composer again.
      const before = yield* SubscriptionRef.get(state);
      const folders = now ? before.folders : keepMentionedFolders(before.folders, current.mentions);
      const message = leftNewChat && before.message?.chat === '' ? null : before.message;
      if (
        message !== before.message ||
        Object.keys(folders).length !== Object.keys(before.folders).length
      )
        yield* SubscriptionRef.set(state, { ...before, folders, message });
      // Once a chat exists in a place's worktree, by this send or a retried one, the place starts
      // over in the folder it made the worktree from.
      for (const worktree of Object.values(yield* Ref.get(made))) {
        const created =
          current.snapshot?.conversation.cwd === worktree.root ||
          current.chats.some((listed) => listed.cwd === worktree.root);
        if (!created) continue;
        yield* Ref.update(made, (m) =>
          Object.fromEntries(Object.entries(m).filter(([key]) => key !== worktree.place.key)),
        );
        if (readChoices(yield* SubscriptionRef.get(state), worktree.place).cwd === worktree.root)
          yield* choose(worktree.place, { cwd: worktree.from, newWorktree: false });
      }
    });
    yield* chat.changes.pipe(
      Stream.buffer({ capacity: 1, strategy: 'sliding' }),
      Stream.runForEach(() => observe),
      Effect.forkScoped,
    );

    return {
      state,
      choose,
      report,
      dismiss,
      noteMentions,
      checkMentions,
      mention: (place, files) =>
        Effect.gen(function* () {
          const current = yield* chat.state;
          const snapshot = yield* SubscriptionRef.get(state);
          const folder = findChatFolder(current, readChoices(snapshot, place).cwd);
          const plan = planFileMentions(
            current,
            snapshot.folders,
            files,
            folder,
            snapshot.creatingWorktree,
          );
          if (plan.draft) {
            yield* chat.setDraft(plan.draft.text, plan.draft.mentions);
            if (!current.selected && (yield* chat.state).draft === plan.draft.text)
              yield* noteMentions(plan.draft.added, plan.folder!);
          }
          const where = current.selected?.conversationId ?? '';
          yield* plan.error
            ? report({ chat: where, text: plan.error })
            : dismiss({ chat: where, place: place.key });
        }),
      send: (place, { selection, createWorktree }) =>
        Effect.gen(function* () {
          const current = yield* chat.state;
          yield* dismiss({ chat: current.selected?.conversationId ?? '', place: place.key });
          // Enter sends even while Send is disabled; one worktree per first message.
          if ((yield* SubscriptionRef.get(state)).creatingWorktree) return;
          if (current.selected) return yield* startSend();
          const { cwd, newWorktree } = readChoices(yield* SubscriptionRef.get(state), place);
          // Without a folder, a new local chat runs in one the host makes for it.
          const settings = selection ? { ...(cwd ? { cwd } : {}), ...selection } : undefined;
          // Mentions picked in another view's folder are checked against this one before sending.
          const problem = settings ? yield* checkMentions(cwd) : null;
          if (problem) return yield* report({ chat: '', place: place.key, text: problem });
          if (createWorktree && newWorktree && selection)
            return yield* sendInWorktree(place, createWorktree, selection);
          yield* startSend(settings);
        }),
      startNewChat: (from, text, mentions, folder) =>
        FiberSet.run(commands, startNewChat(from, text, mentions, folder)).pipe(
          Effect.flatMap(Fiber.join),
        ),
      turnIntoProject: (id, turn) =>
        Effect.gen(function* () {
          const started = yield* SubscriptionRef.modify(state, (s) =>
            s.turning.includes(id) ? [false, s] : [true, { ...s, turning: [...s.turning, id] }],
          );
          if (!started) return;
          yield* dismiss({ chat: id });
          yield* FiberSet.run(creations)(
            turn.pipe(
              Effect.catch((error) => report({ chat: id, text: describeTurnFailure(error) })),
              Effect.ensuring(
                update((s) => ({ ...s, turning: s.turning.filter((turning) => turning !== id) })),
              ),
            ),
          );
        }),
    } satisfies ChatComposer;
  });

/** Makes each chat's composer, in the chat's scope. */
export class ChatComposers extends Context.Service<
  ChatComposers,
  { readonly make: (chat: ComposerChat) => Effect.Effect<ChatComposer, never, Scope.Scope> }
>()('moonbase/chat/ChatComposers') {
  static readonly layer = Layer.succeed(ChatComposers, { make: makeComposer });
}
