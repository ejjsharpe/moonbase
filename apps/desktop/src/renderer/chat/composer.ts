import {
  maximumChatInputBytes,
  maximumChatMentions,
  type ChatMention,
  type ChatModelPreference,
} from '@moonbase/contracts/chat';
import type { ChatController } from '@moonbase/application/chat';
import { rebaseMentions } from './mention-text.ts';
import { chatWorktreeBranch } from './worktree.ts';

/** A new chat's folder choices in one view of it: Agents, or a project's dock. */
export type ChatComposerPlace = {
  /** The new chat's working folder, or '' until one is chosen. */
  cwd: string;
  /** Whether the first message makes a linked worktree of `cwd` for the chat. */
  newWorktree: boolean;
  folderError: string | null;
};
export type ChatComposerSnapshot = {
  places: Readonly<Record<string, ChatComposerPlace>>;
  /** Whether a worktree is being made for the new chat's first message, in any place. */
  creatingWorktree: boolean;
};
type ComposerChat = Pick<
  ChatController,
  'getSnapshot' | 'setDraft' | 'send' | 'closeView' | 'select'
>;

/**
 * A chat controller's new-chat composer choices, outside React: one chat view at a time is mounted
 * (in Agents or a project's dock), so what one chose survives switching between them, and a worktree
 * still being made sends its chat once Git finishes, whichever view shows it then.
 */
export class ChatComposer {
  private snapshot: ChatComposerSnapshot = { places: {}, creatingWorktree: false };
  private readonly listeners = new Set<() => void>();
  private readonly chat: ComposerChat;
  /** The folder the new chat draft's mentions are relative to, once a view has shown one. */
  private mentionFolder: string | undefined;
  constructor(chat: ComposerChat) {
    this.chat = chat;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private publish(change: Partial<ChatComposerSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
  /** A place's choices; one not changed yet starts in `initialCwd`. */
  readPlace(key: string, initialCwd: string): ChatComposerPlace {
    return this.snapshot.places[key] ?? { cwd: initialCwd, newWorktree: false, folderError: null };
  }
  updatePlace(key: string, initialCwd: string, change: Partial<ChatComposerPlace>) {
    const place = { ...this.readPlace(key, initialCwd), ...change };
    this.publish({ places: { ...this.snapshot.places, [key]: place } });
  }
  /**
   * Makes the new chat draft's mentions relative to `folder`, the one its composer now shows.
   * Mentions of files outside it stop being mentions; returns how many did.
   */
  moveMentions(folder: string) {
    const state = this.chat.getSnapshot();
    if (!folder || state.selected) return 0;
    const from = this.mentionFolder;
    this.mentionFolder = folder;
    if (!from || from === folder || !state.mentions.length) return 0;
    const moved = rebaseMentions(state.draft, state.mentions, from, folder);
    this.chat.setDraft(moved.text, moved.mentions);
    return moved.dropped;
  }
  /**
   * Makes a linked worktree of the place's folder and sends the new chat's first message in it.
   * The place keeps the worktree as its folder, so a retried send never makes a second one.
   */
  sendInWorktree(
    key: string,
    initialCwd: string,
    createWorktree: (root: string, branch: string) => Promise<string>,
    settings: ChatModelPreference,
  ) {
    if (this.snapshot.creatingWorktree) return;
    const cwd = this.readPlace(key, initialCwd).cwd;
    this.updatePlace(key, initialCwd, { folderError: null });
    this.publish({ creatingWorktree: true });
    void createWorktree(cwd, chatWorktreeBranch(this.chat.getSnapshot().draft)).then(
      (root) => {
        // `cwd` is a repository root (main refuses others), and the worktree holds its committed
        // files at the same relative paths, so the draft's mentions carry over unchanged.
        if (this.mentionFolder === undefined || this.mentionFolder === cwd)
          this.mentionFolder = root;
        let folderError: string | null = null;
        // Sent first, so a view shown again sees the send under way rather than an idle draft.
        if (this.chat.getSnapshot().selected)
          folderError = `The worktree is ready at ${root}. Send from a new chat there to start it.`;
        else void this.chat.send({ cwd: root, ...settings });
        this.updatePlace(key, initialCwd, { cwd: root, newWorktree: false, folderError });
        this.publish({ creatingWorktree: false });
      },
      (error: unknown) => {
        this.updatePlace(key, initialCwd, {
          folderError:
            `The worktree could not be created. ${error instanceof Error ? error.message : ''}`.trim(),
        });
        this.publish({ creatingWorktree: false });
      },
    );
  }
  /**
   * Opens a new chat with `text`, carried from the open chat (`/new` with lines after it), whose
   * mentions are relative to the open chat's `folder`. The open chat's draft is cleared, and the
   * text joins the new chat's draft after anything already there. Resolves to an error when the
   * text can't fit there and stays in the open chat instead.
   */
  startNewChat(
    text: string,
    mentions: readonly ChatMention[],
    folder: string | undefined,
  ): Promise<string | null> {
    const target = this.chat.getSnapshot().selected;
    if (!target) {
      this.chat.setDraft(text, mentions);
      return Promise.resolve(null);
    }
    this.chat.setDraft('');
    const closing = this.chat.closeView().then(() => null);
    const state = this.chat.getSnapshot();
    if (state.selected) {
      // The view couldn't close: the open chat keeps its draft without the command.
      this.chat.setDraft(text, mentions);
      return closing;
    }
    if (!text) return closing;
    // The new draft's own mentions keep their folder; a new draft without any takes the open chat's.
    const base = state.mentions.length ? this.mentionFolder : folder;
    const carried =
      folder && base && base !== folder
        ? rebaseMentions(text, mentions, folder, base)
        : { text, mentions };
    const combined = state.draft
      ? `${state.draft}${state.draft.endsWith('\n') ? '' : '\n'}${carried.text}`
      : carried.text;
    const all = [
      ...new Map(
        [...state.mentions, ...carried.mentions].map((mention) => [mention.path, mention]),
      ).values(),
    ];
    if (
      new TextEncoder().encode(combined).length > maximumChatInputBytes ||
      all.length > maximumChatMentions
    ) {
      void this.chat.select(target);
      this.chat.setDraft(text, mentions);
      return Promise.resolve(
        "The new chat's draft has no room for the rest of this message, so it stays here.",
      );
    }
    if (base) this.mentionFolder = base;
    this.chat.setDraft(combined, all);
    return closing;
  }
}

const composers = new WeakMap<ComposerChat, ChatComposer>();
/** The composer of a chat controller; it lasts as long as the controller does. */
export function getChatComposer(chat: ComposerChat) {
  let composer = composers.get(chat);
  if (!composer) composers.set(chat, (composer = new ChatComposer(chat)));
  return composer;
}
