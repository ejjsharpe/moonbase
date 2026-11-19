import {
  maximumChatInputBytes,
  maximumChatMentions,
  type ChatMention,
} from '@moonbase/contracts/chat';
import { NewChatDraftError } from '../chat-errors.ts';
import type { ChatState } from '../chat-state.ts';
import { appendMentions } from './mention-text.ts';

/** One view of the new chat (Agents, or a project's dock) and the folder it starts in. */
export type ComposerPlace = { readonly key: string; readonly initialCwd: string };

/** A new chat's folder choices in one place. */
export type ComposerChoices = {
  /** The new chat's working folder, or '' until one is chosen. */
  cwd: string;
  /** Whether the first message makes a linked worktree of `cwd` for the chat. */
  newWorktree: boolean;
};

/**
 * What the composer has to say, and where it applies: a chat (`''` for the new one), optionally
 * only one place's new chat, and optionally only while the draft is still `draft` (a command line
 * it was about).
 */
export type ComposerMessage = {
  readonly chat: string;
  readonly place?: string;
  readonly draft?: string;
  readonly text: string;
};

export type ChatComposerSnapshot = {
  readonly choices: Readonly<Record<string, ComposerChoices>>;
  /** The folder each of the new chat draft's mentions was picked in, by its path. */
  readonly folders: Readonly<Record<string, string>>;
  /** Whether a worktree is being made for the new chat's first message, in any place. */
  readonly creatingWorktree: boolean;
  /** The chats being turned into projects, by conversation id. */
  readonly turning: readonly string[];
  readonly message: ComposerMessage | null;
};

export const emptyComposer: ChatComposerSnapshot = {
  choices: {},
  folders: {},
  creatingWorktree: false,
  turning: [],
  message: null,
};

/** What the composer reads of its chat. */
export type ComposerChatState = Pick<
  ChatState,
  'selected' | 'draft' | 'mentions' | 'chats' | 'snapshot' | 'remote'
>;

/** A view's place: a project's dock, which starts in the project's root, or Agents. */
export const findComposerPlace = (dockCwd: string | undefined, remote: boolean): ComposerPlace => ({
  key: dockCwd ? `dock:${dockCwd}` : 'agents',
  // A remote host's chats use its folders, never this Mac's.
  initialCwd: (!remote && dockCwd) || '',
});

/** A place's choices; one not changed yet starts in its initial folder. */
export const readChoices = (snapshot: ChatComposerSnapshot, place: ComposerPlace) =>
  snapshot.choices[place.key] ?? { cwd: place.initialCwd, newWorktree: false };

/** Whether `message` applies to the chat shown (`''` for the new one), in `place`, with `draft`. */
export const isMessageFor = (
  message: ComposerMessage | null,
  where: { chat: string; place: string; draft: string },
) =>
  !!message &&
  message.chat === where.chat &&
  (message.place === undefined || message.place === where.place) &&
  (message.draft === undefined || message.draft === where.draft);

/** The selected chat's summary, once its snapshot or list entry has loaded. */
export const findSelectedChat = (state: Pick<ChatState, 'snapshot' | 'chats' | 'selected'>) =>
  state.snapshot?.conversation ??
  state.chats.find((c) => c.target.conversationId === state.selected?.conversationId);

/**
 * The folder the chat works in: the selected chat's, or a new chat's (`newChatFolder`). Null while
 * it isn't known, so nothing is mentioned against a guess.
 */
export function findChatFolder(state: ComposerChatState, newChatFolder: string) {
  if (state.selected) return findSelectedChat(state)?.cwd || null;
  return newChatFolder || null;
}

/** Keeps the folders of only the paths the new chat draft still mentions. */
export const keepMentionedFolders = (
  folders: Readonly<Record<string, string>>,
  mentions: readonly ChatMention[],
) =>
  Object.fromEntries(
    Object.entries(folders).filter(([path]) => mentions.some((mention) => mention.path === path)),
  );

/**
 * Why the new chat draft can't mention `path` picked in `folder`: one spelling names one file,
 * and the draft already mentions that path in another folder.
 */
export function findMentionClash(
  folders: Readonly<Record<string, string>>,
  state: Pick<ChatState, 'selected' | 'mentions'>,
  path: string,
  folder: string,
): string | null {
  const own = folders[path];
  if (state.selected || !own || own === folder) return null;
  if (!state.mentions.some((mention) => mention.path === path)) return null;
  return `The draft already mentions ${path} in ${own}, so the one in ${folder} can't be mentioned too.`;
}

const plural = (count: number, one: string, many: string) =>
  count === 1 ? one : `${count} ${many}`;

