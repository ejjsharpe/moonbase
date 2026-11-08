import {
  findChatMentionStarts,
  formatChatMention,
  isChatMentionEnd,
  type ChatMention,
} from '@moonbase/contracts/chat';

/** An `@` being typed before the caret: where it starts and what follows it. */
export type MentionQuery = { start: number; query: string };

/** The `@query` the caret is typing, unless it is an existing mention or follows a word. */
export function findMentionQuery(
  text: string,
  caret: number,
  mentions: readonly ChatMention[],
): MentionQuery | null {
  const match = /(?:^|\s)@([^\s@"]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[1]!,
    start = caret - query.length - 1;
  // The caret resting at the end of a picked mention is not a new query.
  if (mentions.some((mention) => mention.path === query) && isChatMentionEnd(text, caret))
    return null;
  return { start, query };
}

/** Replaces `@query` with the mention and a space, returning the text and the caret after it. */
export function insertMention(text: string, query: MentionQuery, caret: number, path: string) {
  const token = formatChatMention(path) + ' ';
  const after = text.slice(caret).replace(/^ /, '');
  return {
    text: text.slice(0, query.start) + token + after,
    caret: query.start + token.length,
  };
}

/** Each mention's spellings in the text, ordered and not overlapping. */
export function findMentionRanges(text: string, mentions: readonly ChatMention[]) {
  const ranges: { start: number; end: number; path: string }[] = [];
  for (const mention of mentions) {
    const length = formatChatMention(mention.path).length;
    for (const start of findChatMentionStarts(text, mention.path))
      ranges.push({ start, end: start + length, path: mention.path });
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  return ranges.filter((range, index) => !index || range.start >= ranges[index - 1]!.end);
}

/** Backspace at a mention's end deletes the whole mention, as with a chip. */
export function removeMentionBefore(text: string, caret: number, mentions: readonly ChatMention[]) {
  const range = findMentionRanges(text, mentions).find((r) => r.end === caret);
  if (!range) return null;
  return { text: text.slice(0, range.start) + text.slice(range.end), caret: range.start };
}

/**
 * Appends mentions of `files` (absolute paths) that lie inside `folder` to a draft, skipping ones
 * it already mentions. `outside` counts the files left out because they are elsewhere.
 */
export function appendMentions(
  text: string,
  mentions: readonly ChatMention[],
  files: readonly string[],
  folder: string,
) {
  const prefix = folder.replace(/\/+$/, '') + '/';
  // An unknown folder (or the filesystem root) would make every absolute path look inside it.
  const inside =
    prefix === '/'
      ? []
      : files.filter((file) => file.startsWith(prefix) && file.length > prefix.length);
  const added = [...new Set(inside.map((file) => file.slice(prefix.length)))].filter(
    (path) => !mentions.some((mention) => mention.path === path),
  );
  const tokens = added.map(formatChatMention).join(' ');
  const separator = text && !/\s$/.test(text) ? ' ' : '';
  return {
    text: tokens ? `${text}${separator}${tokens} ` : text,
    mentions: [...mentions, ...added.map((path) => ({ path }))],
    outside: files.length - inside.length,
  };
}
