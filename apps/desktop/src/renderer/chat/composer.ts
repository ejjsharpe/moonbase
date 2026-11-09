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
  /** About this place's folder or its mentions; shown in its new-chat composer. */
  folderError: string | null;
};
export type ChatComposerSnapshot = {
  places: Readonly<Record<string, ChatComposerPlace>>;
  /** Whether a worktree is being made for the new chat's first message, in any place. */
  creatingWorktree: boolean;
  /** How that worktree turned out when it didn't send; every view's new-chat composer shows it. */
  notice: string | null;
};
type ComposerChat = Pick<
  ChatController,
  'getSnapshot' | 'subscribe' | 'setDraft' | 'send' | 'closeView' | 'select'
>;
const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : `${count} ${many}`;

/**
 * A chat controller's new-chat composer choices, outside React: one chat view at a time is mounted
 * (in Agents or a project's dock), so what one chose survives switching between them, and a worktree
 * still being made sends its chat once Git finishes, whichever view shows it then.
 *
 * The new chat's draft is shared by every view, but each view has its own folder, so the composer
 * remembers the folder each mention was picked in. Showing the draft never changes it; Send makes
 * its mentions relative to the folder it sends in (`checkMentions`). The folders live only as long
 * as this composer (its controller), so a mention whose folder isn't known, as after a restart,
 * holds the first Send until the user confirms it as a file in the folder sent in.
 */