/**
 * Why the new chat holds its Send in `folder`: `dropped` mentions were in another folder and are
 * now written out in full, and `unknown` had no known folder and are now taken as files in this
 * one. Null when neither.
 */
export function describeMentionCheck(dropped: number, unknown: number, folder: string) {
  // `''` is a chat without a project, whose folder the host makes: no mention is in it yet.
  const place = folder || 'the chat’s new folder';
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
 * Files (absolute paths) from the file tree, mentioned in the chat's draft relative to `folder`:
 * the draft they make, if it changes, and why some or all weren't mentioned.
 */
export function planFileMentions(
  state: ComposerChatState,
  folders: Readonly<Record<string, string>>,
  files: readonly string[],
  folder: string | null,
  creatingWorktree: boolean,
) {
  const newChat = !state.selected;
  // The draft being sent in a new worktree keeps the mentions it has.
  const making = newChat && creatingWorktree;
  const target = making ? null : folder;
  // A path the new chat draft already mentions in another folder would name two files at once.
  const prefix = (target ?? '').replace(/\/+$/, '') + '/';
  const clashes = new Map<string, string>();
  if (newChat && target)
    for (const file of files) {
      const clash = file.startsWith(prefix)
        ? findMentionClash(folders, state, file.slice(prefix.length), target)
        : null;
      if (clash) clashes.set(file, clash);
    }
  const kept = files.filter((file) => !clashes.has(file));
  const next = target ? appendMentions(state.draft, state.mentions, kept, target) : null;
  const count = files.length;
  let error: string | null = null;
  if (making) error = 'A worktree is being made for this chat, so the files weren’t mentioned.';
  else if (!next)
    error = newChat
      ? "Choose this chat's working folder first, so the files can be mentioned in it."
      : "This chat's working folder isn't known yet, so the files weren't mentioned.";
  else {
    const skipped: string[] = [];
    if (clashes.size)
      skipped.push(
        clashes.size === 1
          ? [...clashes.values()][0]!
          : `${clashes.size} of the files have paths the draft already mentions in another folder, so they weren't mentioned.`,
      );
    if (next.outside)
      skipped.push(
        next.outside === count
          ? "Those files are outside this chat's working folder, so they weren't mentioned."
          : `${next.outside} of the files are outside this chat's working folder and weren't mentioned.`,
      );
    // A mention can't hold every path a file can have; the controller would refuse the draft.
    if (next.unmentionable) {
      let paths = `${next.unmentionable} of the files' paths`;
      if (next.unmentionable === count)
        paths = count === 1 ? "That file's path" : "Those files' paths";
      skipped.push(
        `${paths} can't be mentioned: a mention can't hold quotes, backslashes or control characters, or exceed 1,024 bytes.`,
      );
    }
    if (skipped.length) error = skipped.join(' ');
  }
  const draft =
    next && next.text !== state.draft
      ? {
          text: next.text,
          mentions: next.mentions,
          added: next.mentions.slice(state.mentions.length).map((mention) => mention.path),
        }
      : null;
  return { draft, folder: target, error };
}

/**
 * The new chat's draft with `text` (and its `mentions`, picked in `folder`) after it, as `/new`
 * carries the rest of a message from an open chat; or why it can't join it.
 */
export function joinNewChatDraft(
  draft: { readonly text: string; readonly mentions: readonly ChatMention[] },
  folders: Readonly<Record<string, string>>,
  text: string,
  mentions: readonly ChatMention[],
  folder: string | undefined,
): { text: string; mentions: ChatMention[] } | NewChatDraftError {
  if (!text) return { text: draft.text, mentions: [...draft.mentions] };
  const combined = draft.text
    ? `${draft.text}${draft.text.endsWith('\n') ? '' : '\n'}${text}`
    : text;
  const all = [
    ...new Map([...draft.mentions, ...mentions].map((mention) => [mention.path, mention])).values(),
  ];
  // One spelling can name only one file: the new draft's own mention of it from elsewhere wins.
  // A folder nobody knows can't be told apart, and Send will ask about it anyway.
  const clash =
    folder &&
    mentions.find((mention) => {
      const own = folders[mention.path];
      return (
        own !== undefined &&
        own !== folder &&
        draft.mentions.some((mentioned) => mentioned.path === mention.path)
      );
    });
  if (clash) return new NewChatDraftError({ reason: 'clash', path: clash.path });
  if (
    new TextEncoder().encode(combined).length > maximumChatInputBytes ||
    all.length > maximumChatMentions
  )
    return new NewChatDraftError({ reason: 'full' });
  return { text: combined, mentions: all };
}