export class ChatComposer {
  private snapshot: ChatComposerSnapshot = { places: {}, creatingWorktree: false, notice: null };
  private readonly listeners = new Set<() => void>();
  private readonly chat: ComposerChat;
  /** The folder each of the new chat draft's mentions was picked in, by its path. */
  private folders = new Map<string, string>();
  /** Worktrees a place made, kept as its folder until a chat is created in one. */
  private readonly worktrees = new Map<
    string,
    { initialCwd: string; root: string; from: string }
  >();
  private selected: string | null;
  constructor(chat: ComposerChat) {
    this.chat = chat;
    this.selected = chat.getSnapshot().selected?.conversationId ?? null;
    chat.subscribe(() => this.observeChat());
  }
  private observeChat() {
    const state = this.chat.getSnapshot();
    const selected = state.selected?.conversationId ?? null;
    // The folders cover only what the new chat draft mentions, so a sent or emptied one has none.
    if (!selected) {
      const mentioned = new Set(state.mentions.map((mention) => mention.path));
      for (const path of this.folders.keys()) if (!mentioned.has(path)) this.folders.delete(path);
    }
    // Leaving the new chat for a chat leaves its messages behind: they were about what it would do.
    const leftNewChat = this.selected === null && selected !== null;
    this.selected = selected;
    if (leftNewChat) this.clearMessages();
    // Once a chat exists in a place's worktree, by this send or a retried one, the place starts over
    // in the folder it made the worktree from.
    for (const [key, made] of this.worktrees) {
      const created =
        state.snapshot?.conversation.cwd === made.root ||
        state.chats.some((chat) => chat.cwd === made.root);
      if (!created) continue;
      this.worktrees.delete(key);
      if (this.readPlace(key, made.initialCwd).cwd === made.root)
        this.updatePlace(key, made.initialCwd, { cwd: made.from, newWorktree: false });
    }
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
  /** Clears every place's error and the notice, or just one place's error and the notice. */
  clearMessages(key?: string) {
    const places = Object.fromEntries(
      Object.entries(this.snapshot.places).map(([name, place]) => [
        name,
        key === undefined || name === key ? { ...place, folderError: null } : place,
      ]),
    );
    this.publish({ places, notice: null });
  }
  /** Records that the new chat draft's mentions of `paths` were picked in `folder`. */
  noteMentions(paths: readonly string[], folder: string) {
    const state = this.chat.getSnapshot();
    if (state.selected || !folder) return;
    const mentioned = new Set(state.mentions.map((mention) => mention.path));
    for (const path of paths) if (mentioned.has(path)) this.folders.set(path, folder);
    for (const path of this.folders.keys()) if (!mentioned.has(path)) this.folders.delete(path);
  }
  /**
   * Why the new chat draft can't mention `path` picked in `folder`: one spelling names one file,
   * and the draft already mentions that path in another folder.
   */
  findMentionClash(path: string, folder: string): string | null {
    const state = this.chat.getSnapshot();
    const own = this.folders.get(path);
    if (state.selected || !own || own === folder) return null;
    if (!state.mentions.some((mention) => mention.path === path)) return null;
    return `The draft already mentions ${path} in ${own}, so the one in ${folder} can't be mentioned too.`;
  }
  /**
   * Makes the new chat draft's mentions relative to `folder`, the one it is about to send in, and
   * records them as picked in `sentIn` (a worktree holds its checkout's files at the same paths).
   * Returns how many were in another folder and became full paths, or null when the draft couldn't
   * be changed.
   */
  resolveMentions(folder: string, sentIn = folder): number | null {
    const state = this.chat.getSnapshot();
    if (state.selected) return 0;
    const folderOf = (path: string) => this.folders.get(path) ?? folder;
    let resolved = { mentions: state.mentions, dropped: 0 };
    if (state.mentions.some((mention) => folderOf(mention.path) !== folder)) {
      const rebased = rebaseMentions(state.draft, state.mentions, folderOf, folder);
      this.chat.setDraft(rebased.text, rebased.mentions);
      if (this.chat.getSnapshot().draft !== rebased.text) return null;
      resolved = rebased;
    }
    this.folders = new Map(resolved.mentions.map((mention) => [mention.path, sentIn]));
    return resolved.dropped;
  }
  /**
   * Why the new chat can't send in `folder` yet, after making its mentions relative to it: some
   * were in another folder and are written out in full, or some had no known folder and are now
   * taken as files in this one. Either way the next Send goes ahead.
   */
  checkMentions(folder: string, sentIn = folder): string | null {
    const state = this.chat.getSnapshot();
    // `''` is a chat without a project, whose folder the host makes: no mention is in it yet.
    const place = folder || 'the chat’s new folder';
    const unknown = state.selected
      ? 0
      : state.mentions.filter((mention) => !this.folders.has(mention.path)).length;
    const dropped = this.resolveMentions(folder, sentIn);
    if (dropped === null)
      return "The draft's mentions couldn't be made relative to its folder, so it wasn't sent.";
    const problems: string[] = [];
    if (dropped)
      problems.push(
        `${plural(dropped, "A mentioned file isn't", "mentioned files aren't")} in ${place}, so ${dropped === 1 ? 'it is' : 'they are'} written out as ${dropped === 1 ? 'a full path' : 'full paths'} instead.`,
      );
    if (unknown)
      problems.push(
        `Moonbase can't tell which folder ${plural(unknown, 'a mention was', 'mentions were')} picked in, as after a restart, so ${unknown === 1 ? 'it is' : 'they are'} now taken as ${unknown === 1 ? 'a file' : 'files'} in ${place}.`,
      );
    return problems.length ? [...problems, 'Send again to send the message.'].join(' ') : null;
  }
  /**
   * Makes a linked worktree of the place's folder and sends the new chat's first message in it.
   * Until a chat is created there the place keeps the worktree as its folder, so a retried send
   * never makes a second one; then the place goes back to the folder it was made from.
   */
  sendInWorktree(
    key: string,
    initialCwd: string,
    createWorktree: (root: string, branch: string) => Promise<string>,
    settings: ChatModelPreference,
  ) {
    if (this.snapshot.creatingWorktree) return;
    const cwd = this.readPlace(key, initialCwd).cwd;
    this.clearMessages(key);
    this.publish({ creatingWorktree: true });
    void createWorktree(cwd, chatWorktreeBranch(this.chat.getSnapshot().draft)).then(
      (root) => {
        this.worktrees.set(key, { initialCwd, root, from: cwd });
        this.updatePlace(key, initialCwd, { cwd: root, newWorktree: false });
        // `cwd` is a repository root (main refuses others), and the worktree holds its committed
        // files at the same relative paths, so mentions picked in `cwd` are in the worktree.
        for (const [path, folder] of this.folders) if (folder === cwd) this.folders.set(path, root);
        if (this.chat.getSnapshot().selected) {
          this.publish({
            creatingWorktree: false,
            notice: `The worktree is ready at ${root}. Send from a new chat there to start it.`,
          });
          return;
        }
        // Mentions can't be added while it is made, but check them as any Send does.
        const problem = this.checkMentions(root);
        if (problem) {
          this.publish({ creatingWorktree: false, notice: problem });
          return;
        }
        // Sent first, so a view shown again sees the send under way rather than an idle draft.
        void this.chat.send({ cwd: root, ...settings });
        this.publish({ creatingWorktree: false });
      },
      (error: unknown) => {
        this.publish({
          creatingWorktree: false,
          notice:
            `The worktree could not be created. ${error instanceof Error ? error.message : ''}`.trim(),
        });
      },
    );
  }
  /**
   * Opens a new chat with `text`, carried from the open chat (`/new` with lines after it), whose
   * mentions were picked in the open chat's `folder`. The open chat's draft is cleared, and the
   * text joins the new chat's draft after anything already there. Resolves to an error when the
   * text can't join it and stays in the open chat instead.
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
    const combined = state.draft
      ? `${state.draft}${state.draft.endsWith('\n') ? '' : '\n'}${text}`
      : text;
    const all = [
      ...new Map(
        [...state.mentions, ...mentions].map((mention) => [mention.path, mention]),
      ).values(),
    ];
    // One spelling can name only one file: the new draft's own mention of it from elsewhere wins.
    // A folder nobody knows can't be told apart, and Send will ask about it anyway.
    const clash =
      folder &&
      mentions.find((mention) => {
        const own = this.folders.get(mention.path);
        return (
          own !== undefined &&
          own !== folder &&
          state.mentions.some((mentioned) => mentioned.path === mention.path)
        );
      });
    let problem: string | null = null;
    if (clash)
      problem = `The new chat's draft already mentions ${clash.path} in another folder, so the rest of this message stays here.`;
    else if (
      new TextEncoder().encode(combined).length > maximumChatInputBytes ||
      all.length > maximumChatMentions
    )
      problem = "The new chat's draft has no room for the rest of this message, so it stays here.";
    if (problem) {
      void this.chat.select(target);
      this.chat.setDraft(text, mentions);
      return Promise.resolve(problem);
    }
    this.chat.setDraft(combined, all);
    if (this.chat.getSnapshot().draft === combined && folder)
      this.noteMentions(
        mentions.map((mention) => mention.path),
        folder,
      );
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
